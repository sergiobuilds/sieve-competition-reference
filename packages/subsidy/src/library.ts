import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Library, Program, RuleChunk } from "../../rules/src/library.js";

export const librarySchema = z.object({
  builtAt: z.string(),
  programs: z.array(z.object({ id: z.string(), name: z.string(), aliases: z.array(z.string()), agency: z.string(), ministryRegulation: z.string().nullable(), layer2Docs: z.array(z.string()) })),
  documents: z.array(z.object({ id: z.string(), title: z.string(), layer: z.enum(["L1", "L2"]) })),
  chunks: z.array(z.object({ id: z.string(), layer: z.enum(["L1", "L2"]), docId: z.string(), docTitle: z.string(), section: z.string(), text: z.string() })),
});
export type SubsidyLibrary = z.infer<typeof librarySchema> & { readonly version: string };
export const COMMON_DOCS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "FRAUD-G"] as const;

export function readSubsidyLibrary(path: string): SubsidyLibrary {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = librarySchema.parse(raw);
  return { ...parsed, version: "subsidy-" + parsed.builtAt + "-" + createHash("sha256").update(JSON.stringify(parsed)).digest("hex").slice(0, 12) };
}

export function applicableDocuments(library: SubsidyLibrary, program: Program) {
  const ids = new Set<string>([...COMMON_DOCS, ...program.layer2Docs, ...(program.ministryRegulation ? [program.ministryRegulation] : [])]);
  return library.documents.filter((d) => ids.has(d.id)).map((d) => ({ ...d, chunkCount: library.chunks.filter((c) => c.docId === d.id).length }));
}

export function scopedLibrary(library: SubsidyLibrary, program: Program): Library {
  const ids = new Set(applicableDocuments(library, program).map((d) => d.id));
  return { programs: [program], chunks: library.chunks.filter((c) => ids.has(c.docId)) };
}

export function browseRules(library: SubsidyLibrary, program: Program, docId: string, query: string, offset: number) {
  const documents = applicableDocuments(library, program);
  const allowed = new Set(documents.map((d) => d.id));
  const needle = query.normalize("NFKC").toLowerCase().trim();
  const chunks: RuleChunk[] = library.chunks.filter((c) => allowed.has(c.docId) && (!docId || c.docId === docId) && (!needle || (c.docTitle + " " + c.section + " " + c.text).normalize("NFKC").toLowerCase().includes(needle)));
  return { version: library.version, program, documents, chunks: chunks.slice(offset, offset + 30), total: chunks.length, offset, limit: 30 };
}
