import fs from "node:fs";
import path from "node:path";
import type { LoadedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import {
  closeLogger,
  createLogger,
  flushLogs,
  getLogLevel,
  log,
  newRequestId,
  reconfigureLogging,
} from "./logger.ts";
import { lookupMime } from "./mime.ts";
import { PoolError, ProcessPool } from "./pool.ts";
import { LruTtlCache, resolveRoute, type MarkerCache, type RouteCaches, type RouteVerdict } from "./routes.ts";
import { wantsUnixSocket } from "./transport.ts";
import type { LogLevel } from "./logger.ts";
import type {
  CliOverrides,
  ResolvedConfig,
  RouteRule,
} from "./types.ts";
import {
  compileDenyPatterns,
  compileHostPattern,
  compileRedirects,
  compileRoutePattern,
  decodePathname,
  hostSpecificity,
  isWithin,
  normalizeHost,
  type CompiledRedirect,
  type CompiledRoutePattern,
} from "./utils.ts";

interface CompiledRoute {
  match: string;
  matcher: CompiledRoutePattern;
  rootAbs: string;
  stripPrefix: boolean;
  literalLength: number;
  order: number;
}

interface CompiledSite {
  name: string;
  hostPattern?: string;
  hostTest: ((host: string) => boolean) | null;
  rootAbs: string;
  routes: CompiledRoute[];
  redirects: CompiledRedirect[];
  denyTest: (pathname: string) => boolean;
  serviceOptions: Record<string, any>;
  maxProcesses?: number;
}

export interface StartOptions {
  cwd: string;
  isDev: boolean;
  explicitConfig?: string;
  cli: CliOverrides;
  fallbackLogLevel: LogLevel;
  initial: LoadedConfig;
}

function defaultRoot(cwd: string): string {
  const pub = path.join(cwd, "public");
  try {
    if (fs.statSync(pub).isDirectory()) return pub;
  } catch {
    // fall through
  }
  return cwd;
}

function compileSites(config: ResolvedConfig, cwd: string): Map<string, CompiledSite> {
  const out = new Map<string, CompiledSite>();
  const names = Object.keys(config.sites);
  if (names.length === 0) {
    const root = defaultRoot(cwd);
    if (root === cwd) {
      log("warn", "no sites configured and ./public missing; serving cwd as default root", { root });
    }
    out.set(config.defaultSite, {
      name: config.defaultSite,
      hostTest: null,
      rootAbs: root,
      routes: [],
      redirects: [],
      denyTest: () => false,
      serviceOptions: {},
    });
    return out;
  }
  for (const name of names) {
    const s = config.sites[name];
    const rootAbs = path.resolve(cwd, s.root ?? defaultRoot(cwd));
    const routes: CompiledRoute[] = (s.routes ?? []).map((r: RouteRule, i: number) => {
      const matcher = compileRoutePattern(r.match);
      return {
        match: r.match,
        matcher,
        rootAbs: path.resolve(cwd, r.root),
        stripPrefix: r.stripPrefix ?? true,
        literalLength: matcher.literalLength,
        order: i,
      };
    });
    out.set(name, {
      name,
      hostPattern: s.host,
      hostTest: s.host ? compileHostPattern(s.host) : null,
      rootAbs,
      routes,
      redirects: compileRedirects(s.redirects ?? []),
      denyTest: compileDenyPatterns(s.deny ?? []),
      serviceOptions: s.serviceOptions ?? {},
      maxProcesses: s.maxProcesses,
    });
  }
  return out;
}

function matchSite(sites: Map<string, CompiledSite>, host: string, defaultSite: string): CompiledSite {
  let best: CompiledSite | null = null;
  let bestScore = -1;
  for (const site of sites.values()) {
    if (!site.hostTest || !site.hostPattern) continue;
    if (!site.hostTest(host)) continue;
    const score = hostSpecificity(site.hostPattern);
    if (score > bestScore) {
      bestScore = score;
      best = site;
    }
  }
  if (best) return best;
  return sites.get(defaultSite) ?? [...sites.values()][0];
}

function pickRoute(site: CompiledSite, pathname: string): CompiledRoute | null {
  let best: CompiledRoute | null = null;
  for (const r of site.routes) {
    if (!r.matcher.test(pathname)) continue;
    if (
      !best || r.literalLength > best.literalLength ||
      (r.literalLength === best.literalLength && r.order < best.order)
    ) {
      best = r;
    }
  }
  return best;
}

function findRedirectTo(
  site: CompiledSite,
  pathname: string,
): { to: string; status: 301 | 302 | 303 | 307 | 308 } | null {
  for (const r of site.redirects) {
    const to = r.match(pathname);
    if (to !== null) return { to, status: r.status };
  }
  return null;
}

function mapToFs(
  site: CompiledSite,
  rule: CompiledRoute | null,
  pathname: string,
): { rootAbs: string; lookupPath: string } {
  if (!rule) return { rootAbs: site.rootAbs, lookupPath: pathname };
  const special = rule.matcher.kind !== "plain";
  if (!special && rule.match !== "/" && rule.stripPrefix) {
    return { rootAbs: rule.rootAbs, lookupPath: rule.matcher.remainder(pathname) };
  }
  return { rootAbs: rule.rootAbs, lookupPath: pathname };
}

function statusLevel(status: number): "debug" | "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export interface ServerHandle {
  stop(): Promise<void>;
  getConfig(): ResolvedConfig;
}

