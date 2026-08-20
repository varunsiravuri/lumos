/**
 * Write Cursor MCP config and a project rule so the agent actually calls Lumos.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DJANGO_DEMO_REPO = "django/django";

export function workspaceLabel(repo: string): string {
  return repo === DJANGO_DEMO_REPO ? "Django demo" : repo;
}

export function absoluteRepoRoot(root: string, lumosHome: string): string {
  return isAbsolute(root) ? root : resolve(lumosHome, root);
}

export function upsertEnv(envPath: string, updates: Record<string, string>): void {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (text && !text.endsWith("\n")) text += "\n";
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${quoteEnv(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text += `${line}\n`;
  }
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, text, "utf8");
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export interface ConnectResult {
  mcpPath: string;
  rulePath: string;
  repo: string;
  root: string;
  lumosHome: string;
}

export function writeCursorConnect(options: {
  targetRoot: string;
  lumosHome: string;
  repo: string;
  indexedRoot: string;
}): ConnectResult {
  const targetRoot = resolve(options.targetRoot);
  const cursorDir = join(targetRoot, ".cursor");
  const rulesDir = join(cursorDir, "rules");
  mkdirSync(rulesDir, { recursive: true });

  const mcpPath = join(cursorDir, "mcp.json");
  const rulePath = join(rulesDir, "lumos.mdc");
  const existing = readJson(mcpPath);
  const next = mergeMcpConfig(existing, {
    command: "pnpm",
    args: ["mcp"],
    cwd: options.lumosHome,
    env: {
      LUMOS_REPO: options.repo,
      LUMOS_ROOT: options.indexedRoot,
    },
  });
  writeFileSync(mcpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  writeFileSync(rulePath, lumosRule(), "utf8");

  return {
    mcpPath,
    rulePath,
    repo: options.repo,
    root: options.indexedRoot,
    lumosHome: options.lumosHome,
  };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mergeMcpConfig(
  existing: Record<string, unknown>,
  lumosServer: Record<string, unknown>,
): Record<string, unknown> {
  const servers =
    existing.mcpServers && typeof existing.mcpServers === "object" && !Array.isArray(existing.mcpServers)
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  return {
    ...existing,
    mcpServers: {
      ...servers,
      lumos: lumosServer,
    },
  };
}

function lumosRule(): string {
  return `---
description: Preflight and verify agent edits with Lumos before and after changing code
alwaysApply: true
---

# Lumos agent loop

Lumos is the local graph context layer for this repository. Do not skip it.

Before you edit any files, call the MCP tool \`lumos.preflight_change\` with the user's request as \`issue_text\`. Use the returned files, tests, and context contract as the edit plan. Prefer graph-proved files; if the proof is \`text-only\`, still start from the ranked file list and say so.

After you edit, call \`lumos.verify_patch\` with:
- \`issue_text\`: the same original request
- \`changed_files\`: repository-relative paths you changed
- \`tests_run\`: test names or paths you ran, if any

If verification is blocked, fix the missing primary target before continuing. If scope or tests are flagged, tell the user before expanding the change.
`;
}
