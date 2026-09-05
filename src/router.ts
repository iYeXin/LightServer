import type {
  RouteHandler,
  Router,
  ServiceContext,
} from "./service-types.ts";

interface CompiledRoute {
  method: string; // upper-case, or "ALL"
  pattern: string;
  segs: string[];
  handler: RouteHandler;
}

function splitPath(p: string): string[] {
  const clean = p.replace(/\/+/g, "/");
  const trimmed = clean.replace(/^\/|\/$/g, "");
  if (trimmed === "") return [];
  return trimmed.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

function normalizePattern(pattern: string): string {
  if (!pattern.startsWith("/")) pattern = "/" + pattern;
  pattern = pattern.replace(/\/+/g, "/");
  if (pattern.length > 1) pattern = pattern.replace(/\/$/, "");
  return pattern;
}

/**
 * Minimal sub-path router for `(prefix).ts` entries. Usable everywhere:
 * matches against `ctx.subPath` when set, otherwise the request pathname.
 * `:param` matches one segment; a trailing `*` captures the rest.
 */
export function createRouter(boundCtx?: Pick<ServiceContext, "subPath">): Router {
  const routes: CompiledRoute[] = [];

  function add(method: string, pattern: string, handler: RouteHandler): Router {
    if (typeof handler !== "function") throw new Error("router handler must be a function");
    const p = normalizePattern(pattern);
    routes.push({ method: method.toUpperCase(), pattern: p, segs: splitPath(p), handler });
    return api;
  }

  async function handle(req: Request): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const base =
      boundCtx?.subPath && boundCtx.subPath.length > 0 ? boundCtx.subPath : pathname;
    const path = base.startsWith("/") ? base : "/" + base;
    const method = req.method.toUpperCase();
    const segs = splitPath(path);

    for (const route of routes) {
      if (route.method !== "ALL" && route.method !== method) continue;
      const params: Record<string, string> = {};
      const rs = route.segs;
      let ok = true;
      let i = 0;
      for (; i < rs.length; i++) {
        const r = rs[i];
        if (r === "*") {
          params["*"] = segs.slice(i).join("/");
          i = segs.length;
          break;
        }
        const s = segs[i];
        if (s === undefined) {
          ok = false;
          break;
        }
        if (r.startsWith(":")) {
          if (r.length < 2) {
            ok = false;
            break;
          }
          params[r.slice(1)] = s;
        } else if (r !== s) {
          ok = false;
          break;
        }
      }
      if (ok && rs[rs.length - 1] !== "*" && segs.length !== rs.length) ok = false;
      if (!ok) continue;
      return route.handler(req, params);
    }
    return new Response("not found", { status: 404 });
  }

  const api: Router = {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    put: (p, h) => add("PUT", p, h),
    delete: (p, h) => add("DELETE", p, h),
    patch: (p, h) => add("PATCH", p, h),
    options: (p, h) => add("OPTIONS", p, h),
    head: (p, h) => add("HEAD", p, h),
    query: (p, h) => add("QUERY", p, h),
    all: (p, h) => add("ALL", p, h),
    handle,
  };
  return api;
}
