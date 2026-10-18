import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { ModelProvider } from "../../../packages/models/src/index.js";
import { browseRules, readSubsidyLibrary, type SubsidyLibrary } from "../../../packages/subsidy/src/library.js";
import { CHECKLIST, demoInput, programFor, screenInputSchema, screenSubsidy, UnknownSubsidyProgram } from "../../../packages/subsidy/src/screen.js";

export interface SubsidyOptions {
  readonly root: string;
  readonly provider: ModelProvider;
  readonly plan: { readonly reader: string; readonly judge: string; readonly recheck: string };
  readonly allow: () => boolean;
  readonly libraryPath?: string;
  readonly cacheDir?: string;
}

const browseInput = z.object({ programId: z.string().min(1).max(100), docId: z.string().max(100).default(""), q: z.string().max(300).default(""), offset: z.coerce.number().int().min(0).max(100000).default(0) });

export function subsidyRoutes(options: SubsidyOptions) {
  const app = new Hono();
  let library: SubsidyLibrary | undefined;
  const path = options.libraryPath ?? join(options.root, "data/subsidy/library.json");
  app.use("*", async (c, next) => {
    if (!existsSync(path)) return c.json({ error: "The subsidy regulation library is unavailable. Import the regulation snapshot before running a review." }, 503);
    library ??= readSubsidyLibrary(path);
    await next();
  });
  app.get("/catalog", (c) => {
    if (!library) return c.json({ error: "Regulation library unavailable." }, 503);
    return c.json({ version: library.version, programs: library.programs, documents: library.documents, stats: { programs: library.programs.length, documents: library.documents.length, chunks: library.chunks.length }, questionnaire: CHECKLIST });
  });
  app.get("/rules", (c) => {
    if (!library) return c.json({ error: "Regulation library unavailable." }, 503);
    const input = browseInput.safeParse(c.req.query());
    if (!input.success) return c.json({ error: "Select a program and a valid page." }, 400);
    const program = programFor(library, input.data.programId);
    return c.json(browseRules(library, program, input.data.docId, input.data.q, input.data.offset));
  });
  app.get("/demo", (c) => {
    if (!library) return c.json({ error: "Regulation library unavailable." }, 503);
    return c.json(demoInput(library, c.req.query("programId") ?? "patent"));
  });
  app.post("/screen", async (c) => {
    if (!library) return c.json({ error: "Regulation library unavailable." }, 503);
    const input = screenInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Check the program, amount, project dates and evidence text. Document identifiers must be unique." }, 400);
    programFor(library, input.data.programId);
    if (!options.allow()) return c.json({ error: "Today's live check limit is used up. Try again tomorrow." }, 429);
    const result = await screenSubsidy(input.data, library, { provider: options.provider, ...options.plan, cacheDir: options.cacheDir ?? join(tmpdir(), "sieve-subsidy-extract") });
    return c.json(result);
  });
  app.onError((error, c) => {
    if (error instanceof UnknownSubsidyProgram) return c.json({ error: error.message }, 404);
    return c.json({ error: "The subsidy review could not finish. No successful result was recorded. Please retry." }, 503);
  });
  return app;
}
