#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeLaunchCommand, shellQuote } from "./launch-command.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

ok("shell quote wraps simple strings", shellQuote("abc") === "'abc'");
ok("shell quote handles empty strings", shellQuote("") === "''");
ok("shell quote escapes single quotes", shellQuote("a'b") === "'a'\\''b'");

const tempDir = mkdtempSync(join(tmpdir(), "claude-bridge-launch-"));
const fakeClaude = join(tempDir, "fake claude");
const observedPath = join(tempDir, "observed.txt");
const exitStatusPath = join(tempDir, "claude-exit-status");

writeFileSync(
  fakeClaude,
  [
    "#!/bin/sh",
    "{",
    "  printf 'args=%s\\n' \"$*\"",
    "  printf 'api=%s\\n' \"$ANTHROPIC_API_KEY\"",
    "  printf 'base=%s\\n' \"$ANTHROPIC_BASE_URL\"",
    `} > ${shellQuote(observedPath)}`,
    "exit 42",
    "",
  ].join("\n")
);
chmodSync(fakeClaude, 0o755);

const command = buildClaudeLaunchCommand({
  claudePath: fakeClaude,
  claudeArgs: ["--dangerously-skip-permissions", "--model", "claude's best"],
  unsetEnvArgs: ["-u", "ANTHROPIC_API_KEY"],
  envArgs: ["HOME=/root", "ANTHROPIC_BASE_URL=https://example.test"],
  exitStatusPath,
  holdMs: 1,
});

ok("launch command uses an sh wrapper", command.startsWith("/bin/sh -lc "));
ok("launch command keeps pane briefly after exit", command.includes("sleep 1"));

const run = spawnSync("/bin/sh", ["-lc", command], {
  env: { ...process.env, ANTHROPIC_API_KEY: "stale-key" },
  encoding: "utf8",
});
const observed = readFileSync(observedPath, "utf8");
ok("launch command returns Claude exit status", run.status === 42);
ok("launch command writes exit status", readFileSync(exitStatusPath, "utf8").trim() === "42");
ok("launch command clears stale env", observed.includes("api=\n"));
ok("launch command exports forwarded env", observed.includes("base=https://example.test\n"));
ok("launch command preserves quoted args", observed.includes("args=--dangerously-skip-permissions --model claude's best\n"));

rmSync(tempDir, { recursive: true, force: true });

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
