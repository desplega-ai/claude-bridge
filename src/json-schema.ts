import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { DesplegaArg } from "./args.ts";

export const DEFAULT_JSON_SCHEMA_MAX_TOKENS = 15_000;

export type LoadedJsonSchema = {
  schema: JsonSchemaObject;
  compact: string;
  estimatedTokens: number;
  maxTokens: number;
};

export type ExtractedJson = {
  value: unknown;
  json: string;
  source: "full" | "fenced" | "balanced";
};

export type JsonValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string; issues: string[] };

export type StructuredOutputResult =
  | { ok: true; value: unknown; source: ExtractedJson["source"] }
  | { ok: false; message: string; rawResponse: string };

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonSchemaObject = { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

const JsonSchemaObjectSchema = z.record(z.string(), JsonValueSchema);
const PositiveIntSchema = z.coerce.number().int().positive();

export function resolveJsonSchemaMaxTokens(
  desplegaArgs: DesplegaArg[],
  env: NodeJS.ProcessEnv = process.env
): number {
  const flag = desplegaArgs.find(arg =>
    ["json-schema-max-tokens", "schema-max-tokens"].includes(arg.name)
  );
  const raw = flag?.value === undefined || flag.value === true ? env.CLAUDE_BRIDGE_JSON_SCHEMA_MAX_TOKENS : flag.value;
  if (raw === undefined || raw === false || raw === "") return DEFAULT_JSON_SCHEMA_MAX_TOKENS;

  const parsed = PositiveIntSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid JSON schema token limit \`${String(raw)}\`; expected a positive integer.`
    );
  }
  return parsed.data;
}

export function loadJsonSchema(input: string, cwd: string, maxTokens: number): LoadedJsonSchema {
  const rawText = readSchemaInput(input, cwd);
  return loadJsonSchemaFromText(rawText, maxTokens);
}

export function loadJsonSchemaFromText(rawText: string, maxTokens: number): LoadedJsonSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Unable to parse --json-schema as JSON: ${(err as Error).message}`);
  }

  const schema = JsonSchemaObjectSchema.safeParse(parsed);
  if (!schema.success || Array.isArray(parsed)) {
    throw new Error("--json-schema must resolve to a JSON Schema object.");
  }

  const compact = JSON.stringify(schema.data);
  const estimatedTokens = estimateTokens(compact);
  if (estimatedTokens > maxTokens) {
    throw new Error(
      `--json-schema is too large: estimated ${estimatedTokens} tokens exceeds limit ${maxTokens}.`
    );
  }

  return { schema: schema.data, compact, estimatedTokens, maxTokens };
}

export function makeJsonSchemaSystemPrompt(compactSchema: string): string {
  return [
    '<critical when="before replying to the user">',
    "For bridge channel input, call mcp__bridge__reply with the channel id as chat_id. Its text must end with valid JSON matching this schema. No prose after JSON.",
    compactSchema,
    "</critical>",
  ].join("\n");
}

export function mergeAppendSystemPrompt(args: string[], addition: string): string[] {
  const kept: string[] = [];
  const prompts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--append-system-prompt") {
      if (i + 1 < args.length) prompts.push(args[++i]!);
      continue;
    }
    if (arg.startsWith("--append-system-prompt=")) {
      prompts.push(arg.slice("--append-system-prompt=".length));
      continue;
    }
    kept.push(arg);
  }

  const merged = [...prompts, addition].filter(Boolean).join("\n\n");
  return [...kept, "--append-system-prompt", merged];
}

export function extractJsonValue(text: string): ExtractedJson | null {
  const trimmed = text.trim();
  if (trimmed) {
    const parsed = parseJson(trimmed);
    if (parsed.ok) return { value: parsed.value, json: trimmed, source: "full" };
  }

  const fenced = extractLastFencedJson(text);
  if (fenced) return fenced;

  return extractLastBalancedJson(text);
}

export function extractAndValidateStructuredOutput(
  text: string,
  schema: JsonSchemaObject
): StructuredOutputResult {
  const extracted = extractJsonValue(text);
  if (!extracted) {
    return {
      ok: false,
      message:
        "Claude reply did not contain a valid JSON value for --json-schema. Expected full JSON, a fenced json block, or a final balanced JSON object/array.",
      rawResponse: text,
    };
  }

  const validated = validateJsonAgainstSchema(extracted.value, schema);
  if (!validated.ok) {
    return {
      ok: false,
      message: `${validated.message} ${validated.issues.join("; ")}`,
      rawResponse: text,
    };
  }

  return { ok: true, value: validated.value, source: extracted.source };
}

export function validateJsonAgainstSchema(
  value: unknown,
  schema: JsonSchemaObject
): JsonValidationResult {
  let zodSchema: z.ZodType;
  try {
    zodSchema = z.fromJSONSchema(schema);
  } catch (err) {
    return {
      ok: false,
      message: "Unable to convert --json-schema to a Zod schema.",
      issues: [(err as Error).message],
    };
  }
  const parsed = zodSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    message: "Extracted JSON does not conform to --json-schema.",
    issues: parsed.error.issues.map(issue => {
      const path = issue.path.length ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    }),
  };
}

function readSchemaInput(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) return trimmed;

  const path = resolve(cwd, input);
  if (existsSync(path)) return readFileSync(path, "utf8");

  return trimmed;
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function extractLastFencedJson(text: string): ExtractedJson | null {
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: ExtractedJson | null = null;

  while ((match = fenceRe.exec(text))) {
    const candidate = (match[1] ?? "").trim();
    if (!candidate) continue;
    const parsed = parseJson(candidate);
    if (parsed.ok) last = { value: parsed.value, json: candidate, source: "fenced" };
  }

  return last;
}

function extractLastBalancedJson(text: string): ExtractedJson | null {
  let best: { start: number; end: number; value: unknown; json: string } | null = null;

  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== "{" && ch !== "[") continue;
    const json = balancedSliceFrom(text, start);
    if (!json) continue;
    const parsed = parseJson(json);
    if (!parsed.ok) continue;
    const end = start + json.length;
    if (!best || end > best.end || (end === best.end && start < best.start)) {
      best = { start, end, value: parsed.value, json };
    }
  }

  return best ? { value: best.value, json: best.json, source: "balanced" } : null;
}

function balancedSliceFrom(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      stack.push("}");
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}
