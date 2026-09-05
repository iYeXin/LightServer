import { describe, expect, test } from "bun:test";
import { maybeCreateStarterConfig, mergeConfigs, withDefaults } from "../src/config.ts";

describe("config merge", () => {
  test("later wins; sites merge per site; lists replace", () => {
    const merged = mergeConfigs(
      { port: 5600, sites: { a: { root: "./a" } }, staticExtensions: [".html"] },
      { port: 8080, sites: { a: { host: "a.test" }, b: { root: "./b" } } },
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

describe("maybeCreateStarterConfig", () => {
  test("creates a valid no-op template when fully zero-config", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-starter-"));
    try {
      const created = await maybeCreateStarterConfig(dir, []);
      expect(created).toBe(path.join(dir, "lightserver.config.ts"));
      const mod = await import(pathToFileURL(created!).href);
      expect(mod.default).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips when any config exists or file already there", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-starter-"));
    try {
      expect(await maybeCreateStarterConfig(dir, ["/some/global.ts"])).toBeNull();
      expect(fs.existsSync(path.join(dir, "lightserver.config.ts"))).toBe(false);
      fs.writeFileSync(path.join(dir, "lightserver.config.ts"), "export default { port: 1234 };\n");
      expect(await maybeCreateStarterConfig(dir, [])).toBeNull();
      expect(fs.readFileSync(path.join(dir, "lightserver.config.ts"), "utf8")).toContain("1234");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
