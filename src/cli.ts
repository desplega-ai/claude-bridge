#!/usr/bin/env bun
/**
 * claude-bridge CLI.
 *
 *  - Writes a per-run workdir and .claude/settings.local.json.
 *  - Pre-accepts trust and onboarding prompts in Claude's global config.
 *  - Spawns `claude` inside a detached tmux session.
 *  - Sends prompts through tmux and reads results from Claude's transcript.
 *  - Tails the on-disk JSONL transcript (Shannon-style). Piped consumers get
 *    JSONL envelopes; TTY users get a compact readable view.
 *
 * Attach to the live Claude UI from another terminal with:
 *     tmux attach -t <session-name>
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { preAcceptProject, writeWorkdirSettings } from "./preaccept.ts";
import { claudeAuthEnvArgs, claudeUnsetEnvArgs } from "./auth-env.ts";
import {
  isTurnDurationRow,
  listAllTranscriptPaths,
  projectFolderFromTranscript,
  readTranscript,
  sessionIdFromPath,
  tailTranscript,
  tailTranscriptLines,
  waitForFreshTranscriptForCwd,
  waitForTranscriptTurnEnd,
  type TranscriptRow,
} from "./transcript.ts";
import { formatEnvelope } from "./view.ts";
import { formatClaudeHelp, formatWrapperHelp, parseCliArgs, type OutputFormat } from "./args.ts";
import {
  extractAndValidateStructuredOutput,
  loadJsonSchema,
  makeJsonSchemaSystemPrompt,
  mergeAppendSystemPrompt,
  resolveJsonSchemaMaxTokens,
  type LoadedJsonSchema,
} from "./json-schema.ts";
import {
  buildJsonSchemaStopHookCommand,
  buildRuntimeHookCommand,
  installJsonSchemaStopHook,
  installRuntimeHooks,
  uninstallJsonSchemaStopHook,
} from "./hook-install.ts";
import { makePrintErrorResult } from "./print-result.ts";
import { runJsonSchemaStopHook, runRuntimeHook } from "./stop-hook.ts";
import { buildClaudeLaunchCommand } from "./launch-command.ts";
import {
  apiErrorStatusFromRow,
  makeClaudeErrorResultEvent,
  makeClaudeInitEvent,
  makeClaudeResultEvent,
  modelFromAssistantRow,
  stopReasonFromAssistantRow,
  transcriptRowToClaudeStreamEvent,
} from "./claude-compat.ts";
import type { TokenUsage } from "./model-pricing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const parsedArgs = parseCliArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
  process.stderr.write(`claude-bridge: ${parsedArgs.error.message}\n`);
  process.stderr.write(`${parsedArgs.error.hint}\n`);
  process.stderr.write("Run `bun ./src/cli.ts --help` for wrapper usage.\n");
  process.exit(2);
}
const args = parsedArgs.parsed;

if (args.help) {
  process.stdout.write(formatWrapperHelp());
  process.exit(0);
}

if (args.claudeHelp) {
  const claudeHelp = spawnSync("claude", ["-h"], { encoding: "utf8" });
  const helpText = (claudeHelp.stdout ?? "") + (claudeHelp.stderr ?? "");
  process.stdout.write(formatClaudeHelp(helpText));
  process.exit(0);
}

if (args.version) {
  process.stdout.write(formatVersionInfo());
  process.exit(0);
}

const desplegaArgs = args.desplegaArgs;
const desplegaVerbose = args.desplegaVerbose;
const printMode = args.print;
const outputFormat: OutputFormat = args.outputFormat;
const desplegaFormat = hasDesplegaFlag("format");

if (hasDesplegaFlag("internal-json-schema-stop-hook")) {
  await runJsonSchemaStopHook();
  process.exit(0);
}

if (hasDesplegaFlag("internal-runtime-hook")) {
  await runRuntimeHook();
  process.exit(0);
}

if (hasDesplegaFlag("install") && hasDesplegaFlag("uninstall")) {
  process.stderr.write("claude-bridge: use either --desplega-install or --desplega-uninstall, not both.\n");
  process.exit(2);
}

if (hasDesplegaFlag("install")) {
  const result = installJsonSchemaStopHook({ command: buildJsonSchemaStopHookCommand() });
  process.stdout.write(
    `claude-bridge: ${result.changed ? "installed" : "already installed"} JSON schema Stop hook in ${result.settingsPath}\n`
  );
  process.exit(0);
}

if (hasDesplegaFlag("uninstall")) {
  const result = uninstallJsonSchemaStopHook();
  process.stdout.write(
    `claude-bridge: removed ${result.removed} JSON schema Stop hook entr${result.removed === 1 ? "y" : "ies"} from ${result.settingsPath}\n`
  );
  process.exit(0);
}

const targetCwd = resolveTargetCwd();
const transcriptsBefore = await listAllTranscriptPaths();

let initialMessage = args.initialPrompt;
if (printMode && !initialMessage && !process.stdin.isTTY) {
  initialMessage = (await new Response(Bun.stdin.stream()).text()).trimEnd();
}
if (printMode && !initialMessage) {
  process.stderr.write("claude-bridge: -p/--print requires a prompt argument or piped stdin.\n");
  process.stderr.write("Run `bun ./src/cli.ts --help` for wrapper usage.\n");
  process.exit(2);
}

const jsonSchema = loadPrintJsonSchema();
const forwardedClaudeArgs = jsonSchema
  ? mergeAppendSystemPrompt(
      args.claudeArgs,
      makeJsonSchemaSystemPrompt(jsonSchema.compact)
    )
  : args.claudeArgs;

const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const runDir = join(resolveRunRoot(targetCwd), runId);
mkdirSync(runDir, { recursive: true });

const jsonSchemaPath = jsonSchema ? join(runDir, "json-schema.json") : undefined;
const claudeExitStatusPath = join(runDir, "claude-exit-status");
const sessionName = `claude-bridge-${runId.slice(-8)}`;
const CLAUDE_READY_TIMEOUT_MS = envDurationMs("CLAUDE_BRIDGE_CLAUDE_READY_TIMEOUT_MS", 180_000);
const TMUX_SUBMIT_DELAY_MS = envDurationMs("CLAUDE_BRIDGE_TMUX_SUBMIT_DELAY_MS", 1_000);
const TMUX_EXIT_HOLD_MS = envDurationMs("CLAUDE_BRIDGE_TMUX_EXIT_HOLD_MS", 30_000);
const MAX_SESSION_MS = envDurationMs("CLAUDE_BRIDGE_MAX_SESSION_MS", 2 * 60 * 60_000);
// The Stop hook fires before Claude appends the terminal turn_duration row, so
// after a Stop event we briefly wait for that row to land before finalizing —
// otherwise streamed JSONL is truncated mid-turn.
const TURN_END_FLUSH_TIMEOUT_MS = envDurationMs("CLAUDE_BRIDGE_TURN_END_FLUSH_TIMEOUT_MS", 5_000);
const stopEventPath = join(runDir, "stop-event.json");
const messageDisplayPath = join(runDir, "message-display.jsonl");
const transcriptEventPath = join(runDir, "transcript-event.json");

if (jsonSchemaPath && jsonSchema) {
  writeFileSync(jsonSchemaPath, jsonSchema.compact + "\n");
  installJsonSchemaStopHook({ command: buildJsonSchemaStopHookCommand() });
}
installRuntimeHooks({ command: buildRuntimeHookCommand() });

preAcceptProject({ workdir: targetCwd, mcpServerNames: [] });
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
const bypassPermissions = !runningAsRoot;
writeWorkdirSettings(targetCwd, { bypassPermissions });

const tmuxPath = resolveRequiredCommand(
  "tmux",
  "Required command `tmux` was not found on PATH. Install tmux on this host before running claude-bridge."
);
const claudePath = resolveRequiredCommand(
  "claude",
  "Required command `claude` was not found on PATH. Install Claude Code on this host, or make sure PATH includes it before running claude-bridge."
);

const ctrl = new AbortController();
const isTTY = !!process.stdout.isTTY && !printMode;
const showRaw = desplegaVerbose;
const inputPrompt = isTTY ? "> " : "";
const debugEvents: Record<string, unknown>[] = [];
let transcriptSessionId: string | undefined;
let lastAssistantText = "";
let lastAssistantRow: TranscriptRow | null = null;
let lastTurnDurationMs: number | undefined;
let pendingPrintResultText = "";
let pendingPrintFailure: { message: string; rawResponse?: string } | null = null;
let printDone = false;
let messageDisplayOffset = 0;
// stream-json compat: synthesize the claude -p event stream from the
// interactive transcript. We emit init once, then reshaped assistant/user
// events (dropping interactive-only rows), then a terminal result event.
let claudeInitEmitted = false;
let claudeStreamEmittedCount = 0;
let claudeVersionFromTranscript: string | undefined;
let transcriptProjectFolder: string | undefined;
let lastApiErrorStatus: number | null = null;

let rlRef: import("node:readline").Interface | null = null;
const stdoutLine = (obj: Record<string, unknown>): void => {
  if (printMode) {
    if (outputFormat === "stream-json" && desplegaFormat) {
      process.stdout.write(JSON.stringify(obj) + "\n");
    }
    return;
  }

  let text: string;
  if (isTTY) {
    const line = formatEnvelope(obj, { showRaw });
    if (!line) return;
    text = line + "\n";
  } else {
    text = JSON.stringify(obj) + "\n";
  }
  // Clear the current input line (if any), write the message, then redraw the
  // prompt + whatever the user had typed.
  if (rlRef && isTTY) {
    process.stdout.write("\r\x1b[2K" + text);
    rlRef.prompt(true);
  } else {
    process.stdout.write(text);
  }
};

const desplegaDebug = (message: string, data?: Record<string, unknown>): void => {
  if (!desplegaVerbose) return;
  const event = { type: "desplega_debug", message, ...(data ? { data } : {}) };
  if (printMode && outputFormat === "json" && desplegaFormat) {
    debugEvents.push(event);
    return;
  }
  if (printMode && outputFormat === "stream-json" && desplegaFormat) {
    stdoutLine(event);
    return;
  }
  if (printMode) {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    process.stderr.write(`[desplega] ${message}${suffix}\n`);
    return;
  }
  if (isTTY) {
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    process.stderr.write(`[desplega] ${message}${suffix}\n`);
    return;
  }
  stdoutLine(event);
};

desplegaDebug("parsed arguments", {
  claudeArgs: forwardedClaudeArgs,
  desplegaArgs,
  jsonSchema: jsonSchema
    ? { estimatedTokens: jsonSchema.estimatedTokens, maxTokens: jsonSchema.maxTokens }
    : undefined,
});

function formatVersionInfo(): string {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  const whichClaude = spawnSync("which", ["claude"], { encoding: "utf8" });
  const claudePath =
    whichClaude.status === 0 ? whichClaude.stdout.trim() : (whichClaude.stderr.trim() || "not found");
  const claudeVersion =
    whichClaude.status === 0
      ? commandOutput("claude", ["-v"]) || "unknown"
      : "unavailable";

  return [
    `${pkg.name ?? "claude-bridge"} ${pkg.version ?? "0.0.0"}`,
    `claude path: ${claudePath}`,
    `claude version: ${claudeVersion}`,
  ].join("\n") + "\n";
}

function commandOutput(command: string, args: string[]): string {
  const res = spawnSync(command, args, { encoding: "utf8" });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
}

function envDurationMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function loadPrintJsonSchema(): LoadedJsonSchema | null {
  if (!args.jsonSchema) return null;
  try {
    const maxTokens = resolveJsonSchemaMaxTokens(desplegaArgs);
    return loadJsonSchema(args.jsonSchema, targetCwd, maxTokens);
  } catch (err) {
    failBeforeRun((err as Error).message);
  }
}

function resolveTargetCwd(): string {
  const value = desplegaValue("cwd");
  const cwd = value === undefined || value === true ? process.cwd() : String(value);
  const resolved = resolve(process.cwd(), cwd);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    process.stderr.write(`claude-bridge: --desplega-cwd must point to an existing directory: ${resolved}\n`);
    process.exit(2);
  }
  return resolved;
}

function resolveRunRoot(cwd: string): string {
  const value = desplegaValue("run-dir") ?? desplegaValue("state-dir");
  if (value !== undefined && value !== true) return resolve(process.cwd(), String(value));
  return join(cwd, ".claude-bridge", "runs");
}

function hasDesplegaFlag(name: string): boolean {
  const arg = desplegaArgs.find(arg => arg.name === name);
  return Boolean(arg && arg.value !== false);
}

function desplegaValue(name: string): boolean | string | undefined {
  return desplegaArgs.find(arg => arg.name === name)?.value;
}

function failBeforeRun(message: string): never {
  if (printMode && outputFormat !== "text" && desplegaFormat) {
    process.stdout.write(
      JSON.stringify({ type: "result", subtype: "error", is_error: true, error: message }) + "\n"
    );
  } else {
    process.stderr.write(`claude-bridge: ${message}\n`);
  }
  process.exit(2);
}

function commandPath(command: string): string | null {
  const res = spawnSync("which", [command], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return first || null;
}

function resolveRequiredCommand(command: string, message: string): string {
  return commandPath(command) ?? failBeforeRun(message);
}

let claudeReady = false;
const pendingMessages: string[] = initialMessage ? [initialMessage] : [];

function sendUserMessage(text: string): string | null {
  if (!claudeReady) {
    pendingMessages.push(text);
    desplegaDebug("queued message before Claude readiness", {
      length: text.length,
      claudeReady,
    });
    return null;
  }

  const id = randomUUID().slice(0, 8);
  const sent = sendPromptToTmux(text, id);
  if (!sent) return null;
  stdoutLine({ type: "push", id, content: text, transport: "tmux" });
  return id;
}

function sendPromptToTmux(text: string, id: string): boolean {
  const bufferName = `claude-bridge-${id}`;
  const load = spawnSync(tmuxPath, ["load-buffer", "-b", bufferName, "-"], {
    input: text,
    encoding: "utf8",
  });
  if (load.status !== 0) {
    return failTmuxSend("load prompt buffer", load);
  }

  const paste = spawnSync(tmuxPath, ["paste-buffer", "-d", "-b", bufferName, "-t", sessionName], {
    encoding: "utf8",
  });
  if (paste.status !== 0) {
    return failTmuxSend("paste prompt buffer", paste);
  }

  sleepSync(TMUX_SUBMIT_DELAY_MS);
  const enter = spawnSync(tmuxPath, ["send-keys", "-t", sessionName, "Enter"], {
    encoding: "utf8",
  });
  if (enter.status !== 0) {
    return failTmuxSend("submit prompt", enter);
  }

  desplegaDebug("sent prompt through tmux", { id, length: text.length });
  return true;
}

function failTmuxSend(
  action: string,
  result: { status: number | null; stderr?: unknown }
): false {
  const message = `Failed to ${action} with tmux.`;
  const stderr = String(result.stderr ?? "").trim();
  desplegaDebug("tmux send failure", { action, status: result.status, stderr });
  if (printMode) {
    failPrint(stderr ? `${message} ${stderr}` : message);
  } else {
    stdoutLine({
      type: "bridge_error",
      where: "tmux-send",
      message: stderr ? `${message} ${stderr}` : message,
    });
  }
  return false;
}

function flushPendingMessages(): boolean {
  let sent = false;
  while (pendingMessages.length > 0) {
    const text = pendingMessages.shift();
    if (!text) continue;
    const id = sendUserMessage(text);
    if (!id) break;
    sent = true;
  }
  return sent;
}

function promptIfReady(): void {
  if (!printMode && claudeReady && isTTY) rlRef?.prompt();
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

function finishPrintResult(resultText: string): void {
  if (printDone) return;
  const structured = extractStructuredOutput(resultText);
  if (structured && !structured.ok) {
    failPrint(structured.message, { rawResponse: structured.rawResponse });
    return;
  }

  printDone = true;
  if (outputFormat === "text") {
    const text = structured ? JSON.stringify(structured.value) : resultText;
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  } else if (desplegaFormat) {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: resultText,
      ...(structured
        ? { structured_output: structured.value, structured_output_source: structured.source }
        : {}),
      ...(transcriptSessionId ? { session_id: transcriptSessionId } : {}),
      ...(outputFormat === "json" && debugEvents.length ? { debug: debugEvents } : {}),
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (outputFormat === "json") {
    process.stdout.write(JSON.stringify(makeClaudeCompatResult(resultText, structured)) + "\n");
  }
  shutdown();
}

function makeClaudeCompatResult(
  resultText: string,
  structured: { ok: true; value: unknown; source: string } | null
): Record<string, unknown> {
  return makeClaudeResultEvent({
    resultText,
    sessionId: transcriptSessionId,
    durationMs: lastTurnDurationMs,
    model: currentModel(),
    usage: lastAssistantUsage(),
    stopReason: lastAssistantRow ? stopReasonFromAssistantRow(lastAssistantRow) : undefined,
    structuredOutput: structured ? { present: true, value: structured.value } : undefined,
    uuid: randomUUID(),
  });
}

function currentModel(): string | undefined {
  return lastAssistantRow ? modelFromAssistantRow(lastAssistantRow) : undefined;
}

function lastAssistantUsage(): TokenUsage | undefined {
  const msg = (lastAssistantRow?.message as Record<string, unknown> | undefined) ?? undefined;
  return msg?.usage as TokenUsage | undefined;
}

function extractStructuredOutput(
  text: string
):
  | { ok: true; value: unknown; source: string }
  | { ok: false; message: string; rawResponse: string }
  | null {
  if (!jsonSchema) return null;
  return extractAndValidateStructuredOutput(text, jsonSchema.schema);
}

function failPrint(message: string, details: { rawResponse?: string } = {}): void {
  if (printDone) return;
  printDone = true;
  const failureCapture = captureFailurePane();
  const messageWithPaneTail = appendPaneTail(message, failureCapture.paneTail);
  if (outputFormat === "text") {
    process.stderr.write(`claude-bridge: ${messageWithPaneTail}\n`);
    if (details.rawResponse !== undefined) {
      process.stderr.write(`Raw Claude reply:\n${details.rawResponse}\n`);
    }
  } else if (desplegaFormat) {
    let stderrLog: string | undefined;
    if (printMode) {
      try { stderrLog = readFileSync(join(runDir, "stdout.stderr.log"), "utf8").trim() || undefined; } catch {}
    }
    const result = makePrintErrorResult(messageWithPaneTail, {
      rawResponse: details.rawResponse,
      sessionId: transcriptSessionId,
      runState: runDir,
      paneTail: failureCapture.paneTail,
      stderrLog,
      debug: outputFormat === "json" ? debugEvents : undefined,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    // json / stream-json compatibility: emit a headless-shaped error result
    // (subtype error_during_execution), carrying bridge diagnostics as extras.
    if (outputFormat === "stream-json") ensureClaudeInit();
    process.stdout.write(
      JSON.stringify(
        makeClaudeErrorResultEvent({
          message: messageWithPaneTail,
          apiErrorStatus: lastApiErrorStatus,
          sessionId: transcriptSessionId,
          durationMs: lastTurnDurationMs,
          model: currentModel(),
          usage: lastAssistantUsage(),
          uuid: randomUUID(),
          extras: {
            run_state: runDir,
            ...(details.rawResponse !== undefined ? { raw_response: details.rawResponse } : {}),
            ...(failureCapture.paneTail ? { pane_tail: failureCapture.paneTail } : {}),
          },
        })
      ) + "\n"
    );
  }
  shutdown(1);
}

function startTmux(): void {
  // BILLING INVARIANT: never pass `-p`/`--print`, Agent SDK flags, or
  // headless `--output-format stream-json` to Claude. Claude Code computes
  // interactive billing as `!(hasPrint || hasInitOnly || hasSdkUrl ||
  // !stdout.isTTY)`, so the bridge must launch the real TUI in a tmux pty and
  // synthesize print/json output itself.
  const claudeArgs = [
    ...(bypassPermissions ? ["--dangerously-skip-permissions"] : []),
    ...forwardedClaudeArgs,
  ];
  const envArgs = [
    ...claudeAuthEnvArgs(process.env, { localAuth: hasDesplegaFlag("local-auth") }),
    "CLAUDE_BRIDGE_RUNTIME_HOOK=1",
    `CLAUDE_BRIDGE_RUN_DIR=${runDir}`,
    ...(jsonSchemaPath
      ? [
          "CLAUDE_BRIDGE_SCHEMA_STOP_HOOK=1",
          `CLAUDE_BRIDGE_JSON_SCHEMA_PATH=${jsonSchemaPath}`,
          `CLAUDE_BRIDGE_RUN_ID=${runId}`,
        ]
      : []),
  ];

  const launchCommand = buildClaudeLaunchCommand({
    claudePath,
    claudeArgs,
    unsetEnvArgs: claudeUnsetEnvArgs(),
    envArgs,
    exitStatusPath: claudeExitStatusPath,
    holdMs: TMUX_EXIT_HOLD_MS,
  });
  desplegaDebug("starting claude in tmux", {
    sessionName,
    claudePath,
    claudeArgs,
    bypassPermissions,
  });
  const newSession = [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    targetCwd,
    launchCommand,
  ];
  const res = spawnSync(tmuxPath, newSession, { stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write(`[claude-bridge] tmux new-session exited ${res.status}\n`);
    process.exit(1);
  }
  void autoAcceptStartupPrompts();
  void waitForClaudeReady();
  void startTranscriptTail();
  if (printMode) void waitForPrintTurnEnd();
  if (!printMode) printBanner();
}

type RuntimeStopEvent = {
  hook_event_name?: string;
  transcript_path?: string;
  last_assistant_message?: string;
  message?: unknown;
  reason?: unknown;
  error?: unknown;
};

async function waitForPrintTurnEnd(): Promise<void> {
  const POLL_MS = 100;
  const startedAt = Date.now();
  while (!ctrl.signal.aborted && Date.now() - startedAt < MAX_SESSION_MS) {
    emitMessageDisplayEvents();

    const stopEvent = readRuntimeStopEvent();
    if (stopEvent) {
      emitMessageDisplayEvents();
      // A normal Stop fires before Claude appends its stop_hook_summary +
      // terminal turn_duration rows. Wait for that turn-end row to land so the
      // streamed transcript (and the synthesized result) isn't truncated.
      if (stopEvent.hook_event_name === "Stop" && stopEvent.transcript_path) {
        await waitForTranscriptTurnEnd(
          stopEvent.transcript_path,
          TURN_END_FLUSH_TIMEOUT_MS,
          ctrl.signal
        );
        emitMessageDisplayEvents();
      }
      await hydrateTranscriptFromStopEvent(stopEvent);
      if (stopEvent.hook_event_name === "StopFailure") {
        failPrint(runtimeStopFailureMessage(stopEvent), { rawResponse: JSON.stringify(stopEvent) });
        return;
      }
      if (pendingPrintFailure) {
        failPrint(pendingPrintFailure.message, { rawResponse: pendingPrintFailure.rawResponse });
        return;
      }
      const stopAssistantText =
        typeof stopEvent.last_assistant_message === "string" && stopEvent.last_assistant_message !== ""
          ? stopEvent.last_assistant_message
          : undefined;
      const resultText = stopAssistantText ?? pendingPrintResultText ?? lastAssistantText;
      if (resultText === undefined || resultText === "") {
        failPrint("Claude Stop hook fired without assistant text.");
        return;
      }
      if (outputFormat === "stream-json" && !desplegaFormat) {
        if (!(await emitClaudeStreamResult(stopEvent, resultText))) return;
      }
      finishPrintResult(resultText);
      return;
    }

    const exitStatus = readClaudeExitStatus();
    if (exitStatus !== null && exitStatus !== "0") {
      failPrint(`Claude exited with status ${exitStatus} before the Stop hook produced a result.`);
      return;
    }
    if (!tmuxSessionExists()) {
      failPrint("tmux session/server died before the Stop hook produced a result.");
      return;
    }
    await sleep(POLL_MS);
  }

  if (!printDone) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    failPrint(`Session safety ceiling reached after ${elapsed}s waiting for the Stop hook event.`);
  }
}

function readRuntimeStopEvent(): RuntimeStopEvent | null {
  if (!existsSync(stopEventPath)) return null;
  try {
    const event = JSON.parse(readFileSync(stopEventPath, "utf8")) as RuntimeStopEvent;
    return event.hook_event_name === "Stop" || event.hook_event_name === "StopFailure" ? event : null;
  } catch {
    return null;
  }
}

function runtimeStopFailureMessage(stopEvent: RuntimeStopEvent): string {
  for (const field of [stopEvent.error, stopEvent.reason, stopEvent.message]) {
    if (typeof field === "string" && field.trim()) {
      return `Claude StopFailure hook fired: ${field.trim()}`;
    }
  }
  return "Claude StopFailure hook fired before the Stop hook produced a result.";
}

async function hydrateTranscriptFromStopEvent(stopEvent: RuntimeStopEvent): Promise<void> {
  const transcriptPath = stopEvent.transcript_path;
  if (!transcriptPath) return;
  transcriptSessionId = sessionIdFromPath(transcriptPath);
  try {
    const rows = await readTranscript(transcriptPath);
    rows.forEach((row, index) => handleTranscriptRow(row, JSON.stringify(row)));
    desplegaDebug("hydrated final transcript from Stop hook", {
      transcriptPath,
      rows: rows.length,
    });
  } catch (err) {
    desplegaDebug("failed to hydrate transcript from Stop hook", {
      transcriptPath,
      error: (err as Error).message,
    });
  }
}

/** Emit the synthesized claude -p `system/init` event exactly once. */
function ensureClaudeInit(model?: string): void {
  if (claudeInitEmitted) return;
  claudeInitEmitted = true;
  process.stdout.write(
    JSON.stringify(
      makeClaudeInitEvent({
        sessionId: transcriptSessionId,
        cwd: targetCwd,
        model: model ?? currentModel(),
        version: claudeVersionFromTranscript,
        uuid: randomUUID(),
        permissionMode: bypassPermissions ? "bypassPermissions" : "default",
        apiKeySource: hasDesplegaFlag("local-auth") ? "ANTHROPIC_API_KEY" : "none",
        memoryPaths: transcriptProjectFolder
          ? { auto: join(transcriptProjectFolder, "memory") + "/" }
          : {},
      })
    ) + "\n"
  );
}

function writeClaudeStreamEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
  claudeStreamEmittedCount++;
}

/** Live-tail path: reshape one transcript row into a claude -p event (or drop it). */
function emitClaudeStreamRow(row: TranscriptRow): void {
  const event = transcriptRowToClaudeStreamEvent(row, transcriptSessionId);
  if (!event) return;
  ensureClaudeInit(row.type === "assistant" ? modelFromAssistantRow(row) : undefined);
  writeClaudeStreamEvent(event);
}

/**
 * Drain/fallback path: emit any claude -p events the live tail hasn't yet
 * (or all of them, if the tail never started). claudeStreamEmittedCount keeps
 * this idempotent with the live tail since both reshape the same rows in order.
 */
function emitClaudeStreamCatchUp(rows: TranscriptRow[]): void {
  const events = rows
    .map(row => transcriptRowToClaudeStreamEvent(row, transcriptSessionId))
    .filter((event): event is Record<string, unknown> => event !== null);
  if (events.length <= claudeStreamEmittedCount) return;
  const firstAssistant = rows.find(row => row.type === "assistant");
  ensureClaudeInit(firstAssistant ? modelFromAssistantRow(firstAssistant) : undefined);
  for (const event of events.slice(claudeStreamEmittedCount)) writeClaudeStreamEvent(event);
}

