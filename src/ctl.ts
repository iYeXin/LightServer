import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./paths.ts";
import { DAEMON_FAILED_PREFIX, DAEMON_READY_PREFIX } from "./daemon.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("./daemon.ts", import.meta.url));
const START_TIMEOUT_MS = 30000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 8000;
const SHUTDOWN_POLL_MS = 250;

export interface DaemonInfo {
  pid: number;
  host: string;
  port: number;
  sitePorts: number[];
  cwd: string;
  /** Serve flags for restart (everything after the command word). */
  argv: string[];
  token: string;
  startedAt: number;
}

export function pidfilePath(): string {
  return path.join(dataDir(), "lightserver.pid");
}

export function daemonErrPath(): string {
  return path.join(dataDir(), "lightserver-daemon.err");
}

export function readPidfile(): DaemonInfo | null {
  try {
    const raw = fs.readFileSync(pidfilePath(), "utf8");
    const obj = JSON.parse(raw) as Partial<DaemonInfo>;
    if (
      typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid <= 0 ||
      typeof obj.port !== "number" || typeof obj.host !== "string" ||
      !Array.isArray(obj.sitePorts) || typeof obj.cwd !== "string" || !Array.isArray(obj.argv) ||
      typeof obj.token !== "string" || obj.token === "" ||
      typeof obj.startedAt !== "number"
    ) {
      return null;
    }
    return obj as DaemonInfo;
  } catch {
    return null;
  }
}

function removePidfile(): void {
  try {
    fs.rmSync(pidfilePath(), { force: true });
  } catch {
    // ignore
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we may not signal it.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone (or no permission; the wait loop decides)
  }
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return isAlive(pid) === false;
    await new Promise((r) => setTimeout(r, SHUTDOWN_POLL_MS));
  }
}

export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.slice(0, 2).join(" ");
}

/** Bracket IPv6 literals; map wildcard listens to loopback for control calls. */
export function controlOrigin(host: string, port: number): string {
  const h = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return h.includes(":") ? `http://[${h}]:${port}` : `http://${h}:${port}`;
}

export class CtlError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

interface Handshake {
  ok: boolean;
  host?: string;
  port?: number;
  sitePorts?: number[];
  error?: string;
}

function readHandshake(child: ChildProcess, timeoutMs: number): Promise<Handshake> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const done = (r: Handshake) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        // Release the pipe: the daemon outlives us, and any held handle
        // would keep our event loop (and thus this frontend) alive forever.
        try {
          (child.stdout as unknown as { removeAllListeners?: (e: string) => void })?.removeAllListeners?.("data");
        } catch {
          // ignore
        }
        try {
          (child.stdout as unknown as { destroy?: () => void })?.destroy?.();
        } catch {
          // ignore
        }
        resolve(r);
      }
    };
    const timer = setTimeout(() => done({ ok: false, error: `daemon did not become ready within ${timeoutMs / 1000}s` }), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      let idx = buf.indexOf("\n");
      while (idx >= 0 && !settled) {
        const line = buf.slice(0, idx).trimEnd();
        buf = buf.slice(idx + 1);
        if (line.startsWith(DAEMON_READY_PREFIX)) {
          try {
            const payload = JSON.parse(line.slice(DAEMON_READY_PREFIX.length).trim()) as {
              host: string;
              port: number;
              sitePorts?: number[];
            };
            if (typeof payload.host !== "string" || typeof payload.port !== "number") {
              throw new Error("bad handshake");
            }
            done({
              ok: true,
              host: payload.host,
              port: payload.port,
              sitePorts: Array.isArray(payload.sitePorts)
                ? payload.sitePorts.filter((p) => Number.isInteger(p))
                : [],
            });
          } catch {
            done({ ok: false, error: "daemon sent a malformed ready handshake" });
          }
        } else if (line.startsWith(DAEMON_FAILED_PREFIX)) {
          done({ ok: false, error: line.slice(DAEMON_FAILED_PREFIX.length).trim() || "daemon failed to start" });
        }
        idx = buf.indexOf("\n");
      }
    };
    child.stdout?.on("data", onData);
    child.on("error", (e) => done({ ok: false, error: `failed to spawn daemon: ${String(e)}` }));
    child.on("exit", (code) => {
      if (!settled) {
        done({ ok: false, error: `daemon exited during startup (code ${code ?? "?"})` });
      }
    });
  });
}

/**
 * Start the daemon in the background. The CLI returns once the backend
 * reports ready; the daemon survives terminal exit.
 */
