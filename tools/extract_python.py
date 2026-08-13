#!/usr/bin/env python3
"""Extract a code graph from a Python repository.

Emits JSONL on stdout, one tagged record per line, so the Node loader can stream
it without holding a whole repository in memory:

    {"t": "repo",   "slug": ..., "commit": ...}
    {"t": "file",   "path": ..., "language": ..., "loc": ..., "is_test": ...}
    {"t": "symbol", "qualname": ..., "name": ..., "kind": ..., "path": ..., ...}
    {"t": "call",   "src": <qualname>, "dst": <qualname>, "line": ...}
    {"t": "import", "src": <path>,     "dst": <path>}
    {"t": "stats",  ...}

Only the standard library is used, so there is nothing to install.

Call resolution is deliberately heuristic. Python is dynamically typed, so a
fully sound call graph is not obtainable from the AST alone; the aim is high
precision on the calls that can be resolved, and an honest count of the ones
that cannot. `stats` reports the resolution rate so it can be quoted rather
than glossed over.
"""

from __future__ import annotations

import argparse
import ast
import builtins
import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field

BUILTIN_NAMES = frozenset(dir(builtins))

SKIP_DIRS = {
    ".git", ".hg", ".svn", ".tox", ".nox", ".venv", "venv", "env",
    "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache",
    "build", "dist", ".eggs", "site-packages",
}


def is_test_path(path: str) -> bool:
    parts = path.split("/")
    base = parts[-1]
    return (
        base.startswith("test_")
        or base.endswith("_test.py")
        or any(p in ("tests", "test", "testing") for p in parts[:-1])
    )


def module_name(path: str, root: str) -> str:
    """Repository-relative path to the dotted module name Python would import.

    `root` is the source root the file sits under, so that a `src/` layout
    yields `requests.models` rather than `src.requests.models`. Getting this
    right matters because issue text and tracebacks name importable modules,
    and those strings are what a query seeds on.
    """
    stem = path[:-3] if path.endswith(".py") else path
    if root:
        prefix = root + "/"
        if stem.startswith(prefix):
            stem = stem[len(prefix):]
    if stem.endswith("/__init__"):
        stem = stem[: -len("/__init__")]
    return stem.replace("/", ".")


def source_root(repo_root: str, path: str) -> str:
    """Walk up from a file while its parents are packages.

    The first ancestor without an `__init__.py` is the directory that would be
    on `sys.path`, so module names are relative to it.
    """
    parts = path.split("/")[:-1]
    while parts:
        candidate = os.path.join(repo_root, *parts, "__init__.py")
        if not os.path.exists(candidate):
            break
        parts.pop()
    return "/".join(parts)


def package_of(module: str) -> str:
    return module.rsplit(".", 1)[0] if "." in module else ""


@dataclass
class Symbol:
    qualname: str
    name: str
    kind: str
    path: str
    line_start: int
    line_end: int
    is_test: bool


@dataclass
class FileUnit:
    path: str
    module: str
    tree: ast.AST
    loc: int
    is_test: bool
    symbols: list[Symbol] = field(default_factory=list)
    # Local alias -> dotted target, from this file's import statements.
    aliases: dict[str, str] = field(default_factory=dict)
    # Modules this file imports, for File -> File IMPORTS edges.
    imported_modules: set[str] = field(default_factory=set)


class DefinitionCollector(ast.NodeVisitor):
    """Collect every function, method and class with its qualified name."""

    def __init__(self, unit: FileUnit) -> None:
        self.unit = unit
        self.scope: list[str] = [unit.module] if unit.module else []
        self.class_depth = 0

    def _record(self, node: ast.AST, name: str, kind: str) -> None:
        qualname = ".".join([*self.scope, name])
        self.unit.symbols.append(
            Symbol(
                qualname=qualname,
                name=name,
                kind=kind,
                path=self.unit.path,
                line_start=getattr(node, "lineno", 0),
                line_end=getattr(node, "end_lineno", None) or getattr(node, "lineno", 0),
                is_test=self.unit.is_test or name.startswith("test_"),
            )
        )

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._record(node, node.name, "class")
        self.scope.append(node.name)
        self.class_depth += 1
        self.generic_visit(node)
        self.class_depth -= 1
        self.scope.pop()

    def _visit_function(self, node: ast.AST, name: str) -> None:
        self._record(node, name, "method" if self.class_depth > 0 else "function")
        self.scope.append(name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node, node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node, node.name)


