// End-to-end check: builds a demo project in tmp, boots a real server,
// exercises static/service/dynamic/redirect/deny/multisite/reload, kills it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 15000 + Math.floor(Math.random() * 20000);
let PORT2 = 15000 + Math.floor(Math.random() * 20000);
if (PORT2 === PORT) PORT2++;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-e2e-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ls-home-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-data-")); // LIGHTSERVER_DATA_DIR
  const write = (rel: string, content: string) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write("public/index.html", "<h1>home</h1>");
  write("public/style.css", "body{color:red}");
  write(
    "api2/ping.ts",
    `// @lightserver:main
export default async function init(ctx: any) {
  ctx.onRequest(async () => new Response("pong"));
}
`,
  );
  write(
    "api/hello.ts",
    `// @lightserver:main
export default async function init(ctx: any) {
  ctx.onRequest(async (req: Request) => {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") || "World";
    return new Response("Hello, " + name + "!");
  });
}
`,
  );
  write("api/helper.ts", `// @lightserver\nexport function helper() { return "x"; }\n`);
  write("api/plain.ts", `export const x = 1;\n`);
  write(
    "api/(user).ts",
    `// @lightserver:main
export default async function init(ctx: any) {
  const router = ctx.util.createRouter();
  router.get("/", async () => new Response("User root sub=" + ctx.subPath));
  router.query("/find", async (req: Request) => new Response("found:" + await req.text()));
  router.get("/:id", async (_req: Request, p: any) => new Response("User " + p.id));
  ctx.onRequest(async (req: Request) => router.handle(req));
}
`,
  );
  write(
    "api/echo.ts",
    `// @lightserver:main
export default async function init(ctx: any) {
  ctx.onRequest(async (req: Request) => new Response(await req.text()));
}
`,
  );
  write(
    "api/slow.ts",
    `// @lightserver:main
export default async function init(ctx: any) {
  await new Promise((r) => setTimeout(r, 800));
  ctx.onRequest(async () => new Response("slow-ok"));
}
`,
  );
  write(
    "lightserver.config.ts",
    `export default {
  sites: {
    default: {
      hosts: ["localhost", "127.0.0.1"],
      root: "./public",
      routes: [
        { match: "/", root: "./public" },
        { match: "/api", root: "./api" },
      ],
      deny: ["/private/**"],
      redirects: [
        { from: "/old", to: "/new", status: 301 },
        { from: "/legacy/*", to: "/api/*", status: 302 },
      ],
    },
    apisite: { hosts: ["api.test"], root: "./api" },
    portsite: { port: PORT2, root: "./api2" },
  },
  preProcess: (req: Request, info: any) => {
    if (new URL(req.url).pathname === "/blocked") return new Response("blocked", { status: 403 });
  },
};
`.replaceAll("PORT2", String(PORT2)),
  );

  const serverPath = path.resolve(import.meta.dir, "..", "bin", "lightserver.ts");
  const proc = Bun.spawn([process.execPath, serverPath, "start", "--foreground", "--port", String(PORT)], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, LIGHTSERVER_DATA_DIR: dataDir } as Record<string, string>,
  });

  const get = (p: string, headers: Record<string, string> = {}) =>
    fetch(BASE + p, { headers });
  try {
    // wait for readiness
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await get("/");
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    check("server boots", ready);
    if (!ready) return;

    let r = await get("/");
    check("static / serves index.html", r.status === 200 && (await r.text()).includes("home"));

    r = await get("/style.css");
    check("static css + content-type", r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/css"));

    r = await get("/api/hello?name=Bun");
    check("service via routes mapping", r.status === 200 && (await r.text()) === "Hello, Bun!");

    r = await get("/api/helper.ts");
    check("module file is 403", r.status === 403);

    r = await get("/api/plain.ts");
    check("unmarked .ts is not served", r.status === 403 || r.status === 404, `got ${r.status}`);

    r = await get("/nope");
    check("missing path is 404", r.status === 404);

    r = await get("/api/user");
    check("dynamic bare prefix", r.status === 200 && (await r.text()).includes("User root"));

    r = await get("/api/user/42");
    check("dynamic + router param", r.status === 200 && (await r.text()) === "User 42");

    r = await get("/api/user/42/extra");
    check("dynamic unmatched subpath is 404", r.status === 404);

    r = await fetch(BASE + "/api/user/find", { method: "QUERY", body: "qbody" });
    check("QUERY method with body", r.status === 200 && (await r.text()) === "found:qbody");

    r = await fetch(BASE + "/old", { redirect: "manual" });
    check("exact redirect", r.status === 301 && r.headers.get("location") === "/new");

    r = await fetch(BASE + "/legacy/hello", { redirect: "manual" });
    check("tail-preserving redirect", r.status === 302 && r.headers.get("location") === "/api/hello");

    r = await get("/blocked");
    check("preProcess short-circuit", r.status === 403 && (await r.text()) === "blocked");

    r = await get("/hello", { host: "api.test" });
    check("host-based site root", r.status === 200 && (await r.text()) === "Hello, World!");

    // Strict vhost: existing path + unknown Host is 421, never a catch-all.
    r = await get("/api/hello", { host: "nope.test" });
    check("unknown host is 421", r.status === 421);

    // Dedicated site port skips Host matching entirely.
    r = await fetch(`http://127.0.0.1:${PORT2}/ping`);
    check("site port serves without domain", r.status === 200 && (await r.text()) === "pong");

    // streaming bodies: buffered (content-length) and chunked (stream, no length)
    r = await fetch(BASE + "/api/echo", { method: "POST", body: "stream-me" });
    check("buffered POST streams through", r.status === 200 && (await r.text()) === "stream-me");

    const chunks = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk-"));
        c.enqueue(new TextEncoder().encode("body-1"));
        c.close();
      },
    });
    r = await fetch(BASE + "/api/echo", { method: "POST", body: chunks });
    check("chunked POST streams through", r.status === 200 && (await r.text()) === "chunk-body-1");

    const big = new Uint8Array(51 * 1024 * 1024).fill(7);
    r = await fetch(BASE + "/api/echo", { method: "POST", body: big });
    check("oversize declared body is 413", r.status === 413);

    // concurrent burst at a cold entry: one spawn serves all (no double-spawn)
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => fetch(BASE + "/api/slow", { method: "POST", body: "x" })),
    );
    const bodies = await Promise.all(burst.map((b) => b.text()));
    check(
      "concurrent cold burst all succeed",
      burst.every((b) => b.status === 200) && bodies.every((t) => t === "slow-ok"),
    );

    // mtime-triggered process replacement
    write(
      "api/hello.ts",
      `// @lightserver:main
export default async function init(ctx: any) {
  ctx.onRequest(async () => new Response("Hello v2!"));
}
`,
    );
    let v2 = false;
    for (let i = 0; i < 75; i++) {
      await new Promise((r2) => setTimeout(r2, 200));
      try {
        const rr = await get("/api/hello");
        if ((await rr.text()) === "Hello v2!") {
          v2 = true;
          break;
        }
      } catch {
        // ignore transient
      }
    }
    check("mtime change replaces process", v2);

    // logs go to the data-dir file, not stdout
    await new Promise((r2) => setTimeout(r2, 1500));
    let logOk = false;
    try {
      const text = fs.readFileSync(path.join(dataDir, "lightserver.log"), "utf8");
      const lines = text.trim().split("\n").map((l) => JSON.parse(l));
      logOk = lines.length > 5 && lines.some((l) => String(l.msg).startsWith("lightserver listening"));
    } catch {
      logOk = false;
    }
    check("request logs appended to file", logOk);
  } finally {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 8000))]);
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "E2E PASS" : `E2E FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
