import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Maps the string identifiers Lumos works in — qualified symbol names, file
 * paths, commit hashes — onto the non-negative integers HydraDB uses as node
 * identity.
 *
 * Ids are sequential and never reused, which keeps them dense. Density matters
 * because HydraDB compiles adjacency into sparse index generations, and a dense
 * id space keeps those compact.
 *
 * The mapping is persisted so that re-ingesting a repository, or ingesting a
 * second one that shares symbols, resolves to the same ids as the first run.
 * Ingestion is therefore idempotent: `MERGE` by a stable id updates in place
 * instead of duplicating the graph.
 */
export class IdRegistry {
  readonly #db: DatabaseSync;
  readonly #insert: ReturnType<DatabaseSync["prepare"]>;
  readonly #select: ReturnType<DatabaseSync["prepare"]>;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    // AUTOINCREMENT guarantees ids are monotonic and never recycled, so an id
    // that reached HydraDB can never later mean a different entity.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS ids (
        id  INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE
      )
    `);

    this.#insert = this.#db.prepare("INSERT OR IGNORE INTO ids(key) VALUES(?)");
    this.#select = this.#db.prepare("SELECT id FROM ids WHERE key = ?");
  }

  /** Assign ids to any keys not seen before and return the id for every key. */
  allocate(keys: Iterable<string>): Map<string, number> {
    const unique = [...new Set(keys)];
    const resolved = new Map<string, number>();
    if (unique.length === 0) return resolved;

    this.#db.exec("BEGIN");
    try {
      for (const key of unique) this.#insert.run(key);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    for (const key of unique) {
      const row = this.#select.get(key) as { id: number } | undefined;
      if (row === undefined) throw new Error(`id allocation lost key ${JSON.stringify(key)}`);
      resolved.set(key, row.id);
    }

    return resolved;
  }

  /** Resolve one key, or undefined if it was never allocated. */
  lookup(key: string): number | undefined {
    const row = this.#select.get(key) as { id: number } | undefined;
    return row?.id;
  }

  count(): number {
    const row = this.#db.prepare("SELECT count(*) AS n FROM ids").get() as { n: number };
    return row.n;
  }

  close(): void {
    this.#db.close();
  }
}