/**
 * At turn end: drain remaining transcript events, then emit the terminal
 * claude -p result event (with recomputed total_cost_usd). Returns false after
 * a failPrint (e.g. structured-output validation failure).
 */
async function emitClaudeStreamResult(stopEvent: RuntimeStopEvent, resultText: string): Promise<boolean> {
  const structured = extractStructuredOutput(resultText);
  if (structured && !structured.ok) {
    failPrint(structured.message, { rawResponse: structured.rawResponse });
    return false;
  }
  if (stopEvent.transcript_path) {
    try {
      emitClaudeStreamCatchUp(await readTranscript(stopEvent.transcript_path));
    } catch (err) {
      desplegaDebug("failed to drain transcript for stream-json result", {
        error: (err as Error).message,
      });
    }
  }
  // Even an empty/odd turn gets init before the terminal result, like claude -p.
  ensureClaudeInit();
  process.stdout.write(
    JSON.stringify(
      makeClaudeResultEvent({
        resultText,
        sessionId: transcriptSessionId,
        durationMs: lastTurnDurationMs,
        model: currentModel(),
        usage: lastAssistantUsage(),
        stopReason: lastAssistantRow ? stopReasonFromAssistantRow(lastAssistantRow) : undefined,
        structuredOutput: structured ? { present: true, value: structured.value } : undefined,
        uuid: randomUUID(),
      })
    ) + "\n"
  );
  return true;
}

