#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type OutputFormat = "text" | "json" | "stream-json";

type BridgeResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  error?: string;
  result?: string;
  raw_response?: string;
  structured_output?: unknown;
};
type TranscriptRow = Record<string, unknown> & { type?: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
if (!existsSync(REPO)) fail(`Repository path does not exist: ${REPO}`);

const OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "stream-json"]);
const schema = truthy(process.env.CLAUDE_BRIDGE_SMOKE_SCHEMA);
const localAuth = truthy(process.env.CLAUDE_BRIDGE_SMOKE_LOCAL_AUTH);
const desplegaFormat = truthy(process.env.CLAUDE_BRIDGE_SMOKE_DESPLEGA_FORMAT);
const outputFormat = (process.env.CLAUDE_BRIDGE_SMOKE_OUTPUT_FORMAT ?? "text") as OutputFormat;
const model = process.env.CLAUDE_BRIDGE_SMOKE_MODEL ?? "sonnet";
const timeoutMs = envInt("CLAUDE_BRIDGE_SMOKE_TIMEOUT_MS", 300_000);
const outPath =
  process.env.CLAUDE_BRIDGE_SMOKE_OUT ??
  `/tmp/claude-bridge-live-smoke-${outputFormat}-${schema ? "schema" : "plain"}.out`;

if (!OUTPUT_FORMATS.has(outputFormat)) {
  fail(`Unsupported CLAUDE_BRIDGE_SMOKE_OUTPUT_FORMAT: ${outputFormat}`);
}

const jsonSchema = {
  type: "object",
  properties: {
    resp: { type: "string" },
  },
  required: ["resp"],
  additionalProperties: false,
};

const prompt = schema
  ? "Return exactly a JSON object with resp set to ok."
  : "Reply with exactly bridge-ok and no punctuation.";

const args = [
  "./src/cli.ts",
  "--desplega-verbose",
  ...(desplegaFormat ? ["--desplega-format"] : []),
  ...(localAuth ? ["--desplega-local-auth"] : []),
  "-p",
  prompt,
  "--model",
  model,
  "--output-format",
  outputFormat,
];

if (schema) {
  args.push("--json-schema", JSON.stringify(jsonSchema));
}

const env = { ...process.env };
if (!localAuth) {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
  ]) {
    delete env[name];
  }
}

if (!localAuth) {
  const normalizedToken = normalizeClaudeToken(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (normalizedToken) env.CLAUDE_CODE_OAUTH_TOKEN = normalizedToken;
}

env.TERM = "xterm-256color";
if (!localAuth) {
  env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`;
}
env.CLAUDE_BRIDGE_CLAUDE_READY_TIMEOUT_MS =
  process.env.CLAUDE_BRIDGE_CLAUDE_READY_TIMEOUT_MS ?? "240000";
env.CLAUDE_BRIDGE_TMUX_SUBMIT_DELAY_MS =
  process.env.CLAUDE_BRIDGE_TMUX_SUBMIT_DELAY_MS ?? "1000";

console.log(
  `bridge live smoke: output_format=${outputFormat} schema=${schema} model=${model} local_auth=${localAuth} desplega_format=${desplegaFormat}`
);

const run = spawnSync("bun", args, {
  cwd: REPO,
  env,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
  timeout: timeoutMs,
});

const stdout = run.stdout ?? "";
const stderr = run.stderr ?? "";
writeFileSync(outPath, stdout);

if (run.status !== 0) {
  dumpFailure(`claude-bridge exited ${run.status ?? "without a status"}`, stdout, stderr);
}
if (run.error) {
  dumpFailure(`claude-bridge spawn error: ${run.error.message}`, stdout, stderr);
}

try {
  validateSmoke(stdout);
} catch (err) {
  dumpFailure((err as Error).message, stdout, stderr);
}

console.log(`bridge live smoke ok: output_format=${outputFormat} schema=${schema}`);

function validateSmoke(stdout: string): void {
  if (outputFormat === "text") {
    validateText(stdout);
    return;
  }

  if (outputFormat === "stream-json" && !desplegaFormat) {
    validateClaudeCompatStream(stdout);
    return;
  }

  const result = outputFormat === "json" ? parseJsonResult(stdout) : parseBridgeStreamResult(stdout);
  if (result.is_error) {
    throw new Error(
      [
        result.error ?? "Bridge returned an error result.",
        result.raw_response ? `Raw response: ${result.raw_response}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (schema) {
    validateStructuredOutput(result.structured_output);
  } else {
    const text = result.result ?? "";
    if (!text.toLowerCase().includes("bridge-ok")) {
      throw new Error(`Expected result text to include bridge-ok, got: ${JSON.stringify(text)}`);
    }
  }
}

function validateText(stdout: string): void {
  const text = stdout.trim();
  if (schema) {
    validateStructuredOutput(JSON.parse(text));
    return;
  }
  if (!text.toLowerCase().includes("bridge-ok")) {
    throw new Error(`Expected text output to include bridge-ok, got: ${JSON.stringify(text)}`);
  }
}

function validateStructuredOutput(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { resp?: unknown }).resp !== "ok"
  ) {
    throw new Error(`Expected structured_output.resp to equal ok, got: ${JSON.stringify(value)}`);
  }
}