def collect_imports(unit: FileUnit) -> None:
    """Record local aliases and imported modules for one file."""
    package = package_of(unit.module)

    for node in ast.walk(unit.tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                target = alias.name
                unit.imported_modules.add(target)
                unit.aliases[alias.asname or target.split(".")[0]] = target

        elif isinstance(node, ast.ImportFrom):
            if node.level:
                # Relative import: walk up `level - 1` packages from this one.
                base_parts = package.split(".") if package else []
                trimmed = base_parts[: len(base_parts) - (node.level - 1)]
                base = ".".join([*trimmed, node.module] if node.module else trimmed)
            else:
                base = node.module or ""

            if base:
                unit.imported_modules.add(base)

            for alias in node.names:
                if alias.name == "*":
                    continue
                target = f"{base}.{alias.name}" if base else alias.name
                unit.aliases[alias.asname or alias.name] = target


class CallResolver(ast.NodeVisitor):
    """Walk a file and emit resolved caller -> callee pairs."""

    def __init__(
        self,
        unit: FileUnit,
        qualnames: set[str],
        by_name: dict[str, set[str]],
        classes: set[str],
    ) -> None:
        self.unit = unit
        self.qualnames = qualnames
        self.by_name = by_name
        self.classes = classes
        self.scope: list[str] = [unit.module] if unit.module else []
        self.class_stack: list[str] = []
        # One frame per function body, mapping a local name to a class qualname.
        self.var_types: list[dict[str, str]] = []
        self.calls: list[tuple[str, str, int]] = []
        self.external = 0
        self.ambiguous = 0
        self.unknown = 0

    # --- scope tracking -------------------------------------------------

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.scope.append(node.name)
        self.class_stack.append(".".join(self.scope))
        self.generic_visit(node)
        self.class_stack.pop()
        self.scope.pop()

    def _visit_function(self, node: ast.AST, name: str) -> None:
        self.scope.append(name)

        frame: dict[str, str] = {}
        args = getattr(node, "args", None)
        if args is not None:
            # Annotated parameters are free, precise type information.
            for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
                if arg.annotation is not None:
                    resolved = self._resolve_class(arg.annotation)
                    if resolved:
                        frame[arg.arg] = resolved
        self.var_types.append(frame)

        self.generic_visit(node)

        self.var_types.pop()
        self.scope.pop()

    # --- local type inference -------------------------------------------

    def _resolve_class(self, node: ast.AST) -> str | None:
        """Resolve an expression naming a class to its qualname."""
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            # A string annotation, as used for forward references.
            candidates = self.by_name.get(node.value.rsplit(".", 1)[-1])
            if candidates and len(candidates) == 1:
                only = next(iter(candidates))
                return only if only in self.classes else None
            return None

        if isinstance(node, ast.Name):
            local = ".".join([self.unit.module, node.id]) if self.unit.module else node.id
            if local in self.classes:
                return local
            aliased = self.unit.aliases.get(node.id)
            if aliased and aliased in self.classes:
                return aliased
            candidates = {c for c in self.by_name.get(node.id, set()) if c in self.classes}
            if len(candidates) == 1:
                return next(iter(candidates))
            return None

        if isinstance(node, ast.Attribute):
            dotted = attribute_path(node)
            if dotted:
                if dotted in self.classes:
                    return dotted
                head, _, rest = dotted.partition(".")
                target = self.unit.aliases.get(head)
                if target:
                    candidate = f"{target}.{rest}" if rest else target
                    if candidate in self.classes:
                        return candidate
        return None

    def _record_binding(self, target: ast.AST, value: ast.AST | None, annotation: ast.AST | None) -> None:
        if not isinstance(target, ast.Name) or not self.var_types:
            return

        inferred: str | None = None
        if annotation is not None:
            inferred = self._resolve_class(annotation)
        if inferred is None and isinstance(value, ast.Call):
            # `p = PreparedRequest()` gives `p` a known type, which is the single
            # most common way a method call becomes resolvable in Python.
            inferred = self._resolve_class(value.func)

        if inferred:
            self.var_types[-1][target.id] = inferred

    def visit_Assign(self, node: ast.Assign) -> None:
        if len(node.targets) == 1:
            self._record_binding(node.targets[0], node.value, None)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        self._record_binding(node.target, node.value, node.annotation)
        self.generic_visit(node)

    def _local_type(self, name: str) -> str | None:
        for frame in reversed(self.var_types):
            found = frame.get(name)
            if found:
                return found
        return None

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node, node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node, node.name)

    # --- resolution -----------------------------------------------------

    def _by_name(self, name: str) -> tuple[str | None, str]:
        """Resolve a bare name, narrowing by locality before giving up.

        A repo-wide unique match is safe. When several symbols share a name,
        proximity is a strong signal: a call almost always means the definition
        in the same module, and failing that the same package. Only a genuine
        tie across unrelated packages is reported as ambiguous.
        """
        candidates = self.by_name.get(name)
        if not candidates:
            return None, "unknown"
        if len(candidates) == 1:
            return next(iter(candidates)), "resolved"

        module = self.unit.module
        same_module = {c for c in candidates if c.startswith(f"{module}.")}
        if len(same_module) == 1:
            return next(iter(same_module)), "resolved"

        package = package_of(module)
        if package:
            same_package = {c for c in candidates if c.startswith(f"{package}.")}
            if len(same_package) == 1:
                return next(iter(same_package)), "resolved"

        return None, "ambiguous"

    def _resolve(self, func: ast.AST) -> tuple[str | None, str]:
        """Resolve a call target, and say why when it cannot be resolved.

        The distinction matters: a call to `len` or to a third-party library is
        not a failure of the extractor, it is a call that leaves the repository.
        Counting those as failures would understate resolution badly.
        """
        if isinstance(func, ast.Name):
            # A name defined in this module wins over anything imported.
            local = ".".join([self.unit.module, func.id]) if self.unit.module else func.id
            if local in self.qualnames:
                return local, "resolved"

            aliased = self.unit.aliases.get(func.id)
            if aliased:
                if aliased in self.qualnames:
                    return aliased, "resolved"
                # Imported, but from outside the repository.
                return None, "external"

            if func.id in BUILTIN_NAMES:
                return None, "external"

            return self._by_name(func.id)

        if isinstance(func, ast.Attribute):
            # `self.method()` is the most common call form in a class-heavy
            # codebase and is precisely resolvable: the receiver type is the
            # enclosing class.
            if isinstance(func.value, ast.Name) and func.value.id == "self" and self.class_stack:
                own = f"{self.class_stack[-1]}.{func.attr}"
                if own in self.qualnames:
                    return own, "resolved"

            # A receiver whose type we inferred locally resolves precisely.
            if isinstance(func.value, ast.Name):
                receiver = self._local_type(func.value.id)
                if receiver:
                    candidate = f"{receiver}.{func.attr}"
                    if candidate in self.qualnames:
                        return candidate, "resolved"

            dotted = attribute_path(func)
            if dotted:
                if dotted in self.qualnames:
                    return dotted, "resolved"
                head, _, rest = dotted.partition(".")
                target = self.unit.aliases.get(head)
                if target:
                    candidate = f"{target}.{rest}" if rest else target
                    if candidate in self.qualnames:
                        return candidate, "resolved"
                    return None, "external"

            # `self.method()` and `obj.method()` carry no type information here,
            # so fall back to an unambiguous method name.
            return self._by_name(func.attr)

        return None, "unknown"

    def visit_Call(self, node: ast.Call) -> None:
        caller = ".".join(self.scope)
        if caller in self.qualnames:
            callee, reason = self._resolve(node.func)
            if callee and callee != caller:
                self.calls.append((caller, callee, node.lineno))
            elif reason == "external":
                self.external += 1
            elif reason == "ambiguous":
                self.ambiguous += 1
            elif callee is None:
                self.unknown += 1
        self.generic_visit(node)


