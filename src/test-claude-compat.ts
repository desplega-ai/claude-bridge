#!/usr/bin/env bun
/**
 * claude -p compatibility reshaping unit test. Verifies that interactive
 * transcript rows map to the headless claude -p stream-json event shapes
 * (field names, dropped rows, synthesized init/result with computed cost).
 */
import {
  apiErrorStatusFromRow,
  isToolResultUserRow,
  makeClaudeErrorResultEvent,
  makeClaudeInitEvent,
  makeClaudeResultEvent,
  modelFromAssistantRow,
  reshapeAssistantEvent,
  reshapeSystemEvent,
  reshapeUserEvent,
  stopReasonFromAssistantRow,
  transcriptRowToClaudeStreamEvent,
  type TranscriptRow,
} from "./claude-compat.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

// A realistic interactive assistant row (extra wrapper fields + sessionId/requestId).
const assistantRow: TranscriptRow = {
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 4 },
  },
  cwd: "/repo",
  entrypoint: "cli",
  gitBranch: "main",
  isSidechain: false,
  parentUuid: "p-1",
  requestId: "req_99",
  sessionId: "sess-abc",
  timestamp: "2026-06-17T07:44:41.844Z",
  userType: "external",
  uuid: "u-1",
  version: "2.1.179",
};

const assistant = reshapeAssistantEvent(assistantRow);
ok("assistant: type preserved", assistant.type === "assistant");
ok("assistant: message preserved", assistant.message === assistantRow.message);
ok("assistant: sessionId -> session_id", assistant.session_id === "sess-abc");
ok("assistant: requestId -> request_id", assistant.request_id === "req_99");
ok("assistant: uuid preserved", assistant.uuid === "u-1");
ok("assistant: parent_tool_use_id null at top level", assistant.parent_tool_use_id === null);
ok("assistant: interactive-only wrapper fields dropped",
  !("cwd" in assistant) && !("gitBranch" in assistant) && !("timestamp" in assistant) &&
  !("version" in assistant) && !("isSidechain" in assistant) && !("parentUuid" in assistant) &&
  !("entrypoint" in assistant) && !("userType" in assistant) && !("sessionId" in assistant) &&
  !("requestId" in assistant));
ok("modelFromAssistantRow", modelFromAssistantRow(assistantRow) === "claude-opus-4-8");
ok("stopReasonFromAssistantRow", stopReasonFromAssistantRow(assistantRow) === "end_turn");

// session_id fallback when the row lacks sessionId.
const noSession = reshapeAssistantEvent({ type: "assistant", message: { model: "x" }, uuid: "u" }, "fallback-sess");
ok("assistant: session_id falls back to provided id", noSession.session_id === "fallback-sess");

// User rows: plain prompt dropped, tool_result kept.
const promptRow: TranscriptRow = { type: "user", message: { role: "user", content: "hi" } };
const toolResultRow: TranscriptRow = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  sessionId: "sess-abc",
  uuid: "u-2",
  toolUseID: "t1",
};
ok("isToolResultUserRow: prompt is not a tool result", !isToolResultUserRow(promptRow));
ok("isToolResultUserRow: tool_result detected", isToolResultUserRow(toolResultRow));
ok("user prompt row is dropped", reshapeUserEvent(promptRow) === null);
const userEvent = reshapeUserEvent(toolResultRow);
ok("user tool_result kept", userEvent?.type === "user");
ok("user tool_result: parent_tool_use_id from toolUseID", userEvent?.parent_tool_use_id === "t1");
ok("user tool_result: session_id mapped", userEvent?.session_id === "sess-abc");

// Dispatcher drops interactive-only rows.
ok("dispatcher: assistant -> event", transcriptRowToClaudeStreamEvent(assistantRow)?.type === "assistant");
ok("dispatcher: prompt user -> dropped", transcriptRowToClaudeStreamEvent(promptRow) === null);
ok("dispatcher: turn_duration dropped",
  transcriptRowToClaudeStreamEvent({ type: "system", subtype: "turn_duration", durationMs: 1 } as TranscriptRow) === null);
ok("dispatcher: stop_hook_summary dropped",
  transcriptRowToClaudeStreamEvent({ type: "system", subtype: "stop_hook_summary" } as TranscriptRow) === null);
ok("dispatcher: last-prompt dropped",
  transcriptRowToClaudeStreamEvent({ type: "last-prompt" } as TranscriptRow) === null);

// init event.
const init = makeClaudeInitEvent({
  sessionId: "s1", cwd: "/repo", model: "claude-opus-4-8", version: "2.1.179", uuid: "i1",
  permissionMode: "bypassPermissions", apiKeySource: "none", memoryPaths: { auto: "/repo/memory/" },
});
ok("init: type/subtype", init.type === "system" && init.subtype === "init");
ok("init: scalar fields populated",
  init.session_id === "s1" && init.cwd === "/repo" && init.model === "claude-opus-4-8" &&
  init.claude_code_version === "2.1.179" && !("version" in init));
ok("init: inventory placeholders present and empty",
  Array.isArray(init.tools) && (init.tools as unknown[]).length === 0 &&
  Array.isArray(init.mcp_servers) && Array.isArray(init.slash_commands) &&
  Array.isArray(init.agents) && Array.isArray(init.skills) && Array.isArray(init.plugins));
