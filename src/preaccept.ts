/**
 * Pre-accept the prompts that would otherwise block the freshly spawned Claude:
 *
 *   1. The "Do you trust this folder?" dialog
 *      → write projects[<workdir>].hasTrustDialogAccepted = true and
 *        hasCompletedProjectOnboarding = true in ~/.claude.json
 *   2. The .mcp.json server approval prompt
 *      → add the bridge server to projects[<workdir>].approvedMcprcServers
 *
 * The dev-channels confirmation prompt (--dangerously-load-development-channels)
 * is NOT persisted in ~/.claude.json — it has to be answered live. We handle
 * that separately by watching the tmux pane for its marker text and sending
 * `y<Enter>` via tmux send-keys. See cli.ts:autoAcceptDevChannelPrompt.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export function preAcceptProject(opts: { workdir: string; mcpServerNames: string[] }): void {
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (!existsSync(claudeJsonPath)) {
    // Nothing to merge into; create a stub. Claude will fill it in on first run.
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: {} }, null, 2));
  }

  const backup = claudeJsonPath + ".ctc-backup";
  if (!existsSync(backup)) copyFileSync(claudeJsonPath, backup);

  const raw = readFileSync(claudeJsonPath, "utf8");
  const obj = JSON.parse(raw) as {
    projects?: Record<string, Record<string, unknown>>;
  };
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
export function writeWorkdirSettings(workdir: string): void {
  const dir = join(workdir, ".claude");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.local.json");
  const settings = {
    skipDangerousModePermissionPrompt: true,
    defaultMode: "bypassPermissions" as const,
  };
  writeFileSync(file, JSON.stringify(settings, null, 2));
}
