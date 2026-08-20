import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type WorkspaceSource = "sample" | "github" | "local";
export type WorkspaceStatus = "ready" | "indexing" | "error";

export interface WorkspaceRecord {
  slug: string;
  label: string;
  root: string;
  source: WorkspaceSource;
  status: WorkspaceStatus;
  files: number;
  addedAt: string;
  updatedAt: string;
  url?: string;
  error?: string;
}

interface WorkspaceFile {
  active: string;
  workspaces: WorkspaceRecord[];
}

export class WorkspaceStore {
  readonly path: string;
  private activeSlug: string;
  private readonly records = new Map<string, WorkspaceRecord>();

  constructor(path: string, initial: WorkspaceRecord) {
    this.path = resolve(path);
    this.activeSlug = initial.slug;

    if (existsSync(this.path)) {
      try {
        const stored = JSON.parse(readFileSync(this.path, "utf8")) as WorkspaceFile;
        for (const record of stored.workspaces ?? []) {
          if (record?.slug && record?.root) this.records.set(record.slug, record);
        }
        if (stored.active && this.records.has(stored.active)) this.activeSlug = stored.active;
      } catch {
        // A damaged machine-local registry should not prevent the configured
        // repository from starting. The next successful write replaces it.
      }
    }

    this.records.set(initial.slug, {
      ...initial,
      ...(this.records.get(initial.slug) ?? {}),
      root: initial.root,
      status: "ready",
    });
    if (!this.records.has(this.activeSlug)) this.activeSlug = initial.slug;
    this.persist();
  }

  active(): WorkspaceRecord {
    return this.records.get(this.activeSlug) ?? [...this.records.values()][0]!;
  }

  list(): WorkspaceRecord[] {
    return [...this.records.values()].sort((left, right) => {
      if (left.slug === this.activeSlug) return -1;
      if (right.slug === this.activeSlug) return 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  get(slug: string): WorkspaceRecord | null {
    return this.records.get(slug) ?? null;
  }

  upsert(record: WorkspaceRecord): WorkspaceRecord {
    const previous = this.records.get(record.slug);
    const next = { ...previous, ...record };
    this.records.set(next.slug, next);
    this.persist();
    return next;
  }

  activate(slug: string): WorkspaceRecord | null {
    const record = this.records.get(slug);
    if (!record || record.status !== "ready") return null;
    this.activeSlug = slug;
    this.persist();
    return record;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      `${JSON.stringify({ active: this.activeSlug, workspaces: [...this.records.values()] }, null, 2)}\n`,
      "utf8",
    );
  }
}

export function workspaceLabel(slug: string): string {
  if (slug === "django/django") return "Django demo";
  return slug;
}
