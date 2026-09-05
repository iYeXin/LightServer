import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.ts";
import { log } from "./logger.ts";
import {
  createEndpoint,
  createSocketPath,
  fetchLoopback,
  specString,
  wantsUnixSocket,
  type LoopbackEndpoint,
  type LoopbackKind,
} from "./transport.ts";
import { encodeHeaderJson } from "./utils.ts";

const RUNNER_PATH = fileURLToPath(new URL("./runner.ts", import.meta.url));
const READY_PREFIX = "__LIGHTSERVER_READY__";
const FAILED_PREFIX = "__LIGHTSERVER_FAILED__";
const MARKER_PREFIX = "__LIGHTSERVER_";
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_CONFIG_HEADER_BYTES = 8000;

export class PoolError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ProxyMeta {
  site: string;
  pathname: string;
  search: string;
  subPath: string;
  params: Record<string, string>;
  config: Record<string, any>;
  requestId: string;
  forwardedHost: string;
  forwardedProto: string;
}

interface PooledEntry {
  key: string;
  proc: ReturnType<typeof Bun.spawn>;
  endpoint: LoopbackEndpoint;
  mtimeMs: number;
  lastUsed: number;
  active: number;
  site: string;
  exited: boolean;
  exitCode: number | null;
}

export interface PoolOptions {
  maxProcesses: number;
  idleTimeoutSec: number;
  drainTimeoutSec: number;
  requestTimeoutSec: number;
  initTimeoutSec?: number;
  mainPort: number;
  logger: Logger;
  /** Soft per-site cap; undefined means no site cap. */
  siteMaxProcesses?: (site: string) => number | undefined;
  onEvent?: (type: "start" | "stale" | "evict" | "crash" | "idle", key: string) => void;
}

