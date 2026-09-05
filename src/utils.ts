import fs from "node:fs";
import path from "node:path";
import type { RedirectRule } from "./types.ts";

/** Strip `:port`, lowercase. `Host` may be missing. */
export function normalizeHost(header: string | null | undefined): string {
  if (!header) return "";
  let h = header.trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  // Bare IPv6 contains >1 colon; only strip a single host:port colon.
  if ((h.match(/:/g) ?? []).length > 1) return h;
  const idx = h.lastIndexOf(":");
  if (idx > 0) h = h.slice(0, idx);
  return h;
}

/** Exact (case-insensitive), `*.example.com` wildcard, or `~regex`. */
export function matchHost(pattern: string, host: string): boolean {
  if (!pattern || !host) return false;
  if (pattern.startsWith("~")) {
    try {
      return new RegExp(pattern.slice(1), "i").test(host);
    } catch {
      return false;
    }
  }
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return p === host;
}

/** Specificity score for competing site host patterns. Higher wins. */
export function hostSpecificity(pattern: string | undefined): number {
  if (!pattern) return -1;
  if (pattern.startsWith("~")) return 1;
  if (pattern.startsWith("*.")) return 2;
  return 3;
}

function escapeRegExpChar(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
}

/** Glob with `*` (within a segment), `**` (across segments), `?` (one char). */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      let n = 0;
      while (glob[i] === "*") {
        n++;
        i++;
      }
      re += n >= 2 ? ".*" : "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += escapeRegExpChar(c);
      i++;
    }
  }
  return new RegExp(re + "$");
}

export function isGlobPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

export { stripTrailingSlash };

export interface RoutePatternMatch {
  matched: boolean;
  /** Remainder with leading `/` (`"/"` for a bare match), or full path for glob/regex. */
  remainder: string;
  /** Length of the literal matched prefix (for longest-match ranking). */
  literalLength: number;
}

/**
 * Match a `RouteRule.match` against a pathname.
 * Plain prefixes match on segment boundaries; `/` matches everything.
 */
export function matchRoutePattern(
  pattern: string,
  pathname: string,
): RoutePatternMatch {
  if (pattern.startsWith("~")) {
    let ok = false;
    try {
      ok = new RegExp(pattern.slice(1)).test(pathname);
    } catch {
      ok = false;
    }
    return { matched: ok, remainder: pathname, literalLength: 0 };
  }
  if (isGlobPattern(pattern)) {
    let ok = false;
    try {
      ok = globToRegExp(pattern).test(pathname);
    } catch {
      ok = false;
    }
    return { matched: ok, remainder: pathname, literalLength: 0 };
  }
  if (pattern === "/") {
    return { matched: true, remainder: pathname, literalLength: 0 };
  }
  const p = stripTrailingSlash(pattern);
  if (pathname === p) return { matched: true, remainder: "/", literalLength: p.length };
  if (pathname.startsWith(p + "/")) {
    return { matched: true, remainder: pathname.slice(p.length), literalLength: p.length };
  }
  return { matched: false, remainder: pathname, literalLength: 0 };
}

/** Plain patterns match exact or subtree; globs use full glob semantics. */
export function matchDenyPattern(pattern: string, pathname: string): boolean {
  if (pattern.startsWith("~")) {
    try {
      return new RegExp(pattern.slice(1)).test(pathname);
    } catch {
      return false;
    }
  }
  if (isGlobPattern(pattern)) {
    try {
      return globToRegExp(pattern).test(pathname);
    } catch {
      return false;
    }
  }
  const p = stripTrailingSlash(pattern);
  if (p === "/") return true;
  return pathname === p || pathname.startsWith(p + "/");
}

export function matchDeny(
  patterns: string[] | undefined,
  pathname: string,
): boolean {
  if (!patterns) return false;
  return patterns.some((p) => matchDenyPattern(p, pathname));
}

