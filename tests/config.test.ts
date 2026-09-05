import { describe, expect, test } from "bun:test";
import {
  hasAnyConfigFile,
  maybeCreateStarterConfig,
  mergeConfigs,
  validateConfig,
  withDefaults,
} from "../src/config.ts";
import { DATA_DIR_ENV } from "../src/paths.ts";

describe("config merge", () => {
  test("later wins; sites merge per site; lists replace", () => {
    const merged = mergeConfigs(
      { port: 5600, sites: { a: { root: "./a" } }, staticExtensions: [".html"] },
      { port: 8080, sites: { a: { root: "./a", host: "a.test" }, b: { root: "./b" } } },
    );
    expect(merged.port).toBe(8080);
    expect(merged.sites?.a).toEqual({ root: "./a", host: "a.test" });
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
    withDefaults({ sites: { default: { root: "/srv/x" } } });
  test("accepts explicit roots", () => {
    expect(() => validateConfig(base())).not.toThrow();
  });
  test("rejects empty sites", () => {
    expect(() => validateConfig(withDefaults({}))).toThrow(/no sites configured/);
  });
  test("rejects sites without root", () => {
    expect(() =>
      validateConfig(withDefaults({ sites: { default: {} as never } })),
    ).toThrow(/must define an explicit root/);
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
        sites: { default: { root: "/srv/websites/example.com" } },
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
