// Service subprocess runner. Launched per entry file as:
//   bun runner.ts <absolute-entry-path> <loopback-port>
// Loads the entry's default `init(ctx)` export, then serves loopback HTTP
// for the main process to proxy to. Per-request metadata (subPath, site,
// config, ...) arrives via `x-lightserver-*` headers because one process
// serves many requests with different routes.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRouter } from "./router.ts";
import type { ServiceContext } from "./service-types.ts";
import { parseSpec } from "./transport.ts";
import { decodeHeaderJson } from "./utils.ts";

const entryArg = Bun.argv[2];
const specArg = Bun.argv[3];
if (!entryArg || !specArg) {
  console.error("runner usage: runner.ts <entry> <unix:/path|tcp:port>");
  process.exit(2);
}
let endpoint;
try {
  endpoint = parseSpec(specArg);
} catch {
  console.error(`runner: bad listen spec: ${specArg}`);
  process.exit(2);
}
const entryPath = path.resolve(entryArg);

function svcLog(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  try {
    process.stderr.write(
      JSON.stringify({ t: new Date().toISOString(), level, msg, service: entryPath, ...fields }) + "\n",
    );
  } catch {
    // never crash on logging
  }
}

function initialConfig(): Record<string, any> {
  const raw = process.env.LIGHTSERVER_CONFIG_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, any>;
  } catch {
    return {};
  }
}

type Handler = (req: Request, ctx: ServiceContext) => Response | Promise<Response>;

let onRequestHandler: Handler | null = null;
const unloaders: Array<() => void | Promise<void>> = [];
const aborter = new AbortController();
let shuttingDown = false;

const ctx: ServiceContext = {
  config: initialConfig(),
  env: { ...(process.env as Record<string, string>) },
  log: {
    info: (m, f) => svcLog("info", m, f ?? {}),
    warn: (m, f) => svcLog("warn", m, f ?? {}),
    error: (m, f) => svcLog("error", m, f ?? {}),
    debug: (m, f) => svcLog("debug", m, f ?? {}),
  },
  signal: aborter.signal,
  subPath: "",
  params: {},
  pathname: "",
  site: process.env.LIGHTSERVER_SITE ?? "",
  routeFile: entryPath,
  onRequest(h: Handler) {
    if (onRequestHandler) svcLog("warn", "onRequest registered twice; last wins");
    onRequestHandler = h;
  },
  onUnload(cb: () => void | Promise<void>) {
    unloaders.push(cb);
  },
  util: {
    // Bound to the shared ctx object so use() sees per-request subPath.
    createRouter: () => createRouter(ctx),
  },
};

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  aborter.abort();
  for (const fn of unloaders) {
    try {
      await fn();
    } catch (e) {
      svcLog("error", "onUnload failed", { error: String((e as Error)?.stack ?? e) });
    }
  }
  try {
    server?.stop(true);
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

let server: ReturnType<typeof Bun.serve> | null = null;

try {
  const mod = await import(pathToFileURL(entryPath).href);
  const init = mod?.default;
  if (typeof init !== "function") {
    throw new Error("entry file must have a default export function init(ctx)");
  }
  await init(ctx);
} catch (e) {
  // Main process watches stdout for this marker.
  console.log(`__LIGHTSERVER_FAILED__ ${String((e as Error)?.stack ?? e)}`);
  process.exit(1);
}

function normalizeSub(raw: string): string {
  if (!raw) return "";
  return raw.startsWith("/") ? raw : "/" + raw;
}

try {
  server = Bun.serve(
    endpoint.kind === "unix"
      ? {
          unix: endpoint.socketPath,
          fetch: invoke,
        }
      : { hostname: "127.0.0.1", port: endpoint.port!, fetch: invoke },
  );
} catch (e) {
  // Pool watches for UNSUPPORTED and falls back to another transport.
  console.log(`__LIGHTSERVER_FAILED__ UNSUPPORTED:${String((e as Error)?.message ?? e)}`);
  process.exit(1);
}

async function invoke(req: Request): Promise<Response> {
  const u = new URL(req.url);
  if (u.pathname === "/__lightserver_health__") return new Response("ok");
  if (!onRequestHandler) return new Response("no handler", { status: 404 });

  const h = req.headers;
  ctx.subPath = normalizeSub(h.get("x-lightserver-sub-path") ?? "");
  ctx.site = h.get("x-lightserver-site") ?? ctx.site;
  ctx.pathname = h.get("x-lightserver-pathname") ?? u.pathname;
  ctx.routeFile = h.get("x-lightserver-route-file") ?? entryPath;
  const cfg = decodeHeaderJson<Record<string, any> | null>(
    h.get("x-lightserver-config"),
    null,
  );
  if (cfg !== null) ctx.config = cfg;
  ctx.params = decodeHeaderJson<Record<string, string>>(
    h.get("x-lightserver-params"),
    {},
  );

  // Rebuild the original client URL so `new URL(req.url)` in handlers
  // sees the public host/path instead of the loopback address.
  // Bodies stream straight through (no buffering).
  let handlerReq = req;
  const origHost = h.get("x-forwarded-host");
  if (origHost) {
    const proto = h.get("x-forwarded-proto") ?? "http";
    const headers = new Headers(h);
    headers.set("host", origHost);
    handlerReq = new Request(`${proto}://${origHost}${u.pathname}${u.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
  }

  try {
    const resp = await onRequestHandler(handlerReq, ctx);
    if (!(resp instanceof Response)) {
      svcLog("error", "handler must return a Response");
      return new Response("bad handler", { status: 500 });
    }
    return resp;
  } catch (e) {
    svcLog("error", "handler threw", { error: String((e as Error)?.stack ?? e) });
    return new Response("internal error", { status: 500 });
  }
}

console.log(`__LIGHTSERVER_READY__ ${specArg}`);
