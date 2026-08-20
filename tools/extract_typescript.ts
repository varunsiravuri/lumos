#!/usr/bin/env node
/**
 * Extract a code graph from a TypeScript / JavaScript repository.
 *
 * Emits the same JSONL schema as tools/extract_python.py so the Node ingest
 * loader can stream either language into HydraDB without changes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import * as ts from "typescript";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".tox", ".nox", ".venv", "venv", "env",
  "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache",
  "build", "dist", ".eggs", "site-packages", ".next", "coverage", ".turbo", "data",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

interface SymbolRow {
  qualname: string;
  name: string;
  kind: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  isTest: boolean;
}

interface FileUnit {
  path: string;
  module: string;
  sourceFile: ts.SourceFile;
  loc: number;
  isTest: boolean;
  symbols: SymbolRow[];
  aliases: Map<string, string>;
  importedModules: Set<string>;
}

function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  return (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    parts.some((part) => part === "__tests__" || part === "tests" || part === "test")
  );
}

function discover(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(directory, entry.name));
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (!SOURCE_EXT.has(ext) || entry.name.endsWith(".d.ts")) continue;
        found.push(relative(root, join(directory, entry.name)).replaceAll("\\", "/"));
      }
    }
  };

  walk(root);
  return found.sort();
}

function moduleName(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "").replaceAll("/", ".");
}

function resolveImport(fromPath: string, specifier: string, root: string, moduleToPath: Map<string, string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = fromPath.split("/").slice(0, -1);
  const parts = [...fromDir, ...specifier.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  const candidates = [
    `${normalized.join("/")}.ts`,
    `${normalized.join("/")}.tsx`,
    `${normalized.join("/")}.js`,
    `${normalized.join("/")}.jsx`,
    `${normalized.join("/")}/index.ts`,
    `${normalized.join("/")}/index.tsx`,
  ];
  for (const candidate of candidates) {
    if (moduleToPath.has(moduleName(candidate))) return candidate;
    try {
      statSync(join(root, candidate));
      return candidate;
    } catch {
      // not on disk
    }
  }
  return null;
}

function lineEnd(node: ts.Node, sourceFile: ts.SourceFile): number {
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return end.line + 1;
}

function collectDefinitions(unit: FileUnit): void {
  const scope: string[] = [unit.module];
  let classDepth = 0;
  const sourceFile = unit.sourceFile;

  const record = (node: ts.Node, name: string, kind: string): void => {
    const qualname = [...scope, name].join(".");
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    unit.symbols.push({
      qualname,
      name,
      kind,
      path: unit.path,
      lineStart: start,
      lineEnd: lineEnd(node, sourceFile),
      isTest: unit.isTest || name.startsWith("test") || name.startsWith("it") || name.startsWith("describe"),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      record(node, node.name.text, "class");
      scope.push(node.name.text);
      classDepth += 1;
      ts.forEachChild(node, visit);
      classDepth -= 1;
      scope.pop();
      return;
    }

    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      record(node, node.name.text, classDepth > 0 ? "method" : "function");
      if (node.body) {
        scope.push(node.name.text);
        ts.forEachChild(node.body, visit);
        scope.pop();
      }
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      record(node, node.name.text, classDepth > 0 ? "method" : "function");
      scope.push(node.name.text);
      ts.forEachChild(node.body ?? node, visit);
      scope.pop();
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          record(decl, decl.name.text, classDepth > 0 ? "method" : "function");
          scope.push(decl.name.text);
          ts.forEachChild(init.body ?? init, visit);
          scope.pop();
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function collectImports(unit: FileUnit, root: string, moduleToPath: Map<string, string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const targetPath = resolveImport(unit.path, spec, root, moduleToPath);
      if (targetPath) {
        unit.importedModules.add(moduleName(targetPath));
      } else if (!spec.startsWith(".")) {
        unit.importedModules.add(spec);
      }

      const clause = node.importClause;
      if (!clause) return;

      if (clause.name) {
        unit.aliases.set(clause.name.text, targetPath ? moduleName(targetPath) : spec);
      }

      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const local = (element.propertyName ?? element.name).text;
          const imported = element.name.text;
          const base = targetPath ? moduleName(targetPath) : spec;
          unit.aliases.set(local, `${base}.${imported}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(unit.sourceFile);
}

function expressionPath(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = expressionPath(node.expression);
    return left ? `${left}.${node.name.text}` : node.name.text;
  }
  return null;
}

function resolveCalls(
  unit: FileUnit,
  qualnames: Set<string>,
  byName: Map<string, Set<string>>,
  classes: Set<string>,
): { calls: [string, string, number][]; external: number; ambiguous: number; unknown: number } {
  const calls: [string, string, number][] = [];
  let external = 0;
  let ambiguous = 0;
  let unknown = 0;

  const scope: string[] = [unit.module];
  const classStack: string[] = [];

  const byNameLocal = (name: string): [string | null, "resolved" | "ambiguous" | "unknown"] => {
    const candidates = byName.get(name);
    if (!candidates || candidates.size === 0) return [null, "unknown"];
    if (candidates.size === 1) return [next(candidates)!, "resolved"];

    const modulePrefix = unit.module;
    const sameModule = [...candidates].filter((c) => c.startsWith(`${modulePrefix}.`));
    if (sameModule.length === 1) return [sameModule[0]!, "resolved"];

    return [null, "ambiguous"];
  };

  const resolveExpr = (expr: ts.Expression): [string | null, "resolved" | "external" | "ambiguous" | "unknown"] => {
    if (ts.isIdentifier(expr)) {
      const local = [...scope, expr.text].join(".");
      if (qualnames.has(local)) return [local, "resolved"];
      const aliased = unit.aliases.get(expr.text);
      if (aliased && qualnames.has(aliased)) return [aliased, "resolved"];
      if (aliased && !aliased.startsWith(unit.module)) return [null, "external"];
      const [hit, reason] = byNameLocal(expr.text);
      return [hit, reason];
    }

    if (ts.isPropertyAccessExpression(expr)) {
      if (ts.isIdentifier(expr.expression) && expr.expression.text === "this" && classStack.length > 0) {
        const own = `${classStack[classStack.length - 1]}.${expr.name.text}`;
        if (qualnames.has(own)) return [own, "resolved"];
      }

      const dotted = expressionPath(expr);
      if (dotted) {
        if (qualnames.has(dotted)) return [dotted, "resolved"];
        const [head, ...rest] = dotted.split(".");
        const alias = head ? unit.aliases.get(head) : undefined;
        if (alias) {
          const candidate = rest.length ? `${alias}.${rest.join(".")}` : alias;
          if (qualnames.has(candidate)) return [candidate, "resolved"];
          return [null, "external"];
        }
      }

      const [hit, reason] = byNameLocal(expr.name.text);
      return [hit, reason];
    }

    return [null, "unknown"];
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      scope.push(node.name.text);
      classStack.push([...scope].join("."));
      ts.forEachChild(node, visit);
      classStack.pop();
      scope.pop();
      return;
    }

    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      scope.push(node.name.text);
      ts.forEachChild(node.body ?? node, visit);
      scope.pop();
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          scope.push(decl.name.text);
          ts.forEachChild(init.body ?? init, visit);
          scope.pop();
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const caller = scope.join(".");
      if (qualnames.has(caller)) {
        const line = unit.sourceFile.getLineAndCharacterOfPosition(node.getStart(unit.sourceFile)).line + 1;
        const [callee, reason] = resolveExpr(node.expression);
        if (callee && callee !== caller) calls.push([caller, callee, line]);
        else if (reason === "external") external += 1;
        else if (reason === "ambiguous") ambiguous += 1;
        else unknown += 1;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(unit.sourceFile);
  return { calls, external, ambiguous, unknown };
}

function next<T>(iter: Set<T>): T | undefined {
  return iter.values().next().value;
}

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function main(): number {
  const args = process.argv.slice(2);
  const rootFlag = args.findIndex((arg) => arg === "--slug");
  const commitFlag = args.findIndex((arg) => arg === "--commit");
  const root = resolve(args[0] ?? "");
  const slug = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
  const commit = commitFlag >= 0 ? args[commitFlag + 1] ?? "" : "";

  if (!root || !slug) {
    console.error("usage: extract_typescript.ts <repo-root> --slug owner/name [--commit sha]");
    return 1;
  }

  emit({ t: "repo", slug, commit });

  const paths = discover(root);
  const units: FileUnit[] = [];
  let parseFailures = 0;

  for (const path of paths) {
    let source = "";
    try {
      source = readFileSync(join(root, path), "utf8");
      if (statSync(join(root, path)).size > 1_500_000) continue;
    } catch {
      parseFailures += 1;
      continue;
    }

    const kind = path.endsWith(".tsx") || path.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
    if (sourceFile.parseDiagnostics.length > 0) {
      parseFailures += 1;
      continue;
    }

    const unit: FileUnit = {
      path,
      module: moduleName(path),
      sourceFile,
      loc: source.split("\n").length,
      isTest: isTestPath(path),
      symbols: [],
      aliases: new Map(),
      importedModules: new Set(),
    };
    collectDefinitions(unit);
    units.push(unit);
  }

  const moduleToPath = new Map(units.map((unit) => [unit.module, unit.path]));
  for (const unit of units) collectImports(unit, root, moduleToPath);

  const qualnames = new Set<string>();
  const classes = new Set<string>();
  const byName = new Map<string, Set<string>>();

  for (const unit of units) {
    for (const symbol of unit.symbols) {
      qualnames.add(symbol.qualname);
      if (symbol.kind === "class") classes.add(symbol.qualname);
      const bucket = byName.get(symbol.name) ?? new Set<string>();
      bucket.add(symbol.qualname);
      byName.set(symbol.name, bucket);
    }
  }

  for (const unit of units) {
    emit({
      t: "file",
      path: unit.path,
      language: unit.path.endsWith(".js") || unit.path.endsWith(".jsx") || unit.path.endsWith(".mjs") || unit.path.endsWith(".cjs")
        ? "javascript"
        : "typescript",
      loc: unit.loc,
      is_test: unit.isTest,
    });

    for (const symbol of unit.symbols) {
      emit({
        t: "symbol",
        qualname: symbol.qualname,
        name: symbol.name,
        kind: symbol.kind,
        path: symbol.path,
        line_start: symbol.lineStart,
        line_end: symbol.lineEnd,
        is_test: symbol.isTest,
      });
    }
  }

  let resolved = 0;
  let external = 0;
  let ambiguous = 0;
  let unknown = 0;
  let importEdges = 0;

  for (const unit of units) {
    const result = resolveCalls(unit, qualnames, byName, classes);
    for (const [src, dst, line] of result.calls) emit({ t: "call", src, dst, line });
    resolved += result.calls.length;
    external += result.external;
    ambiguous += result.ambiguous;
    unknown += result.unknown;

    for (const imported of unit.importedModules) {
      const target = moduleToPath.get(imported);
      if (target && target !== unit.path) {
        emit({ t: "import", src: unit.path, dst: target });
        importEdges += 1;
      }
    }
  }

  const internal = resolved + ambiguous + unknown;
  emit({
    t: "stats",
    files: units.length,
    parse_failures: parseFailures,
    symbols: qualnames.size,
    calls_resolved: resolved,
    calls_external: external,
    calls_ambiguous: ambiguous,
    calls_unknown: unknown,
    internal_resolution_rate: internal ? Math.round((resolved / internal) * 10_000) / 10_000 : 0,
    imports: importEdges,
  });

  return 0;
}

process.exit(main());
