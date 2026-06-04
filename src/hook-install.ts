import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const JSON_SCHEMA_STOP_HOOK_ARG = "--desplega-internal-json-schema-stop-hook";

type HookHandler = {
  type?: string;
  command?: string;
  [key: string]: unknown;
};

type HookGroup = {
  hooks?: HookHandler[];
  [key: string]: unknown;
};

type ClaudeSettings = {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

export function globalClaudeSettingsPath(): string {
  return resolve(homedir(), ".claude", "settings.json");
}

export function buildJsonSchemaStopHookCommand(argv = process.argv): string {
  const entry = argv[1] ? resolve(process.cwd(), argv[1]) : resolve("src/cli.ts");
  const parts = entry.endsWith(".ts")
    ? ["bun", entry, JSON_SCHEMA_STOP_HOOK_ARG]
    : [entry, JSON_SCHEMA_STOP_HOOK_ARG];
  return parts.map(shellQuote).join(" ");
}

export function installJsonSchemaStopHook(opts: {
  settingsPath?: string;
  command: string;
}): { settingsPath: string; changed: boolean } {
  const settingsPath = opts.settingsPath ?? globalClaudeSettingsPath();
  const settings = readSettings(settingsPath);
  settings.hooks ??= {};
  const stopGroups = settings.hooks.Stop ?? [];
  const current = removeStaleJsonSchemaStopHookGroups(stopGroups, opts.command);
  const alreadyInstalled = current.some(group =>
    (group.hooks ?? []).some(handler => handler.command === opts.command)
  );

  settings.hooks.Stop = alreadyInstalled
    ? current
    : [
        ...current,
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: opts.command,
              timeout: 30,
            },
          ],
        },
      ];

  const changed =
    stopGroups.length !== settings.hooks.Stop.length ||
    !alreadyInstalled ||
    JSON.stringify(stopGroups) !== JSON.stringify(settings.hooks.Stop);
  if (changed) writeSettings(settingsPath, settings);
  return { settingsPath, changed };
}

export function uninstallJsonSchemaStopHook(settingsPath = globalClaudeSettingsPath()): {
  settingsPath: string;
  removed: number;
} {
  const settings = readSettings(settingsPath);
  const stopGroups = settings.hooks?.Stop ?? [];
  const before = countJsonSchemaStopHookHandlers(stopGroups);
  if (!settings.hooks || before === 0) return { settingsPath, removed: 0 };

  settings.hooks.Stop = removeJsonSchemaStopHookGroups(stopGroups);
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  writeSettings(settingsPath, settings);
  return { settingsPath, removed: before };
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as ClaudeSettings;
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const backup = settingsPath + ".claude-bridge-backup";
  if (existsSync(settingsPath) && !existsSync(backup)) copyFileSync(settingsPath, backup);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function removeJsonSchemaStopHookGroups(groups: HookGroup[]): HookGroup[] {
  return removeStaleJsonSchemaStopHookGroups(groups);
}

function removeStaleJsonSchemaStopHookGroups(groups: HookGroup[], keepCommand?: string): HookGroup[] {
  return groups
    .map(group => ({
      ...group,
      hooks: (group.hooks ?? []).filter(
        handler =>
          !handler.command?.includes(JSON_SCHEMA_STOP_HOOK_ARG) ||
          (keepCommand !== undefined && handler.command === keepCommand && group.matcher === "*")
      ),
    }))
    .filter(group => (group.hooks ?? []).length > 0);
}

function countJsonSchemaStopHookHandlers(groups: HookGroup[]): number {
  return groups.reduce(
    (count, group) =>
      count +
      (group.hooks ?? []).filter(handler => handler.command?.includes(JSON_SCHEMA_STOP_HOOK_ARG)).length,
    0
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
