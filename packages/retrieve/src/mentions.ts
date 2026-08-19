/**
 * Pull the code a bug report is talking about out of the prose it is buried in.
 *
 * An issue is not a search query. It is a paragraph of frustration wrapped
 * around two or three load-bearing tokens: a traceback frame, a class name in
 * backticks, the one function the reporter thinks is at fault. Those tokens are
 * the only part worth matching exactly, and they are worth very different
 * amounts depending on where they appear.
 *
 * A path in a traceback is nearly always right. A CamelCase word in a sentence
 * is a guess. Recording that difference here is what lets the ranker trust the
 * strong evidence and merely nudge on the weak, instead of drowning in a bag of
 * words where `Model` counts as much as `separability_matrix`.
 */

/** Where a mention was found, ordered by how much the location vouches for it. */
export type MentionSource =
  /** A frame in a Python traceback. The reporter ran this code. */
  | "traceback"
  /** A repository-relative path written out in the text. */
  | "path"
  /** Inside a fenced code block or an indented block. */
  | "code"
  /** Inside single backticks. */
  | "quoted"
  /** Bare in a sentence. */
  | "prose";

export const SOURCE_WEIGHT: Record<MentionSource, number> = {
  traceback: 1.0,
  path: 1.0,
  code: 0.6,
  quoted: 0.5,
  prose: 0.25,
};

export interface Mention {
  text: string;
  kind: "path" | "symbol";
  source: MentionSource;
  /** How many times the text occurs anywhere in the issue. */
  occurrences: number;
  /** `SOURCE_WEIGHT` of the strongest source, with a small bonus for repetition. */
  weight: number;
}

/**
 * Identifiers so common that matching them selects a random slice of the
 * repository. These are not stopwords in the English sense — they are perfectly
 * good code — but as retrieval seeds they carry no signal.
 */
const NOISE = new Set([
  "self", "cls", "args", "kwargs", "value", "values", "data", "result", "results",
  "name", "names", "key", "keys", "item", "items", "obj", "object", "objects",
  "type", "types", "test", "tests", "error", "errors", "exception", "true", "false",
  "none", "class", "def", "return", "import", "from", "print", "len", "str", "int",
  "list", "dict", "set", "tuple", "bool", "float", "get", "set_", "run", "main",
  "init", "new", "add", "remove", "update", "delete", "create", "make", "build",
  "python", "django", "traceback", "file", "line", "module", "code", "output",
  "expected", "actual", "example", "issue", "bug", "version", "problem", "should",
  "inner", "outer", "wrapper", "decorator", "callback", "helper", "tmp", "temp",
]);

const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const BACKTICK = /`([^`\n]{2,120})`/g;
const INDENTED = /^(?: {4}|\t)\S.*$/gm;

/** `File "/x/y/z.py", line 42, in handler` — path and frame name in one shape. */
const TRACEBACK_FRAME = /File "([^"]+\.py)", line \d+(?:, in ([A-Za-z_]\w*))?/g;

/** A dotted path ending in `.py`, with an optional leading directory chain. */
const PY_PATH = /(?:^|[\s"'`(\[<])((?:[\w.-]+\/)*[\w.-]+\.py)\b/g;

/** `a.b.c` or `a.b()` — the dotted chains that name real code. */
const DOTTED = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\b/g;

