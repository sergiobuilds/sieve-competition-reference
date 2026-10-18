import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { VertexProvider } from "../../../packages/models/src/index.js";
import { subsidyRoutes } from "./subsidy.js";

const config = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  GOOGLE_CLOUD_PROJECT: z.string().min(1),
  SIEVE_READER_MODEL: z.string().min(1),
  SIEVE_JUDGE_MODEL: z.string().min(1),
  SIEVE_RECHECK_MODEL: z.string().min(1),
}).parse(process.env);
const app = new Hono();
app.get("/", (c) => c.json({
  product: "Sieve competition API reference",
  scope: "Fictional training rules only. Not a legal review service or full hosted-product reproduction.",
  catalog: "/api/subsidy/catalog", sample: "/api/subsidy/demo?programId=patent",
}));
app.get("/api/health", (c) => c.json({ status: "ok", fixture: "synthetic-not-law" }));
app.route("/api/subsidy", subsidyRoutes({
  root: process.cwd(), provider: new VertexProvider(config.GOOGLE_CLOUD_PROJECT),
  plan: { reader: config.SIEVE_READER_MODEL, judge: config.SIEVE_JUDGE_MODEL, recheck: config.SIEVE_RECHECK_MODEL },
  allow: () => true,
}));
serve({ fetch: app.fetch, port: config.PORT, hostname: "127.0.0.1" });
