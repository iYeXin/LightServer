import fs from "node:fs";
import path from "node:path";
import { isWithin } from "./utils.ts";

export type Marker = "main" | "module" | null;

const MARKER_RE = /@lightserver(?::main)?/;
const HEAD_BYTES = 4096;

/** Tiny LRU with per-entry TTL. ttlMs <= 0 disables (get always misses). */
export class LruTtlCache<V> {
  private map = new Map<string, { exp: number; value: V }>();
  constructor(private opts: { ttlMs: number; max: number }) {}

  get(key: string): V | undefined {
    if (this.opts.ttlMs <= 0) return undefined;
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    if (this.opts.ttlMs <= 0 || this.opts.max <= 0) return;
    if (!this.map.has(key) && this.map.size >= this.opts.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.delete(key);
    this.map.set(key, { exp: Date.now() + this.opts.ttlMs, value });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export type MarkerCache = LruTtlCache<Marker>;

/** Read the file head (first ~4KB) and detect the LightServer marker. */
export async function detectMarker(absPath: string, cache?: MarkerCache): Promise<Marker> {
  const hit = cache?.get(absPath);
  if (hit !== undefined) return hit;
  const marker = await readMarker(absPath);
  cache?.set(absPath, marker);
  return marker;
}

async function readMarker(absPath: string): Promise<Marker> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(absPath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    if (head.includes("@lightserver:main")) return "main";
    if (MARKER_RE.test(head)) return "module";
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const SERVICE_EXTS = new Set([".ts", ".mts", ".cts", ".tsx"]);
const SCRIPT_EXTS = new Set([".js", ".mjs", ".jsx"]);

export function isServiceExt(ext: string): boolean {
  return SERVICE_EXTS.has(ext.toLowerCase());
}

export function isScriptExt(ext: string): boolean {
  return SCRIPT_EXTS.has(ext.toLowerCase());
}

export type ExactResolution =
  | { kind: "static"; file: string }
  | { kind: "service"; file: string; subPath: ""; params: Record<string, string> }
  | { kind: "forbidden" }
  | { kind: "miss" };

async function existsFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function existsDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function isStaticExt(ext: string, whitelist: Set<string>): boolean {
  return whitelist.has(ext.toLowerCase());
}

async function classifyFile(
  absPath: string,
  ext: string,
  staticSet: Set<string>,
  markers?: MarkerCache,
): Promise<ExactResolution> {
  const lower = ext.toLowerCase();
  if (isServiceExt(lower)) {
    const marker = await detectMarker(absPath, markers);
    if (marker === "main") {
      return { kind: "service", file: absPath, subPath: "", params: {} };
    }
    // Module files must never leak; unmarked .ts is not a static type -> miss.
    return marker === "module" ? { kind: "forbidden" } : { kind: "miss" };
  }
  if (isScriptExt(lower)) {
    const marker = await detectMarker(absPath, markers);
    if (marker === "module" || marker === "main") return { kind: "forbidden" };
    if (isStaticExt(lower, staticSet)) return { kind: "static", file: absPath };
    return { kind: "miss" };
  }
  if (isStaticExt(lower, staticSet)) return { kind: "static", file: absPath };
  return { kind: "miss" };
}

/**
 * Exact file routing inside `rootAbs` for a decoded pathname.
 * Returns `forbidden` on traversal/symlink escape or module access,
 * `miss` when nothing matches (caller may try dynamic routing).
 */
export async function resolveExact(
  rootAbs: string,
  pathname: string,
  staticSet: Set<string>,
  markers?: MarkerCache,
): Promise<ExactResolution> {
  const rel = pathname.replace(/^\/+/, "");
  const abs = path.resolve(rootAbs, rel);
  if (!isWithin(rootAbs, abs)) return { kind: "forbidden" };

  try {
    const st = await fs.promises.stat(abs);
    if (st.isDirectory()) {
      const indexHtml = path.join(abs, "index.html");
      if (await existsFile(indexHtml)) return { kind: "static", file: indexHtml };
      const indexTs = path.join(abs, "index.ts");
      if (await existsFile(indexTs)) {
        const marker = await detectMarker(indexTs, markers);
        if (marker === "main") {
          return { kind: "service", file: indexTs, subPath: "", params: {} };
        }
        if (marker === "module") return { kind: "forbidden" };
      }
      return { kind: "miss" };
    }
    if (st.isFile()) {
      const real = await fs.promises.realpath(abs).catch(() => abs);
      if (!isWithin(rootAbs, real)) return { kind: "forbidden" };
      return classifyFile(real, path.extname(abs), staticSet, markers);
    }
    return { kind: "miss" };
  } catch {
    // missing -> try extension probing below
  }

  // Extension probing for extensionless URLs: `/hello` -> `hello.ts`, `hello.html`.
  if (path.extname(abs) === "") {
    const tsCandidate = abs + ".ts";
    if (await existsFile(tsCandidate)) {
      const r = await classifyFile(tsCandidate, ".ts", staticSet, markers);
      if (r.kind === "service" || r.kind === "forbidden") return r;
    }
    for (const ext of [".html", ".htm"]) {
      const c = abs + ext;
      if (await existsFile(c)) return { kind: "static", file: c };
    }
  }
  return { kind: "miss" };
}

export interface DynamicResolution {
  file: string;
  /** Remainder with leading `/`; `"/"` when the prefix itself was requested. */
  subPath: string;
  params: Record<string, string>;
}

export interface RouteCaches {
  route: LruTtlCache<RouteVerdict>;
  markers: MarkerCache;
}

export type RouteVerdict =
  | { kind: "static"; file: string }
  | { kind: "service"; file: string; subPath: string; params: Record<string, string> }
  | { kind: "forbidden" }
  | { kind: "miss" };

/**
 * Exact + dynamic resolution with a shared verdict cache. Cached entries may
 * lag the filesystem by up to the cache TTL (new files 404, edited markers
 * stale). Entry-file *content* edits still hot-replace via the pool's mtime
 * check, which runs outside this cache.
 */
export async function resolveRoute(
  rootAbs: string,
  lookupPath: string,
  staticSet: Set<string>,
  dyn: { enabled: boolean; maxDepth: number },
  caches?: RouteCaches,
): Promise<RouteVerdict> {
  const key = caches ? `${rootAbs}\n${lookupPath}` : "";
  const hit = caches?.route.get(key);
  if (hit) return hit;

  let verdict: RouteVerdict;
  const exact = await resolveExact(rootAbs, lookupPath, staticSet, caches?.markers);
  if (exact.kind === "service") {
    verdict = { kind: "service", file: exact.file, subPath: "", params: {} };
  } else if (exact.kind === "forbidden") {
    verdict = { kind: "forbidden" };
  } else {
    let v: RouteVerdict | null = null;
    if (exact.kind === "static") {
      v = { kind: "static", file: exact.file };
    } else if (dyn.enabled) {
      const d = await resolveDynamic(rootAbs, lookupPath, dyn.maxDepth, caches?.markers);
      if (d) v = { kind: "service", file: d.file, subPath: d.subPath, params: d.params };
    }
    verdict = v ?? { kind: "miss" };
  }

  caches?.route.set(key, verdict);
  return verdict;
}

/**
 * `(prefix).ts` fallback: the parenthesized name is a *literal* path segment.
 * `api/(user).ts` serves `/api/user` and `/api/user/*` with the remainder as
 * `subPath`. Deepest (longest-prefix) match wins; at most `maxDepth` levels
 * are walked upward.
 */
export async function resolveDynamic(
  rootAbs: string,
  pathname: string,
  maxDepth: number,
  markers?: MarkerCache,
): Promise<DynamicResolution | null> {
  const rel = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const segs = rel === "" ? [] : rel.split("/");
  if (segs.length === 0) return null;

  const start = Math.max(0, segs.length - maxDepth);
  // Walk from deepest to shallowest so the longest prefix wins.
  for (let i = segs.length - 1; i >= start; i--) {
    const dirSegs = segs.slice(0, i);
    const next = segs[i];
    if (!next || next === "." || next === "..") continue;
    // Parenthesis names map 1:1 to a literal segment; skip hostile names.
    if (next.includes("/") || next.includes("\\") || next.length > 128) continue;
    const candidate = path.resolve(rootAbs, ...dirSegs, `(${next}).ts`);
    if (!isWithin(rootAbs, candidate)) continue;
    if (!(await existsFile(candidate))) continue;
    const marker = await detectMarker(candidate, markers);
    if (marker !== "main") continue;
    const tail = segs.slice(i + 1);
    return {
      file: candidate,
      // "/" means the prefix itself was requested; "" is reserved for non-dynamic matches.
      subPath: tail.length > 0 ? "/" + tail.join("/") : "/",
      params: { prefix: next },
    };
  }
  return null;
}
