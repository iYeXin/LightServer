import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultLogFile, globalConfigCandidates } from "./paths.ts";
import type { CliOverrides, LightServerConfig, ResolvedConfig } from "./types.ts";

export const LOCAL_CONFIG_NAME = "lightserver.config.ts";

export const DEFAULTS = {
  port: 5600,
  host: "127.0.0.1",
  maxProcesses: 10,
  idleTimeout: 300,
  drainTimeout: 10,
  requestTimeout: 30,
  routeCacheTtl: 60,
  routeCacheSize: 2000,
  logMaxBytes: 10 * 1024 * 1024,
  logMaxFiles: 5,
  logFlushIntervalMs: 1000,
  defaultSite: "default",
  logLevel: "info" as const,
  dynamicRouting: { enabled: true, maxDepth: 5 },
  staticExtensions: [
    ".html", ".htm", ".css", ".js", ".mjs", ".json", ".png", ".jpg", ".jpeg",
    ".gif", ".svg", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".eot",
    ".mp4", ".webm", ".mp3", ".txt", ".xml", ".pdf",
  ],
};

let reloadCounter = 0;

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Accept `.ts` (primary) with `.js`/`.mjs` fallback for the same basename. */
async function resolveConfigVariant(p: string): Promise<string | null> {
  if (await fileExists(p)) return p;
  if (p.endsWith(".ts")) {
    for (const alt of [p.slice(0, -3) + ".js", p.slice(0, -3) + ".mjs"]) {
      if (await fileExists(alt)) return alt;
    }
  }
  return null;
}

