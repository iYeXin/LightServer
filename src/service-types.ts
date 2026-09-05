// Public types for service authors (`import type { ServiceContext } from "lightserver"`).
// This module must stay free of Node/Bun imports so it can be used for typing only.

export type RequestHandler = (
  req: Request,
  ctx: ServiceContext,
) => Response | Promise<Response>;

export type UnloadCallback = () => void | Promise<void>;

export interface ServiceLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

export interface Router {
  get(pattern: string, handler: RouteHandler): Router;
  post(pattern: string, handler: RouteHandler): Router;
  put(pattern: string, handler: RouteHandler): Router;
  delete(pattern: string, handler: RouteHandler): Router;
  patch(pattern: string, handler: RouteHandler): Router;
  options(pattern: string, handler: RouteHandler): Router;
  head(pattern: string, handler: RouteHandler): Router;
  all(pattern: string, handler: RouteHandler): Router;
  use(req: Request): Promise<Response>;
}

export interface ServiceContext {
  /** Register the (single) request handler. Last call wins. */
  onRequest(handler: RequestHandler): void;
  /** Register cleanup callbacks, run in order on graceful shutdown. */
  onUnload(cb: UnloadCallback): void;
  /** Per-site `serviceOptions`. Refreshed per request from the matched site. */
  config: Record<string, any>;
  /** Process environment snapshot taken at process start. */
  env: Record<string, string>;
  log: ServiceLog;
  /** Aborted on graceful shutdown (SIGTERM/SIGINT to the service process). */
  signal: AbortSignal;
  /**
   * Remainder after a `(prefix).ts` match, always with a leading `/`
   * (`"/"` when the prefix itself was requested, `""` when this request
   * is not a dynamic match). The runner mutates this object per request,
   * so closures and the 2nd handler arg stay fresh.
   */
  subPath: string;
  /** Route params. For dynamic matches at least `{ prefix }`. */
  params: Record<string, string>;
  /** Full original request pathname (e.g. `/api/user/123`). */
  pathname: string;
  /** Matched site name. */
  site: string;
  /** Absolute path of the entry file serving this request. */
  routeFile: string;
  util: {
    createRouter(): Router;
  };
}