def attribute_path(node: ast.Attribute) -> str | None:
    """Flatten `a.b.c` into "a.b.c", or None if the base is not a plain name."""
    parts: list[str] = []
    current: ast.AST = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    parts.append(current.id)
    return ".".join(reversed(parts))


def discover(root: str) -> list[str]:
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for filename in filenames:
            if filename.endswith(".py"):
                absolute = os.path.join(dirpath, filename)
                found.append(os.path.relpath(absolute, root).replace(os.sep, "/"))
    return sorted(found)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", help="repository root to extract")
    parser.add_argument("--slug", required=True, help='repository slug, e.g. "django/django"')
    parser.add_argument("--commit", default="", help="commit the extraction represents")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    out = sys.stdout

    def emit(record: dict) -> None:
        out.write(json.dumps(record, separators=(",", ":")))
        out.write("\n")

    emit({"t": "repo", "slug": args.slug, "commit": args.commit})

    paths = discover(root)
    units: list[FileUnit] = []
    parse_failures = 0

    for path in paths:
        try:
            with open(os.path.join(root, path), "r", encoding="utf-8", errors="replace") as handle:
                source = handle.read()
            tree = ast.parse(source, filename=path)
        except (SyntaxError, ValueError, OSError):
            # Repositories carry fixtures and templates that are not valid Python
            # on this interpreter. Skipping them is correct; hiding it is not.
            parse_failures += 1
            continue

        unit = FileUnit(
            path=path,
            module=module_name(path, source_root(root, path)),
            tree=tree,
            loc=source.count("\n") + 1,
            is_test=is_test_path(path),
        )
        DefinitionCollector(unit).visit(tree)
        collect_imports(unit)
        units.append(unit)

    # Global symbol index, needed before any call can be resolved.
    qualnames: set[str] = set()
    classes: set[str] = set()
    by_name: dict[str, set[str]] = defaultdict(set)
    module_to_path: dict[str, str] = {}

    for unit in units:
        module_to_path[unit.module] = unit.path
        for symbol in unit.symbols:
            qualnames.add(symbol.qualname)
            by_name[symbol.name].add(symbol.qualname)
            if symbol.kind == "class":
                classes.add(symbol.qualname)

    for unit in units:
        emit({
            "t": "file",
            "path": unit.path,
            "language": "python",
            "loc": unit.loc,
            "is_test": unit.is_test,
        })
        for symbol in unit.symbols:
            emit({
                "t": "symbol",
                "qualname": symbol.qualname,
                "name": symbol.name,
                "kind": symbol.kind,
                "path": symbol.path,
                "line_start": symbol.line_start,
                "line_end": symbol.line_end,
                "is_test": symbol.is_test,
            })

    resolved = external = ambiguous = unknown = import_edges = 0

    for unit in units:
        resolver = CallResolver(unit, qualnames, by_name, classes)
        resolver.visit(unit.tree)
        for caller, callee, line in resolver.calls:
            emit({"t": "call", "src": caller, "dst": callee, "line": line})

        resolved += len(resolver.calls)
        external += resolver.external
        ambiguous += resolver.ambiguous
        unknown += resolver.unknown

        for module in sorted(unit.imported_modules):
            target = module_to_path.get(module)
            if target and target != unit.path:
                emit({"t": "import", "src": unit.path, "dst": target})
                import_edges += 1

    # Calls leaving the repository are not resolution failures, so the rate is
    # reported over calls that could in principle land on an internal symbol.
    internal = resolved + ambiguous + unknown

    emit({
        "t": "stats",
        "files": len(units),
        "parse_failures": parse_failures,
        "symbols": len(qualnames),
        "calls_resolved": resolved,
        "calls_external": external,
        "calls_ambiguous": ambiguous,
        "calls_unknown": unknown,
        "internal_resolution_rate": round(resolved / internal, 4) if internal else 0.0,
        "imports": import_edges,
    })

    return 0


if __name__ == "__main__":
    sys.exit(main())
