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
  isTurnDurationRow,
  listAllTranscriptPaths,
  listTranscriptPaths,
  readTranscriptLines,
  transcriptHasTurnEnd,
  waitForFreshTranscript,
  waitForFreshTranscriptForCwd,
  waitForTranscriptTurnEnd,
  tailTranscript,
  tailTranscriptLines,
  sessionIdFromPath,
  projectKeyForCwd,
  projectFolderFromTranscript,
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

const projectFolder = mkdtempSync(join(tmpdir(), "claude-bridge-tr-"));

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
ok("projectFolderFromTranscript extracts parent folder", projectFolderFromTranscript(found) === projectFolder);

const existingProjectFolder = mkdtempSync(join(tmpdir(), "claude-bridge-tr-existing-"));
const existingSessionUuid = "00000000-0000-0000-0000-000000000def";
const existingTranscriptPath = join(existingProjectFolder, `${existingSessionUuid}.jsonl`);
writeFileSync(
  existingTranscriptPath,
  JSON.stringify({ type: "system", subtype: "init", session_id: existingSessionUuid }) + "\n"
);
const existingFound = await waitForFreshTranscript(existingProjectFolder, new Set());
ok("waitForFreshTranscript accepts an already-created file", existingFound === existingTranscriptPath);

const allRoot = mkdtempSync(join(tmpdir(), "claude-bridge-tr-root-"));
const allProject = join(allRoot, "project");
mkdirSync(allProject, { recursive: true });
const allBefore = await listAllTranscriptPaths(allRoot);
ok("listAllTranscriptPaths starts empty", allBefore.size === 0);
const cwdSessionUuid = "00000000-0000-0000-0000-000000000fed";
const cwdTranscriptPath = join(allProject, `${cwdSessionUuid}.jsonl`);
const targetCwd = mkdtempSync(join(tmpdir(), "claude-bridge-cwd-"));
setTimeout(() => {
  writeFileSync(
    cwdTranscriptPath,
    JSON.stringify({ type: "system", subtype: "init", cwd: targetCwd }) + "\n"
  );
}, 250);
const cwdFound = await waitForFreshTranscriptForCwd(targetCwd, allBefore, undefined, allRoot);
ok("waitForFreshTranscriptForCwd finds matching cwd transcript", cwdFound === cwdTranscriptPath);

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

const rawLines = await readTranscriptLines(transcriptPath);
ok("readTranscriptLines preserves raw JSONL lines", rawLines[2]?.includes("\"assistant\"") === true);

const partialPath = join(projectFolder, "partial.jsonl");
writeFileSync(partialPath, "");
const partialCtrl = new AbortController();
const partialLines: string[] = [];
const partialTail = tailTranscriptLines(partialPath, line => partialLines.push(line), partialCtrl.signal);
appendFileSync(partialPath, JSON.stringify({ type: "user", message: "partial" }));
await new Promise(r => setTimeout(r, 250));
ok("tailTranscriptLines buffers partial line", partialLines.length === 0);
appendFileSync(partialPath, "\n" + JSON.stringify({ type: "assistant", message: "complete" }) + "\n");
await new Promise(r => setTimeout(r, 250));
partialCtrl.abort();
await partialTail;
ok("tailTranscriptLines emits completed partial after newline", partialLines[0]?.includes("\"partial\"") === true);
ok("tailTranscriptLines emits later complete line", partialLines[1]?.includes("\"assistant\"") === true);

// isTurnDurationRow recognizes only the terminal turn_duration system row.
ok(
  "isTurnDurationRow matches turn_duration",
  isTurnDurationRow({ type: "system", subtype: "turn_duration", durationMs: 1 } as TranscriptRow)
);
ok(
  "isTurnDurationRow rejects other system rows",
  !isTurnDurationRow({ type: "system", subtype: "stop_hook_summary" } as TranscriptRow)
);
ok(
  "isTurnDurationRow rejects assistant rows",
  !isTurnDurationRow({ type: "assistant" } as TranscriptRow)
);

// waitForTranscriptTurnEnd resolves only once the terminal row has landed,
// mirroring the Stop-hook-fires-before-turn_duration race.
const turnEndPath = join(projectFolder, "turn-end.jsonl");
writeFileSync(
  turnEndPath,
  JSON.stringify({ type: "system", subtype: "init" }) + "\n" +
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }) + "\n"
);
ok("transcriptHasTurnEnd false before terminal row", (await transcriptHasTurnEnd(turnEndPath)) === false);

// Times out (returns false) when turn_duration never lands.
const missedTurnEnd = await waitForTranscriptTurnEnd(turnEndPath, 200);
ok("waitForTranscriptTurnEnd times out without turn_duration", missedTurnEnd === false);

// Append the stop_hook_summary + turn_duration rows mid-wait; the wait should
// resolve true once the terminal row appears.
setTimeout(() => {
  appendFileSync(turnEndPath, JSON.stringify({ type: "system", subtype: "stop_hook_summary" }) + "\n");
  appendFileSync(turnEndPath, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 42 }) + "\n");
}, 200);
const sawTurnEnd = await waitForTranscriptTurnEnd(turnEndPath, 3_000);
ok("waitForTranscriptTurnEnd resolves once turn_duration lands", sawTurnEnd === true);
ok("transcriptHasTurnEnd true after terminal row", (await transcriptHasTurnEnd(turnEndPath)) === true);

try { rmSync(projectFolder, { recursive: true, force: true }); } catch {}
try { rmSync(existingProjectFolder, { recursive: true, force: true }); } catch {}
try { rmSync(allRoot, { recursive: true, force: true }); } catch {}
try { rmSync(targetCwd, { recursive: true, force: true }); } catch {}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
