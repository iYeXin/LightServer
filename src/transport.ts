import os from "node:os";
import path from "node:path";

export type LoopbackKind = "unix" | "tcp";

export interface LoopbackEndpoint {
  kind: LoopbackKind;
  /** POSIX socket file. Reserved pipe name shape on Windows for future Bun support. */
  socketPath?: string;
  /** TCP loopback port (Windows and unix-fallback). */
  port?: number;
  /** Unique fake host so pooled keepalive connections never mix endpoints. */
  host: string;
}

let counter = 0;

/**
 * Unix sockets give cheaper connects than TCP loopback, but Bun (1.3.x)
 * can neither serve nor fetch over Windows named pipes (probed: serve
 * ENOENT, fetch "typo in url or port"), so Windows stays on TCP loopback
 * where Bun fetch already pools keepalive connections.
 */
export function wantsUnixSocket(): boolean {
  return process.platform !== "win32";
}

/** Short POSIX socket path (sun_path is ~104 chars). */
export function createSocketPath(): string {
  counter++;
  const name =
    `ls-${process.pid.toString(36)}-${counter.toString(36)}-` +
    `${Math.random().toString(36).slice(2, 6)}.sock`;
  return path.join(os.tmpdir(), name);
}

export function createEndpoint(kind: LoopbackKind, port?: number, socketPath?: string): LoopbackEndpoint {
  counter++;
  return { kind, port, socketPath, host: `ls${counter.toString(36)}.invalid` };
}

/** Runner argv spec: `unix:/path` or `tcp:1234` (bare number = tcp, legacy). */
export function parseSpec(spec: string): LoopbackEndpoint {
  if (spec.startsWith("unix:")) {
    return { kind: "unix", socketPath: spec.slice(5), host: "localhost" };
  }
  const port = Number(spec.startsWith("tcp:") ? spec.slice(4) : spec);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bad listen spec: ${spec}`);
  }
  return { kind: "tcp", port, host: "127.0.0.1" };
}

export function specString(ep: LoopbackEndpoint): string {
  return ep.kind === "unix" ? `unix:${ep.socketPath}` : `tcp:${ep.port}`;
}

/** fetch() against a loopback endpoint. Response bodies stream through. */
export function fetchLoopback(
  ep: LoopbackEndpoint,
  pathAndSearch: string,
  init: RequestInit & { unix?: string },
): Promise<Response> {
  if (ep.kind === "unix") {
    return fetch(`http://${ep.host}${pathAndSearch}`, { ...init, unix: ep.socketPath });
  }
  return fetch(`http://127.0.0.1:${ep.port}${pathAndSearch}`, init);
}
