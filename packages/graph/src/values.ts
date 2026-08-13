/**
 * Decoding for HydraDB's wire values.
 *
 * The query API returns each cell as a tagged object, `{"type":"string","value":"react"}`,
 * while properties nested inside a path use a differently tagged form,
 * `{"name":{"String":"react"}}`. Both shapes are normalised here so the rest of
 * Lumos only ever sees plain JavaScript values.
 */

export type Scalar = string | number | boolean | null;

export interface GraphNode {
  id: number;
  labels: string[];
  properties: Record<string, Scalar>;
}

export interface GraphRelationship {
  /** Engine-assigned relationship id, distinct from the `id` property we set. */
  id: number;
  type: string;
  src: number;
  dst: number;
  properties: Record<string, Scalar>;
}

export interface GraphPath {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export type GraphValue = Scalar | GraphPath;

interface RawCell {
  type: string;
  value: unknown;
}

/** Property maps inside a path are tagged by Rust type name: {"Integer": 9001}. */
function decodeProperties(raw: unknown): Record<string, Scalar> {
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, Scalar> = {};
  for (const [key, tagged] of Object.entries(raw as Record<string, unknown>)) {
    if (tagged === null || typeof tagged !== "object") {
      out[key] = tagged as Scalar;
      continue;
    }
    const entries = Object.values(tagged as Record<string, unknown>);
    out[key] = (entries.length === 1 ? entries[0] : null) as Scalar;
  }
  return out;
}

function decodeNode(raw: unknown): GraphNode {
  const node = raw as { id: number; labels?: string[]; properties?: unknown };
  return {
    id: node.id,
    labels: node.labels ?? [],
    properties: decodeProperties(node.properties),
  };
}

function decodeRelationship(raw: unknown): GraphRelationship {
  const rel = raw as {
    id: number;
    edge_type: string;
    src: number;
    dst: number;
    properties?: unknown;
  };
  return {
    id: rel.id,
    type: rel.edge_type,
    src: rel.src,
    dst: rel.dst,
    properties: decodeProperties(rel.properties),
  };
}

export function decodeCell(cell: unknown): GraphValue {
  if (cell === null || typeof cell !== "object") return cell as Scalar;
  const { type, value } = cell as RawCell;

  if (type === "path") {
    const path = value as { nodes?: unknown[]; relationships?: unknown[] };
    return {
      nodes: (path.nodes ?? []).map(decodeNode),
      relationships: (path.relationships ?? []).map(decodeRelationship),
    };
  }

  // vertex_id, string, integer, float, boolean and null all carry a plain scalar.
  return value as Scalar;
}

export function isGraphPath(value: GraphValue): value is GraphPath {
  return typeof value === "object" && value !== null && "nodes" in value;
}
