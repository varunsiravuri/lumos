import { configFromEnv, type HydraConfig } from "./config.ts";
import { decodeCell, type GraphValue } from "./values.ts";

export type Consistency = "causal" | "strong";

export interface QueryOptions {
  parameters?: Record<string, unknown>;
  consistency?: Consistency;
  signal?: AbortSignal;
}

export interface QueryResult {
  queryId: string;
  columns: string[];
  rows: Record<string, GraphValue>[];
  bookmark: string | null;
  readEpoch: number | null;
}

export class HydraQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly query: string,
  ) {
    super(message);
    this.name = "HydraQueryError";
  }
}

/**
 * Cypher identifiers are interpolated into query text, so they are validated
 * rather than escaped. Every label, relationship type and property name in
 * Lumos is code-defined, so anything failing this is a bug, not user input.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value: string, kind: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`invalid ${kind} ${JSON.stringify(value)}: expected /${IDENTIFIER.source}/`);
  }
  return value;
}

export interface NodeRow {
  /** Node identity. HydraDB node ids are non-negative integers. */
  vertex: number;
  [property: string]: string | number | boolean;
}

export interface EdgeRow {
  src: number;
  dst: number;
  /** Relationship identity. Batch CREATE requires an explicit `id: row.<field>`. */
  rel: number;
  [property: string]: string | number | boolean;
}

export class HydraClient {
  readonly config: HydraConfig;

  constructor(config: Partial<HydraConfig> = {}) {
    this.config = { ...configFromEnv(), ...config };
  }

  async query(cypher: string, options: QueryOptions = {}): Promise<QueryResult> {
    const { httpUrl, graph, namespace, cellId, token } = this.config;

    const body: Record<string, unknown> = { cell_id: cellId, query: cypher };
    // The HTTP API names this field `parameters`; `params` is silently ignored
    // and the query then fails with "missing OpenCypher query parameter".
    if (options.parameters) body.parameters = options.parameters;
    if (options.consistency) body.consistency = options.consistency;

    const response = await fetch(`${httpUrl}/v1/graphs/${graph}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Graph-Namespace": namespace,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const text = await response.text();

    if (!response.ok) {
      let code = "http_error";
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // Non-JSON bodies (such as a 422 deserialisation failure) pass through as-is.
      }
      throw new HydraQueryError(code, message, response.status, cypher);
    }

    const payload = JSON.parse(text) as {
      query_id: string;
      columns: string[];
      rows: unknown[][];
      bookmark: string | null;
      read_epoch: number | null;
    };

    const columns = payload.columns ?? [];
    const rows = (payload.rows ?? []).map((cells) => {
      const row: Record<string, GraphValue> = {};
      columns.forEach((column, index) => {
        row[column] = decodeCell(cells[index]);
      });
      return row;
    });

    return {
      queryId: payload.query_id,
      columns,
      rows,
      bookmark: payload.bookmark,
      readEpoch: payload.read_epoch,
    };
  }

  /** Run one UNWIND statement per chunk. Returns the number of rows submitted. */
  async batch(cypher: string, rows: object[], chunkSize = 1000): Promise<number> {
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      await this.query(cypher, { parameters: { rows: chunk } });
    }
    return rows.length;
  }

  /**
   * Upsert nodes by id and apply a label plus properties.
   *
   * A vertex upsert must be MERGE-by-id followed by SET; folding properties into
   * the MERGE pattern is rejected, because the pattern is the identity being
   * matched on. Every row must carry the same property keys.
   */
  async upsertNodes(label: string, rows: NodeRow[], chunkSize = 1000): Promise<number> {
    if (rows.length === 0) return 0;
    assertIdentifier(label, "label");

    const properties = Object.keys(rows[0]!).filter((key) => key !== "vertex");
    const assignments = properties
      .map((key) => `n.${assertIdentifier(key, "property")} = row.${key}`)
      .join(", ");

    const setClause = assignments ? `SET n:${label}, ${assignments}` : `SET n:${label}`;
    return this.batch(`UNWIND $rows AS row MERGE (n {id: row.vertex}) ${setClause}`, rows, chunkSize);
  }

  /**
   * Create typed relationships between nodes that already exist.
   *
   * Batch CREATE requires the relationship to carry `id: row.<field>`, and the
   * endpoints must already be present: UNWIND MATCH ... CREATE will silently
   * write nothing for rows whose endpoints do not match.
   */
  async createEdges(
    type: string,
    srcLabel: string,
    dstLabel: string,
    rows: EdgeRow[],
    chunkSize = 1000,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    assertIdentifier(type, "relationship type");
    assertIdentifier(srcLabel, "label");
    assertIdentifier(dstLabel, "label");

    const properties = Object.keys(rows[0]!).filter(
      (key) => key !== "src" && key !== "dst" && key !== "rel",
    );
    const inline = ["id: row.rel", ...properties.map((key) => `${assertIdentifier(key, "property")}: row.${key}`)].join(", ");

    return this.batch(
      `UNWIND $rows AS row ` +
        `MATCH (s:${srcLabel} {id: row.src}), (d:${dstLabel} {id: row.dst}) ` +
        `CREATE (s)-[:${type} {${inline}}]->(d)`,
      rows,
      chunkSize,
    );
  }

  /**
   * Idempotent counterpart to {@link createEdges}: MERGE on the relationship id
   * and apply properties with a following SET.
   *
   * Re-running ingestion has to update rather than duplicate, and MERGE that
   * changes nothing still commits, so a retry costs the same as the first write.
   */
  async mergeEdges(
    type: string,
    srcLabel: string,
    dstLabel: string,
    rows: EdgeRow[],
    chunkSize = 1000,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    assertIdentifier(type, "relationship type");
    assertIdentifier(srcLabel, "label");
    assertIdentifier(dstLabel, "label");

    const properties = Object.keys(rows[0]!).filter(
      (key) => key !== "src" && key !== "dst" && key !== "rel",
    );
    const setClause = properties.length
      ? ` SET ${properties.map((key) => `r.${assertIdentifier(key, "property")} = row.${key}`).join(", ")}`
      : "";

    return this.batch(
      `UNWIND $rows AS row ` +
        `MATCH (s:${srcLabel} {id: row.src}), (d:${dstLabel} {id: row.dst}) ` +
        `MERGE (s)-[r:${type} {id: row.rel}]->(d)${setClause}`,
      rows,
      chunkSize,
    );
  }

  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.adminUrl}/readyz`, signal ? { signal } : {});
      return response.ok;
    } catch {
      return false;
    }
  }
}
