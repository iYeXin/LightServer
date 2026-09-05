import { dataDir, defaultLogFile, globalConfigCandidates } from "./paths.ts";
import type { CliOverrides } from "./types.ts";

export type Command = "start" | "dev" | "stop" | "restart" | "status";

export interface Parsed {
  command: Command | null;
  explicitConfig?: string;
  foreground?: boolean;
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

const COMMANDS: Command[] = ["start", "dev", "stop", "restart", "status"];

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
        if ((COMMANDS as string[]).includes(arg)) out.command = arg as Command;
        else throw new Error(`Unknown command: ${arg} (expected ${COMMANDS.join(", ")})`);
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
        case "-f":
        case "--foreground":
          out.foreground = true;
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
    if (out.foreground && out.command && out.command !== "start") {
      throw new Error("--foreground only applies to start");
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/** Shared value checks for serve flags; null when valid. */
export function validateServeArgs(parsed: Parsed): string | null {
  const port = parsed.cli.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return "--port must be an integer 1-65535";
  }
  return null;
}

export async function readVersion(): Promise<string> {
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
  lightserver start [options]    Start the daemon in the background
  lightserver stop               Stop the running daemon gracefully
  lightserver restart [options]  Restart the daemon (new options replace stored ones)
  lightserver status             Show whether the daemon is running
  lightserver dev [options]      Run in the foreground for development

Daemon commands manage <dataDir>/lightserver.pid (data dir: ${dataDir()}).

start options:
  -f, --foreground          Run in the foreground instead of daemonizing
                            (for containers, systemd ExecStart, debugging)
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
  lightserver stop && lightserver status
  lightserver start -c ./prod.config.ts --port 8080
  lightserver start -f            # foreground (docker)
  lightserver dev --port 5600
`;
}
