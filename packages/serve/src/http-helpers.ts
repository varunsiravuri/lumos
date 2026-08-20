import type { WorkspaceRecord, WorkspaceStatus } from "./workspace-store.ts";

export function githubRepository(value: string): { slug: string; url: string } | null {
  const trimmed = value.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const shorthand = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  const full = trimmed.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
  const match = full ?? shorthand;
  if (!match?.[1] || !match[2]) return null;
  const slug = `${match[1]}/${match[2]}`;
  return { slug, url: `https://github.com/${slug}.git` };
}

export const PUBLIC_IMPORT_ERROR =
  "Couldn’t import this public repository. Check that it exists and is publicly accessible, then retry.";

export function publicImportError(): string {
  return PUBLIC_IMPORT_ERROR;
}

export interface PublicWorkspaceRecord {
  slug: string;
  label: string;
  source: WorkspaceRecord["source"];
  status: WorkspaceStatus | "unindexed";
  files: number;
  graphFiles: number;
  graphSymbols: number;
  graphSymbolsCapped: boolean;
  graphReady: boolean;
  addedAt: string;
  updatedAt: string;
  url?: string;
  error?: string;
  active: boolean;
}

export function publicWorkspace(
  record: WorkspaceRecord,
  details: {
    active: boolean;
    files: number;
    graphFiles: number;
    graphSymbols: number;
    serviceReady: boolean;
  },
): PublicWorkspaceRecord {
  const graphReady = details.serviceReady && details.graphFiles > 0;
  const status = record.status === "ready" && !graphReady ? "unindexed" : record.status;
  return {
    slug: record.slug,
    label: record.label,
    source: record.source,
    status,
    files: details.files,
    graphFiles: details.graphFiles,
    graphSymbols: details.graphSymbols,
    graphSymbolsCapped: details.graphSymbols >= 64,
    graphReady,
    addedAt: record.addedAt,
    updatedAt: record.updatedAt,
    ...(record.url ? { url: record.url } : {}),
    ...(record.status === "error" ? { error: publicImportError() } : {}),
    active: details.active,
  };
}

export function publicServerError(): string {
  return "Lumos couldn’t complete that request. Retry in a moment.";
}