async function importConfigFile(
  absPath: string,
): Promise<{ config: Partial<LightServerConfig>; file: string }> {
  const found = await resolveConfigVariant(absPath);
  if (!found) return { config: {}, file: "" };
  reloadCounter++;
  const url = pathToFileURL(found).href + `?lightserver=${reloadCounter}`;
  const mod = await import(url);
  const config = (mod?.default ?? {}) as Partial<LightServerConfig>;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Invalid config in ${found}: default export must be an object`);
  }
  return { config, file: found };
}

/**
 * Merge order (later wins): defaults < global (~) < local (cwd) <
 * explicit -c file < CLI flags. `sites` merge per site; `routes`,
 * `staticExtensions`, `deny`, `redirects` replace when specified.
 */
export function mergeConfigs(
  ...parts: Array<Partial<LightServerConfig> | undefined | null>
): Partial<LightServerConfig> {
  const out: Partial<LightServerConfig> = {};
  for (const part of parts) {
    if (!part) continue;
    const { sites, dynamicRouting, ...rest } = part;
    Object.assign(out, rest);
    if (dynamicRouting) {
      out.dynamicRouting = { ...(out.dynamicRouting ?? {}), ...dynamicRouting };
    }
    if (sites) {
      out.sites = { ...(out.sites ?? {}) };
      for (const [name, site] of Object.entries(sites)) {
        if (!site || typeof site !== "object") continue;
        out.sites[name] = { ...(out.sites[name] ?? {}), ...site };
      }
    }
  }
  return out;
}

function cliToPartial(cli: CliOverrides | undefined): Partial<LightServerConfig> {
  if (!cli) return {};
  const out: Partial<LightServerConfig> = {};
  if (cli.port !== undefined) out.port = cli.port;
  if (cli.host !== undefined) out.host = cli.host;
  if (cli.maxProcesses !== undefined) out.maxProcesses = cli.maxProcesses;
  if (cli.idleTimeout !== undefined) out.idleTimeout = cli.idleTimeout;
  if (cli.drainTimeout !== undefined) out.drainTimeout = cli.drainTimeout;
  if (cli.requestTimeout !== undefined) out.requestTimeout = cli.requestTimeout;
  if (cli.logLevel !== undefined) out.logLevel = cli.logLevel;
  if (cli.logFile !== undefined) out.logFile = cli.logFile;
  return out;
}

export function withDefaults(
  partial: Partial<LightServerConfig>,
  fallbackLogLevel?: ResolvedConfig["logLevel"],
): ResolvedConfig {
  return {
    port: partial.port ?? DEFAULTS.port,
    host: partial.host ?? DEFAULTS.host,
    maxProcesses: partial.maxProcesses ?? DEFAULTS.maxProcesses,
    idleTimeout: partial.idleTimeout ?? DEFAULTS.idleTimeout,
    drainTimeout: partial.drainTimeout ?? DEFAULTS.drainTimeout,
    requestTimeout: partial.requestTimeout ?? DEFAULTS.requestTimeout,
    staticExtensions: [...(partial.staticExtensions ?? DEFAULTS.staticExtensions)],
    defaultSite: partial.defaultSite ?? DEFAULTS.defaultSite,
    routeCacheTtl: partial.routeCacheTtl ?? DEFAULTS.routeCacheTtl,
    routeCacheSize: partial.routeCacheSize ?? DEFAULTS.routeCacheSize,
    sites: { ...(partial.sites ?? {}) },
    preProcess: partial.preProcess,
    dynamicRouting: {
      enabled: partial.dynamicRouting?.enabled ?? DEFAULTS.dynamicRouting.enabled,
      maxDepth: partial.dynamicRouting?.maxDepth ?? DEFAULTS.dynamicRouting.maxDepth,
    },
    logLevel: partial.logLevel ?? fallbackLogLevel ?? DEFAULTS.logLevel,
    logFile: partial.logFile ?? "",
    logMaxBytes: partial.logMaxBytes ?? DEFAULTS.logMaxBytes,
    logMaxFiles: partial.logMaxFiles ?? DEFAULTS.logMaxFiles,
    logFlushIntervalMs: partial.logFlushIntervalMs ?? DEFAULTS.logFlushIntervalMs,
  };
}

export function validateConfig(config: ResolvedConfig): void {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  if (!Number.isInteger(config.maxProcesses) || config.maxProcesses < 1) {
    throw new Error(`Invalid maxProcesses: ${config.maxProcesses}`);
  }
  for (const t of [config.idleTimeout, config.drainTimeout, config.requestTimeout]) {
    if (!Number.isFinite(t) || t <= 0) throw new Error(`Invalid timeout value: ${t}`);
  }
  if (!Number.isInteger(config.dynamicRouting.maxDepth) || config.dynamicRouting.maxDepth < 0) {
    throw new Error(`Invalid dynamicRouting.maxDepth: ${config.dynamicRouting.maxDepth}`);
  }
  if (!Number.isFinite(config.routeCacheTtl) || config.routeCacheTtl < 0) {
    throw new Error(`Invalid routeCacheTtl: ${config.routeCacheTtl}`);
  }
  if (!Number.isFinite(config.routeCacheSize) || config.routeCacheSize < 0) {
    throw new Error(`Invalid routeCacheSize: ${config.routeCacheSize}`);
  }
  if (!Number.isFinite(config.logMaxBytes) || config.logMaxBytes <= 0) {
    throw new Error(`Invalid logMaxBytes: ${config.logMaxBytes}`);
  }
  if (!Number.isFinite(config.logMaxFiles) || config.logMaxFiles < 0) {
    throw new Error(`Invalid logMaxFiles: ${config.logMaxFiles}`);
  }
  if (!Number.isFinite(config.logFlushIntervalMs) || config.logFlushIntervalMs < 100) {
    throw new Error(`Invalid logFlushIntervalMs (min 100): ${config.logFlushIntervalMs}`);
  }
  if (!config.sites[config.defaultSite] && Object.keys(config.sites).length > 0) {
    throw new Error(
      `defaultSite "${config.defaultSite}" is not defined in sites (${Object.keys(config.sites).join(", ")})`,
    );
  }
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Absolute paths of the config files that were actually loaded. */
  files: string[];
}

export async function resolveConfig(opts: {
  cwd: string;
  explicit?: string;
  cli?: CliOverrides;
  /** Mode default for logLevel; config files and CLI still win. */
  fallbackLogLevel?: ResolvedConfig["logLevel"];
}): Promise<LoadedConfig> {
  const localPath = path.join(opts.cwd, LOCAL_CONFIG_NAME);

  const [g, l] = await Promise.all([
    importGlobalConfig(),
    importConfigFile(localPath),
  ]);

  let e: { config: Partial<LightServerConfig>; file: string } = { config: {}, file: "" };
  if (opts.explicit) {
    const abs = path.isAbsolute(opts.explicit)
      ? opts.explicit
      : path.resolve(opts.cwd, opts.explicit);
    e = await importConfigFile(abs);
    if (!e.file) throw new Error(`Config file not found: ${abs}`);
  }

  const merged = mergeConfigs(g.config, l.config, e.config, cliToPartial(opts.cli));
  const config = withDefaults(merged, opts.fallbackLogLevel);
  if (!config.logFile) {
    config.logFile = defaultLogFile();
  } else if (!path.isAbsolute(config.logFile)) {
    config.logFile = path.resolve(opts.cwd, config.logFile);
  }
  validateConfig(config);

  const files = [g.file, l.file, e.file].filter((f) => f !== "");
  return { config, files };
}

/** First existing global config wins (platform path, then legacy dotfile). */
async function importGlobalConfig(): Promise<{ config: Partial<LightServerConfig>; file: string }> {
  for (const candidate of globalConfigCandidates()) {
    const loaded = await importConfigFile(candidate);
    if (loaded.file) return loaded;
  }
  return { config: {}, file: "" };
}
