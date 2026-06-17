#!/usr/bin/env bun
/**
 * Regenerates src/model-pricing-data.ts from models.dev.
 *
 * models.dev publishes a single JSON document at https://models.dev/api.json
 * keyed by provider. We take the `anthropic` provider's models and emit:
 *   - MODEL_COST_RATES: per-model USD rates per 1,000,000 tokens
 *     (input / output / cache_read / cache_write_5m).
 *   - MODEL_ALIASES: short + family aliases (`opus`, `claude-opus`, ...) pointing
 *     at the newest model in each family, so `--model opus` still resolves a cost.
 *
 * The 1-hour cache-write rate is not stored: Anthropic prices it at 2x base
 * input uniformly, and src/model-pricing.ts derives it at compute time.
 *
 * Usage: bun run scripts/update-model-pricing.ts [--source <url|file>]
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT_PATH = resolve(REPO, "src", "model-pricing-data.ts");
const DEFAULT_SOURCE = "https://models.dev/api.json";

type ModelsDevModel = {
  id: string;
  family?: string;
  release_date?: string;
  last_updated?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
};

type CostRates = { input: number; output: number; cacheRead: number; cacheWrite5m: number };
type Limits = { contextWindow: number; maxOutputTokens: number };

const source = parseSource(process.argv.slice(2)) ?? DEFAULT_SOURCE;

const raw = await loadSource(source);
let parsed: Record<string, { models?: Record<string, ModelsDevModel> }>;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  fail(`Could not parse models.dev payload as JSON: ${(err as Error).message}`);
}

const anthropic = parsed.anthropic;
if (!anthropic?.models) fail("models.dev payload has no `anthropic.models` entry.");
const models = anthropic.models;

const rates: Record<string, CostRates> = {};
const limits: Record<string, Limits> = {};
for (const [id, model] of Object.entries(models)) {
  const cost = model.cost;
  if (!cost || cost.input == null || cost.output == null) continue;
  rates[id] = {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite5m: cost.cache_write ?? cost.input * 1.25,
  };
  if (model.limit?.context != null && model.limit?.output != null) {
    limits[id] = { contextWindow: model.limit.context, maxOutputTokens: model.limit.output };
  }
}
if (Object.keys(rates).length === 0) fail("No Anthropic models with cost data were found.");

const aliases = buildAliases(models, rates);

writeFileSync(OUT_PATH, renderFile(source, rates, limits, aliases));
console.log(
  `Wrote ${OUT_PATH}\n  models: ${Object.keys(rates).length}\n  aliases: ${Object.keys(aliases).length}`
);

function buildAliases(
  models: Record<string, ModelsDevModel>,
  rates: Record<string, CostRates>
): Record<string, string> {
  const byFamily = new Map<string, ModelsDevModel[]>();
  for (const model of Object.values(models)) {
    if (!model.family || !rates[model.id]) continue;
    const list = byFamily.get(model.family) ?? [];
    list.push(model);
    byFamily.set(model.family, list);
  }

  const aliases: Record<string, string> = {};
  for (const [family, list] of byFamily) {
    const newest = pickNewest(list);
    if (!newest) continue;
    aliases[family] = newest.id; // e.g. "claude-opus"
    const short = family.replace(/^claude-/, ""); // e.g. "opus"
    if (short && short !== family) aliases[short] = newest.id;
  }
  return aliases;
}

/** Newest by release_date; prefer date-less ids, then shorter ids, for a stable canonical alias target. */
function pickNewest(list: ModelsDevModel[]): ModelsDevModel | null {
  return [...list].sort((a, b) => {
    const dateA = a.release_date ?? a.last_updated ?? "";
    const dateB = b.release_date ?? b.last_updated ?? "";
    if (dateA !== dateB) return dateA < dateB ? 1 : -1; // newer first
    const datedA = /-\d{8}$/.test(a.id) ? 1 : 0;
    const datedB = /-\d{8}$/.test(b.id) ? 1 : 0;
    if (datedA !== datedB) return datedA - datedB; // prefer date-less
    if (a.id.length !== b.id.length) return a.id.length - b.id.length;
    return a.id < b.id ? -1 : 1;
  })[0] ?? null;
}

function renderFile(
  src: string,
  rates: Record<string, CostRates>,
  limits: Record<string, Limits>,
  aliases: Record<string, string>
): string {
  const rateLines = Object.keys(rates)
    .sort()
    .map(id => {
      const r = rates[id]!;
      return `  ${JSON.stringify(id)}: { input: ${r.input}, output: ${r.output}, cacheRead: ${r.cacheRead}, cacheWrite5m: ${r.cacheWrite5m} },`;
    })
    .join("\n");
  const limitLines = Object.keys(limits)
    .sort()
    .map(id => {
      const l = limits[id]!;
      return `  ${JSON.stringify(id)}: { contextWindow: ${l.contextWindow}, maxOutputTokens: ${l.maxOutputTokens} },`;
    })
    .join("\n");
  const aliasLines = Object.keys(aliases)
    .sort()
    .map(alias => `  ${JSON.stringify(alias)}: ${JSON.stringify(aliases[alias])},`)
    .join("\n");

  return `// AUTO-GENERATED by scripts/update-model-pricing.ts — DO NOT EDIT BY HAND.
// Source: ${src} (anthropic provider).
// Regenerate: bun run scripts/update-model-pricing.ts
// Rates are USD per 1,000,000 tokens. cacheWrite5m is the 5-minute cache-write
// rate; the 1-hour rate is derived in model-pricing.ts as 2x input.

export type ModelCostRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
};

export type ModelLimits = {
  contextWindow: number;
  maxOutputTokens: number;
};

export const MODEL_COST_RATES: Record<string, ModelCostRates> = {
${rateLines}
};

export const MODEL_LIMITS: Record<string, ModelLimits> = {
${limitLines}
};

/** Short + family aliases pointing at the newest model in each family. */
export const MODEL_ALIASES: Record<string, string> = {
${aliasLines}
};
`;
}

function parseSource(argv: string[]): string | null {
  const i = argv.indexOf("--source");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]!;
  return null;
}

async function loadSource(src: string): Promise<string> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) fail(`Fetch of ${src} failed: ${res.status} ${res.statusText}`);
    return res.text();
  }
  const file = Bun.file(resolve(REPO, src));
  if (!(await file.exists())) fail(`Source file does not exist: ${src}`);
  return file.text();
}

function fail(message: string): never {
  console.error(`update-model-pricing: ${message}`);
  process.exit(1);
}
