/**
 * BM25 over file contents: the baseline Lumos has to beat.
 *
 * This is the retriever the SWE-bench paper uses, and it is a genuinely strong
 * one. When an issue quotes the failing function by name, lexical matching
 * finds the file instantly and no amount of graph structure improves on that.
 *
 * It is kept honest on purpose. Beating a crippled baseline would prove
 * nothing, so the tokeniser splits identifiers the way a developer reads them —
 * `separability_matrix` also matches `separability` and `matrix`, and
 * `HttpResponse` also matches `http` and `response` — which is most of the gap
 * between a naive whitespace split and a real code search.
 *
 * What it cannot do is find a file the issue never mentions. That is the whole
 * argument for the graph, and it only holds if this baseline is at full strength.
 */

const K1 = 1.2;
const B = 0.75;

/** Words that appear in nearly every source file and every issue. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "while",
  "in", "on", "at", "to", "from", "of", "is", "are", "was", "were", "be", "been",
  "it", "this", "that", "these", "those", "with", "as", "by", "not", "no", "yes",
  "i", "you", "we", "they", "he", "she", "my", "our", "your", "their", "its",
  "do", "does", "did", "can", "could", "should", "would", "will", "have", "has",
  "had", "when", "what", "which", "who", "how", "why", "there", "here", "so",
  "def", "class", "return", "import", "self", "none", "true", "false", "pass",
]);

/**
 * Split text into terms, emitting both the whole identifier and its parts.
 *
 * Keeping the whole identifier matters as much as splitting it: `get_or_create`
 * as one term is a far sharper signal than `get`, `or` and `create` separately,
 * and the intact form is what lets an exact quote in an issue dominate.
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];

  for (const raw of text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    terms.push(raw);

    if (raw.includes("_")) {
      for (const part of raw.split("_")) {
        if (part.length >= 3 && !STOPWORDS.has(part)) terms.push(part);
      }
    }
  }

  // CamelCase is lost by the lowercase pass above, so it is split separately
  // against the original text.
  for (const raw of text.match(/[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+/g) ?? []) {
    for (const part of raw.match(/[A-Z][a-z0-9]*/g) ?? []) {
      const lower = part.toLowerCase();
      if (lower.length >= 3 && !STOPWORDS.has(lower)) terms.push(lower);
    }
  }

  return terms;
}

export interface Scored {
  path: string;
  score: number;
}

export class Bm25Index {
  private readonly paths: string[] = [];
  private readonly lengths: number[] = [];
  /** term -> [document index, term frequency][] */
  private readonly postings = new Map<string, [number, number][]>();
  private averageLength = 0;

  get size(): number {
    return this.paths.length;
  }

  /**
   * The path is indexed alongside the contents, weighted up.
   *
   * A file's own name is the most concentrated description of it that exists,
   * and issues quote paths constantly, so `db/models/query.py` should answer a
   * question about queries even before its body is considered.
   */
  add(path: string, contents: string): void {
    const index = this.paths.length;
    const pathTerms = tokenize(path.replace(/[/.]/g, " "));
    const terms = [...contents ? tokenize(contents) : [], ...pathTerms, ...pathTerms, ...pathTerms];

    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);

    for (const [term, count] of frequencies) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, (posting = []));
      posting.push([index, count]);
    }

    this.paths.push(path);
    this.lengths.push(terms.length);
    this.averageLength += (terms.length - this.averageLength) / this.paths.length;
  }

  search(query: string, limit = 100): Scored[] {
    const frequencies = new Map<string, number>();
    for (const term of tokenize(query)) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }

    const total = this.paths.length;
    const scores = new Float64Array(total);

    for (const [term, queryCount] of frequencies) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const idf = Math.log(1 + (total - posting.length + 0.5) / (posting.length + 0.5));
      // A term repeated in the query is saturated the same way as in a
      // document, so a word said ten times cannot swamp the rest of the issue.
      const queryWeight = (queryCount * (K1 + 1)) / (queryCount + K1);

      for (const [document, count] of posting) {
        const normalized = 1 - B + (B * this.lengths[document]!) / this.averageLength;
        scores[document]! += idf * queryWeight * ((count * (K1 + 1)) / (count + K1 * normalized));
      }
    }

    const ranked: Scored[] = [];
    for (let index = 0; index < total; index += 1) {
      if (scores[index]! > 0) ranked.push({ path: this.paths[index]!, score: scores[index]! });
    }

    ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return ranked.slice(0, limit);
  }
}
