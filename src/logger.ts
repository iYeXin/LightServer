import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  level: LogLevel;
  /** Append target. Parent dirs are created on demand. */
  file: string;
  /** Rotate when file + pending bytes exceed this. */
  maxBytes: number;
  /** Keep file.1 .. file.maxFiles. <=0 disables rotation. */
  maxFiles: number;
  /** Async flush cadence. */
  flushIntervalMs: number;
  /** Ring size; oldest lines drop past it (counted). */
  maxBuffer: number;
}

export const DEFAULT_LOG_OPTIONS = {
  level: "info" as LogLevel,
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  flushIntervalMs: 1000,
  maxBuffer: 20000,
};

let opts: LoggerOptions = { ...DEFAULT_LOG_OPTIONS, file: "" };
let buffer: string[] = [];
let dropped = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let flushChain: Promise<void> = Promise.resolve();

export function setLogLevel(level: LogLevel): void {
  opts.level = level;
}

export function getLogLevel(): LogLevel {
  return opts.level;
}

/** First call starts the flush timer; re-calls flush the old file, then switch. */
export function configureLogging(o: Partial<LoggerOptions>): void {
  Object.assign(opts, o);
  if (!timer) {
    timer = setInterval(() => void flushLogs(), Math.max(50, opts.flushIntervalMs));
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

/** Live-update level/rotation cadence (used on config hot-reload). */
export async function reconfigureLogging(o: Partial<LoggerOptions>): Promise<void> {
  await flushLogs();
  const fileChanged = o.file !== undefined && o.file !== opts.file;
  Object.assign(opts, o);
  if (fileChanged) {
    log("info", "log file switched", { file: opts.file });
  }
  if (timer) {
    clearInterval(timer);
    timer = setInterval(() => void flushLogs(), Math.max(50, opts.flushIntervalMs));
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

export function closeLogger(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (ORDER[level] < ORDER[opts.level]) return;
  try {
    buffer.push(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  } catch {
    return;
  }
  if (buffer.length > opts.maxBuffer) {
    buffer.splice(0, buffer.length - opts.maxBuffer);
    dropped++;
  }
}

async function rotateIfNeeded(incomingBytes: number): Promise<void> {
  if (opts.maxFiles <= 0 || !opts.file) return;
  let size = -1;
  try {
    size = (await fs.promises.stat(opts.file)).size;
  } catch {
    return; // missing -> plain append creates it
  }
  if (size + incomingBytes <= opts.maxBytes) return;
  for (let i = opts.maxFiles - 1; i >= 1; i--) {
    await fs.promises.rename(`${opts.file}.${i}`, `${opts.file}.${i + 1}`).catch(() => {});
  }
  await fs.promises.rename(opts.file, `${opts.file}.1`).catch(() => {});
  await fs.promises.unlink(`${opts.file}.${opts.maxFiles + 1}`).catch(() => {});
}

async function doFlush(): Promise<void> {
  if (buffer.length === 0 && dropped === 0) return;
  const lines = buffer;
  buffer = [];
  if (dropped > 0) {
    lines.unshift(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "warn",
        msg: `log buffer overflowed; dropped ${dropped} lines`,
      }),
    );
    dropped = 0;
  }
  const payload = lines.join("\n") + "\n";
  if (!opts.file) {
    try {
      process.stderr.write(payload);
    } catch {
      // last resort failed; drop
    }
    return;
  }
  try {
    await rotateIfNeeded(Buffer.byteLength(payload));
    await fs.promises.appendFile(opts.file, payload).catch(async (e) => {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        await fs.promises.mkdir(path.dirname(opts.file), { recursive: true });
        await fs.promises.appendFile(opts.file, payload);
      } else {
        throw e;
      }
    });
  } catch {
    try {
      process.stderr.write(payload);
    } catch {
      // drop rather than crash
    }
  }
}

/** Serialized flushes; await before process exit. */
export function flushLogs(): Promise<void> {
  flushChain = flushChain.then(doFlush, doFlush);
  return flushChain;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  base: Record<string, unknown> = {},
): Logger {
  return {
    debug: (msg, fields) => log("debug", msg, { ...base, ...fields }),
    info: (msg, fields) => log("info", msg, { ...base, ...fields }),
    warn: (msg, fields) => log("warn", msg, { ...base, ...fields }),
    error: (msg, fields) => log("error", msg, { ...base, ...fields }),
  };
}

export function newRequestId(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}
