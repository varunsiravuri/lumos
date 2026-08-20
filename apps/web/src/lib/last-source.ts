const KEY = "lumos-last-source";

export interface LastSource {
  repo: string;
  label: string;
}

export function readLastSource(): LastSource | null {
  try {
    const raw = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastSource;
    if (!parsed.repo) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLastSource(source: LastSource): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(source));
  } catch {
    // Private mode can block storage.
  }
}
