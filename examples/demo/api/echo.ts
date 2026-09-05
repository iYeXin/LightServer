// @lightserver:main
import type { ServiceContext } from "@iyexin/lightserver";

export default async function init(ctx: ServiceContext) {
  ctx.onRequest(async (req: Request) => new Response(await req.text()));
}
