#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeGlobalConfigPath, preAcceptProject, writeWorkdirSettings } from "./preaccept.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const root = mkdtempSync(join(tmpdir(), "bridge-preaccept-"));
const configDir = join(root, "config");
const workdir = join(root, "work");

try {
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const configPath = claudeGlobalConfigPath();
  ok("respects CLAUDE_CONFIG_DIR", configPath === join(configDir, ".claude.json"));

  preAcceptProject({ workdir, mcpServerNames: ["bridge"] });
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    hasCompletedOnboarding?: boolean;
    lastOnboardingVersion?: string;
    projects?: Record<string, Record<string, unknown>>;
  };
  const project = config.projects?.[workdir];
  ok("marks global onboarding complete", config.hasCompletedOnboarding === true);
  ok("sets global onboarding version", typeof config.lastOnboardingVersion === "string");
  ok("creates project entry", Boolean(project));
  ok("accepts trust dialog", project?.hasTrustDialogAccepted === true);
  ok("marks onboarding complete", project?.hasCompletedProjectOnboarding === true);
  ok(
    "approves bridge mcp server",
    Array.isArray(project?.approvedMcprcServers) &&
      project.approvedMcprcServers.includes("bridge")
  );

  writeWorkdirSettings(workdir, { bypassPermissions: true });
  const bypassSettings = JSON.parse(
    readFileSync(join(workdir, ".claude", "settings.local.json"), "utf8")
  ) as Record<string, unknown>;
  ok("writes bypass mode for non-root runs", bypassSettings.defaultMode === "bypassPermissions");
  ok(
    "writes dangerous mode prompt skip for non-root runs",
    bypassSettings.skipDangerousModePermissionPrompt === true
  );

  bypassSettings.otherSetting = "preserved";
  await Bun.write(
    join(workdir, ".claude", "settings.local.json"),
    JSON.stringify(bypassSettings, null, 2) + "\n"
  );
  writeWorkdirSettings(workdir, { bypassPermissions: false });
  const rootSettings = JSON.parse(
    readFileSync(join(workdir, ".claude", "settings.local.json"), "utf8")
  ) as Record<string, unknown>;
  ok("removes bypass mode for root runs", !("defaultMode" in rootSettings));
  ok(
    "removes dangerous mode prompt skip for root runs",
    !("skipDangerousModePermissionPrompt" in rootSettings)
  );
  ok("preserves unrelated settings", rootSettings.otherSetting === "preserved");
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  rmSync(root, { recursive: true, force: true });
}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
