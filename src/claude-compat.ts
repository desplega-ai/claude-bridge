/**
 * Reshape interactive-transcript rows into the event stream that
 * `claude -p --output-format stream-json` emits, so the bridge is a drop-in.
 *
 * The bridge reads the interactive transcript (the only data it has), which
 * carries extra rows (last-prompt, mode, permission-mode, attachment, ai-title,
 * stop_hook_summary, turn_duration) and different wrapper field names
 * (sessionId vs session_id). Headless `claude -p` emits only system/init,
 * assistant, user (tool results), and a terminal result event.
 *
 * What we can reproduce exactly: assistant/user events (field-remapped) and
 * total_cost_usd (recomputed from usage, see model-pricing.ts). What we cannot:
 * the init event's tool/mcp/agent/skill/plugin inventories and the headless
 * API-client timings (ttft_ms, duration_api_ms) — those are absent from the
 * interactive path, so synthesized init is thin and those timings are omitted.
 */
import { buildModelUsage, computeCostUsd, type TokenUsage } from "./model-pricing.ts";

export type TranscriptRow = Record<string, unknown> & { type?: string; message?: unknown };
export type ClaudeEvent = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
}

export function modelFromAssistantRow(row: TranscriptRow): string | undefined {
  const model = asRecord(row.message)?.model;
  return typeof model === "string" ? model : undefined;
}

export function stopReasonFromAssistantRow(row: TranscriptRow): string | undefined {
  const reason = asRecord(row.message)?.stop_reason;
  return typeof reason === "string" ? reason : undefined;
}

/** Headless echoes user events only for tool results, not the initiating prompt. */
export function isToolResultUserRow(row: TranscriptRow): boolean {
  const content = asRecord(row.message)?.content;
  return Array.isArray(content) && content.some(part => asRecord(part)?.type === "tool_result");
}

export function makeClaudeInitEvent(opts: {
  sessionId?: string;
  cwd?: string;
  model?: string;
  version?: string;
  uuid?: string;
  permissionMode?: string;
  apiKeySource?: string | null;
  outputStyle?: string;
  memoryPaths?: Record<string, unknown>;
}): ClaudeEvent {
  return {
    type: "system",
    subtype: "init",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    // The interactive transcript never exposes the live session inventory, so
    // these are emitted as empty placeholders for shape parity with headless.
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    agents: [],
    skills: [],
    plugins: [],
    ...(opts.model ? { model: opts.model } : {}),
    permissionMode: opts.permissionMode ?? "default",
    apiKeySource: opts.apiKeySource ?? null,
    output_style: opts.outputStyle ?? "default",
    memory_paths: opts.memoryPaths ?? {},
    fast_mode_state: "off",
    ...(opts.version ? { claude_code_version: opts.version } : {}),
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
  };
}

