/**
 * Pre-accept the prompts that would otherwise block the freshly spawned Claude:
 *
 *   1. The "Do you trust this folder?" dialog
 *      → write projects[<workdir>].hasTrustDialogAccepted = true and
 *        hasCompletedProjectOnboarding = true in Claude's global config file.
 *        That is ~/.claude.json by default, or $CLAUDE_CONFIG_DIR/.claude.json
 *        when CLAUDE_CONFIG_DIR is set.
 *   2. Optional .mcp.json server approvals
 *      → add any requested server names to projects[<workdir>].approvedMcprcServers.
 *
 * Live startup prompts such as theme and security notes are handled by watching
 * the tmux pane for marker text and sending Enter. See cli.ts:autoAcceptStartupPrompts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function claudeGlobalConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) return join(homedir(), ".claude.json");
  return join(resolve(configDir), ".claude.json");
}

export function preAcceptProject(opts: { workdir: string; mcpServerNames: string[] }): void {
  const claudeJsonPath = claudeGlobalConfigPath();
  mkdirSync(dirname(claudeJsonPath), { recursive: true });
  if (!existsSync(claudeJsonPath)) {
    // Nothing to merge into; create a stub. Claude will fill it in on first run.
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: {} }, null, 2));
  }

  const backup = claudeJsonPath + ".claude-bridge-backup";
  if (!existsSync(backup)) copyFileSync(claudeJsonPath, backup);

  const raw = readFileSync(claudeJsonPath, "utf8");
  const obj = JSON.parse(raw) as {
    hasCompletedOnboarding?: boolean;
    lastOnboardingVersion?: string;
    projects?: Record<string, Record<string, unknown>>;
  };
  obj.hasCompletedOnboarding = true;
  obj.lastOnboardingVersion ??= "2.1.0";
  obj.projects ??= {};
  const entry = (obj.projects[opts.workdir] ??= {});
  entry.hasTrustDialogAccepted = true;
  entry.hasCompletedProjectOnboarding = true;
  const approved = new Set([
    ...((entry.approvedMcprcServers as string[] | undefined) ?? []),
    ...opts.mcpServerNames,
  ]);
  entry.approvedMcprcServers = [...approved];

  writeFileSync(claudeJsonPath, JSON.stringify(obj, null, 2));
}

/**
 * Per-workdir settings.json with the policy bits that skip remaining prompts.
 * Claude reads .claude/settings.local.json out of the cwd at startup.
 */
export function writeWorkdirSettings(
  workdir: string,
  opts: { bypassPermissions: boolean } = { bypassPermissions: true }
): void {
  const dir = join(workdir, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.local.json");
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  const settings = { ...existing };
  if (opts.bypassPermissions) {
    settings.skipDangerousModePermissionPrompt = true;
    settings.defaultMode = "bypassPermissions";
  } else {
    if (settings.defaultMode === "bypassPermissions") delete settings.defaultMode;
    if (settings.skipDangerousModePermissionPrompt === true) {
      delete settings.skipDangerousModePermissionPrompt;
    }
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}
