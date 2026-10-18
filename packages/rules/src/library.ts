import { readFileSync } from "node:fs";

export interface RuleChunk {
  id: string;
  layer: "L1" | "L2";
  docId: string;
  docTitle: string;
  section: string;
  text: string;
}

export interface Program {
  id: string;
  name: string;
  aliases: string[];
  agency: string;
  ministryRegulation: string | null;
  layer2Docs: string[];
}

export interface Library {
  programs: Program[];
  chunks: RuleChunk[];
}

const COMMON_L1 = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "FRAUD-G"];
const PROCEDURAL_SECTION = /시행일|재검토기한|적용례|벌칙|과태료|목적\)|위원회|경과조치/;

export function loadLibrary(path: string): Library {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Library;
  return { programs: raw.programs, chunks: raw.chunks };
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s·・\-_()\[\]「」『』"'.,:;]/g, "");
}

export function identifyProgram(lib: Library, name: string): Program | null {
  const n = normalize(name);
  const exact = lib.programs.find((p) => normalize(p.name) === n);
  if (exact) return exact;
  const scored = lib.programs
    .map((p) => ({ p, hit: [p.name, ...p.aliases].filter((a) => n.includes(normalize(a))).map((a) => normalize(a).length) }))
    .filter((x) => x.hit.length > 0)
    .sort((a, b) => Math.max(...b.hit) - Math.max(...a.hit));
  return scored[0]?.p ?? null;
}

function grams(text: string): string[] {
  const t = normalize(text);
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

interface Index {
  docFreq: Map<string, number>;
  vectors: Map<string, Map<string, number>>;
  lengths: Map<string, number>;
  avgLength: number;
  total: number;
}

const indexCache = new WeakMap<Library, Index>();

function index(lib: Library): Index {
  const cached = indexCache.get(lib);
  if (cached) return cached;
  const docFreq = new Map<string, number>();
  const vectors = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  for (const c of lib.chunks) {
    const tf = new Map<string, number>();
    const g = grams(c.section + " " + c.text);
    for (const x of g) tf.set(x, (tf.get(x) ?? 0) + 1);
    vectors.set(c.id, tf);
    lengths.set(c.id, g.length);
    for (const x of tf.keys()) docFreq.set(x, (docFreq.get(x) ?? 0) + 1);
  }
  const total = lib.chunks.length;
  const avgLength = [...lengths.values()].reduce((s, v) => s + v, 0) / Math.max(1, total);
  const built = { docFreq, vectors, lengths, avgLength, total };
  indexCache.set(lib, built);
  return built;
}

function bm25(idx: Index, chunkId: string, query: string[]): number {
  const tf = idx.vectors.get(chunkId);
  if (!tf) return 0;
  const len = idx.lengths.get(chunkId) ?? 0;
  let score = 0;
  for (const q of new Set(query)) {
    const f = tf.get(q);
    if (!f) continue;
    const df = idx.docFreq.get(q) ?? 0;
    const idf = Math.log(1 + (idx.total - df + 0.5) / (df + 0.5));
    score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (len / idx.avgLength)));
  }
  return score;
}

export interface RetrievedRules {
  program: Program | null;
  layer2: RuleChunk[];
  layer1: RuleChunk[];
}

export function retrieveRules(lib: Library, program: Program | null, query: string, k2 = 5, k1 = 3): RetrievedRules {
  const idx = index(lib);
  const q = grams(query);
  const l2Docs = new Set(program?.layer2Docs ?? []);
  const l1Docs = new Set([...COMMON_L1, ...(program?.ministryRegulation ? [program.ministryRegulation] : [])]);
  const rank = (filter: (c: RuleChunk) => boolean, k: number) =>
    lib.chunks
      .filter(filter)
      .map((c) => ({ c, s: bm25(idx, c.id, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.c);
  const commonCandidates = rank((c) => c.layer === "L1" && l1Docs.has(c.docId) && !PROCEDURAL_SECTION.test(c.section), lib.chunks.length);
  const coveredDocs = new Set<string>();
  const representative = commonCandidates.filter((c) => {
    if (coveredDocs.has(c.docId)) return false;
    coveredDocs.add(c.docId);
    return true;
  });
  const representativeIds = new Set(representative.map((c) => c.id));
  const layer1 = [...representative, ...commonCandidates.filter((c) => !representativeIds.has(c.id))].slice(0, k1);
  return {
    program,
    layer2: program ? rank((c) => c.layer === "L2" && l2Docs.has(c.docId), k2) : [],
    layer1,
  };
}


