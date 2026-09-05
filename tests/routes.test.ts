import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectMarker } from "../src/routes.ts";
import { LruTtlCache, resolveDynamic, resolveExact, resolveRoute } from "../src/routes.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkRoot(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-test-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

const staticSet = new Set([".html", ".css", ".js", ".mjs", ".json", ".txt"]);

describe("detectMarker", () => {
  test("main wins over module substring", async () => {
    const root = mkRoot({
      "a.ts": "// @lightserver:main\nexport default 1;\n",
      "b.ts": "// @lightserver\nexport const x = 1;\n",
      "c.ts": "export const x = 1;\n",
    });
    expect(await detectMarker(path.join(root, "a.ts"))).toBe("main");
    expect(await detectMarker(path.join(root, "b.ts"))).toBe("module");
    expect(await detectMarker(path.join(root, "c.ts"))).toBeNull();
  });
});

describe("resolveExact", () => {
  test("directory serves index.html; service by extensionless name", async () => {
    const root = mkRoot({
      "index.html": "<h1>hi</h1>",
      "api/hello.ts": "// @lightserver:main\nexport default async () => {};\n",
      "api/secret.ts": "// @lightserver\nexport const s = 1;\n",
      "api/plain.ts": "export const x = 1;\n",
      "style.css": "body{}",
    });
    expect(await resolveExact(root, "/", staticSet)).toEqual({
      kind: "static",
      file: path.join(root, "index.html"),
    });
    const svc = await resolveExact(root, "/api/hello", staticSet);
    expect(svc.kind).toBe("service");
    expect(await resolveExact(root, "/api/secret.ts", staticSet)).toEqual({ kind: "forbidden" });
    expect((await resolveExact(root, "/api/plain.ts", staticSet)).kind).toBe("miss");
    expect((await resolveExact(root, "/nope", staticSet)).kind).toBe("miss");
  });

  test("traversal escapes are forbidden", async () => {
    const root = mkRoot({ "index.html": "x" });
    expect(await resolveExact(root, "/../secret", staticSet)).toEqual({ kind: "forbidden" });
  });
});

describe("resolveDynamic", () => {
  test("(prefix).ts matches literally with subPath", async () => {
    const root = mkRoot({
      "api/(user).ts": "// @lightserver:main\nexport default async () => {};\n",
      "(api).ts": "// @lightserver:main\nexport default async () => {};\n",
    });
    const deep = await resolveDynamic(root, "/api/user/123", 5);
    expect(deep?.file).toBe(path.join(root, "api", "(user).ts"));
    expect(deep?.subPath).toBe("/123");
    expect(deep?.params).toEqual({ prefix: "user" });

    const bare = await resolveDynamic(root, "/api/user", 5);
    expect(bare?.subPath).toBe("/");

    // Deepest wins over the shallower (api).ts fallback.
    const other = await resolveDynamic(root, "/api/other", 5);
    expect(other?.file).toBe(path.join(root, "(api).ts"));
    expect(other?.subPath).toBe("/other");
  });

  test("non-main candidates are skipped; maxDepth respected", async () => {
    const root = mkRoot({
      "a/(b).ts": "// @lightserver\nexport const x = 1;\n",
      "a/b/c/(d).ts": "// @lightserver:main\nexport default async () => {};\n",
    });
    expect(await resolveDynamic(root, "/a/b", 5)).toBeNull();
    expect(await resolveDynamic(root, "/a/b/c/d/e", 1)).toBeNull();
    const hit = await resolveDynamic(root, "/a/b/c/d/e", 5);
    expect(hit?.subPath).toBe("/e");
  });
});

describe("LruTtlCache", () => {
  test("expiry and LRU eviction", async () => {
    const c = new LruTtlCache<string>({ ttlMs: 30, max: 2 });
    c.set("a", "1");
    expect(c.get("a")).toBe("1");
    await new Promise((r) => setTimeout(r, 45));
    expect(c.get("a")).toBeUndefined();
    c.set("a", "1");
    c.set("b", "2");
    expect(c.get("a")).toBe("1"); // refresh a
    c.set("c", "3"); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    expect(c.get("c")).toBe("3");
  });

  test("ttl <= 0 disables", () => {
    const c = new LruTtlCache<string>({ ttlMs: 0, max: 10 });
    c.set("a", "1");
    expect(c.get("a")).toBeUndefined();
  });
});

describe("resolveRoute", () => {
  const dyn = { enabled: true, maxDepth: 5 };
  test("verdicts cache across filesystem changes (TTL staleness)", async () => {
    const root = mkRoot({
      "api/hello.ts": "// @lightserver:main\nexport default async () => {};\n",
    });
    const caches = {
      route: new LruTtlCache<import("../src/routes.ts").RouteVerdict>({ ttlMs: 60000, max: 100 }),
      markers: new LruTtlCache<import("../src/routes.ts").Marker>({ ttlMs: 60000, max: 100 }),
    };
    const first = await resolveRoute(root, "/api/hello", staticSet, dyn, caches);
    expect(first.kind).toBe("service");
    // Replace with a module file: cached verdict still says service until TTL.
    fs.writeFileSync(path.join(root, "api", "hello.ts"), "// @lightserver\nexport const x = 1;\n");
    const second = await resolveRoute(root, "/api/hello", staticSet, dyn, caches);
    expect(second.kind).toBe("service");
    // Fresh caches see the truth.
    const fresh = await resolveRoute(root, "/api/hello", staticSet, dyn);
    expect(fresh).toEqual({ kind: "forbidden" });
  });

  test("marker cache survives deletion within TTL", async () => {
    const root = mkRoot({ "a.ts": "// @lightserver:main\n1;\n" });
    const markers = new LruTtlCache<import("../src/routes.ts").Marker>({ ttlMs: 60000, max: 100 });
    expect(await detectMarker(path.join(root, "a.ts"), markers)).toBe("main");
    fs.rmSync(path.join(root, "a.ts"));
    expect(await detectMarker(path.join(root, "a.ts"), markers)).toBe("main");
    expect(await detectMarker(path.join(root, "a.ts"))).toBeNull();
  });
});