function pickPort(exclude: number): number {
  let port = 0;
  for (let i = 0; i < 50; i++) {
    port = 20000 + Math.floor(Math.random() * 40000);
    if (port !== exclude) return port;
  }
  return port === exclude ? exclude + 1 : port;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function cleanupSocket(ep: LoopbackEndpoint): Promise<void> {
  if (ep.kind !== "unix" || !ep.socketPath) return;
  await fs.promises.unlink(ep.socketPath).catch(() => {});
}

export class ProcessPool {
  private entries = new Map<string, PooledEntry>();
  private draining = new Set<PooledEntry>();
  /** Cold-start dedup: concurrent requests for one entry share a single spawn. */
  private inflight = new Map<string, Promise<PooledEntry>>();
  /** serviceOptions are per-site objects; encode once until config reload swaps them. */
  private encodedConfig = new WeakMap<object, string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private initTimeoutSec: number;
  private opts: PoolOptions;

  constructor(opts: PoolOptions) {
    this.opts = opts;
    this.initTimeoutSec = opts.initTimeoutSec ?? 15;
    const intervalMs = Math.max(5000, Math.min(opts.idleTimeoutSec, 30) * 1000);
    this.sweeper = setInterval(() => void this.sweepIdle(), intervalMs);
    (this.sweeper as unknown as { unref?: () => void }).unref?.();
  }

  size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  private async statMtime(key: string): Promise<number> {
    try {
      return (await fs.promises.stat(key)).mtimeMs;
    } catch {
      return -1;
    }
  }

  /** Ensure a fresh process for `key`; concurrent callers share one spawn. */
  getOrStart(key: string, meta: ProxyMeta): Promise<PooledEntry> {
    const hit = this.inflight.get(key);
    if (hit) return hit;
    const p = this.ensure(key, meta).finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async ensure(key: string, meta: ProxyMeta): Promise<PooledEntry> {
    const mtimeMs = await this.statMtime(key);
    if (mtimeMs < 0) throw new PoolError(404, `entry not found: ${key}`);
    const cur = this.entries.get(key);
    if (cur) {
      if (cur.exited) {
        this.entries.delete(key);
        this.opts.logger.warn("service process had exited; restarting", { service: key });
        this.opts.onEvent?.("crash", key);
      } else if (cur.mtimeMs !== mtimeMs) {
        this.entries.delete(key);
        this.opts.logger.info("entry file changed; replacing process", { service: key });
        this.opts.onEvent?.("stale", key);
        void this.drain(cur, "stale");
      } else {
        cur.lastUsed = Date.now();
        return cur;
      }
    }
    this.enforceCaps(meta.site);
    const entry = await this.spawn(key, mtimeMs, meta);
    this.entries.set(key, entry);
    return entry;
  }

  /** Proactive restart for dev-mode file watching (no-op when unknown/stale). */
  async refresh(key: string): Promise<void> {
    const cur = this.entries.get(key);
    if (!cur || cur.exited) return;
    const mtimeMs = await this.statMtime(key);
    if (mtimeMs < 0 || mtimeMs === cur.mtimeMs) return;
    this.entries.delete(key);
    void this.drain(cur, "stale");
    this.opts.onEvent?.("stale", key);
  }

  private enforceCaps(site: string): void {
    const siteCap = this.opts.siteMaxProcesses?.(site);
    if (siteCap !== undefined) {
      const ofSite = [...this.entries.values()].filter((e) => e.site === site);
      if (ofSite.length >= siteCap) {
        ofSite.sort((a, b) => a.lastUsed - b.lastUsed);
        const victim = ofSite.find((e) => e.active === 0) ?? ofSite[0];
        if (victim && this.entries.get(victim.key) === victim) {
          this.entries.delete(victim.key);
          this.opts.onEvent?.("evict", victim.key);
          void this.drain(victim, "site-cap");
        }
      }
    }
    let overflow = this.entries.size - this.opts.maxProcesses;
    while (overflow > 0) {
      const all = [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed);
      const victim = all.find((e) => e.active === 0) ?? all[0];
      if (!victim) break;
      if (this.entries.get(victim.key) !== victim) break;
      this.entries.delete(victim.key);
      this.opts.onEvent?.("evict", victim.key);
      void this.drain(victim, "lru");
      overflow--;
    }
  }

  private encodeConfig(cfg: Record<string, any>): string {
    let s = this.encodedConfig.get(cfg);
    if (s === undefined) {
      s = encodeHeaderJson(cfg);
      this.encodedConfig.set(cfg, s);
    }
    return s;
  }

  private async spawn(key: string, mtimeMs: number, meta: ProxyMeta): Promise<PooledEntry> {
    const bunBin = process.execPath;
    const kinds: LoopbackKind[] = wantsUnixSocket() ? ["unix", "tcp"] : ["tcp"];
    let lastError = "";
    for (const kind of kinds) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const endpoint =
          kind === "unix"
            ? createEndpoint("unix", undefined, createSocketPath())
            : createEndpoint("tcp", pickPort(this.opts.mainPort));
        if (kind === "unix" && endpoint.socketPath) {
          await fs.promises.unlink(endpoint.socketPath).catch(() => {});
        }
        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn([bunBin, RUNNER_PATH, key, specString(endpoint)], {
            stdout: "pipe",
            stderr: "inherit",
            env: {
              ...process.env,
              LIGHTSERVER_SITE: meta.site,
              LIGHTSERVER_CONFIG_JSON: JSON.stringify(meta.config ?? {}),
            } as Record<string, string>,
          });
        } catch (e) {
          await cleanupSocket(endpoint);
          throw new PoolError(502, `failed to spawn service: ${String(e)}`);
        }
        const entry: PooledEntry = {
          key, proc, endpoint, mtimeMs,
          lastUsed: Date.now(), active: 0,
          site: meta.site, exited: false, exitCode: null,
        };
        void proc.exited.then((code) => {
          entry.exited = true;
          entry.exitCode = code;
        });
        const ready = await this.waitForReady(entry);
        if (!ready.ok) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          await cleanupSocket(endpoint);
          if (ready.unsupported && kind === "unix") break; // fall through to tcp
          lastError = ready.error;
          if (ready.fatal || !/already in use|EADDRINUSE/i.test(ready.error)) {
            throw new PoolError(502, `service failed to start: ${lastError || key}`);
          }
          continue; // tcp port clash -> retry
        }
        if (!(await this.checkHealth(entry))) {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
          await cleanupSocket(endpoint);
          lastError = `${kind} transport health check failed`;
          if (kind === "unix") break; // fall through to tcp
          throw new PoolError(502, `service failed to start: ${lastError}`);
        }
        this.opts.logger.info("service process started", {
          service: key,
          transport: kind === "unix" ? `unix:${endpoint.socketPath}` : `tcp:${endpoint.port}`,
        });
        this.opts.onEvent?.("start", key);
        return entry;
      }
    }
    throw new PoolError(502, `service failed to start: ${lastError || key}`);
  }

  /** Validates the full client path (fetch over this transport) before serving. */
  private async checkHealth(entry: PooledEntry): Promise<boolean> {
    try {
      const res = await fetchLoopback(entry.endpoint, "/__lightserver_health__", {
        signal: AbortSignal.timeout(5000),
      });
      await res.arrayBuffer().catch(() => {});
      return res.status === 200;
    } catch {
      return false;
    }
  }

  private waitForReady(
    entry: PooledEntry,
  ): Promise<{ ok: boolean; error: string; unsupported?: boolean; fatal?: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: "init timeout", fatal: true });
        }
      }, this.initTimeoutSec * 1000);
      (timer as unknown as { unref?: () => void }).unref?.();

      const onLine = (line: string) => {
        if (line.startsWith(MARKER_PREFIX)) {
          if (settled) return;
          if (line.startsWith(READY_PREFIX)) {
            settled = true;
            clearTimeout(timer);
            resolve({ ok: true, error: "" });
          } else if (line.startsWith(FAILED_PREFIX)) {
            settled = true;
            clearTimeout(timer);
            const msg = line.slice(FAILED_PREFIX.length).trim();
            resolve({
              ok: false,
              error: msg,
              unsupported: msg.startsWith("UNSUPPORTED:"),
              fatal: !msg.startsWith("UNSUPPORTED:") && !/already in use|EADDRINUSE/i.test(msg),
            });
          }
          return;
        }
        this.emitServiceLog(entry.key, line);
      };
      void this.pumpStdout(entry, onLine).catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: "process exited during init", fatal: true });
        }
      });
      void entry.proc.exited.then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: "process exited during init", fatal: true });
        }
      });
    });
  }

  /** Child stdout lines go to the log file, never to our stdout. */
  private emitServiceLog(key: string, line: string): void {
    if (!line) return;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj && typeof obj === "object" && typeof obj.msg === "string") {
        const { t: _t, level, msg, ...rest } = obj;
        void _t;
        const lv = level === "debug" || level === "info" || level === "warn" || level === "error"
          ? level
          : "info";
        log(lv, msg, { service: key, ...rest });
        return;
      }
    } catch {
      // plain text below
    }
    log("info", line, { service: key, stream: "stdout" });
  }

  private async pumpStdout(
    entry: PooledEntry,
    onLine: (line: string) => void,
  ): Promise<void> {
    const stream = entry.proc.stdout;
    if (!stream || typeof (stream as ReadableStream).getReader !== "function") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf("\n");
        while (idx >= 0) {
          onLine(buf.slice(0, idx).trimEnd());
          buf = buf.slice(idx + 1);
          idx = buf.indexOf("\n");
        }
      }
      if (buf.trim() !== "") onLine(buf.trimEnd());
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  async proxy(entry: PooledEntry, req: Request, meta: ProxyMeta): Promise<Response> {
    const headers = new Headers();
    req.headers.forEach((v, k) => {
      const name = k.toLowerCase();
      if (
        name === "connection" || name === "keep-alive" ||
        name === "transfer-encoding" || name === "upgrade" ||
        name === "proxy-authenticate" || name === "proxy-authorization" ||
        name === "te" || name === "trailer"
      ) {
        return;
      }
      if (name === "host") return; // loopback target sets its own
      try {
        headers.append(k, v);
      } catch {
        // skip unloadable headers
      }
    });
    headers.set("x-lightserver-site", meta.site);
    headers.set("x-lightserver-pathname", meta.pathname);
    headers.set("x-lightserver-sub-path", meta.subPath);
    headers.set("x-lightserver-route-file", entry.key);
    headers.set("x-lightserver-params", encodeHeaderJson(meta.params));
    const encodedConfig = this.encodeConfig(meta.config);
    headers.set("x-lightserver-config", encodedConfig);
    headers.set("x-lightserver-request-id", meta.requestId);
    if (meta.forwardedHost) {
      headers.set("x-forwarded-host", meta.forwardedHost);
      headers.set("x-forwarded-proto", meta.forwardedProto);
    }

    // Bodies stream straight through. The size cap can only be enforced
    // up-front when the client sent a content-length; length-less streams
    // are passed to the service as-is.
    let body: ReadableStream<Uint8Array> | null | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const declared = req.headers.get("content-length");
      if (declared !== null && declared !== "") {
        const n = Number(declared);
        if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
          throw new PoolError(413, "request body too large");
        }
      }
      body = req.body;
    }
    if (encodedConfig.length > MAX_CONFIG_HEADER_BYTES) {
      throw new PoolError(500, "serviceOptions too large for proxy headers (~8KB cap)");
    }

    entry.active++;
    entry.lastUsed = Date.now();
    try {
      const timeout = AbortSignal.timeout(this.opts.requestTimeoutSec * 1000);
      return await fetchLoopback(entry.endpoint, `${meta.pathname}${meta.search}`, {
        method: req.method,
        headers,
        body: body ?? undefined,
        signal: timeout,
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new PoolError(504, "service timed out");
      }
      // Connection failure: the process is dead; drop it so next request restarts.
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      try {
        entry.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      this.opts.logger.warn("service connection failed", { service: entry.key });
      this.opts.onEvent?.("crash", entry.key);
      throw new PoolError(502, "service unavailable");
    } finally {
      entry.active--;
      entry.lastUsed = Date.now();
    }
  }

  private sweepIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.active === 0 && now - entry.lastUsed > this.opts.idleTimeoutSec * 1000) {
        this.entries.delete(entry.key);
        this.opts.onEvent?.("idle", entry.key);
        void this.drain(entry, "idle");
      }
    }
  }

  private async drain(entry: PooledEntry, _reason: string): Promise<void> {
    this.draining.add(entry);
    try {
      entry.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    const timeoutMs = this.opts.drainTimeoutSec * 1000;
    await Promise.race([entry.proc.exited, sleep(timeoutMs)]);
    if (!entry.exited) {
      try {
        entry.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await entry.proc.exited.catch(() => {});
    }
    await cleanupSocket(entry.endpoint);
    this.draining.delete(entry);
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const all = [...this.entries.values(), ...this.draining];
    this.entries.clear();
    await Promise.all(all.map((e) => this.drain(e, "shutdown")));
  }
}

export { MAX_BODY_BYTES };
