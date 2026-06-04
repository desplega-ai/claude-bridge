import { readFileSync } from "node:fs";
import {
  extractAndValidateStructuredOutput,
  loadJsonSchemaFromText,
} from "./json-schema.ts";

export type StopHookDecision = { decision: "block"; reason: string } | null;

const SCHEMA_STOP_FEEDBACK_MARKER = "claude-bridge schema output required";
const DEFAULT_MAX_SCHEMA_STOP_BLOCKS = 3;

type StopHookInput = {
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  transcript_path?: string;
};

export async function runJsonSchemaStopHook(): Promise<void> {
  const input = await new Response(Bun.stdin.stream()).text();
  const decision = evaluateJsonSchemaStopHook(input, process.env);
  if (decision) process.stdout.write(JSON.stringify(decision) + "\n");
}

export function evaluateJsonSchemaStopHook(
  inputText: string,
  env: NodeJS.ProcessEnv = process.env
): StopHookDecision {
  if (env.CLAUDE_BRIDGE_SCHEMA_STOP_HOOK !== "1" || !env.CLAUDE_BRIDGE_JSON_SCHEMA_PATH) {
    return null;
  }

  const input = parseHookInput(inputText);
  if (!input || input.hook_event_name !== "Stop") return null;

  const schema = loadJsonSchemaFromText(
    readFileSync(env.CLAUDE_BRIDGE_JSON_SCHEMA_PATH, "utf8"),
    Number.MAX_SAFE_INTEGER
  ).schema;
  const candidates = collectCandidateReplies(input);
  for (const candidate of candidates) {
    const result = extractAndValidateStructuredOutput(candidate, schema);
    if (result.ok) return null;
  }

  const feedbackCount = input.transcript_path
    ? countSchemaStopFeedbacks(input.transcript_path)
    : 0;
  if (feedbackCount >= resolveMaxSchemaStopBlocks(env)) return null;

  return {
    decision: "block",
    reason: [
      `${SCHEMA_STOP_FEEDBACK_MARKER}: reply again with valid JSON matching the provided JSON Schema.`,
      "No prose after the JSON.",
    ].join(" "),
  };
}

function parseHookInput(inputText: string): StopHookInput | null {
  try {
    return JSON.parse(inputText) as StopHookInput;
  } catch {
    return null;
  }
}

function collectCandidateReplies(input: StopHookInput): string[] {
  const candidates: string[] = [];
  const transcriptReply = input.transcript_path
    ? latestAssistantTextFromTranscript(input.transcript_path)
    : null;
  if (transcriptReply) candidates.push(transcriptReply);
  if (input.last_assistant_message) candidates.push(input.last_assistant_message);
  return candidates;
}

function latestAssistantTextFromTranscript(transcriptPath: string): string | null {
  try {
    const rows = readTranscriptRows(transcriptPath);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.type !== "assistant") continue;
      const text = textFromMessageContent(
        (rows[i]!.message as Record<string, unknown> | undefined)?.content
      ).trim();
      if (text) return text;
    }
  } catch {
    return null;
  }
  return null;
}

function countSchemaStopFeedbacks(transcriptPath: string): number {
  try {
    return readTranscriptRows(transcriptPath).filter(row =>
      textFromMessageContent((row.message as Record<string, unknown> | undefined)?.content).includes(
        SCHEMA_STOP_FEEDBACK_MARKER
      )
    ).length;
  } catch {
    return 0;
  }
}

function readTranscriptRows(transcriptPath: string): Record<string, unknown>[] {
  return readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      return block.type === "text" ? String(block.text ?? "") : "";
    })
    .join("\n");
}

function resolveMaxSchemaStopBlocks(env: NodeJS.ProcessEnv): number {
  const value = Number(env.CLAUDE_BRIDGE_SCHEMA_STOP_HOOK_MAX_BLOCKS ?? DEFAULT_MAX_SCHEMA_STOP_BLOCKS);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_MAX_SCHEMA_STOP_BLOCKS;
  return Math.floor(value);
}
