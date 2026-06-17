# `stream-json` compatibility with `claude -p`

`claude-bridge -p --output-format stream-json` (without `--desplega-format`) is a
drop-in for Claude Code's headless `claude -p --output-format stream-json`. The
bridge drives the **interactive** TUI (for billing correctness) and reshapes its
on-disk transcript into the headless event schema:

```
{"type":"system","subtype":"init", ...}
{"type":"assistant","message":{...}, ...}
{"type":"user","message":{...}, ...}      # tool results only
{"type":"result","subtype":"success", ...}
```

It is **structurally** compatible, not byte-identical. The interactive path does
not expose a real `init` event or the headless API-client telemetry, so some
fields are synthesized, approximated, or omitted. This document is the contract.

## Verified against

| Component             | Pinned version       |
| --------------------- | -------------------- |
| `@desplega.ai/claude-bridge` | `0.2.0`       |
| Claude Code CLI       | `2.1.179`            |
| models.dev pricing snapshot  | `2026-06-17`  |

The reshaping reads interactive transcript field names (`sessionId`, `requestId`,
`message.usage.cache_creation`, the terminal `turn_duration` row, …). A different
Claude Code version may rename or restructure those and silently drift. Re-verify
(and re-capture ground truth) when bumping the Claude Code pin. Pricing comes from
the generated `src/model-pricing-data.ts`; regenerate with
`bun run update:model-pricing` when Anthropic pricing or the model lineup changes.

## What matches

- Event sequence and types: `system/init` → `assistant` → (`user` tool results) → `result`.
- `assistant` / `user` wrappers remapped to headless names: `session_id`,
  `request_id`, `parent_tool_use_id`; interactive-only wrapper keys (`cwd`,
  `gitBranch`, `sessionId`, `requestId`, `timestamp`, `version`, `isSidechain`,
  `parentUuid`, `entrypoint`, `userType`) stripped.
- `assistant.message` body (model, id, content, stop_reason, usage) passes through
  intact.
- `result`: full headless field set — `type`, `subtype`, `is_error`,
  `api_error_status`, `duration_ms`, `num_turns`, `result`, `stop_reason`,
  `session_id`, `usage`, `permission_denials`, `terminal_reason`,
  `fast_mode_state`, `uuid`.
- **`total_cost_usd`** is recomputed from token usage and models.dev rates,
  splitting cache-creation into 5-minute (1.25× input) and 1-hour (2× input)
  tiers. It matches the headless cost **to the cent** when the model is in the
  pricing snapshot.
- **`modelUsage`** is synthesized from the same usage + cost, with
  `contextWindow` / `maxOutputTokens` from the models.dev snapshot.
- **`init`** carries the derivable scalars: `cwd`, `session_id`, `model`,
  `claude_code_version`, `permissionMode`, `apiKeySource`, `output_style`,
  `memory_paths`, `fast_mode_state`, `uuid`.
- **Rate-limit / overloaded / retry** rows (`system/api_error`) and safety
  `system/model_refusal_fallback` rows are passed through (see below).

## Known incompatibilities

### Placeholder fields (present for shape parity, but empty/synthetic)

- **`init` inventory**: `tools`, `mcp_servers`, `slash_commands`, `agents`,
  `skills`, `plugins` are emitted as empty arrays. The interactive transcript
  never exposes the live session inventory, so these are placeholders, not the
  real lists.
- **`init` scalars** (`permissionMode`, `apiKeySource`, `output_style`,
  `memory_paths`, `fast_mode_state`) are best-effort, derived from the bridge's
  own launch flags rather than read back from Claude.

### Null fields (data the interactive path never produces)

- **`result`**: `duration_api_ms`, `ttft_ms`, `ttft_stream_ms`,
  `time_to_request_ms` are always `null` — they come from the headless API
  client, which the bridge does not run.

### Approximate / non-equal fields

- **`result.duration_ms`** is the interactive turn duration (from the
  `turn_duration` row), not the headless wall-clock + API duration.
- **`result.num_turns`** is hard-coded to `1`. Headless counts each model
  inference, so a tool-using turn reports a higher number there.
- **`total_cost_usd`** / **`modelUsage`** are `null` when the model is absent
  from the pricing snapshot, and only as accurate as that snapshot.
- **`uuid`** values are freshly generated for synthesized `init` / `result`
  events (assistant/user events keep their real transcript uuids).

### Field-name / shape drift

- **`assistant.message.usage`** carries extra interactive keys (`iterations`,
  `speed`) and lacks `context_management`.
- **`assistant`** usage reflects the final token counts; headless emits the
  streaming-partial usage on the assistant event and the final counts on
  `result`.

### Dropped rows / unsupported flags

- Hook telemetry rows (`system/hook_started`, `system/hook_response`) that
  headless emits when hooks are installed are dropped.
- `--include-partial-messages` (headless `stream_event` deltas) is not produced;
  the bridge emits whole `assistant` events only.

## Superset behavior: rate limits, retries, and refusals

Headless `claude -p` retries transient API failures (HTTP 429 rate limit, 529
overloaded, 5xx, network resets) **internally** and emits nothing for them. The
interactive transcript, however, records each attempt as a `system/api_error`
row, and the bridge surfaces these reshaped:

```json
{"type":"system","subtype":"api_error","error":{"status":529,"message":"529 Overloaded","rateLimits":null},"retryAttempt":1,"retryInMs":562.9,"maxRetries":10,"level":"error","session_id":"...","uuid":"..."}
```

Safety-driven model fallbacks are likewise surfaced as
`system/model_refusal_fallback` (with `originalModel` / `fallbackModel`). This
makes the bridge a **superset** of headless: a consumer that switches on `type`
and ignores unknown `subtype`s is unaffected; a consumer that wants retry/
rate-limit visibility (which headless never gives) can read these rows. If the
turn ultimately fails after exhausting retries, the terminal error result's
`api_error_status` carries the last seen HTTP status.

## Error path

A failed turn emits a terminal error result in headless shape:

```json
{"type":"result","subtype":"error_during_execution","is_error":true,"api_error_status":null,"result":null,"terminal_reason":"error","num_turns":1,...}
```

`subtype` defaults to `error_during_execution`. Bridge diagnostics — an `error`
message string plus `run_state` and `pane_tail` — ride along as extra fields a
headless consumer ignores. (Headless does not include an `error` string field.)

## Practical guidance

Consumers that switch on `type` and read `result`, `is_error`, `session_id`,
`usage`, `total_cost_usd`, and `modelUsage` work unchanged. Consumers that depend
on the real `init` inventory, headless latency metrics (`ttft_ms`,
`duration_api_ms`), or accurate `num_turns` for tool loops need to account for
the gaps above.