export async function startServer(opts: StartOptions): Promise<ServerHandle> {
  const { cwd, isDev } = opts;
  let config = opts.initial.config;
  let configFiles = opts.initial.files;
  let sites = compileSites(config, cwd);
  const staticSet = new Set<string>();
  const syncStaticSet = () => {
    staticSet.clear();
    for (const e of config.staticExtensions) staticSet.add(e.toLowerCase());
  };
  syncStaticSet();

  // File-route verdict cache (start mode only; dev bypasses for freshness).
  // Recreated (hence invalidated) on every config reload.
  let caches: RouteCaches | undefined;
  const syncCaches = () => {
    if (isDev || config.routeCacheTtl <= 0 || config.routeCacheSize <= 0) {
      caches = undefined;
      return;
    }
    caches = {
      route: new LruTtlCache<RouteVerdict>({
        ttlMs: config.routeCacheTtl * 1000,
        max: Math.floor(config.routeCacheSize),
      }),
      markers: new LruTtlCache({ ttlMs: config.routeCacheTtl * 1000, max: 4000 }),
    };
  };
  syncCaches();

  const poolLogger = createLogger({ scope: "pool" });
  const poolOpts = {
    maxProcesses: config.maxProcesses,
    idleTimeoutSec: config.idleTimeout,
    drainTimeoutSec: config.drainTimeout,
    requestTimeoutSec: config.requestTimeout,
    mainPort: config.port,
    logger: poolLogger,
    siteMaxProcesses: (site: string) => sites.get(site)?.maxProcesses,
    onEvent: isDev
      ? (type: string, key: string) => {
        log("debug", `pool event: ${type}`, { service: key });
        if (type === "start") watchEntry(key);
        else pruneEntryWatchers();
      }
      : undefined,
  };
  const pool = new ProcessPool(poolOpts);

  // ---- dev-mode file watching ----
  const entryWatchers = new Map<string, fs.FSWatcher>();
  const configWatchers: fs.FSWatcher[] = [];
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function debounced(key: string, fn: () => void, ms = 250): void {
    const prev = debounce.get(key);
    if (prev) clearTimeout(prev);
    debounce.set(key, setTimeout(() => {
      debounce.delete(key);
      fn();
    }, ms));
  }

  function watchEntry(key: string): void {
    if (!isDev || entryWatchers.has(key)) return;
    try {
      const w = fs.watch(key, () => {
        debounced(`entry:${key}`, () => {
          log("debug", "entry file changed; refreshing", { service: key });
          void pool.refresh(key).catch((e) => log("warn", "refresh failed", { error: String(e) }));
        });
      });
      entryWatchers.set(key, w);
    } catch {
      // file may vanish; lazy mtime check still covers it
    }
  }

  function pruneEntryWatchers(): void {
    const live = new Set(pool.keys());
    for (const [key, w] of entryWatchers) {
      if (!live.has(key)) {
        try {
          w.close();
        } catch {
          // ignore
        }
        entryWatchers.delete(key);
      }
    }
  }

  async function reloadConfig(reason: string): Promise<void> {
    try {
      const loaded = await resolveConfig({
        cwd,
        explicit: opts.explicitConfig,
        cli: opts.cli,
        fallbackLogLevel: opts.fallbackLogLevel,
      });
      const portChanged = loaded.config.port !== config.port;
      const hostChanged = loaded.config.host !== config.host;
      config = loaded.config;
      configFiles = loaded.files;
      sites = compileSites(config, cwd);
      syncStaticSet();
      syncCaches();
      await reconfigureLogging({
        level: config.logLevel,
        file: config.logFile,
        maxBytes: config.logMaxBytes,
        maxFiles: config.logMaxFiles,
        flushIntervalMs: config.logFlushIntervalMs,
      });
      poolOpts.maxProcesses = config.maxProcesses;
      poolOpts.idleTimeoutSec = config.idleTimeout;
      poolOpts.drainTimeoutSec = config.drainTimeout;
      poolOpts.requestTimeoutSec = config.requestTimeout;
      poolOpts.mainPort = config.port;
      log("info", `config reloaded (${reason})`, { files: configFiles });
      if (portChanged || hostChanged) {
        log("warn", "port/host changed; restart lightserver to apply", {
          port: config.port,
          host: config.host,
        });
      }
    } catch (e) {
      log("error", "config reload failed; keeping previous config", { error: String(e) });
    }
  }

  function watchConfigs(): void {
    if (!isDev) return;
    for (const file of new Set(configFiles)) {
      try {
        const w = fs.watch(file, () => {
          debounced(`config:${file}`, () => void reloadConfig(file));
        });
        configWatchers.push(w);
      } catch {
        // ignore unwatched files
      }
    }
  }

  watchConfigs();

  async function serveStatic(file: string, req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    // Always stat here: the verdict cache stores paths only, so a replaced
    // file can never be served with a stale content-length.
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
      if (!st.isFile()) return new Response("not found", { status: 404 });
    } catch {
      return new Response("not found", { status: 404 });
    }
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers: Record<string, string> = {
      "content-type": lookupMime(path.extname(file)),
      "content-length": String(st.size),
      etag,
      "last-modified": st.mtime.toUTCString(),
      "cache-control": "public, max-age=0, must-revalidate",
    };
    const inm = req.headers.get("if-none-match");
    if (inm === etag) return new Response(null, { status: 304, headers });
    if (req.method === "HEAD") return new Response(null, { headers });
    return new Response(Bun.file(file), { headers });
  }

  async function handle(req: Request): Promise<Response> {
    const reqId = newRequestId();
    const t0 = Date.now();
    let status = 500;
    let siteName = "";
    let routeLabel = "";
    try {
      const url = new URL(req.url);
      const host = normalizeHost(req.headers.get("host"));
      const site = matchSite(sites, host, config.defaultSite);
      siteName = site.name;

      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        status = 501;
        return new Response("websocket not supported", { status });
      }

      const pathname = decodePathname(url.pathname);
      if (pathname === null || !pathname.startsWith("/")) {
        status = 400;
        return new Response("bad request", { status });
      }

      if (site.denyTest(pathname)) {
        status = 403;
        return new Response("forbidden", { status });
      }

      const redirect = findRedirectTo(site, pathname);
      if (redirect) {
        let to = redirect.to;
        if (url.search && !to.includes("?") && !/^https?:\/\//i.test(to)) to += url.search;
        status = redirect.status;
        return new Response(null, { status, headers: { location: to } });
      }

      if (config.preProcess) {
        let r: unknown;
        try {
          r = await config.preProcess(req, { site: site.name, pathname, reqId });
        } catch (e) {
          log("error", "preProcess threw", { reqId, error: String(e) });
          status = 500;
          return new Response("internal error", { status });
        }
        if (r instanceof Response) {
          status = r.status;
          return r;
        }
        if (r instanceof Request) req = r;
      }

      const rule = pickRoute(site, pathname);
      const { rootAbs, lookupPath } = mapToFs(site, rule, pathname);
      routeLabel = rule ? `${rule.match} -> ${rule.rootAbs}` : site.rootAbs;

      const verdict = await resolveRoute(rootAbs, lookupPath, staticSet, config.dynamicRouting, caches);
      if (verdict.kind === "static") {
        const resp = await serveStatic(verdict.file, req);
        status = resp.status;
        return resp;
      }
      if (verdict.kind === "forbidden") {
        status = 403;
        return new Response("forbidden", { status });
      }
      if (verdict.kind === "service") {
        const meta = {
          site: site.name,
          pathname,
          search: url.search,
          subPath: verdict.subPath,
          params: verdict.params,
          config: site.serviceOptions,
          requestId: reqId,
          forwardedHost: req.headers.get("host") ?? "",
          forwardedProto: req.headers.get("x-forwarded-proto") ?? "http",
        };
        try {
          const entry = await pool.getOrStart(verdict.file, meta);
          if (isDev) watchEntry(verdict.file);
          const resp = await pool.proxy(entry, req, meta);
          status = resp.status;
          resp.headers.set("x-request-id", reqId);
          return resp;
        } catch (e) {
          status = e instanceof PoolError ? e.status : 502;
          log("warn", "service proxy failed", {
            reqId,
            service: verdict.file,
            status,
            error: e instanceof Error ? e.message : String(e),
          });
          return new Response(status === 504 ? "gateway timeout" : "bad gateway", { status });
        }
      }
      status = 404;
      return new Response("not found", { status });
    } catch (e) {
      log("error", "request failed", { reqId, error: String(e) });
      status = 500;
      return new Response("internal error", { status });
    } finally {
      const durMs = Date.now() - t0;
      let method = "";
      try {
        method = req.method;
      } catch {
        method = "?";
      }
      log(statusLevel(status), "request", {
        reqId,
        site: siteName,
        method,
        status,
        durMs,
        route: routeLabel || undefined,
        dev: isDev || undefined,
      });
    }
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: handle,
  });

  log("info", `lightserver listening (${isDev ? "dev" : "start"})`, {
    host: config.host,
    port: config.port,
    loopback: wantsUnixSocket() ? "unix-socket" : "tcp-loopback",
    logFile: config.logFile,
    sites: [...sites.values()].map((s) => ({
      name: s.name,
      host: s.hostPattern ?? "(default)",
      root: s.rootAbs,
      routes: s.routes.map((r) => `${r.match} -> ${r.rootAbs}`),
    })),
    logLevel: getLogLevel(),
  });

  const onSignal = () => {
    if (stopped) return;
    stopped = true;
    log("info", "shutting down");
    try {
      server.stop(true);
    } catch {
      // ignore
    }
    for (const w of entryWatchers.values()) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    for (const w of configWatchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    void (async () => {
      await pool.shutdown();
      await flushLogs();
      closeLogger();
      process.exit(0);
    })();
    setTimeout(() => process.exit(0), (config.drainTimeout + 2) * 1000).unref?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    async stop() {
      onSignal();
    },
    getConfig: () => config,
  };
}

export function isWithinRoot(rootAbs: string, targetAbs: string): boolean {
  return isWithin(rootAbs, targetAbs);
}
