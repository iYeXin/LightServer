import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR_ENV = "LIGHTSERVER_DATA_DIR";
export const LEGACY_GLOBAL_CONFIG_NAME = ".lightserver.config.ts";
export const GLOBAL_CONFIG_NAME = "lightserver.jsonc";
export const DEFAULT_LOG_NAME = "lightserver.log";

/**
 * Central data dir for global config + default log file.
 * Linux: /etc/lightserver ; macOS/Windows: ~/.lightserver.
 * Overridable via LIGHTSERVER_DATA_DIR (tests, containers, non-root setups).
 */
export function dataDir(): string {
  const override = process.env[DATA_DIR_ENV]?.trim();
  if (override) return override;
  if (process.platform === "linux") return path.join(path.sep, "etc", "lightserver");
  return path.join(os.homedir(), ".lightserver");
}

/** New platform path first, legacy ~/.lightserver.config.ts as fallback. */
export function globalConfigCandidates(): string[] {
  const primary = path.join(dataDir(), GLOBAL_CONFIG_NAME);
  const legacy = path.join(os.homedir(), LEGACY_GLOBAL_CONFIG_NAME);
  return primary === legacy ? [primary] : [primary, legacy];
}

export function defaultLogFile(): string {
  return path.join(defaultLogDir(), DEFAULT_LOG_NAME);
}

/** Linux/macOS: /var/log/lightserver ; Windows: ~/.lightserver. */
export function defaultLogDir(): string {
  const override = process.env[DATA_DIR_ENV]?.trim();
  if (override) return override;
  if (process.platform === "win32") return path.join(os.homedir(), ".lightserver");
  return path.join(path.sep, "var", "log", "lightserver");
}

/** Best-effort mkdir (system dirs need root); null on success. */
export async function ensureDataDir(): Promise<string | null> {
  return ensureDir(dataDir());
}

/** Best-effort mkdir; null on success, error message otherwise. */
export async function ensureDir(dir: string): Promise<string | null> {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}
