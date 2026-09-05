import { afterEach, describe, expect, test } from "bun:test";
import {
  controlOrigin,
  formatUptime,
  isAlive,
  pidfilePath,
  readPidfile,
  type DaemonInfo,
} from "../src/ctl.ts";
import { DATA_DIR_ENV } from "../src/paths.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const savedDataDir = process.env[DATA_DIR_ENV];
let tmp = "";
afterEach(() => {
  if (savedDataDir === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = savedDataDir;
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function useTmpDataDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ls-ctl-"));
  process.env[DATA_DIR_ENV] = tmp;
  return tmp;
}

describe("formatUptime", () => {
  test("largest two units", () => {
    expect(formatUptime(5000)).toBe("5s");
    expect(formatUptime(90000)).toBe("1m 30s");
  });
});

describe("isAlive", () => {
  test("own pid is alive, absurd pid is not", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 30)).toBe(false);
  });
});

describe("controlOrigin", () => {
  test("wildcards map to loopback, ipv6 gets brackets", () => {
    expect(controlOrigin("0.0.0.0", 5600)).toBe("http://127.0.0.1:5600");
    expect(controlOrigin("::", 5600)).toBe("http://[::1]:5600");
    expect(controlOrigin("127.0.0.1", 1)).toBe("http://127.0.0.1:1");
  });
});

describe("pidfile", () => {
  test("roundtrip and corrupt handling", () => {
    useTmpDataDir();
    expect(pidfilePath()).toBe(path.join(tmp, "lightserver.pid"));
    expect(readPidfile()).toBeNull();
    const info: DaemonInfo = {
      pid: process.pid,
      host: "127.0.0.1",
      port: 5600,
      cwd: tmp,
      argv: ["--port", "5600"],
      token: "t",
      startedAt: Date.now(),
    };
    fs.writeFileSync(pidfilePath(), JSON.stringify(info));
    expect(readPidfile()).toEqual(info);
    fs.writeFileSync(pidfilePath(), "not-json{{{");
    expect(readPidfile()).toBeNull();
    fs.writeFileSync(pidfilePath(), JSON.stringify({ pid: "x" }));
    expect(readPidfile()).toBeNull();
  });
});
