#!/usr/bin/env bun
/**
 * Model pricing unit test. Verifies alias/family resolution and that computed
 * cost matches Claude Code's headless total_cost_usd for a captured turn.
 */
import { buildModelUsage, computeCostUsd, resolveModelCostRates, resolveModelLimits } from "./model-pricing.ts";
import { MODEL_COST_RATES } from "./model-pricing-data.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};
const near = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

// Resolution: exact id, alias, family substring, context-window suffix.
ok("exact id resolves", resolveModelCostRates("claude-opus-4-8")?.input === 5);
ok("short alias resolves", resolveModelCostRates("opus")?.input === 5);
ok("family alias resolves", resolveModelCostRates("claude-opus")?.input === 5);
ok("sonnet alias resolves", resolveModelCostRates("sonnet")?.output === 15);
ok("haiku alias resolves", resolveModelCostRates("haiku")?.input === 1);
ok("[1m] suffix is stripped", resolveModelCostRates("claude-opus-4-8[1m]")?.input === 5);
ok("unknown id falls back via family substring", resolveModelCostRates("claude-opus-4-9")?.input === 5);
ok("case-insensitive", resolveModelCostRates("Claude-Opus-4-8")?.input === 5);
ok("unknown model returns null", resolveModelCostRates("gpt-4o") === null);
ok("undefined model returns null", resolveModelCostRates(undefined) === null);

// Cost matches the captured headless run exactly (opus-4-8, 1h cache write):
// 16287*5 + 4*25 + 15536*0.5 + 3902*(5*2) per Mtok = 0.128323
const captured = computeCostUsd("claude-opus-4-8", {
  input_tokens: 16287,
  output_tokens: 4,
  cache_read_input_tokens: 15536,
  cache_creation_input_tokens: 3902,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3902 },
});
ok("computed cost matches headless total_cost_usd to the cent", near(captured, 0.128323));

// 5-minute cache write uses the lower (1.25x) rate.
const fiveMin = computeCostUsd("claude-opus-4-8", {
  input_tokens: 1000,
  output_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
});
// 1000*5 + 1000*6.25 = 11250 microUSD = 0.01125
ok("5-minute cache write uses 1.25x rate", near(fiveMin, 0.01125));

// Without a 5m/1h split, cache_creation_input_tokens is billed at the 5m rate.
const noSplit = computeCostUsd("claude-opus-4-8", {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 1000,
});
ok("cache_creation without split uses 5m rate", near(noSplit, 0.00625));

// Plain output/input only.
const simple = computeCostUsd("claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
ok("simple input+output cost", near(simple, 3 + 15));

ok("null usage returns null", computeCostUsd("claude-opus-4-8", undefined) === null);
ok("null model returns null", computeCostUsd(undefined, { input_tokens: 10 }) === null);

// Limits + modelUsage.
ok("resolveModelLimits exact", resolveModelLimits("claude-opus-4-8")?.contextWindow === 1000000);
ok("resolveModelLimits alias", resolveModelLimits("opus")?.maxOutputTokens === 128000);
ok("resolveModelLimits unknown -> null", resolveModelLimits("gpt-4o") === null);

const mu = buildModelUsage("claude-opus-4-8", {
  input_tokens: 16287,
  output_tokens: 4,
  cache_read_input_tokens: 15536,
  cache_creation_input_tokens: 3902,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3902 },
  server_tool_use: { web_search_requests: 2 },
});
const entry = mu?.["claude-opus-4-8"] as Record<string, number>;
ok("buildModelUsage: keyed by model", !!entry);
ok("buildModelUsage: token + cost fields",
  entry.inputTokens === 16287 && entry.outputTokens === 4 &&
  entry.cacheReadInputTokens === 15536 && entry.cacheCreationInputTokens === 3902 &&
  entry.webSearchRequests === 2 && near(entry.costUSD ?? null, 0.128323));
ok("buildModelUsage: limits attached",
  entry.contextWindow === 1000000 && entry.maxOutputTokens === 128000);
ok("buildModelUsage: null for unknown model/usage",
  buildModelUsage("gpt", undefined) === null && buildModelUsage(undefined, { input_tokens: 1 }) === null);

// Data sanity.
ok("data file has opus-4-8", "claude-opus-4-8" in MODEL_COST_RATES);
ok("all rates are positive numbers", Object.values(MODEL_COST_RATES).every(r =>
  r.input > 0 && r.output > 0 && r.cacheRead >= 0 && r.cacheWrite5m >= 0
));

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
