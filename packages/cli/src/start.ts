/**
 * One-command local bootstrap: HydraDB up, index workspace, write Cursor config.
 *
 *   lumos start [repo-path] [--index] [--skip-index] [--lang auto|python|typescript]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { upsertEnv, writeCursorConnect } from "./connect.ts";
import { lumosHome } from "./defaults.ts";

export interface StartOptions {
  target: string;
  slug?: string;
  lang: "auto" | "python" | "typescript";
  forceIndex: boolean;
  skipIndex: boolean;
  run: (command: string, args: string[], cwd?: string) => string;
  indexRepo: (
    root: string,
    slug?: string,
    lang?: "auto" | "python" | "typescript",
  ) => { slug: string; root: string };
}

function envHasWorkspace(envPath: string): boolean {
  if (!existsSync(envPath)) return false;
  const text = readFileSync(envPath, "utf8");
  return /^LUMOS_ROOT=/m.test(text) && /^LUMOS_REPO=/m.test(text);
}

export function cmdStart(options: StartOptions): void {
  const home = lumosHome();
  const root = resolve(options.target);
  const envPath = join(home, ".env");

  console.log("==> HydraDB");
  options.run("bash", ["scripts/db-up.sh"], home);

  console.log("==> Probe");
  options.run(
    "node",
    ["--no-warnings", "--import", "tsx", "--env-file-if-exists=.env", "packages/graph/src/probe.ts"],
    home,
  );

  let repo = process.env.LUMOS_REPO ?? "django/django";
  let indexedRoot = process.env.LUMOS_ROOT ?? join(home, "data/repos/django");

  if (!options.skipIndex && (options.forceIndex || !envHasWorkspace(envPath))) {
    console.log(`==> Index ${root}`);
    const indexed = options.indexRepo(root, options.slug, options.lang);
    repo = indexed.slug;
    indexedRoot = indexed.root;
    upsertEnv(envPath, {
      LUMOS_REPO: indexed.slug,
      LUMOS_ROOT: indexed.root,
    });
    console.log(`active workspace ${indexed.slug} -> ${indexed.root}`);
  } else if (options.skipIndex) {
    console.log("==> Skipped index (--skip-index)");
  } else {
    console.log("==> Using workspace from .env (pass --index to re-index)");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf8").split("\n")) {
        if (line.startsWith("LUMOS_REPO=")) repo = line.slice("LUMOS_REPO=".length).trim();
        if (line.startsWith("LUMOS_ROOT=")) indexedRoot = line.slice("LUMOS_ROOT=".length).trim();
      }
    }
  }

  console.log("==> Cursor connect");
  const written = writeCursorConnect({
    targetRoot: root,
    lumosHome: home,
    repo,
    indexedRoot: resolve(indexedRoot),
  });
  console.log(`wrote ${written.mcpPath}`);
  console.log(`wrote ${written.rulePath}`);

  console.log(`
Lumos is ready.

  Terminal 1:  pnpm api
  Terminal 2:  pnpm mcp
  Browser:     pnpm web   →   http://localhost:3000/app

  Preflight:   pnpm lumos preflight "describe your change"
  Verify:      pnpm lumos verify "…" --changed path/to/file

Workspace: ${repo}
Root:      ${indexedRoot}
`);
}
