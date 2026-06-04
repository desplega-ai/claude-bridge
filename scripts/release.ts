#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const VERSION_ARG_RE =
  /^(patch|minor|major|prepatch|preminor|premajor|prerelease|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

if (import.meta.main) {
  main();
}

function main(): void {
  const args = process.argv.slice(2);
  const bump = args.find(arg => !arg.startsWith("-"));
  const allowDirty = args.includes("--allow-dirty");
  const noVerify = args.includes("--no-verify");

  if (!bump || !VERSION_ARG_RE.test(bump)) {
    usage();
    process.exit(2);
  }

  if (!allowDirty) {
    const status = command("git", ["status", "--porcelain"], { capture: true });
    if (status.stdout.trim()) {
      fail("Working tree is dirty. Commit/stash changes first, or rerun with --allow-dirty.");
    }
  }

  const before = packageVersion();
  if (isExplicitVersion(bump) && compareVersions(bump, before) <= 0) {
    fail(`Explicit version ${bump} must be greater than current version ${before}.`);
  }

  run("npm", ["version", "--no-git-tag-version", bump]);
  const after = packageVersion();

  if (before === after) {
    fail(`Version did not change (${before}).`);
  }

  run("bun", ["install"]);

  if (!noVerify) {
    run("bun", ["run", "test"]);
    run("bun", ["run", "typecheck"]);
    run("npm", ["pack", "--dry-run", "--json"]);
  }

  run("git", ["add", "package.json", "bun.lock"]);
  run("git", ["commit", "-m", `Release v${after}`]);

  console.log("");
  console.log(`Prepared release v${after}.`);
  console.log("");
  console.log("Next:");
  console.log("  git push origin HEAD");
  console.log("");
  console.log("The GitHub release workflow will publish npm, create the git tag, and create the GitHub Release.");
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) fail("package.json is missing version.");
  return pkg.version;
}

function run(commandName: string, commandArgs: string[]): void {
  const result = command(commandName, commandArgs, { capture: false });
  if (result.status !== 0) {
    fail(`${commandName} ${commandArgs.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function command(
  commandName: string,
  commandArgs: string[],
  options: { capture: boolean }
): { status: number | null; stdout: string } {
  const result = spawnSync(commandName, commandArgs, {
    cwd: REPO,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) fail(result.error.message);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
  };
}

function usage(): void {
  console.error("Usage: bun run release <patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z> [--allow-dirty] [--no-verify]");
}

export function isExplicitVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

export function compareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  for (let i = 0; i < 3; i++) {
    const delta = leftParts[i]! - rightParts[i]!;
    if (delta !== 0) return delta;
  }

  const leftPrerelease = left.includes("-");
  const rightPrerelease = right.includes("-");
  if (leftPrerelease === rightPrerelease) return 0;
  return leftPrerelease ? -1 : 1;
}

function numericVersionParts(version: string): [number, number, number] {
  const [main] = version.split("-");
  const parts = main!.split(".").map(part => Number(part));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}
