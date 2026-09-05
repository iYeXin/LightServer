import { describe, expect, test } from "bun:test";
import {
  hasAnyConfigFile,
  loadPreProcessModule,
  maybeCreateStarterConfig,
  mergeConfigs,
  resolveConfig,
  validateConfig,
  withDefaults,
} from "../src/config.ts";
import { DATA_DIR_ENV } from "../src/paths.ts";

describe("config merge", () => {
  test("later wins; sites merge per site; lists replace", () => {
    const merged = mergeConfigs(
      { port: 5600, sites: { a: { root: "./a" } }, staticExtensions: [".html"] },
      { port: 8080, sites: { a: { root: "./a", hosts: ["a.test"] }, b: { root: "./b" } } },
    );
    expect(merged.port).toBe(8080);
    expect(merged.sites?.a).toEqual({ root: "./a", hosts: ["a.test"] });
    expect(merged.sites?.b).toEqual({ root: "./b" });
    expect(merged.staticExtensions).toEqual([".html"]);
  });

  test("defaults fill the gaps (port 5600)", () => {
    const c = withDefaults({});
    expect(c.port).toBe(5600);
    expect(c.host).toBe("127.0.0.1");
    expect(c.maxProcesses).toBe(10);
    expect(c.dynamicRouting).toEqual({ enabled: true, maxDepth: 5 });
    expect(c.logLevel).toBe("info");
    expect(c.routeCacheTtl).toBe(60);
    expect(c.routeCacheSize).toBe(2000);
    expect(c.logFile).toBe("");
    expect(c.logMaxBytes).toBe(10 * 1024 * 1024);
    expect(c.logMaxFiles).toBe(5);
    expect(c.logFlushIntervalMs).toBe(1000);
    const dev = withDefaults({}, "debug");
    expect(dev.logLevel).toBe("debug");
  });
});

describe("validateConfig", () => {
  const base = () =>
    withDefaults({ sites: { default: { root: "/srv/x", hosts: ["x.test"] } } });
  test("accepts explicit roots", () => {
    expect(() => validateConfig(base())).not.toThrow();
  });
  test("rejects empty sites", () => {
    expect(() => validateConfig(withDefaults({}))).toThrow(/no sites configured/);
  });
  test("rejects sites without root", () => {
    expect(() =>
      validateConfig(withDefaults({ sites: { default: { hosts: ["x.test"] } as never } })),
    ).toThrow(/must define an explicit root/);
  });
  test("rejects sites with neither hosts nor port", () => {
    expect(() =>
      validateConfig(withDefaults({ sites: { default: { root: "/srv/x" } } })),
    ).toThrow(/define hosts/);
  });
  test("rejects legacy singular host", () => {
    expect(() =>
      validateConfig(
        withDefaults({ sites: { default: { root: "/srv/x", host: "x.test" } as never } }),
      ),
    ).toThrow(/renamed to "hosts"/);
  });
  test("rejects bad host regex, dup ports, main-port collision", () => {
    expect(() =>
      validateConfig(withDefaults({ sites: { a: { root: "/a", hosts: ["~(bad"] } } })),
    ).toThrow(/invalid host regex/);
    expect(() =>
      validateConfig(
        withDefaults({ sites: { a: { root: "/a", port: 9001 }, b: { root: "/b", port: 9001 } } }),
      ),
    ).toThrow(/same port/);
    expect(() =>
      validateConfig(withDefaults({ port: 9002, sites: { a: { root: "/a", port: 9002 } } })),
    ).toThrow(/collides with the main listen port/);
  });
  test("accepts port-only sites", () => {
    expect(() =>
      validateConfig(withDefaults({ sites: { a: { root: "/a", port: 9003 } } })),
    ).not.toThrow();
  });
});

