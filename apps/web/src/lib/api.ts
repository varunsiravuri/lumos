const API = process.env.NEXT_PUBLIC_LUMOS_API ?? "/api";

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${API}${suffix}`;
}

/** Parse an API response as JSON, with a clear message when nginx returns HTML (e.g. 429). */
export async function readApiJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("API returned invalid JSON");
    }
  }

  if (response.status === 429 || /429 Too Many Requests/i.test(text)) {
    throw new Error("Too many requests. Wait a moment and try again.");
  }

  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 80);
  throw new Error(
    response.status
      ? `API error (${response.status})${snippet ? `: ${snippet}` : ""}`
      : "API returned a non-JSON response",
  );
}
