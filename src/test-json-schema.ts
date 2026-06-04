#!/usr/bin/env bun
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAndValidateStructuredOutput,
  extractJsonValue,
  loadJsonSchema,
  makeJsonSchemaSystemPrompt,
  mergeAppendSystemPrompt,
  resolveJsonSchemaMaxTokens,
  validateJsonAgainstSchema,
} from "./json-schema.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const inline = loadJsonSchema('{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}', process.cwd(), 100);
ok("loads inline schema", inline.compact === '{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}');
ok("estimates compact schema tokens", inline.estimatedTokens > 0 && inline.estimatedTokens < 100);

const workdir = mkdtempSync(join(tmpdir(), "bridge-schema-"));
const schemaPath = join(workdir, "schema.json");
writeFileSync(schemaPath, '{"type":"array","items":{"type":"integer"}}');
const fromFile = loadJsonSchema(schemaPath, process.cwd(), 100);
ok("loads schema from file", fromFile.compact === '{"type":"array","items":{"type":"integer"}}');

let tooLarge = false;
try {
  loadJsonSchema('{"type":"object","description":"' + "x".repeat(100) + '"}', process.cwd(), 5);
} catch {
  tooLarge = true;
}
ok("rejects schema above token limit", tooLarge);

ok(
  "env max token limit parses",
  resolveJsonSchemaMaxTokens([], { CLAUDE_BRIDGE_JSON_SCHEMA_MAX_TOKENS: "42" }) === 42
);
ok(
  "desplega max token limit wins",
  resolveJsonSchemaMaxTokens(
    [{ raw: "--desplega-json-schema-max-tokens=77", name: "json-schema-max-tokens", value: "77" }],
    { CLAUDE_BRIDGE_JSON_SCHEMA_MAX_TOKENS: "42" }
  ) === 77
);

const schemaPrompt = makeJsonSchemaSystemPrompt(inline.compact);
ok("schema prompt includes compact schema", schemaPrompt.includes(inline.compact));
ok("schema prompt asks for bridge reply tool", schemaPrompt.includes("mcp__bridge__reply"));
ok("schema prompt uses critical block", schemaPrompt.includes('<critical when="before replying to the user">'));

const mergedSeparate = mergeAppendSystemPrompt(
  ["--model", "sonnet", "--append-system-prompt", "existing prompt"],
  "schema prompt"
);
ok(
  "merges separate append-system-prompt without overwriting",
  mergedSeparate.join("\n").includes("existing prompt\n\nschema prompt")
);
ok("keeps non-prompt args while merging", mergedSeparate.slice(0, 2).join(" ") === "--model sonnet");

const mergedEquals = mergeAppendSystemPrompt(
  ["--append-system-prompt=first", "--append-system-prompt", "second"],
  "third"
);
ok("merges multiple append-system-prompt forms", mergedEquals.at(-1) === "first\n\nsecond\n\nthird");

const full = extractJsonValue('{"ok":true}');
ok("extracts full json", full?.source === "full" && (full.value as any).ok === true);

const fenced = extractJsonValue('notes\n```json\n{"ok":true}\n```');
ok("extracts fenced json", fenced?.source === "fenced" && (fenced.value as any).ok === true);

const balanced = extractJsonValue('explanation first\n{"ok":true,"nested":{"value":1}}\n');
ok("extracts final balanced json", balanced?.source === "balanced" && (balanced.value as any).nested.value === 1);

const valid = validateJsonAgainstSchema({ name: "Taras" }, inline.schema);
ok("validates conforming object with zod", valid.ok);

const invalid = validateJsonAgainstSchema({ name: 123 }, inline.schema);
ok("rejects non-conforming object with zod", !invalid.ok && invalid.issues.some(issue => issue.includes("name")));

const noJson = extractAndValidateStructuredOutput("plain text only", inline.schema);
ok("structured extraction failure includes raw response", !noJson.ok && noJson.rawResponse === "plain text only");

const wrongJson = extractAndValidateStructuredOutput('{"name":123}', inline.schema);
ok("structured validation failure includes raw response", !wrongJson.ok && wrongJson.rawResponse === '{"name":123}');

const draft202012 = loadJsonSchema(
  '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"resp":{"type":"string"}},"required":["resp"]}',
  process.cwd(),
  100
);
ok("loads draft 2020-12 schema with $schema key", draft202012.schema.$schema === "https://json-schema.org/draft/2020-12/schema");
ok("validates draft 2020-12 schema via z.fromJSONSchema", validateJsonAgainstSchema({ resp: "hi" }, draft202012.schema).ok);
ok("rejects draft 2020-12 schema mismatch", !validateJsonAgainstSchema({ resp: 123 }, draft202012.schema).ok);

try { rmSync(workdir, { recursive: true, force: true }); } catch {}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
