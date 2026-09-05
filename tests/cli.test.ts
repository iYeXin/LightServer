import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("shared flags for start and dev", () => {
    const p = parseArgs(["start", "-c", "x.ts", "--port", "5600", "--host", "0.0.0.0"]);
    expect(p.command).toBe("start");
    expect(p.explicitConfig).toBe("x.ts");
    expect(p.cli.port).toBe(5600);
    expect(p.cli.host).toBe("0.0.0.0");

    const d = parseArgs(["dev", "--port=8080", "--max-processes", "4", "-v"]);
    expect(d.command).toBe("dev");
    expect(d.cli.port).toBe(8080);
    expect(d.cli.maxProcesses).toBe(4);
    expect(d.cli.logLevel).toBe("debug");

    const l = parseArgs(["start", "--log-file", "logs/app.log", "--log-level", "warn"]);
    expect(l.cli.logFile).toBe("logs/app.log");
    expect(l.cli.logLevel).toBe("warn");
  });

  test("unknown command/option surfaces as error", () => {
    expect(parseArgs(["serve"]).error).toMatch(/Unknown command/);
    expect(parseArgs(["start", "--nope"]).error).toMatch(/Unknown option/);
    expect(parseArgs(["start", "--port", "abc"]).error).toMatch(/Invalid --port/);
  });
});
