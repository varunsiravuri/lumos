export interface HydraConfig {
  /** Query API base, e.g. http://127.0.0.1:8443 */
  httpUrl: string;
  /** Admin base serving /readyz and /metrics, e.g. http://127.0.0.1:9090 */
  adminUrl: string;
  token: string;
  namespace: string;
  graph: string;
  cellId: string;
}

const DEFAULTS: HydraConfig = {
  httpUrl: "http://127.0.0.1:8443",
  adminUrl: "http://127.0.0.1:9090",
  token: "local-development-token-32-bytes",
  namespace: "default",
  graph: "default",
  cellId: "cell-0",
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HydraConfig {
  return {
    httpUrl: env.HYDRA_HTTP_URL ?? DEFAULTS.httpUrl,
    adminUrl: env.HYDRA_ADMIN_URL ?? DEFAULTS.adminUrl,
    token: env.HYDRA_AUTH_TOKEN ?? DEFAULTS.token,
    namespace: env.HYDRA_NAMESPACE ?? DEFAULTS.namespace,
    graph: env.HYDRA_GRAPH ?? DEFAULTS.graph,
    cellId: env.HYDRA_CELL_ID ?? DEFAULTS.cellId,
  };
}
