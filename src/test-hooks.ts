#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  JSON_SCHEMA_STOP_HOOK_ARG,
  buildJsonSchemaStopHookCommand,
  installJsonSchemaStopHook,
  uninstallJsonSchemaStopHook,
} from "./hook-install.ts";
import { evaluateJsonSchemaStopHook } from "./stop-hook.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const workdir = mkdtempSync(join(tmpdir(), "bridge-hooks-"));
const settingsPath = join(workdir, "settings.json");
const command = buildJsonSchemaStopHookCommand(["bun", "src/cli.ts"]);

ok("hook command uses bun for source entry", command.startsWith("'bun' "));
ok("hook command includes full cli path", command.includes(resolve(process.cwd(), "src/cli.ts")));
ok("hook command includes internal marker", command.includes(JSON_SCHEMA_STOP_HOOK_ARG));

writeFileSync(
  settingsPath,
  JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            matcher: "existing",
            hooks: [{ type: "command", command: "echo keep" }],
          },
        ],
        PreToolUse: [{ hooks: [{ type: "command", command: "echo other" }] }],
      },
    },
    null,
    2
  )
);

const installed = installJsonSchemaStopHook({ settingsPath, command });
ok("install reports changed first time", installed.changed);
let settings = JSON.parse(readFileSync(settingsPath, "utf8")) as any;
ok("install preserves existing stop hook", JSON.stringify(settings.hooks.Stop).includes("echo keep"));
ok("install appends one bridge hook", countBridgeHooks(settings) === 1);
ok("install adds wildcard matcher", bridgeHookGroup(settings)?.matcher === "*");
ok("install preserves non-stop hooks", JSON.stringify(settings.hooks.PreToolUse).includes("echo other"));

const installedAgain = installJsonSchemaStopHook({ settingsPath, command });
ok("install is idempotent", !installedAgain.changed);
settings = JSON.parse(readFileSync(settingsPath, "utf8")) as any;
ok("idempotent install keeps one bridge hook", countBridgeHooks(settings) === 1);

const newCommand = buildJsonSchemaStopHookCommand(["bun", "src/cli.ts"]) + " --changed";
const changed = installJsonSchemaStopHook({ settingsPath, command: newCommand });
ok("changed command updates hook", changed.changed);
settings = JSON.parse(readFileSync(settingsPath, "utf8")) as any;
ok("changed command removes stale bridge hook", countBridgeHooks(settings) === 1);
ok("changed command is present", JSON.stringify(settings.hooks.Stop).includes("--changed"));

const uninstalled = uninstallJsonSchemaStopHook(settingsPath);
ok("uninstall removes one bridge hook", uninstalled.removed === 1);
settings = JSON.parse(readFileSync(settingsPath, "utf8")) as any;
ok("uninstall preserves existing stop hook", JSON.stringify(settings.hooks.Stop).includes("echo keep"));
ok("uninstall preserves non-stop hooks", JSON.stringify(settings.hooks.PreToolUse).includes("echo other"));

const staleSettingsPath = join(workdir, "stale-settings.json");
writeFileSync(
  staleSettingsPath,
  JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }, null, 2)
);
const upgraded = installJsonSchemaStopHook({ settingsPath: staleSettingsPath, command });
const upgradedSettings = JSON.parse(readFileSync(staleSettingsPath, "utf8")) as any;
ok("install upgrades stale same-command hook", upgraded.changed);
ok("upgraded hook has wildcard matcher", bridgeHookGroup(upgradedSettings)?.matcher === "*");
ok("upgraded hook keeps one bridge hook", countBridgeHooks(upgradedSettings) === 1);

const schemaPath = join(workdir, "schema.json");
writeFileSync(
  schemaPath,
  JSON.stringify({
    type: "object",
    properties: { resp: { type: "string" } },
    required: ["resp"],
    additionalProperties: false,
  })
);
const env = {
  CLAUDE_BRIDGE_SCHEMA_STOP_HOOK: "1",
  CLAUDE_BRIDGE_JSON_SCHEMA_PATH: schemaPath,
};

