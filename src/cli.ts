import { hasAnyConfigFile, maybeCreateStarterConfig, resolveConfig } from "./config.ts";
import { configureLogging } from "./logger.ts";
import { dataDir, defaultLogFile, ensureDataDir, globalConfigCandidates } from "./paths.ts";
import { startServer } from "./server.ts";
import type { CliOverrides } from "./types.ts";
import type { LogLevel } from "./logger.ts";

type Command = "start" | "dev";

interface Parsed {
  command: Command | null;
  explicitConfig?: string;
  cli: CliOverrides;
  help: boolean;
  version: boolean;
  error?: string;
}

function isFlag(a: string): boolean {
  return a.startsWith("-");
}

function parseNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { command: null, cli: {}, help: false, version: false };
  let i = 0;
  const takeValue = (name: string, attached: string | undefined): string => {
    if (attached !== undefined && attached !== "") return attached;
    const next = argv[++i];
    if (next === undefined || isFlag(next)) {
      throw new Error(`Missing value for ${name}`);
    }
    return next;
  };
  try {
    while (i < argv.length) {
      const arg = argv[i];
      const eq = arg.indexOf("=");
      const head = eq >= 0 ? arg.slice(0, eq) : arg;
      const attached = eq >= 0 ? arg.slice(eq + 1) : undefined;
      if (!isFlag(arg)) {
        if (out.command) throw new Error(`Unexpected argument: ${arg}`);
        if (arg === "start" || arg === "dev") out.command = arg;
        else throw new Error(`Unknown command: ${arg} (expected "start" or "dev")`);
        i++;
        continue;
      }
      switch (head) {
        case "-h":
        case "--help":
          out.help = true;
          break;
        case "-V":
        case "--version":
          out.version = true;
          break;
        case "-v":
        case "--verbose":
          out.cli.logLevel = "debug";
          break;
        case "-c":
        case "--config":
          out.explicitConfig = takeValue("--config", attached);
          break;
        case "-p":
        case "--port":
          out.cli.port = parseNumber(takeValue("--port", attached), "--port");
          break;
        case "-H":
        case "--host":
        case "--hostname":
          out.cli.host = takeValue("--host", attached);
          break;
        case "--max-processes":
          out.cli.maxProcesses = parseNumber(takeValue("--max-processes", attached), "--max-processes");
          break;
        case "--idle-timeout":
          out.cli.idleTimeout = parseNumber(takeValue("--idle-timeout", attached), "--idle-timeout");
          break;
        case "--drain-timeout":
          out.cli.drainTimeout = parseNumber(takeValue("--drain-timeout", attached), "--drain-timeout");
          break;
        case "--request-timeout":
          out.cli.requestTimeout = parseNumber(takeValue("--request-timeout", attached), "--request-timeout");
          break;
        case "--log-level":
          {
            const v = takeValue("--log-level", attached).toLowerCase();
            if (v !== "debug" && v !== "info" && v !== "warn" && v !== "error") {
              throw new Error(`Invalid --log-level: ${v}`);
            }
            out.cli.logLevel = v;
          }
          break;
        case "--log-file":
          out.cli.logFile = takeValue("--log-file", attached);
          break;
        default:
          throw new Error(`Unknown option: ${head}`);
      }
      i++;
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

async function readVersion(): Promise<string> {
  try {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    if (typeof pkg?.version === "string") return pkg.version;
  } catch {
    // ignore
  }
  return "0.0.0";
}

export function helpText(version: string): string {
  const [primaryGlobal, ...legacyGlobals] = globalConfigCandidates();
  const legacy = legacyGlobals.length > 0 ? ` (legacy ${legacyGlobals[0]} also read)` : "";
  return `lightserver v${version} - lightweight file-routed services on Bun

Usage:
  lightserver start [options]   Run in production mode
  lightserver dev [options]     Run in development mode (config hot-reload,
                                proactive service restart, debug logs)

Options (shared by start and dev):
  -c, --config <path>       Explicit config file (overrides auto-discovery)
  -p, --port <n>            Listen port (default 5600)
  -H, --host <addr>         Listen address (default 127.0.0.1)
      --max-processes <n>   Global service process cap (default 10)
      --idle-timeout <s>    Idle reap seconds (default 300)
      --drain-timeout <s>   Drain wait seconds (default 10)
      --request-timeout <s> Service request timeout seconds (default 30)
      --log-level <level>   debug|info|warn|error
      --log-file <path>     Log file (default ${defaultLogFile()})
  -v, --verbose             Same as --log-level debug
  -h, --help                Show this help
  -V, --version             Show version

Config resolution (later wins):
  built-in defaults < ${primaryGlobal}${legacy} < ./lightserver.config.ts
  < -c file < CLI flags. dev only changes the built-in log default to debug.

Examples:
  lightserver start
  lightserver dev --port 5600
  lightserver start -c ./prod.config.ts --port 8080
`;
}

export async function main(argv: string[]): Promise<void> {
  const version = await readVersion();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n\n${helpText(version)}`);
    process.exit(2);
  }
  if (parsed.help || (!parsed.command && !parsed.version)) {
    process.stdout.write(helpText(version));
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(`lightserver v${version}\n`);
    process.exit(0);
  }

  const isDev = parsed.command === "dev";
  const cwd = process.cwd();
  const fallbackLogLevel: LogLevel = isDev ? "debug" : "info";

  const dataDirError = await ensureDataDir();
  if (dataDirError) {
    process.stderr.write(
      `Warning: cannot create data dir ${dataDir()}: ${dataDirError} (logging falls back to stderr)\n`,
    );
  }

  if (parsed.cli.port !== undefined && (!Number.isInteger(parsed.cli.port) || parsed.cli.port < 1 || parsed.cli.port > 65535)) {
    process.stderr.write("Error: --port must be an integer 1-65535\n");
    process.exit(2);
  }

  let loaded;
  try {
    if (!parsed.explicitConfig && !(await hasAnyConfigFile(cwd))) {
      const created = await maybeCreateStarterConfig(dataDir(), []);
      if (created) {
        process.stdout.write(`Created starter config: ${created}\n`);
      }
    }
    loaded = await resolveConfig({
      cwd,
      explicit: parsed.explicitConfig,
      cli: parsed.cli,
      fallbackLogLevel,
    });
  } catch (e) {
    process.stderr.write(`Error: failed to load config: ${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  }

  configureLogging({
    level: loaded.config.logLevel,
    file: loaded.config.logFile,
    maxBytes: loaded.config.logMaxBytes,
    maxFiles: loaded.config.logMaxFiles,
    flushIntervalMs: loaded.config.logFlushIntervalMs,
  });
  try {
    const handle = await startServer({
      cwd,
      isDev,
      explicitConfig: parsed.explicitConfig,
      cli: parsed.cli,
      fallbackLogLevel,
      initial: loaded,
    });
    const c = handle.getConfig();
    // The only stdout line: everything else goes to the log file.
    process.stdout.write(
      `lightserver v${version} listening on http://${c.host}:${c.port} ` +
        `(${isDev ? "dev" : "start"}; logs: ${c.logFile})\n`,
    );
  } catch (e) {
    process.stderr.write(`Error: failed to start server: ${String((e as Error)?.message ?? e)}\n`);
    process.exit(1);
  }
}