export interface RedirectMatch {
  to: string;
  status: 301 | 302 | 303 | 307 | 308;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `from` may be exact or end with `/*`; a `to` ending in `/*` preserves the tail. */
export function findRedirect(
  rules: RedirectRule[] | undefined,
  pathname: string,
): RedirectMatch | null {
  if (!rules) return null;
  for (const r of rules) {
    if (!r?.from || !r?.to) continue;
    const status = (
      r.status && REDIRECT_STATUSES.has(r.status) ? r.status : 301
    ) as RedirectMatch["status"];
    if (r.from.endsWith("/*")) {
      const base = stripTrailingSlash(r.from.slice(0, -2));
      let tail: string | null = null;
      if (pathname === base) tail = "";
      else if (pathname.startsWith(base + "/")) tail = pathname.slice(base.length + 1);
      else continue;
      const to = r.to.endsWith("/*") ? r.to.slice(0, -1) + tail : r.to;
      return { to, status };
    }
    if (isGlobPattern(r.from) || r.from.startsWith("~")) {
      const m = matchDenyPattern(r.from, pathname);
      if (m) return { to: r.to, status };
      continue;
    }
    if (pathname === stripTrailingSlash(r.from)) return { to: r.to, status };
  }
  return null;
}

function withinLexical(rootAbs: string, targetAbs: string): boolean {
  const norm =
    process.platform === "win32"
      ? (s: string) => path.resolve(s).toLowerCase()
      : (s: string) => path.resolve(s);
  const rel = path.relative(norm(rootAbs), norm(targetAbs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * True when `target` is inside (or equal to) `root`.
 * Falls back to canonicalized paths so Windows 8.3 short names
 * (`ADMINI~1`), junctions and symlinks don't cause false negatives.
 */
export function isWithin(rootAbs: string, targetAbs: string): boolean {
  if (withinLexical(rootAbs, targetAbs)) return true;
  // Canonicalize (8.3 short names, junctions, symlinks). Note: plain
  // realpathSync preserves 8.3 components on Windows, so prefer native.
  const canonical = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    }
  };
  try {
    return withinLexical(canonical(rootAbs), canonical(targetAbs));
  } catch {
    return false;
  }
}

/** Decode a URL pathname; null when malformed (caller should 400). */
export function decodePathname(rawPath: string): string | null {
  if (rawPath.includes("\0")) return null;
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return null;
  }
}

/** base64url helpers for passing small JSON blobs through loopback headers. */
export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeHeaderJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Precompiled matchers. Compiled once in compileSites(); requests only test.
// ---------------------------------------------------------------------------

export type PatternKind = "plain" | "glob" | "regex";

export interface CompiledRoutePattern {
  kind: PatternKind;
  literalLength: number;
  test(pathname: string): boolean;
  /** Stripped remainder (leading `/`) for plain prefixes with strip, else full path. */
  remainder(pathname: string): string;
}

function safeRegExp(source: string, flags?: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/** Same semantics as matchRoutePattern, but the regex compiles once. */
export function compileRoutePattern(pattern: string): CompiledRoutePattern {
  if (pattern.startsWith("~")) {
    const re = safeRegExp(pattern.slice(1));
    return {
      kind: "regex",
      literalLength: 0,
      test: (p) => (re ? re.test(p) : false),
      remainder: (p) => p,
    };
  }
  if (isGlobPattern(pattern)) {
    let re: RegExp | null = null;
    try {
      re = globToRegExp(pattern);
    } catch {
      re = null;
    }
    return {
      kind: "glob",
      literalLength: 0,
      test: (p) => (re ? re.test(p) : false),
      remainder: (p) => p,
    };
  }
  if (pattern === "/") {
    return { kind: "plain", literalLength: 0, test: () => true, remainder: (p) => p };
  }
  const p = stripTrailingSlash(pattern);
  return {
    kind: "plain",
    literalLength: p.length,
    test: (pathname) => pathname === p || pathname.startsWith(p + "/"),
    remainder: (pathname) => (pathname === p ? "/" : pathname.slice(p.length)),
  };
}

/** Same semantics as matchDenyPattern, compiled once. */
export function compileDenyPatterns(patterns: string[]): (pathname: string) => boolean {
  const tests = patterns.map((pattern) => {
    if (pattern.startsWith("~")) {
      const re = safeRegExp(pattern.slice(1));
      return (p: string) => (re ? re.test(p) : false);
    }
    if (isGlobPattern(pattern)) {
      let re: RegExp | null = null;
      try {
        re = globToRegExp(pattern);
      } catch {
        re = null;
      }
      return (p: string) => (re ? re.test(p) : false);
    }
    const plain = stripTrailingSlash(pattern);
    if (plain === "/") return () => true;
    return (p: string) => p === plain || p.startsWith(plain + "/");
  });
  return (pathname) => tests.some((t) => t(pathname));
}

/** Same semantics as matchHost, compiled once. */
export function compileHostPattern(pattern: string): (host: string) => boolean {
  if (pattern.startsWith("~")) {
    const re = safeRegExp(pattern.slice(1), "i");
    return (host) => (host ? re?.test(host) === true : false);
  }
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1);
    return (host) => !!host && host.endsWith(suffix) && host.length > suffix.length;
  }
  return (host) => p === host;
}

export interface CompiledRedirect {
  match(pathname: string): string | null;
  status: 301 | 302 | 303 | 307 | 308;
}

const REDIRECT_STATUS_FALLBACK = 301 as const;

/** Same semantics as findRedirect, compiled once. */
export function compileRedirects(
  rules: Array<{ from: string; to: string; status?: number }>,
): CompiledRedirect[] {
  const out: CompiledRedirect[] = [];
  for (const r of rules) {
    if (!r?.from || !r?.to) continue;
    const status = (
      r.status && [301, 302, 303, 307, 308].includes(r.status)
        ? r.status
        : REDIRECT_STATUS_FALLBACK
    ) as CompiledRedirect["status"];
    if (r.from.endsWith("/*")) {
      const base = stripTrailingSlash(r.from.slice(0, -2));
      const to = r.to;
      const keepTail = to.endsWith("/*");
      out.push({
        status,
        match: (pathname) => {
          let tail: string | null = null;
          if (pathname === base) tail = "";
          else if (pathname.startsWith(base + "/")) tail = pathname.slice(base.length + 1);
          else return null;
          return keepTail ? to.slice(0, -1) + tail : to;
        },
      });
      continue;
    }
    if (isGlobPattern(r.from) || r.from.startsWith("~")) {
      const test = compileDenyPatterns([r.from]);
      const to = r.to;
      out.push({ status, match: (p) => (test(p) ? to : null) });
      continue;
    }
    const from = stripTrailingSlash(r.from);
    const to = r.to;
    out.push({ status, match: (p) => (p === from ? to : null) });
  }
  return out;
}
