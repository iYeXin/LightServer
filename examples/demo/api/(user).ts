// @lightserver:main
import type { ServiceContext } from "@iyexin/lightserver";

export default async function init(ctx: ServiceContext) {
  const router = ctx.util.createRouter();

  router.get("/", async () => new Response("User root"));
  router.get("/:id", async (_req, params) => new Response(`User ${params.id}`));
  router.put("/:id/update", async (_req, params) => new Response(`Update ${params.id}`));

  ctx.onRequest(async (req: Request) => {
    return router.handle(req);
  });
}
