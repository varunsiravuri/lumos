/**
 * Score a retrieval run the way the submission reports it: three columns,
 * and an honest count of the cases the graph helped or hurt.
 */

export interface EvalOutcome {
  instanceId: string;
  goldFiles: string[];
  bm25: number | null;
  graph: number | null;
  hybrid: number | null;
  candidates: number;
  retrieveMs: number;
}

export interface MethodMetrics {
  at1: number;
  at3: number;
  at5: number;
  at10: number;
  at20: number;
  mrr: number;
}

export interface EvalSummary {
  n: number;
  methods: {
    bm25: MethodMetrics;
    graph: MethodMetrics;
    hybrid: MethodMetrics;
  };
  hybridVsBm25: { improved: number; hurt: number; tie: number };
  helped: string[];
  hurt: string[];
  failureMode: string;
}

const CUTOFFS = [1, 3, 5, 10, 20] as const;

function metricsOf(ranks: (number | null)[]): MethodMetrics {
  const total = ranks.length || 1;
  const hit = (k: number) => ranks.filter((rank) => rank !== null && rank <= k).length / total;
  const mrr = ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / total;
  return {
    at1: hit(1),
    at3: hit(3),
    at5: hit(5),
    at10: hit(10),
    at20: hit(20),
    mrr,
  };
}

export function summarizeEval(outcomes: EvalOutcome[]): EvalSummary {
  const helped = outcomes
    .filter((row) => row.hybrid !== null && (row.bm25 === null || row.hybrid < row.bm25))
    .map((row) => row.instanceId);
  const hurt = outcomes
    .filter((row) => row.bm25 !== null && (row.hybrid === null || row.hybrid > row.bm25))
    .map((row) => row.instanceId);

  return {
    n: outcomes.length,
    methods: {
      bm25: metricsOf(outcomes.map((row) => row.bm25)),
      graph: metricsOf(outcomes.map((row) => row.graph)),
      hybrid: metricsOf(outcomes.map((row) => row.hybrid)),
    },
    hybridVsBm25: {
      improved: helped.length,
      hurt: hurt.length,
      tie: outcomes.length - helped.length - hurt.length,
    },
    helped,
    hurt,
    failureMode:
      "When hybrid loses, the usual cause is a bad seed (the issue never names the patched symbol), dynamic dispatch the extractor cannot resolve, or a missing test-coverage edge.",
  };
}

export { CUTOFFS };