/** `some_function`, `SomeClass`. Single lowercase words are excluded as noise. */
const SNAKE = /\b([a-z_][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const CAMEL = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g;
/** `FILE_UPLOAD_PERMISSIONS` — settings and constants the issue names in prose. */
const CONSTANT = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

/**
 * Single-token names that are real Django types and also appear in every other
 * issue. Seeding them from prose walks the hub. Quoted or traceback uses stay.
 */
const HUB_TAILS = new Set([
  "Model", "Manager", "QuerySet", "Field", "Form", "View", "Widget", "User",
  "Client", "Request", "Response", "Error", "Exception", "Object", "Mixin",
  "Admin", "App", "Config", "Settings", "Handler", "Storage", "Query", "Node",
  "Token", "Parser", "Engine", "Library", "Router", "Signal",
]);

function isNoise(text: string): boolean {
  return NOISE.has(text.toLowerCase()) || text.length < 3;
}

/**
 * Split `module.Class.method` into the pieces worth looking up.
 *
 * The whole chain is the best candidate when it exists in the graph, but the
 * tail is what usually matches: reporters write `models.Model.save` where the
 * graph knows `django.db.models.base.Model.save`.
 */
function dottedParts(chain: string): string[] {
  const parts = chain.split(".");
  const tail = parts[parts.length - 1]!;
  const pair = parts.length >= 2 ? parts.slice(-2).join(".") : "";
  return [chain, pair, tail].filter((part) => part.length > 0);
}

class Collector {
  private readonly best = new Map<string, { kind: Mention["kind"]; source: MentionSource }>();

  add(text: string, kind: Mention["kind"], source: MentionSource): void {
    const cleaned = text.trim().replace(/^[.'"(\[]+|[.'":,)\]]+$/g, "");
    if (!cleaned) return;
    if (kind === "symbol" && isNoise(cleaned)) return;

    const key = `${kind}\u0000${cleaned}`;
    const existing = this.best.get(key);
    if (!existing || SOURCE_WEIGHT[source] > SOURCE_WEIGHT[existing.source]) {
      this.best.set(key, { kind, source });
    }
  }

  finish(text: string): Mention[] {
    const mentions: Mention[] = [];

    for (const [key, { kind, source }] of this.best) {
      const value = key.slice(key.indexOf("\u0000") + 1);
      const occurrences = countOccurrences(text, value);
      // Repetition is mild corroboration, not proof: a name said five times is
      // worth more than one said once, but not five times more.
      const repetition = 1 + Math.min(0.5, Math.log2(occurrences) * 0.15);
      mentions.push({
        text: value,
        kind,
        source,
        occurrences,
        weight: SOURCE_WEIGHT[source] * repetition,
      });
    }

    return mentions.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function scan(regex: RegExp, text: string, onMatch: (match: RegExpExecArray) => void): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) onMatch(match);
}

export function extractMentions(issue: string): Mention[] {
  const collector = new Collector();

  // Tracebacks first: they are the strongest evidence and they are structured,
  // so reading them before anything else generalises them out of the text.
  scan(TRACEBACK_FRAME, issue, ([, path, frame]) => {
    if (path) collector.add(path, "path", "traceback");
    if (frame) collector.add(frame, "symbol", "traceback");
  });

  scan(PY_PATH, issue, ([, path]) => {
    if (path) collector.add(path, "path", "path");
  });

  const regions: [string, MentionSource][] = [];
  scan(FENCE, issue, ([block]) => regions.push([block, "code"]));
  scan(INDENTED, issue, ([block]) => regions.push([block, "code"]));
  scan(BACKTICK, issue, ([, inner]) => {
    if (!inner) return;
    regions.push([inner, "quoted"]);
    // A reporter who put a token in backticks named the code. `join` is not
    // snake_case and would otherwise be dropped as a lowercase English word.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) && inner.length >= 4 && !isNoise(inner)) {
      collector.add(inner, "symbol", "quoted");
    }
  });
  regions.push([issue, "prose"]);

  for (const [region, source] of regions) {
    scan(DOTTED, region, ([, chain]) => {
      if (!chain || chain.endsWith(".py")) return;
      for (const part of dottedParts(chain)) collector.add(part, "symbol", source);
    });
    scan(SNAKE, region, ([, word]) => word && collector.add(word, "symbol", source));
    scan(CAMEL, region, ([, word]) => word && collector.add(word, "symbol", source));
    scan(CONSTANT, region, ([, word]) => word && collector.add(word, "symbol", source));
  }

  return collector.finish(issue);
}

/**
 * Prose is allowed when the token is distinctive. `set_cookie` in a sentence
 * is a seed. `Model` in a sentence is a hub and is not.
 */
export function isSeedableMention(mention: Mention): boolean {
  if (mention.source !== "prose") return true;
  if (mention.kind === "path") return true;
  if (mention.text.includes("_") || mention.text.includes(".")) return true;
  if (HUB_TAILS.has(mention.text)) return false;
  return /[A-Z]/.test(mention.text.slice(1));
}

/** The highest-weighted mentions, which is all a seeded traversal should use. */
export function topMentions(mentions: Mention[], limit: number): Mention[] {
  return mentions.slice(0, limit);
}
