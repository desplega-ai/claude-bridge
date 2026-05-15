#!/usr/bin/env bun
/**
 * Transcript discovery + tail unit test. No tmux, no claude.
 * Synthesises a fake project folder, drops a JSONL file in it, asserts that
 * waitForFreshTranscript finds it and tailTranscript emits every row exactly
 * once even when new rows append after the tail starts.
 */
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listTranscriptPaths,
  waitForFreshTranscript,
  tailTranscript,
  sessionIdFromPath,
  projectKeyForCwd,
  type TranscriptRow,
} from "./transcript.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

// projectKeyForCwd matches Shannon's slug rule
ok(
  "projectKeyForCwd slugifies",
  projectKeyForCwd("/Users/foo/My Project/sub.dir") ===
    "-Users-foo-My-Project-sub.dir"
);

const projectFolder = mkdtempSync(join(tmpdir(), "ctc-tr-"));

const before = await listTranscriptPaths(projectFolder);
ok("snapshot starts empty", before.size === 0);

const sessionUuid = "00000000-0000-0000-0000-000000000abc";
const transcriptPath = join(projectFolder, `${sessionUuid}.jsonl`);

// Create the file after a small delay so waitForFreshTranscript actually polls.
setTimeout(() => {
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionUuid }) + "\n"
  );
}, 250);

const found = await waitForFreshTranscript(projectFolder, before);
ok("waitForFreshTranscript finds the file", found === transcriptPath);
ok("sessionIdFromPath extracts uuid", sessionIdFromPath(found) === sessionUuid);

const seen: TranscriptRow[] = [];
const ctrl = new AbortController();
const tailPromise = tailTranscript(found, row => seen.push(row), ctrl.signal);

// Append a few rows over the next 600ms.
const append = (row: unknown) => appendFileSync(transcriptPath, JSON.stringify(row) + "\n");
await new Promise(r => setTimeout(r, 150));
append({ type: "user", message: { role: "user", content: "hi" } });
await new Promise(r => setTimeout(r, 150));
append({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
await new Promise(r => setTimeout(r, 150));
append({ type: "system", subtype: "turn_duration", durationMs: 1234 });

// Give the tail loop time to pick the last write up.
await new Promise(r => setTimeout(r, 250));
ctrl.abort();
await tailPromise;

ok("tail emitted at least 4 rows", seen.length >= 4);
ok("init row first", seen[0]?.type === "system");
ok("user row second", seen[1]?.type === "user");
ok("assistant row third", seen[2]?.type === "assistant");
ok("turn_duration row last", seen[3]?.type === "system" && (seen[3] as any).subtype === "turn_duration");

// no duplicates
const userCount = seen.filter(r => r.type === "user").length;
ok("user row appears exactly once", userCount === 1);

try { rmSync(projectFolder, { recursive: true, force: true }); } catch {}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