function emitMessageDisplayEvents(): void {
  if (!existsSync(messageDisplayPath)) return;
  let text = "";
  try {
    text = readFileSync(messageDisplayPath, "utf8");
  } catch {
    return;
  }
  if (text.length <= messageDisplayOffset) return;
  const chunk = text.slice(messageDisplayOffset);
  messageDisplayOffset = text.length;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const delta = typeof row.delta === "string" ? row.delta : "";
    if (outputFormat === "stream-json" && !desplegaFormat) {
      continue;
    } else {
      stdoutLine({ type: "message_display", delta });
    }
  }
}

function capturePane(): string {
  const r = spawnSync(tmuxPath, ["capture-pane", "-pt", sessionName, "-S", "-80"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

function captureFailurePane(): { pane: string; paneTail: string; path: string } {
  paneCaptured = true;
  const path = join(runDir, "tmux-pane-final.txt");
  const r = spawnSync(tmuxPath, ["capture-pane", "-pt", sessionName, "-S", "-"], {
    encoding: "utf8",
  });
  const pane = ((r.stdout ?? "") + (r.stderr ?? "")).trimEnd();
  try {
    writeFileSync(path, pane ? pane + "\n" : "");
  } catch (err) {
    desplegaDebug("failed to write final tmux pane capture", {
      path,
      error: (err as Error).message,
    });
  }
  let paneTail = tailLines(pane, 40);
  if (printMode && !paneTail) {
    const stderrFile = join(runDir, "stdout.stderr.log");
    try {
      const stderr = readFileSync(stderrFile, "utf8").trim();
      if (stderr) paneTail = `[stderr.log] ${tailLines(stderr, 40)}`;
    } catch {}
  }
  if (paneTail) {
    desplegaDebug("diagnostics before failure", { path, tail: paneTail });
  }
  return { pane, paneTail, path };
}

function appendPaneTail(message: string, paneTail: string): string {
  return paneTail ? `${message}\nPane tail:\n${paneTail}` : message;
}

function tailLines(text: string, count: number): string {
  return text.trim().split("\n").filter(Boolean).slice(-count).join("\n");
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const THEME_DIALOG_RE = /(Choose the text style that looks best with your terminal|To change this later, run \/theme)/i;
const SECURITY_NOTES_DIALOG_RE = /(Security notes:|Security guide|Press Enter to continue|Enter to confirm)/i;
const CUSTOM_API_KEY_DIALOG_RE = /(Detected a custom API key in your environment|Do you want to use this API key\?)/i;
const TRUST_DIALOG_RE = /(Quick safety check|Is this a project you created|Yes, I trust this folder)/i;
const CLAUDE_INPUT_PROMPT_RE = /(^|\n)\s*(?:❯|>)\s*(?!\d+\.\s)[^\n]*(?:\n|$)/;

/**
 * Claude may show first-run selectors before the input prompt is available:
 *
 *   1. Theme selection on a fresh config directory.
 *   2. Security notes on first authenticated startup.
 *
 * These dialogs have safe defaults for bridge usage, so Enter accepts them.
 * Login-method selection is deliberately not handled here because accepting the
 * wrong row can launch browser auth on local machines.
 */
async function autoAcceptStartupPrompts(): Promise<void> {
  const t0 = Date.now();
  let lastFire = 0;
  let lastPaneDebug = 0;
  let fires = 0;
  while (Date.now() - t0 < 45_000 && !ctrl.signal.aborted) {
    const pane = capturePane();
    if (isClaudePaneReady(pane)) {
      if (fires > 0 && !printMode) process.stderr.write("[claude-bridge] startup prompts cleared\n");
      return;
    }
    if (desplegaVerbose && Date.now() - lastPaneDebug > 2_000) {
      const tail = pane.split("\n").slice(-12).join("\n");
      desplegaDebug("pane tail", { tail });
      lastPaneDebug = Date.now();
    }

    const prompt = startupPromptFromPane(pane);
    if (prompt && Date.now() - lastFire > 600) {
      if (prompt === "custom-api-key") {
        spawnSync(tmuxPath, ["send-keys", "-t", sessionName, "Up", "Enter"]);
      } else {
        spawnSync(tmuxPath, ["send-keys", "-t", sessionName, "Enter"]);
      }
      lastFire = Date.now();
      fires++;
      if (!printMode) {
        process.stderr.write(`[claude-bridge] accepted Claude ${prompt} prompt (#${fires})\n`);
      }
    }

    await sleep(150);
  }

  if (fires === 0 && !printMode) {
    process.stderr.write(
      "[claude-bridge] startup prompts not detected within 45s; attach to the tmux pane if it's stuck\n"
    );
  }
}

function startupPromptFromPane(
  pane: string
): "theme" | "security-notes" | "custom-api-key" | "trust" | null {
  if (hasDesplegaFlag("local-auth") && CUSTOM_API_KEY_DIALOG_RE.test(pane)) {
    return "custom-api-key";
  }
  if (TRUST_DIALOG_RE.test(pane)) return "trust";
  if (THEME_DIALOG_RE.test(pane)) return "theme";
  if (SECURITY_NOTES_DIALOG_RE.test(pane)) return "security-notes";
  return null;
}

async function waitForClaudeReady(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CLAUDE_READY_TIMEOUT_MS && !ctrl.signal.aborted) {
    const pane = capturePane();
    const exitStatus = readClaudeExitStatus();
    if (exitStatus !== null) {
      failClaudeStartup(exitStatus, pane);
      return;
    }
    if (!tmuxSessionExists()) {
      failClaudeStartup(null, pane);
      return;
    }
    if (isClaudePaneReady(pane)) {
      claudeReady = true;
      desplegaDebug("claude pane ready");
      if (!flushPendingMessages()) promptIfReady();
      return;
    }
    await sleep(150);
  }

  if (ctrl.signal.aborted) return;
  const message = `Timed out after ${CLAUDE_READY_TIMEOUT_MS / 1000}s waiting for Claude to become ready.`;
  if (printMode) {
    failPrint(message);
  } else {
    stdoutLine({ type: "bridge_warning", message });
  }
}

function readClaudeExitStatus(): string | null {
  if (!existsSync(claudeExitStatusPath)) return null;
  return readFileSync(claudeExitStatusPath, "utf8").trim() || "unknown";
}

function tmuxSessionExists(): boolean {
  const res = spawnSync(tmuxPath, ["has-session", "-t", sessionName], {
    stdio: "ignore",
  });
  return res.status === 0;
}

function failClaudeStartup(exitStatus: string | null, pane: string): void {
  const statusText = exitStatus === null ? "the tmux session exited" : `Claude exited with status ${exitStatus}`;
  const message = `${statusText} before Claude became ready. Run state: ${runDir}. Check \`${claudePath} -v\` and Claude auth on this host.`;
  if (printMode) {
    failPrint(message);
  } else {
    const failureCapture = captureFailurePane();
    const paneTail = failureCapture.paneTail || tailLines(pane, 40);
    stdoutLine({
      type: "bridge_error",
      where: "claude-startup",
      message,
      run_state: runDir,
      pane_tail: paneTail || undefined,
    });
    shutdown(1);
  }
}

function isClaudePaneReady(pane: string): boolean {
  return CLAUDE_INPUT_PROMPT_RE.test(pane) || /-- INSERT --/.test(pane);
}

async function startTranscriptTail(): Promise<void> {
  const compatStreamJsonPrint = printMode && outputFormat === "stream-json" && !desplegaFormat;
  let transcriptPath: string;
  try {
    transcriptPath =
      (compatStreamJsonPrint ? await waitForRuntimeTranscriptPath(1_500) : null) ??
      await waitForFreshTranscriptForCwd(targetCwd, transcriptsBefore, ctrl.signal);
  } catch (err) {
    if (printMode) {
      desplegaDebug("live transcript discovery failed; falling back to Stop hook result", {
        error: (err as Error).message,
      });
      return;
    }
    stdoutLine({
      type: "bridge_error",
      where: "transcript-discovery",
      message: (err as Error).message,
    });
    return;
  }
  const projectFolder = projectFolderFromTranscript(transcriptPath);
  transcriptProjectFolder = projectFolder;
  stdoutLine({ type: "transcript_folder", path: projectFolder });
  const sessionId = sessionIdFromPath(transcriptPath);
  transcriptSessionId = sessionId;
  stdoutLine({ type: "transcript_open", path: transcriptPath, session_id: sessionId });
  if (compatStreamJsonPrint) {
    await tailTranscriptLines(
      transcriptPath,
      (line: string) => {
        let row: TranscriptRow;
        try {
          row = JSON.parse(line) as TranscriptRow;
        } catch {
          row = { type: "bridge_parse_error", line };
        }
        handleTranscriptRow(row, line);
        emitClaudeStreamRow(row);
      },
      ctrl.signal
    );
    return;
  }
  await tailTranscript(
    transcriptPath,
    (row: TranscriptRow, _index: number, rawLine: string) => handleTranscriptRow(row, rawLine),
    ctrl.signal
  );
}

async function waitForRuntimeTranscriptPath(timeoutMs: number): Promise<string | null> {
  const startedAt = Date.now();
  while (!ctrl.signal.aborted && Date.now() - startedAt < timeoutMs) {
    const path = readRuntimeTranscriptPath();
    if (path) return path;
    await sleep(50);
  }
  return null;
}

function readRuntimeTranscriptPath(): string | null {
  if (!existsSync(transcriptEventPath)) return null;
  try {
    const event = JSON.parse(readFileSync(transcriptEventPath, "utf8")) as RuntimeStopEvent;
    return typeof event.transcript_path === "string" && event.transcript_path
      ? event.transcript_path
      : null;
  } catch {
    return null;
  }
}

function handleTranscriptRow(row: TranscriptRow, _rawLine: string): void {
  if (printMode && printDone) return;

  stdoutLine({ type: "transcript", row });

  if (!printMode) return;

  if (typeof row.version === "string" && row.version) claudeVersionFromTranscript = row.version;
  if (row.type === "system" && row.subtype === "api_error") {
    const status = apiErrorStatusFromRow(row);
    if (status != null) lastApiErrorStatus = status;
  }

  const type = String(row.type ?? "");
  if (type === "assistant") {
    const msg = (row.message as Record<string, unknown> | undefined) ?? {};
    const text = textFromContent(msg.content).trim();
    if (text) {
      lastAssistantText = text;
      lastAssistantRow = row;
    }
    return;
  }

  if (isTurnDurationRow(row)) {
    if (typeof row.durationMs === "number") lastTurnDurationMs = row.durationMs;
    if (!lastAssistantText) {
      pendingPrintFailure = {
        message: "Claude reached turn end without assistant text.",
        rawResponse: lastAssistantText,
      };
      return;
    }
    pendingPrintResultText = lastAssistantText;
    return;
  }

}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      return block.type === "text" ? String(block.text ?? "") : "";
    })
    .filter(Boolean)
    .join("\n");
}

