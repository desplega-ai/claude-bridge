#!/usr/bin/env bun
/**
 * Packaging guard: every runtime source in src/ must be listed in package.json's
 * `files` allowlist, and every src/ entry in `files` must exist on disk.
 *
 * Without this, adding a new src file that cli.ts imports (but forgetting the
 * allowlist) publishes a tarball that crashes at runtime with
 * "Cannot find module ./<file>.ts" — npm pack does not resolve imports, so the
 * dry-run validation in CI passes anyway. v0.2.0 shipped exactly this bug
 * (missing src/claude-compat.ts).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const pkg = await Bun.file(join(ROOT, "package.json")).json();
const files: string[] = pkg.files ?? [];
const listed = new Set(files);

// Every non-test src/*.ts must be in the allowlist.
const runtimeSources = readdirSync(join(ROOT, "src"))
  .filter(f => f.endsWith(".ts") && !f.startsWith("test-"))
  .map(f => "src/" + f);

for (const src of runtimeSources) {
  ok(`${src} is in package.json files`, listed.has(src));
}

// Every src/ entry in the allowlist must exist on disk (catch stale entries).
const srcEntries = readdirSync(join(ROOT, "src")).map(f => "src/" + f);
const onDisk = new Set(srcEntries);
for (const f of files.filter(f => f.startsWith("src/"))) {
  ok(`listed file ${f} exists on disk`, onDisk.has(f));
}

// Test files must NOT be shipped.
for (const f of files) {
  ok(`${f} is not a test file`, !/(^|\/)test-/.test(f));
}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