ok("init: derivable scalars",
  init.permissionMode === "bypassPermissions" && init.apiKeySource === "none" &&
  init.output_style === "default" && init.fast_mode_state === "off" &&
  (init.memory_paths as { auto?: string }).auto === "/repo/memory/");
ok("init: defaults when unspecified", (() => {
  const d = makeClaudeInitEvent({ sessionId: "s" });
  return d.permissionMode === "default" && d.apiKeySource === null && d.fast_mode_state === "off";
})());

// result event with computed cost.
const result = makeClaudeResultEvent({
  resultText: "hi",
  sessionId: "s1",
  durationMs: 3120,
  model: "claude-opus-4-8",
  usage: {
    input_tokens: 16287,
    output_tokens: 4,
    cache_read_input_tokens: 15536,
    cache_creation_input_tokens: 3902,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3902 },
  },
  stopReason: "end_turn",
});
ok("result: shape", result.type === "result" && result.subtype === "success" && result.is_error === false);
ok("result: success-honest constants",
  result.api_error_status === null &&
  Array.isArray(result.permission_denials) && (result.permission_denials as unknown[]).length === 0 &&
  result.terminal_reason === "completed");
ok("result: result text", result.result === "hi");
ok("result: num_turns default", result.num_turns === 1);
ok("result: duration_ms", result.duration_ms === 3120);
ok("result: stop_reason", result.stop_reason === "end_turn");
ok("result: total_cost_usd computed", Math.abs((result.total_cost_usd as number) - 0.128323) < 1e-9);
ok("result: timing fields present and null",
  result.duration_api_ms === null && result.ttft_ms === null &&
  result.ttft_stream_ms === null && result.time_to_request_ms === null);
ok("result: fast_mode_state default", result.fast_mode_state === "off");
ok("result: modelUsage synthesized",
  !!result.modelUsage && typeof result.modelUsage === "object" &&
  (result.modelUsage as Record<string, { costUSD?: number; contextWindow?: number }>)["claude-opus-4-8"]?.contextWindow === 1000000);
ok("result: structured_output omitted when absent", !("structured_output" in result));

const structured = makeClaudeResultEvent({ resultText: "{}", structuredOutput: { present: true, value: { ok: true } } });
ok("result: structured_output included when present",
  JSON.stringify((structured.structured_output as object)) === JSON.stringify({ ok: true }));
ok("result: total_cost_usd null for unknown model",
  makeClaudeResultEvent({ resultText: "x", model: "gpt", usage: { input_tokens: 1 } }).total_cost_usd === null);

// Surfaced system events (rate limit / refusal).
const apiErrRow: TranscriptRow = {
  type: "system", subtype: "api_error", level: "error",
  error: { status: 529, message: "529 Overloaded", formatted: "529 Overloaded" },
  retryAttempt: 1, retryInMs: 562.9, maxRetries: 10,
  cwd: "/repo", gitBranch: "main", sessionId: "s1", uuid: "e1", version: "2.1.179",
};
const apiErr = reshapeSystemEvent(apiErrRow);
ok("api_error: surfaced as system event", apiErr?.type === "system" && apiErr?.subtype === "api_error");
ok("api_error: retry + error fields kept",
  apiErr?.retryAttempt === 1 && apiErr?.maxRetries === 10 &&
  (apiErr?.error as { status?: number }).status === 529);
ok("api_error: session_id mapped, interactive wrapper dropped",
  apiErr?.session_id === "s1" && !("cwd" in (apiErr as object)) && !("gitBranch" in (apiErr as object)) &&
  !("version" in (apiErr as object)) && !("sessionId" in (apiErr as object)));
ok("api_error: status extracted", apiErrorStatusFromRow(apiErrRow) === 529);
ok("dispatcher surfaces api_error", transcriptRowToClaudeStreamEvent(apiErrRow)?.subtype === "api_error");
ok("model_refusal_fallback surfaced",
  reshapeSystemEvent({ type: "system", subtype: "model_refusal_fallback", trigger: "refusal", fallbackModel: "claude-opus-4-8" } as TranscriptRow)?.subtype === "model_refusal_fallback");
ok("other system rows still dropped",
  reshapeSystemEvent({ type: "system", subtype: "local_command" } as TranscriptRow) === null);

// Error result event.
const errResult = makeClaudeErrorResultEvent({
  message: "tmux session died",
  apiErrorStatus: 529,
  sessionId: "s1",
  durationMs: 100,
  model: "claude-opus-4-8",
  usage: { input_tokens: 10, output_tokens: 0 },
  uuid: "r1",
  extras: { run_state: "/tmp/run", pane_tail: "boom" },
});
ok("error result: headless shape",
  errResult.type === "result" && errResult.subtype === "error_during_execution" &&
  errResult.is_error === true && errResult.result === null && errResult.terminal_reason === "error");
ok("error result: api_error_status surfaced", errResult.api_error_status === 529);
ok("error result: message + bridge extras", errResult.error === "tmux session died" &&
  errResult.run_state === "/tmp/run" && errResult.pane_tail === "boom");
ok("error result: cost computed from usage", typeof errResult.total_cost_usd === "number");
ok("error result: custom subtype",
  makeClaudeErrorResultEvent({ message: "x", subtype: "error_max_turns" }).subtype === "error_max_turns");

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
