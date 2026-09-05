import { describe, expect, test } from "bun:test";
import { createRouter } from "../src/router.ts";

const fakeCtx = (subPath: string) => ({ subPath });

describe("createRouter", () => {
  test("matches methods, params and root", async () => {
    const r = createRouter(fakeCtx("/123"));
    r.get("/", async () => new Response("root"));
    r.get("/:id", async (_req, p) => new Response(`id=${p.id}`));
    r.post("/:id", async (_req, p) => new Response(`post=${p.id}`));

    expect(await (await r.handle(new Request("http://x/123"))).text()).toBe("id=123");
    const post = await r.handle(new Request("http://x/123", { method: "POST" }));
    expect(await post.text()).toBe("post=123");
  });

  test("falls back to request pathname without subPath", async () => {
    const r = createRouter(fakeCtx(""));
    r.get("/a/b", async () => new Response("ab"));
    const resp = await r.handle(new Request("http://x/a/b"));
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ab");
  });

  test("trailing * captures the rest; no match is 404", async () => {
    const r = createRouter(fakeCtx("/files/a/b"));
    r.get("/files/*", async (_req, p) => new Response(`wild=${p["*"]}`));
    const hit = await r.handle(new Request("http://x/files/a/b"));
    expect(await hit.text()).toBe("wild=a/b");
    // subPath takes precedence over the request URL, so 404 needs its own ctx
    const r2 = createRouter(fakeCtx(""));
    r2.get("/files/*", async (_req, p) => new Response(`wild=${p["*"]}`));
    const miss = await r2.handle(new Request("http://x/nope"));
    expect(miss.status).toBe(404);
  });

  test("all() matches any method", async () => {
    const r = createRouter(fakeCtx(""));
    r.all("/x", async (req) => new Response(`m=${req.method}`));
    expect(await (await r.handle(new Request("http://x/x", { method: "DELETE" }))).text()).toBe("m=DELETE");
  });

  test("query() parses search params, repeats become arrays", () => {
    const r = createRouter(fakeCtx(""));
    expect(r.query(new Request("http://x/s?name=Bun&n=1&n=2&empty=&enc=%E4%B8%AD"))).toEqual({
      name: "Bun",
      n: ["1", "2"],
      empty: "",
      enc: "中",
    });
    expect(r.query(new Request("http://x/s"))).toEqual({});
  });
});
