import type { ServiceContext } from "./service-types.ts";

export type { ServiceContext };
export type { RequestHandler, Router, RouteHandler } from "./service-types.ts";

export interface DynamicRoutingConfig {
  enabled?: boolean;
  maxDepth?: number;
}

export interface RouteRule {
  /**
   * Plain prefix (`/api`), glob (`/static/**`, `/dl/*.zip`) or regex (`~^/api/v\d+/`).
   * Plain `/` matches everything. Plain prefixes match on segment boundaries.
   */
  match: string;
  /** Directory for this rule (relative paths resolve against the process cwd). */
  root: string;
  /**
   * Strip the matched plain prefix before mapping to the filesystem.
   * Default true for plain prefixes; ignored (treated as false) for glob/regex.
   */
  stripPrefix?: boolean;
}

export interface RedirectRule {
  /** Exact path (`/old`) or prefix glob (`/old/*`). */
  from: string;
  /** Target path/URL. A trailing `/*` preserves the matched tail. */
  to: string;
  status?: 301 | 302 | 303 | 307 | 308;
}

export interface SiteConfig {
  /** Exact (`example.com`), wildcard (`*.example.com`) or regex (`~^api\d?\.`). */
  host?: string;
  /** Site root dir (required; relative paths resolve against the process cwd). */
  root: string;
  /** Path-based routing inside this site. Longest match wins. */
  routes?: RouteRule[];
  /**
   * Soft per-site process cap inside the shared global pool.
   * The global `maxProcesses` is always the hard cap.
   */
  maxProcesses?: number;
  redirects?: RedirectRule[];
  /** Glob deny list (e.g. `/private/**`). Matched requests get 403. */
  deny?: string[];
  /** Passed to services as `ctx.config` (per request, JSON, ~8KB header cap). */
  serviceOptions?: Record<string, any>;
}

export interface PreProcessInfo {
  site: string;
  pathname: string;
  reqId: string;
}

export type PreProcessResult = Response | Request | void | undefined | null;

export type PreProcessFn = (
  req: Request,
  info: PreProcessInfo,
) => PreProcessResult | Promise<PreProcessResult>;

export interface LightServerConfig {
  port?: number;
  host?: string;
  /** Global shared process-pool hard cap. */
  maxProcesses?: number;
  /** Seconds a pooled process may sit idle before reaping. */
  idleTimeout?: number;
  /** Seconds to wait for active requests while draining before SIGKILL. */
  drainTimeout?: number;
  /** Seconds before a proxied service request times out (504). */
  requestTimeout?: number;
  /** File-route verdict cache TTL in seconds (0 disables). Default 60. */
  routeCacheTtl?: number;
  /** Max cached route verdicts. Default 2000. */
  routeCacheSize?: number;
  /** Log file path (default <dataDir>/lightserver.log). Relative resolves against cwd. */
  logFile?: string;
  /** Rotate when the log file exceeds this many bytes. Default 10MB. */
  logMaxBytes?: number;
  /** Keep logFile.1 .. logFile.N. Default 5; <=0 disables rotation. */
  logMaxFiles?: number;
  /** Async log flush cadence in ms. Default 1000. */
  logFlushIntervalMs?: number;
  staticExtensions?: string[];
  defaultSite?: string;
  sites?: Record<string, SiteConfig>;
  /**
   * Inline function (TS configs) or module path (JSONC, or TS referencing
   * a separate file). Paths resolve against the declaring config file's dir;
   * the module's default export must be the middleware function.
   */
  preProcess?: PreProcessFn | string;
  dynamicRouting?: DynamicRoutingConfig;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface ResolvedConfig {
  port: number;
  host: string;
  maxProcesses: number;
  idleTimeout: number;
  drainTimeout: number;
  requestTimeout: number;
  staticExtensions: string[];
  defaultSite: string;
  routeCacheTtl: number;
  routeCacheSize: number;
  logFile: string;
  logMaxBytes: number;
  logMaxFiles: number;
  logFlushIntervalMs: number;
  sites: Record<string, SiteConfig>;
  preProcess?: PreProcessFn;
  dynamicRouting: { enabled: boolean; maxDepth: number };
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface CliOverrides {
  port?: number;
  host?: string;
  maxProcesses?: number;
  idleTimeout?: number;
  drainTimeout?: number;
  requestTimeout?: number;
  logLevel?: ResolvedConfig["logLevel"];
  logFile?: string;
}