function parseJsonResult(stdout: string): BridgeResult {
  const text = stdout.trim();
  if (!text) throw new Error("Expected json output, got empty stdout.");
  const parsed = JSON.parse(text) as BridgeResult;
  if (parsed.type !== "result") {
    throw new Error(`Expected json result event, got: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function parseBridgeStreamResult(stdout: string): BridgeResult {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("Expected stream-json output, got empty stdout.");

  let final: BridgeResult | null = null;
  for (const line of lines) {
    const parsed = JSON.parse(line) as BridgeResult;
    if (parsed.type === "result") final = parsed;
  }
  if (!final) {
    throw new Error(`Expected final stream-json result event, got ${lines.length} JSONL lines.`);
  }
  return final;
}

function validateClaudeCompatStream(stdout: string): void {
  // Interactive-only transcript wrapper keys that must NOT leak into claude -p
  // compatible assistant/user events. (Declared here, not at module scope, to
  // avoid a temporal-dead-zone error: validateSmoke runs before module consts.)
  const INTERACTIVE_WRAPPER_KEYS = [
    "cwd",
    "gitBranch",
    "sessionId",
    "requestId",
    "timestamp",
    "version",
    "isSidechain",
    "parentUuid",
    "entrypoint",
    "userType",
  ];
  const rows = parseTranscriptRows(stdout);

  // No bridge-owned synthetic delta rows.
  const syntheticDelta = rows.find(row => "delta" in row || "final" in row || "index" in row);
  if (syntheticDelta) {
    throw new Error(`Expected claude -p compatible stream, got synthesized delta row: ${JSON.stringify(syntheticDelta)}`);
  }

  // Only claude -p event types; system rows must be init or a surfaced
  // api_error / model_refusal_fallback. This rejects interactive-only rows
  // (last-prompt, mode, permission-mode, attachment, ai-title,
  // stop_hook_summary, turn_duration, hook_*, local_command, ...).
  const allowedSystem = new Set(["init", "api_error", "model_refusal_fallback"]);
  for (const row of rows) {
    const type = row.type;
    if (type === "system") {
      if (!allowedSystem.has(String(row.subtype))) {
        throw new Error(`Unexpected interactive-only system row in claude -p stream: ${JSON.stringify(row)}`);
      }
      continue;
    }
    if (type !== "assistant" && type !== "user" && type !== "result") {
      throw new Error(`Unexpected interactive-only row type "${String(type)}" in claude -p stream.`);
    }
  }

  if (rows[0]?.type !== "system" || rows[0]?.subtype !== "init") {
    throw new Error(`Expected the first event to be system/init, got: ${JSON.stringify(rows[0])}`);
  }

  const assistantRows = rows.filter(row => row.type === "assistant");
  const assistant = assistantRows[0];
  if (!assistant) throw new Error("Expected an assistant event in claude -p stream-json output.");
  if (!("session_id" in assistant) || !("parent_tool_use_id" in assistant)) {
    throw new Error(`Assistant event missing claude -p wrapper fields: ${JSON.stringify(Object.keys(assistant))}`);
  }
  const leaked = INTERACTIVE_WRAPPER_KEYS.filter(key => key in assistant);
  if (leaked.length) {
    throw new Error(`Assistant event leaked interactive wrapper fields: ${leaked.join(", ")}`);
  }

  const result = rows[rows.length - 1];
  if (result?.type !== "result") {
    throw new Error(`Expected the terminal event to be a result, got: ${JSON.stringify(result)}`);
  }
  if (result.is_error) throw new Error(`Result event reported an error: ${JSON.stringify(result)}`);
  if (typeof result.total_cost_usd !== "number" || (result.total_cost_usd as number) <= 0) {
    throw new Error(`Expected a positive computed total_cost_usd, got: ${JSON.stringify(result.total_cost_usd)}`);
  }

  // Concatenate text across all assistant events. With extended thinking the
  // model emits a separate thinking-only assistant row before the text row, so
  // the first assistant event can carry no text — reading only that row gave
  // JSON.parse("") → "Unexpected EOF" for the schema case.
  const text = assistantRows.map(assistantText).join("").trim();
  if (schema) {
    if (!text) {
      throw new Error("Expected assistant text for schema validation, got none.");
    }
    validateStructuredOutput(JSON.parse(text));
    return;
  }
  if (!text.toLowerCase().includes("bridge-ok")) {
    throw new Error(`Expected stream text to include bridge-ok, got: ${JSON.stringify(text)}`);
  }
}

function parseTranscriptRows(stdout: string): TranscriptRow[] {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("Expected native stream-json transcript rows, got empty stdout.");
  return lines.map(line => JSON.parse(line) as TranscriptRow);
}

function assistantText(row: TranscriptRow): string {
  const message = row.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { text?: unknown };
      return typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("");
}

function dumpFailure(reason: string, stdout: string, stderr: string): never {
  console.error(`bridge live smoke failed: ${reason}`);
  console.error(`output file: ${outPath}`);
  if (stdout.trim()) {
    console.error("--- stdout");
    console.error(stdout.trimEnd());
  }
  if (stderr.trim()) {
    console.error("--- stderr");
    console.error(stderr.trimEnd());
  }
  const paneDump = activeBridgePanes();
  if (paneDump.trim()) {
    console.error("--- active bridge tmux panes");
    console.error(paneDump.trimEnd());
  }
  process.exit(1);
}

function activeBridgePanes(): string {
  const ls = spawnSync("tmux", ["ls"], { encoding: "utf8" });
  const sessions = (ls.stdout ?? "")
    .split(/\r?\n/)
    .map(line => line.split(":")[0])
    .filter(name => name.startsWith("claude-bridge-"));

  const chunks: string[] = [];
  for (const session of sessions) {
    const pane = spawnSync("tmux", ["capture-pane", "-pt", session, "-S", "-120"], {
      encoding: "utf8",
    });
    chunks.push(`--- ${session}\n${(pane.stdout ?? pane.stderr ?? "").trimEnd()}`);
  }
  return chunks.join("\n");
}

function normalizeClaudeToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const token = raw
    .trim()
    .replace(/^CLAUDE_CODE_OAUTH_TOKEN=/, "")
    .replace(/^export CLAUDE_CODE_OAUTH_TOKEN=/, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, "")
    .trim();
  if (!token) return undefined;
  if (!token.startsWith("sk-ant-")) {
    fail("CLAUDE_CODE_OAUTH_TOKEN must be a Claude OAuth token from `claude setup-token`.");
  }
  return token;
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
