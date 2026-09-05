import { afterEach, describe, expect, test } from "bun:test";
import {
  DATA_DIR_ENV,
  defaultLogFile,
  globalConfigCandidates,
} from "../src/paths.ts";
import { dataDir } from "../src/paths.ts";

const saved = process.env[DATA_DIR_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[DATA_DIR_ENV];
  else process.env[DATA_DIR_ENV] = saved;
});

describe("dataDir", () => {
  test("env override wins", async () => {
    const path = await import("node:path");
    process.env[DATA_DIR_ENV] = path.join("tmp", "custom-ls");
    expect(dataDir()).toBe(path.join("tmp", "custom-ls"));
    expect(defaultLogFile()).toBe(path.join("tmp", "custom-ls", "lightserver.log"));
  });

  test("platform default", () => {
    delete process.env[DATA_DIR_ENV];
    const dir = dataDir();
    if (process.platform === "linux") {
      expect(dir).toBe("/etc/lightserver");
    } else {
      expect(dir.endsWith(".lightserver")).toBe(true);
    }
  });

  test("global candidates prefer platform path, keep legacy fallback", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    delete process.env[DATA_DIR_ENV];
    const cands = globalConfigCandidates();
    expect(cands[0]).toBe(
      process.platform === "linux"
        ? "/etc/lightserver/lightserver.config.ts"
        : path.join(os.homedir(), ".lightserver", "lightserver.config.ts"),
    );
    expect(cands[cands.length - 1]).toBe(path.join(os.homedir(), ".lightserver.config.ts"));
  });
});
