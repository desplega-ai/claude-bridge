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
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { preAcceptProject, writeWorkdirSettings } from "./preaccept.ts";
import { claudeAuthEnvArgs, claudeUnsetEnvArgs } from "./auth-env.ts";
import {
  listAllTranscriptPaths,
  projectFolderFromTranscript,
  sessionIdFromPath,
  tailTranscript,
  waitForFreshTranscriptForCwd,
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
  installJsonSchemaStopHook,
  uninstallJsonSchemaStopHook,
} from "./hook-install.ts";
import { makePrintErrorResult } from "./print-result.ts";
import { runJsonSchemaStopHook } from "./stop-hook.ts";

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

if (hasDesplegaFlag("internal-json-schema-stop-hook")) {
  await runJsonSchemaStopHook();
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
const runDir = join(REPO, ".runs", runId);
mkdirSync(runDir, { recursive: true });

const jsonSchemaPath = jsonSchema ? join(runDir, "json-schema.json") : undefined;
const sessionName = `claude-bridge-${runId.slice(-8)}`;
const PRINT_READY_TIMEOUT_MS = envDurationMs(
  "CLAUDE_BRIDGE_PRINT_READY_TIMEOUT_MS",
  envDurationMs("CLAUDE_BRIDGE_PRINT_CHANNEL_TIMEOUT_MS", 180_000)
);
const PRINT_REPLY_TIMEOUT_MS = envDurationMs("CLAUDE_BRIDGE_PRINT_REPLY_TIMEOUT_MS", 10 * 60_000);
const CLAUDE_READY_TIMEOUT_MS = envDurationMs("CLAUDE_BRIDGE_CLAUDE_READY_TIMEOUT_MS", 180_000);
const TMUX_SUBMIT_DELAY_MS = envDurationMs("CLAUDE_BRIDGE_TMUX_SUBMIT_DELAY_MS", 1_000);

if (jsonSchemaPath && jsonSchema) {
  writeFileSync(jsonSchemaPath, jsonSchema.compact + "\n");
  installJsonSchemaStopHook({ command: buildJsonSchemaStopHookCommand() });
}

preAcceptProject({ workdir: targetCwd, mcpServerNames: [] });
writeWorkdirSettings(targetCwd);

const ctrl = new AbortController();
const isTTY = !!process.stdout.isTTY && !printMode;
const showRaw = desplegaVerbose;
const inputPrompt = isTTY ? "> " : "";
const debugEvents: Record<string, unknown>[] = [];
let transcriptSessionId: string | undefined;
let lastAssistantText = "";
let printDone = false;
let printReadyTimer: ReturnType<typeof setTimeout> | null = null;
let printReplyTimer: ReturnType<typeof setTimeout> | null = null;

let rlRef: import("node:readline").Interface | null = null;
const stdoutLine = (obj: Record<string, unknown>): void => {
  if (printMode) {
    if (outputFormat === "stream-json") process.stdout.write(JSON.stringify(obj) + "\n");
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
  if (printMode && outputFormat === "json") {
    debugEvents.push(event);
    return;
  }
  if (printMode && outputFormat === "stream-json") {
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

function hasDesplegaFlag(name: string): boolean {
  const arg = desplegaArgs.find(arg => arg.name === name);
  return Boolean(arg && arg.value !== false);
}

function desplegaValue(name: string): boolean | string | undefined {
  return desplegaArgs.find(arg => arg.name === name)?.value;
}

function failBeforeRun(message: string): never {
  if (printMode && outputFormat !== "text") {
    process.stdout.write(
      JSON.stringify({ type: "result", subtype: "error", is_error: true, error: message }) + "\n"
    );
  } else {
    process.stderr.write(`claude-bridge: ${message}\n`);
  }
  process.exit(2);
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
  if (printMode && !printReplyTimer) startPrintReplyTimer();
  return id;
}

function sendPromptToTmux(text: string, id: string): boolean {
  const bufferName = `claude-bridge-${id}`;
  const load = spawnSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
    input: text,
    encoding: "utf8",
  });
  if (load.status !== 0) {
    return failTmuxSend("load prompt buffer", load);
  }

  const paste = spawnSync("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", sessionName], {
    encoding: "utf8",
  });
  if (paste.status !== 0) {
    return failTmuxSend("paste prompt buffer", paste);
  }

  sleepSync(TMUX_SUBMIT_DELAY_MS);
  const enter = spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
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
  clearPrintTimers();
  if (outputFormat === "text") {
    const text = structured ? JSON.stringify(structured.value) : resultText;
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  } else {
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
  }
  shutdown();
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

function startPrintReadyTimer(): void {
  if (!printMode || printReadyTimer) return;
  printReadyTimer = setTimeout(() => {
    failPrint(
      `Timed out after ${PRINT_READY_TIMEOUT_MS / 1000}s waiting for Claude to become ready.`
    );
  }, PRINT_READY_TIMEOUT_MS);
}

function startPrintReplyTimer(): void {
  if (!printMode || printReplyTimer) return;
  printReplyTimer = setTimeout(() => {
    failPrint(
      `Timed out after ${PRINT_REPLY_TIMEOUT_MS / 1000}s waiting for a reply from Claude.`
    );
  }, PRINT_REPLY_TIMEOUT_MS);
}

function clearPrintReadyTimer(): void {
  if (!printReadyTimer) return;
  clearTimeout(printReadyTimer);
  printReadyTimer = null;
}

function clearPrintReplyTimer(): void {
  if (!printReplyTimer) return;
  clearTimeout(printReplyTimer);
  printReplyTimer = null;
}

function clearPrintTimers(): void {
  clearPrintReadyTimer();
  clearPrintReplyTimer();
}

function failPrint(message: string, details: { rawResponse?: string } = {}): void {
  if (printDone) return;
  printDone = true;
  clearPrintTimers();
  if (desplegaVerbose) {
    const pane = capturePane();
    if (pane.trim()) {
      desplegaDebug("tmux pane before failure", {
        tail: pane.split("\n").slice(-80).join("\n"),
      });
    }
  }
  if (outputFormat === "text") {
    process.stderr.write(`claude-bridge: ${message}\n`);
    if (details.rawResponse !== undefined) {
      process.stderr.write(`Raw Claude reply:\n${details.rawResponse}\n`);
    }
  } else {
    const result = makePrintErrorResult(message, {
      rawResponse: details.rawResponse,
      sessionId: transcriptSessionId,
      debug: outputFormat === "json" ? debugEvents : undefined,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  shutdown(1);
}

function startTmux(): void {
  const claudeArgs = [
    "--dangerously-skip-permissions",
    ...forwardedClaudeArgs,
  ];
  const envArgs = [
    ...claudeAuthEnvArgs(process.env, { localAuth: hasDesplegaFlag("local-auth") }),
    ...(jsonSchemaPath
      ? [
          "CLAUDE_BRIDGE_SCHEMA_STOP_HOOK=1",
          `CLAUDE_BRIDGE_JSON_SCHEMA_PATH=${jsonSchemaPath}`,
          `CLAUDE_BRIDGE_RUN_ID=${runId}`,
        ]
      : []),
  ];
  desplegaDebug("starting claude in tmux", { sessionName, claudeArgs });
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
    "env",
    ...claudeUnsetEnvArgs(),
    ...envArgs,
    "claude",
    ...claudeArgs,
  ];
  const res = spawnSync("tmux", newSession, { stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write(`[claude-bridge] tmux new-session exited ${res.status}\n`);
    process.exit(1);
  }
  void autoAcceptStartupPrompts();
  void waitForClaudeReady();
  void startTranscriptTail();
  if (!printMode) printBanner();
}

function capturePane(): string {
  const r = spawnSync("tmux", ["capture-pane", "-pt", sessionName, "-S", "-80"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const THEME_DIALOG_RE = /(Choose the text style that looks best with your terminal|To change this later, run \/theme)/i;
const SECURITY_NOTES_DIALOG_RE = /(Security notes:|Press Enter to continue)/i;
const CUSTOM_API_KEY_DIALOG_RE = /(Detected a custom API key in your environment|Do you want to use this API key\?)/i;
const CLAUDE_INPUT_PROMPT_RE = /(^|\n)\s*(?:❯|>)[^\n]*(?:\n|$)/;

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
        spawnSync("tmux", ["send-keys", "-t", sessionName, "Up", "Enter"]);
      } else {
        spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
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
): "theme" | "security-notes" | "custom-api-key" | null {
  if (hasDesplegaFlag("local-auth") && CUSTOM_API_KEY_DIALOG_RE.test(pane)) {
    return "custom-api-key";
  }
  if (THEME_DIALOG_RE.test(pane)) return "theme";
  if (SECURITY_NOTES_DIALOG_RE.test(pane)) return "security-notes";
  return null;
}

async function waitForClaudeReady(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CLAUDE_READY_TIMEOUT_MS && !ctrl.signal.aborted) {
    const pane = capturePane();
    if (isClaudePaneReady(pane)) {
      claudeReady = true;
      clearPrintReadyTimer();
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

function isClaudePaneReady(pane: string): boolean {
  return (
    /bypass permissions on/i.test(pane) &&
    (CLAUDE_INPUT_PROMPT_RE.test(pane) || /-- INSERT --/.test(pane))
  );
}

async function startTranscriptTail(): Promise<void> {
  let transcriptPath: string;
  try {
    transcriptPath = await waitForFreshTranscriptForCwd(targetCwd, transcriptsBefore, ctrl.signal);
  } catch (err) {
    if (printMode) {
      failPrint((err as Error).message);
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
  stdoutLine({ type: "transcript_folder", path: projectFolder });
  const sessionId = sessionIdFromPath(transcriptPath);
  transcriptSessionId = sessionId;
  stdoutLine({ type: "transcript_open", path: transcriptPath, session_id: sessionId });
  await tailTranscript(
    transcriptPath,
    (row: TranscriptRow) => handleTranscriptRow(row),
    ctrl.signal
  );
}

function handleTranscriptRow(row: TranscriptRow): void {
  stdoutLine({ type: "transcript", row });

  if (!printMode) return;

  const type = String(row.type ?? "");
  if (type === "assistant") {
    const msg = (row.message as Record<string, unknown> | undefined) ?? {};
    const text = textFromContent(msg.content).trim();
    if (text) lastAssistantText = text;
    return;
  }

  if (type === "system" && row.subtype === "turn_duration") {
    if (!lastAssistantText) {
      failPrint("Claude reached turn end without assistant text.", {
        rawResponse: lastAssistantText,
      });
      return;
    }
    finishPrintResult(lastAssistantText);
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
function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearPrintTimers();
  ctrl.abort();
  spawn("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" }).on("exit", () =>
    process.exit(exitCode)
  );
  setTimeout(() => process.exit(exitCode), 1500);
}

desplegaDebug("run state created", { runDir });
startPrintReadyTimer();
startTmux();
if (!printMode) startRepl();
