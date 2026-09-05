import { describe, expect, test } from "bun:test";
import { mergeConfigs, withDefaults } from "../src/config.ts";

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
