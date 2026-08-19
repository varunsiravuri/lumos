import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The Lumos checkout, not the repository being indexed. */
export function lumosHome(): string {
  if (process.env.LUMOS_HOME) return resolve(process.env.LUMOS_HOME);
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(here, "pnpm-workspace.yaml"))) return here;
    here = dirname(here);
  }
  return process.cwd();
}

export const DEFAULT_REPO = process.env.LUMOS_REPO ?? "django/django";
export const DEFAULT_ROOT = process.env.LUMOS_ROOT ?? "data/repos/django";