describe("hasAnyConfigFile", () => {
  test("detects global, legacy, local, or nothing", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const prev = process.env[DATA_DIR_ENV];
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "ls-hasany-data-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ls-hasany-cwd-"));
    try {
      process.env[DATA_DIR_ENV] = data;
      expect(await hasAnyConfigFile(cwd)).toBe(false);
      fs.writeFileSync(path.join(cwd, "lightserver.config.ts"), "export default {};\n");
      expect(await hasAnyConfigFile(cwd)).toBe(true);
      fs.rmSync(path.join(cwd, "lightserver.config.ts"));
      fs.writeFileSync(path.join(data, "lightserver.jsonc"), '{ "port": 5600 }\n');
      expect(await hasAnyConfigFile(cwd)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[DATA_DIR_ENV];
      else process.env[DATA_DIR_ENV] = prev;
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("preProcess module references", () => {
  test("loads default-exported middleware by relative and absolute path", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-mw-"));
    try {
      fs.writeFileSync(
        path.join(dir, "mw.ts"),
        "export default async (req: Request) => new Response('mw:' + new URL(req.url).pathname);\n",
      );
      const rel = await loadPreProcessModule("./mw.ts", dir, "test");
      expect(typeof rel.fn).toBe("function");
      expect(rel.file).toBe(path.join(dir, "mw.ts"));
      const out = await rel.fn(new Request("http://x/hi"), {} as never);
      expect(out).toBeInstanceOf(Response);
      expect(await (out as Response).text()).toBe("mw:/hi");
      const abs = await loadPreProcessModule(path.join(dir, "mw.ts"), dir, "test");
      expect(typeof abs.fn).toBe("function");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file and non-function export throw", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-mw-"));
    try {
      await expect(loadPreProcessModule("./nope.ts", dir, "decl")).rejects.toThrow(/Failed to load/);
      fs.writeFileSync(path.join(dir, "bad.ts"), "export default 42;\n");
      await expect(loadPreProcessModule("./bad.ts", dir, "decl")).rejects.toThrow(/must default-export/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("global JSONC declaring middleware resolves end to end", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const prev = process.env[DATA_DIR_ENV];
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "ls-mw-data-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ls-mw-cwd-"));
    try {
      process.env[DATA_DIR_ENV] = data;
      fs.writeFileSync(
        path.join(data, "mw.ts"),
        "export default async () => new Response('blocked', { status: 403 });\n",
      );
      fs.writeFileSync(
        path.join(data, "lightserver.jsonc"),
        `{
          // machine-managed global config
          "sites": { "default": { "hosts": ["x.test"], "root": ${JSON.stringify(cwd)} } },
          "preProcess": "./mw.ts",
        }\n`,
      );
      const loaded = await resolveConfig({ cwd });
      expect(typeof loaded.config.preProcess).toBe("function");
      const resp = await loaded.config.preProcess!(new Request("http://x/"), {} as never);
      expect(resp).toBeInstanceOf(Response);
      expect((resp as Response).status).toBe(403);
      expect(loaded.extraWatchFiles).toEqual([path.join(data, "mw.ts")]);
    } finally {
      if (prev === undefined) delete process.env[DATA_DIR_ENV];
      else process.env[DATA_DIR_ENV] = prev;
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("maybeCreateStarterConfig", () => {
  test("creates a valid working template when no global config", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { parseJsonc } = await import("../src/jsonc.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-starter-"));
    try {
      const created = await maybeCreateStarterConfig(dir, []);
      expect(created).toBe(path.join(dir, "lightserver.jsonc"));
      const parsed = parseJsonc(fs.readFileSync(created!, "utf8"), created!) as Record<
        string,
        any
      >;
      expect(parsed).toEqual({
        sites: { config: { hosts: ["example.com"], root: "/srv/websites/example.com" } },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips when a global config exists or file already there", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-starter-"));
    try {
      expect(await maybeCreateStarterConfig(dir, ["/etc/lightserver/lightserver.jsonc"])).toBeNull();
      expect(fs.existsSync(path.join(dir, "lightserver.jsonc"))).toBe(false);
      fs.writeFileSync(path.join(dir, "lightserver.jsonc"), '{ "port": 1234 }\n');
      expect(await maybeCreateStarterConfig(dir, [])).toBeNull();
      expect(fs.readFileSync(path.join(dir, "lightserver.jsonc"), "utf8")).toContain("1234");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
