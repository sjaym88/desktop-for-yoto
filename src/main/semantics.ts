import { app } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { pipeline, env } from "@huggingface/transformers";

interface IconLite {
  mediaId: string;
  title: string;
  url: string;
  tags: string[];
}

interface State {
  extractor: ((text: string | string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>) | null;
  loading: Promise<void> | null;
  iconVectors: Map<string, Float32Array>;
  iconLibVersion: number;
}

const state: State = {
  extractor: null,
  loading: null,
  iconVectors: new Map(),
  iconLibVersion: 0,
};

function modelsRoot(): string {
  // In dev: <projectRoot>/models. In packaged app: process.resourcesPath/models.
  const dev = path.resolve(__dirname, "..", "models");
  if (existsSync(dev)) return dev;
  return path.join(process.resourcesPath || dev, "models");
}

async function ensureExtractor(): Promise<void> {
  if (state.extractor) return;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    env.localModelPath = modelsRoot();
    env.cacheDir = path.join(app.getPath("userData"), "model-cache");
    env.allowRemoteModels = false;
    state.extractor = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",
    })) as unknown as State["extractor"];
  })();
  await state.loading;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  await ensureExtractor();
  const out = await state.extractor!(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[1];
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(out.data.slice(i * dim, (i + 1) * dim) as Float32Array);
  }
  return vectors;
}

export async function ensureIconsEmbedded(icons: IconLite[]): Promise<void> {
  // Re-embed only if library composition changed (cardinality + ordered ids hash)
  const sig = icons.length + ":" + icons.slice(0, 32).map((i) => i.mediaId).join("");
  const hashed = simpleHash(sig);
  if (hashed === state.iconLibVersion && state.iconVectors.size === icons.length) return;

  const texts = icons.map(
    (i) => `${i.title || ""}. ${(i.tags || []).filter(Boolean).join(", ")}`.trim()
  );
  // Embed in batches to avoid memory spikes
  const batchSize = 64;
  state.iconVectors.clear();
  for (let i = 0; i < icons.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const vecs = await embedBatch(slice);
    for (let j = 0; j < slice.length; j++) {
      state.iconVectors.set(icons[i + j].mediaId, vecs[j]);
    }
  }
  state.iconLibVersion = hashed;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export interface MatchResult {
  title: string;
  mediaId: string | null;
  url: string | null;
  iconTitle: string | null;
  score: number;
}

const STOP = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","is","are","was","were","be","been","being",
  "it","its","this","that","these","those","my","your","our","their","i","you","he","she","they","we","me","him","her","them","us",
  "do","does","did","done","have","has","had","will","would","could","should","may","might","can",
  "just","not","no","yes","up","down","out","off","over","under","into","onto","than","then","so","as","if",
  "song","track","title","intro","outro","interlude","bonus","disc","cd","mp3","aac","opus","ogg","pt","part","vol","volume","ep","lp",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[''']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

function tagBoost(titleWords: string[], icon: IconLite): number {
  if (titleWords.length === 0) return 0;
  const wordSet = new Set<string>();
  for (const w of titleWords) {
    wordSet.add(w);
    if (w.length > 3 && w.endsWith("s")) wordSet.add(w.slice(0, -1));
    else wordSet.add(w + "s");
  }
  let boost = 0;
  const tags = (icon.tags || []).map((t) => t.toLowerCase()).filter((t) => t.length >= 4);
  for (const tag of tags) {
    if (wordSet.has(tag)) boost += 0.15;
  }
  const iconTitleTokens = (icon.title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  for (const tt of iconTitleTokens) {
    if (wordSet.has(tt)) boost += 0.05;
  }
  return Math.min(boost, 0.4);
}

export async function matchTitles(
  titles: string[],
  icons: IconLite[],
  threshold = 0
): Promise<MatchResult[]> {
  await ensureIconsEmbedded(icons);
  if (titles.length === 0) return [];
  const queryVecs = await embedBatch(titles);

  return titles.map((title, qi) => {
    const q = queryVecs[qi];
    const titleWords = tokenize(title);
    let best: IconLite | null = null;
    let bestScore = -Infinity;
    let bestCosine = -Infinity;
    for (const icon of icons) {
      const v = state.iconVectors.get(icon.mediaId);
      if (!v) continue;
      const c = cosine(q, v);
      const score = c + tagBoost(titleWords, icon);
      if (score > bestScore) {
        bestScore = score;
        bestCosine = c;
        best = icon;
      }
    }
    if (!best || bestScore < threshold) {
      return { title, mediaId: null, url: null, iconTitle: null, score: bestCosine };
    }
    return {
      title,
      mediaId: best.mediaId,
      url: best.url,
      iconTitle: best.title,
      score: bestScore,
    };
  });
}