function printBanner(): void {
  process.stderr.write(
    [
      "",
      `   tmux session : ${sessionName}`,
      `   cwd          : ${targetCwd}`,
      `   run state    : ${runDir}`,
      "",
      `   attach to the Claude UI in another terminal:`,
      `     tmux attach -t ${sessionName}`,
      "",
      `   Type a message + Enter on stdin to send it to Claude.`,
      `   Assistant and useful transcript rows print below.`,
      `   Use --desplega-verbose for raw transcript rows and wrapper debug.`,
      `   Ctrl-D to quit (kills the tmux session).`,
      "",
    ].join("\n")
  );
}

function startRepl(): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
    prompt: inputPrompt,
  });
  rlRef = rl;
  if (isTTY) process.stdout.write("\n");
  rl.on("line", line => {
    const text = line.trim();
    if (!text) {
      promptIfReady();
      return;
    }
    sendUserMessage(text);
  });
  rl.on("close", () => shutdown());
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
}

let shuttingDown = false;
let paneCaptured = false;
function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  ctrl.abort();
  if (!paneCaptured && exitCode !== 0) {
    captureFailurePane();
  }
  spawnSync(tmuxPath, ["kill-session", "-t", sessionName], { stdio: "ignore" });
  process.exit(exitCode);
}

desplegaDebug("run state created", { runDir });
startTmux();
if (!printMode) startRepl();
