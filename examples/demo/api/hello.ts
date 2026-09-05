// @lightserver:main
import type { ServiceContext } from "lightserver";
import { helper } from "./helper.ts";

export default async function init(ctx: ServiceContext) {
  ctx.onRequest(async (req: Request) => {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") || helper();
    const greeting = (ctx.config.greeting as string | undefined) ?? "Hello";
    return Response.json({ message: `${greeting}, ${name}!`, site: ctx.site });
  });
}
