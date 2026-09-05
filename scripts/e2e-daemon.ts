// Daemon lifecycle e2e: start (background) / status / restart / stop via the
// CLI frontend, against an isolated data dir. Run: bun ./scripts/e2e-daemon.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 15000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = path.resolve(import.meta.dir, "..", "bin", "lightserver.ts");

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${extra}`);
  }
}

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

async function cli(args: string[], cwd: string, env: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function pidOf(statusOut: string): number | null {
  const m = statusOut.match(/pid (\d+)/);
  return m ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-dmn-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ls-dmn-data-"));
  const env = {
    HOME: data,
    USERPROFILE: data,
    LIGHTSERVER_DATA_DIR: data,
  };
  const write = (rel: string, content: string) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write("public/index.html", "<h1>daemon</h1>");
  write(
    "lightserver.config.ts",
    `export default { sites: { default: { root: "./public" } } };\n`,
  );

  const baseArgs = ["--port", String(PORT)];
  try {
    let r = await cli(["start", ...baseArgs], dir, env);
    check("start daemonizes", r.code === 0 && /started \(pid \d+/.test(r.out), `${r.code} ${r.out} ${r.err}`);
    const pid1 = pidOf(r.out);
    check("pidfile written", pid1 !== null && fs.existsSync(path.join(data, "lightserver.pid")));

    const home = await fetch(BASE + "/");
    check("daemon serves traffic", home.status === 200 && (await home.text()).includes("daemon"));

    r = await cli(["start", ...baseArgs], dir, env);
    check("double start refused", r.code === 1 && /already running/.test(r.err), `${r.code} ${r.out} ${r.err}`);

    r = await cli(["status"], dir, env);
    check("status shows running", r.code === 0 && /running \(pid \d+/.test(r.out), `${r.code} ${r.out}`);

    // Control channel without token must look like any other 404.
    const evil = await fetch(BASE + "/__lightserver_shutdown__", { method: "POST" });
    check("shutdown endpoint gated", evil.status === 404);

    r = await cli(["restart"], dir, env);
    check("restart recycles", r.code === 0 && /restarted \(pid \d+/.test(r.out), `${r.code} ${r.out} ${r.err}`);
    const pid2 = pidOf(r.out);
    check("restart spawns a new process", pid2 !== null && pid2 !== pid1, `was ${pid1}, now ${pid2}`);
    const home2 = await fetch(BASE + "/");
    check("serves after restart", home2.status === 200);

    r = await cli(["stop"], dir, env);
    check("stop drains", r.code === 0 && /stopped|not running/.test(r.out), `${r.code} ${r.out} ${r.err}`);
    check("pidfile removed", !fs.existsSync(path.join(data, "lightserver.pid")));

    r = await cli(["status"], dir, env);
    check("status reports down", r.code === 1 && /not running/.test(r.out), `${r.code} ${r.out}`);

    r = await cli(["stop"], dir, env);
    check("second stop is idempotent", r.code === 0 && /not running/.test(r.out), `${r.code} ${r.out}`);

    r = await cli(["start", "--port", "notaport"], dir, env);
    check("bad flags fail fast", r.code === 2, `${r.code} ${r.out} ${r.err}`);

    r = await cli(["start", "-c", path.join(dir, "missing.config.ts")], dir, env);
    check("missing config fails without daemon", r.code === 1 && !fs.existsSync(path.join(data, "lightserver.pid")), `${r.code} ${r.err}`);
  } finally {
    // Last-resort cleanup so failures never leak a daemon.
    try {
      await cli(["stop"], dir, env);
    } catch {
      // ignore
    }
    try {
      const raw = fs.readFileSync(path.join(data, "lightserver.pid"), "utf8");
      const pid = (JSON.parse(raw) as { pid: number }).pid;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
      fs.rmSync(path.join(data, "lightserver.pid"), { force: true });
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "DAEMON E2E PASS" : `DAEMON E2E FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
