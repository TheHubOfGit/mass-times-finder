import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import { api } from "./api";
import type { Env } from "./core";
import { createServer } from "./mcp";

const app = new Hono<{ Bindings: Env }>();

app.route("/v1", api);

app.all("/mcp", async (c) => {
  if (c.env.MCP_LIMITER) {
    const ip = c.req.header("cf-connecting-ip") ?? "local";
    const { success } = await c.env.MCP_LIMITER.limit({ key: ip });
    if (!success) return c.json({ error: "rate limited; try again in a minute" }, 429);
  }
  const handler = createMcpHandler(() => createServer(c.env), { route: "/mcp" });
  return handler(c.req.raw, c.env, c.executionCtx as ExecutionContext);
});

// Everything else is the PWA (static assets, single-page-app fallback) once web/ is built.
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text("Mass Times Finder API: see /v1/meta");
});

export default app;