export async function startDaemon(opts: {
  cwd: string;
  serveArgv: string[];
}): Promise<{ pid: number; host: string; port: number; sitePorts: number[] }> {
  const existing = readPidfile();
  if (existing) {
    if (isAlive(existing.pid)) {
      throw new CtlError(
        `already running (pid ${existing.pid}, http://${existing.host}:${existing.port}); run "lightserver stop" or "restart" first`,
      );
    }
    removePidfile();
  }

  const token = crypto.randomBytes(16).toString("hex");
  const errFile = daemonErrPath();
  let errFd = -1;
  let child: ChildProcess;
  try {
    errFd = fs.openSync(errFile, "a");
  } catch (e) {
    throw new CtlError(`cannot open daemon err log ${errFile}: ${String(e)}`);
  }
  try {
    child = spawn(process.execPath, [DAEMON_ENTRY, ...opts.serveArgv], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        LIGHTSERVER_DAEMON: "1",
        LIGHTSERVER_CONTROL_TOKEN: token,
      } as Record<string, string>,
      stdio: ["ignore", "pipe", errFd],
      detached: true,
      windowsHide: true,
    });
  } catch (e) {
    try {
      fs.closeSync(errFd);
    } catch {
      // ignore
    }
    throw new CtlError(`failed to spawn daemon: ${String(e)}`);
  }
  try {
    fs.closeSync(errFd);
  } catch {
    // child keeps its own copy
  }
  if (typeof child.unref === "function") child.unref();
  if (child.pid === undefined) {
    throw new CtlError("failed to spawn daemon: no pid");
  }

  const hs = await readHandshake(child, START_TIMEOUT_MS);
  if (!hs.ok || hs.host === undefined || hs.port === undefined) {
    tryKill(child.pid, "SIGKILL");
    throw new CtlError(`${hs.error ?? "daemon failed to start"} (see ${errFile})`);
  }

  const info: DaemonInfo = {
    pid: child.pid,
    host: hs.host,
    port: hs.port,
    sitePorts: hs.sitePorts ?? [],
    cwd: opts.cwd,
    argv: opts.serveArgv,
    token,
    startedAt: Date.now(),
  };
  try {
    fs.writeFileSync(pidfilePath(), JSON.stringify(info, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Lost a concurrent start race: drop our backend, the winner serves.
    tryKill(child.pid, "SIGKILL");
    const winner = readPidfile();
    throw new CtlError(
      winner && isAlive(winner.pid)
        ? `already running (pid ${winner.pid}); run "lightserver stop" or "restart" first`
        : "another starter won the race; try again",
    );
  }
  return { pid: info.pid, host: info.host, port: info.port, sitePorts: info.sitePorts };
}

/** Graceful stop: token-gated control endpoint first, signals as fallback. */
export async function stopDaemon(): Promise<string> {
  const info = readPidfile();
  if (!info) {
    if (fs.existsSync(pidfilePath())) removePidfile();
    return "lightserver is not running";
  }
  if (!isAlive(info.pid)) {
    removePidfile();
    return `lightserver is not running (stale pid ${info.pid} removed)`;
  }

  try {
    await fetch(`${controlOrigin(info.host, info.port)}/__lightserver_shutdown__`, {
      method: "POST",
      headers: { "x-lightserver-token": info.token },
      signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS),
    });
  } catch {
    // Unreachable or rung down already: fall through to signals.
  }
  if (await waitExit(info.pid, 30000)) {
    removePidfile();
    return `stopped (pid ${info.pid})`;
  }
  tryKill(info.pid, "SIGTERM");
  if (await waitExit(info.pid, 5000)) {
    removePidfile();
    return `stopped (pid ${info.pid})`;
  }
  tryKill(info.pid, "SIGKILL");
  if (await waitExit(info.pid, 3000)) {
    removePidfile();
    return `stopped (pid ${info.pid})`;
  }
  throw new CtlError(`failed to stop daemon (pid ${info.pid} still alive)`);
}

export async function restartDaemon(opts: {
  cwd: string;
  serveArgv: string[];
}): Promise<{ pid: number; host: string; port: number; sitePorts: number[]; restarted: boolean }> {
  const previous = readPidfile();
  const stored = previous && isAlive(previous.pid) ? previous : null;
  await stopDaemon();
  const useStored = opts.serveArgv.length === 0 && stored;
  const started = await startDaemon({
    cwd: useStored ? stored.cwd : opts.cwd,
    serveArgv: useStored ? stored.argv : opts.serveArgv,
  });
  return { ...started, restarted: stored !== null };
}

export function statusDaemon(): { running: boolean; message: string } {
  const info = readPidfile();
  if (!info) {
    if (fs.existsSync(pidfilePath())) removePidfile();
    return { running: false, message: "lightserver is not running" };
  }
  if (!isAlive(info.pid)) {
    removePidfile();
    return { running: false, message: `lightserver is not running (stale pid ${info.pid} removed)` };
  }
  const extra = info.sitePorts.length > 0 ? `, site ports ${info.sitePorts.join(", ")}` : "";
  return {
    running: true,
    message:
      `running (pid ${info.pid}, http://${info.host}:${info.port}${extra}, ` +
      `up ${formatUptime(Date.now() - info.startedAt)})`,
  };
}