const stopInput = (transcriptPath: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: "Stop",
    transcript_path: transcriptPath,
    last_assistant_message: '{"resp":"assistant-only"}',
    ...extra,
  });

const noEnvDecision = evaluateJsonSchemaStopHook(
  JSON.stringify({ hook_event_name: "Stop" }),
  {}
);
ok("stop hook no-ops outside bridge schema sessions", noEnvDecision === null);

const noBridgeTranscript = join(workdir, "no-bridge.jsonl");
writeFileSync(
  noBridgeTranscript,
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: '{"resp":"ok"}' }] } }) + "\n"
);
const noBridgeDecision = evaluateJsonSchemaStopHook(stopInput(noBridgeTranscript), env);
ok("stop hook requires bridge reply instead of assistant fallback", noBridgeDecision?.decision === "block");

const activeDecision = evaluateJsonSchemaStopHook(
  stopInput(noBridgeTranscript, { stop_hook_active: true }),
  env
);
ok("stop hook still blocks active schema continuations", activeDecision?.decision === "block");

const validTranscript = join(workdir, "valid.jsonl");
writeFileSync(validTranscript, bridgeReplyRow('{"resp":"ok"}') + "\n");
const validDecision = evaluateJsonSchemaStopHook(stopInput(validTranscript), env);
ok("stop hook allows valid bridge reply", validDecision === null);

const invalidTranscript = join(workdir, "invalid.jsonl");
writeFileSync(invalidTranscript, bridgeReplyRow("not json") + "\n");
const invalidDecision = evaluateJsonSchemaStopHook(stopInput(invalidTranscript), env);
ok("stop hook blocks invalid bridge reply", invalidDecision?.decision === "block");
ok("stop hook reason asks for bridge reply", invalidDecision?.reason.includes("mcp__bridge__reply") === true);

const latestWinsTranscript = join(workdir, "latest-wins.jsonl");
writeFileSync(
  latestWinsTranscript,
  bridgeReplyRow('{"resp":"ok"}') + "\n" + bridgeReplyRow('{"resp":123}') + "\n"
);
const latestWinsDecision = evaluateJsonSchemaStopHook(stopInput(latestWinsTranscript), env);
ok("stop hook validates latest bridge reply", latestWinsDecision?.decision === "block");

const maxedTranscript = join(workdir, "maxed.jsonl");
writeFileSync(
  maxedTranscript,
  [
    stopFeedbackRow(),
    stopFeedbackRow(),
    stopFeedbackRow(),
    bridgeReplyRow("not json"),
  ].join("\n") + "\n"
);
const maxedDecision = evaluateJsonSchemaStopHook(stopInput(maxedTranscript), env);
ok("stop hook stops blocking after bounded retries", maxedDecision === null);

try { rmSync(workdir, { recursive: true, force: true }); } catch {}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);

function bridgeReplyRow(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "mcp__bridge__reply",
          input: { chat_id: "abc123", text },
        },
      ],
    },
  });
}

function countBridgeHooks(settings: any): number {
  return (settings.hooks?.Stop ?? []).reduce(
    (count: number, group: any) =>
      count +
      (group.hooks ?? []).filter((hook: any) =>
        String(hook.command ?? "").includes(JSON_SCHEMA_STOP_HOOK_ARG)
      ).length,
    0
  );
}

function bridgeHookGroup(settings: any): any {
  return (settings.hooks?.Stop ?? []).find((group: any) =>
    (group.hooks ?? []).some((hook: any) =>
      String(hook.command ?? "").includes(JSON_SCHEMA_STOP_HOOK_ARG)
    )
  );
}

function stopFeedbackRow(): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        "Stop hook feedback:\nclaude-bridge schema output required: call mcp__bridge__reply now.",
    },
  });
}
