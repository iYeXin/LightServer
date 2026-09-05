import path from "node:path";
import { parseArgs, validateServeArgs } from "./args.ts";
import { hasAnyConfigFile, maybeCreateStarterConfig, resolveConfig } from "./config.ts";
import { configureLogging } from "./logger.ts";
import { dataDir, ensureDataDir, ensureDir } from "./paths.ts";
import { startServer } from "./server.ts";
import type { LogLevel } from "./logger.ts";

export const DAEMON_READY_PREFIX = "__LIGHTSERVER_DAEMON_READY__";
export const DAEMON_FAILED_PREFIX = "__LIGHTSERVER_DAEMON_FAILED__";

function fail(child: boolean, msg: string, code: number): never {
  if (child) {
    try {
      process.stdout.write(`${DAEMON_FAILED_PREFIX} ${msg.split("\n")[0]}\n`);
    } catch {
      // ignore
    }
  }
  try {
    process.stderr.write(`Error: ${msg}\n`);
  } catch {
    // ignore
  }
  process.exit(code);
}

export interface DaemonRunOptions {
  mode: "child" | "foreground" | "dev";
  argv: string[];
  version?: string;
}

/**
 * Backend entry. Runs the server in this process:
 * - child: detached daemon (handshake via stdout markers, then silent forever)
 * - foreground: direct `start -f` run (friendly console line)
 * - dev: development run (watchers, debug default)
 */
export async function runDaemon(opts: DaemonRunOptions): Promise<void> {
  const { mode, argv, version = "0.0.0" } = opts;
  const child = mode === "child";
  const isDev = mode === "dev";
  const parsed = parseArgs(argv);
  if (parsed.error) fail(child, parsed.error, 2);
  const serveError = validateServeArgs(parsed);
  if (serveError) fail(child, serveError, 2);
  if (child) {
    // Detached children must survive terminal exit (POSIX SIGHUP).
    process.on("SIGHUP", () => {});
  }

  const cwd = process.cwd();
  const dataDirError = await ensureDataDir();
  if (dataDirError && !child) {
    process.stderr.write(
      `Warning: cannot create data dir ${dataDir()}: ${dataDirError} (logging falls back to stderr)\n`,
    );
  }

  let loaded;
  try {
    if (!parsed.explicitConfig && !(await hasAnyConfigFile(cwd))) {
      const created = await maybeCreateStarterConfig(dataDir(), []);
      if (created && !child) {
        process.stdout.write(`Created starter config: ${created}\n`);
      }
    }
    loaded = await resolveConfig({
      cwd,
      explicit: parsed.explicitConfig,
      cli: parsed.cli,
      fallbackLogLevel: (isDev ? "debug" : "info") as LogLevel,
    });
  } catch (e) {
    fail(child, `failed to load config: ${String((e as Error)?.message ?? e)}`, 1);
  }

  configureLogging({
    level: loaded.config.logLevel,
    file: loaded.config.logFile,
    maxBytes: loaded.config.logMaxBytes,
    maxFiles: loaded.config.logMaxFiles,
    flushIntervalMs: loaded.config.logFlushIntervalMs,
  });
  const logDirError = await ensureDir(path.dirname(loaded.config.logFile));
  if (logDirError && !child) {
    process.stderr.write(
      `Warning: cannot create log dir ${path.dirname(loaded.config.logFile)}: ${logDirError} (logging falls back to stderr)\n`,
    );
  }

  try {
    const handle = await startServer({
      cwd,
      isDev,
      explicitConfig: parsed.explicitConfig,
      cli: parsed.cli,
      fallbackLogLevel: (isDev ? "debug" : "info") as LogLevel,
      initial: loaded,
    });
    const c = handle.getConfig();
    const sitePorts = [
      ...new Set(
        Object.values(c.sites)
          .map((s) => s.port)
          .filter((p): p is number => p !== undefined),
      ),
    ];
    if (child) {
      process.stdout.write(
        `${DAEMON_READY_PREFIX} ${JSON.stringify({ host: c.host, port: c.port, sitePorts })}\n`,
      );
    } else {
      process.stdout.write(
        `lightserver v${version} listening on http://${c.host}:${c.port} ` +
          `(${isDev ? "dev" : "start"}; logs: ${c.logFile})\n`,
      );
    }
  } catch (e) {
    fail(child, `failed to start server: ${String((e as Error)?.message ?? e)}`, 1);
  }
}

// Daemon child entry: `bun src/daemon.ts [serve flags...]`.
if (import.meta.main) {
  await runDaemon({ mode: "child", argv: Bun.argv.slice(2) });
}
