import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  closeLogger,
  configureLogging,
  flushLogs,
  log,
} from "../src/logger.ts";

let tmp = "";
afterEach(async () => {
  await flushLogs();
  closeLogger();
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("file logger", () => {
  test("appends JSON lines and flushes on demand", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-log-"));
    const file = path.join(tmp, "app.log");
    configureLogging({ level: "debug", file, flushIntervalMs: 60000 });
    log("info", "hello", { a: 1 });
    log("debug", "dbg");
    await flushLogs();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ level: "info", msg: "hello", a: 1 });
  });

  test("level filtering", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-log-"));
    const file = path.join(tmp, "app.log");
    configureLogging({ level: "warn", file, flushIntervalMs: 60000 });
    log("info", "hidden");
    log("error", "shown");
    await flushLogs();
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("hidden");
    expect(text).toContain("shown");
  });

  test("rotation keeps bounded history", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-log-"));
    const file = path.join(tmp, "app.log");
    configureLogging({ level: "info", file, maxBytes: 300, maxFiles: 2, flushIntervalMs: 60000 });
    for (let i = 0; i < 30; i++) {
      log("info", `line-${i}-padding-to-grow-the-file`, { i });
      await flushLogs();
    }
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    const total = [file, `${file}.1`, `${file}.2`]
      .filter((f) => fs.existsSync(f))
      .reduce((n, f) => n + fs.statSync(f).size, 0);
    expect(total).toBeLessThan(300 * 4);
  });
});