export function reshapeAssistantEvent(row: TranscriptRow, sessionId?: string): ClaudeEvent {
  const session = firstString(row.sessionId, sessionId);
  const requestId = firstString(row.requestId);
  const uuid = firstString(row.uuid);
  return {
    type: "assistant",
    message: row.message ?? {},
    parent_tool_use_id: firstString(row.toolUseID) ?? null,
    ...(session ? { session_id: session } : {}),
    ...(uuid ? { uuid } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

export function reshapeUserEvent(row: TranscriptRow, sessionId?: string): ClaudeEvent | null {
  if (!isToolResultUserRow(row)) return null;
  const session = firstString(row.sessionId, sessionId);
  const uuid = firstString(row.uuid);
  return {
    type: "user",
    message: row.message ?? {},
    parent_tool_use_id: firstString(row.toolUseID) ?? null,
    ...(session ? { session_id: session } : {}),
    ...(uuid ? { uuid } : {}),
  };
}

// Interactive system rows worth surfacing. Headless retries internally and
// stays silent on these, so emitting them makes the bridge a superset: a
// claude -p consumer that switches on `type`/`subtype` can ignore them.
const SURFACED_SYSTEM_SUBTYPES = new Set(["api_error", "model_refusal_fallback"]);
const SYSTEM_EVENT_FIELDS = [
  // api_error (rate limit / overloaded / network retry)
  "error",
  "cause",
  "retryAttempt",
  "retryInMs",
  "maxRetries",
  "level",
  "slug",
  // model_refusal_fallback (safety refusal -> fallback model)
  "direction",
  "content",
  "trigger",
  "originalModel",
  "fallbackModel",
  "apiRefusalCategory",
  "apiRefusalExplanation",
];

/** Reshape a surfaced system row (api_error / model_refusal_fallback), or null. */
export function reshapeSystemEvent(row: TranscriptRow, sessionId?: string): ClaudeEvent | null {
  const subtype = (row as { subtype?: unknown }).subtype;
  if (typeof subtype !== "string" || !SURFACED_SYSTEM_SUBTYPES.has(subtype)) return null;
  const event: ClaudeEvent = { type: "system", subtype };
  for (const key of SYSTEM_EVENT_FIELDS) {
    if (key in row) event[key] = (row as Record<string, unknown>)[key];
  }
  const session = firstString(row.sessionId, sessionId);
  if (session) event.session_id = session;
  const uuid = firstString(row.uuid);
  if (uuid) event.uuid = uuid;
  return event;
}

/** Reshape one transcript row into a claude -p stream event, or null to drop it. */
export function transcriptRowToClaudeStreamEvent(
  row: TranscriptRow,
  sessionId?: string
): ClaudeEvent | null {
  if (row.type === "assistant") return reshapeAssistantEvent(row, sessionId);
  if (row.type === "user") return reshapeUserEvent(row, sessionId);
  if (row.type === "system") return reshapeSystemEvent(row, sessionId);
  return null; // synthesized init + interactive-only rows handled elsewhere
}

/** Extract the HTTP status from an api_error transcript row, if present. */
export function apiErrorStatusFromRow(row: TranscriptRow): number | null {
  const error = (row as { error?: unknown }).error;
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
}

export function makeClaudeResultEvent(opts: {
  resultText: string;
  sessionId?: string;
  durationMs?: number;
  model?: string;
  usage?: TokenUsage;
  stopReason?: string;
  numTurns?: number;
  structuredOutput?: { present: boolean; value: unknown };
  uuid?: string;
}): ClaudeEvent {
  const cost = computeCostUsd(opts.model, opts.usage);
  const modelUsage = buildModelUsage(opts.model, opts.usage);
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    api_error_status: null,
    // API-client timings are not observable from the interactive path.
    duration_ms: opts.durationMs ?? null,
    duration_api_ms: null,
    ttft_ms: null,
    ttft_stream_ms: null,
    time_to_request_ms: null,
    num_turns: opts.numTurns ?? 1,
    result: opts.resultText,
    stop_reason: opts.stopReason ?? null,
    session_id: opts.sessionId ?? null,
    total_cost_usd: cost,
    usage: opts.usage ?? null,
    modelUsage: modelUsage,
    // Honest for the success path; the bridge fails non-success turns elsewhere.
    permission_denials: [],
    terminal_reason: "completed",
    fast_mode_state: "off",
    uuid: opts.uuid ?? null,
    // Bridge-only: present only when --json-schema validated.
    ...(opts.structuredOutput?.present ? { structured_output: opts.structuredOutput.value } : {}),
  };
}

/**
 * Terminal error result in headless `claude -p` shape (default subtype
 * `error_during_execution`). Bridge diagnostics — `error` message, plus any
 * `extras` like `run_state` / `pane_tail` — ride along as extra fields a
 * headless consumer ignores.
 */
export function makeClaudeErrorResultEvent(opts: {
  message: string;
  subtype?: string;
  apiErrorStatus?: number | null;
  sessionId?: string;
  durationMs?: number;
  model?: string;
  usage?: TokenUsage;
  uuid?: string;
  extras?: Record<string, unknown>;
}): ClaudeEvent {
  return {
    type: "result",
    subtype: opts.subtype ?? "error_during_execution",
    is_error: true,
    api_error_status: opts.apiErrorStatus ?? null,
    duration_ms: opts.durationMs ?? null,
    duration_api_ms: null,
    ttft_ms: null,
    ttft_stream_ms: null,
    time_to_request_ms: null,
    num_turns: 1,
    result: null,
    error: opts.message,
    stop_reason: null,
    session_id: opts.sessionId ?? null,
    total_cost_usd: computeCostUsd(opts.model, opts.usage),
    usage: opts.usage ?? null,
    modelUsage: buildModelUsage(opts.model, opts.usage),
    permission_denials: [],
    terminal_reason: "error",
    fast_mode_state: "off",
    uuid: opts.uuid ?? null,
    ...(opts.extras ?? {}),
  };
}
