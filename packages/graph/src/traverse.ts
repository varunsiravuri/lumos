import type { HydraClient } from "./client.ts";
import { isGraphPath, type GraphPath } from "./values.ts";

export interface ClosureOptions {
  /** Label of the nodes named in `values`. */
  label: string;
  /** Indexed property used to resolve `values` to node ids. */
  property: string;
  values: (string | number)[];
  relTypes: string[];
  /** `incoming` walks edges backwards, which is what reverse-dependency closure needs. */
  direction: "incoming" | "outgoing" | "both";
  maxLen: number;
  pathCount?: number;
  resultLimit?: number;
}

/**
 * Traverse outward from a set of seed nodes and return whole paths.
 *
 * This exists because variable-length MATCH requires a fixed source id, so
 * `MATCH (s:Package)-[:DEPENDS_ON*1..5]->(t {id: $x})` is rejected outright.
 * The path procedures are the only way to express a closure that ends at a
 * known node, by seeding at the target and walking `incoming` instead.
 */
export async function closure(client: HydraClient, options: ClosureOptions): Promise<GraphPath[]> {
  const {
    label,
    property,
    values,
    relTypes,
    direction,
    maxLen,
    pathCount = 1000,
    resultLimit = 10_000,
  } = options;

  if (values.length === 0) return [];

  const config = [
    `sourceLabel: ${JSON.stringify(label)}`,
    `sourceProperty: ${JSON.stringify(property)}`,
    `sourceValues: ${JSON.stringify(values)}`,
    `relTypes: ${JSON.stringify(relTypes)}`,
    `relDirection: ${JSON.stringify(direction)}`,
    `maxLen: ${maxLen}`,
    `pathCount: ${pathCount}`,
    `resultLimit: ${resultLimit}`,
  ].join(", ");

  // pathCount defaults low: without it the procedure returns a single path and
  // the closure looks far smaller than it is.
  const result = await client.query(
    `CALL algo.MSpaths({${config}}) YIELD path RETURN path`,
  );

  return result.rows
    .map((row) => row.path)
    .filter((value) => value !== undefined && isGraphPath(value)) as GraphPath[];
}

export interface ReachedNode {
  id: number;
  labels: string[];
  properties: Record<string, string | number | boolean | null>;
  /** Fewest hops from a seed node across all returned paths. */
  depth: number;
}

/** Flatten paths into the distinct set of reached nodes, keeping the shortest depth. */
export function reachedNodes(paths: GraphPath[]): ReachedNode[] {
  const byId = new Map<number, ReachedNode>();

  for (const path of paths) {
    path.nodes.forEach((node, index) => {
      const existing = byId.get(node.id);
      if (existing) {
        existing.depth = Math.min(existing.depth, index);
        return;
      }
      byId.set(node.id, {
        id: node.id,
        labels: node.labels,
        properties: node.properties,
        depth: index,
      });
    });
  }

  return [...byId.values()].sort((a, b) => a.depth - b.depth || a.id - b.id);
}
