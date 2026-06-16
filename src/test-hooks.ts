#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  JSON_SCHEMA_STOP_HOOK_ARG,
  RUNTIME_HOOK_ARG,
  buildJsonSchemaStopHookCommand,
  buildRuntimeHookCommand,
  installJsonSchemaStopHook,
  installRuntimeHooks,
  uninstallJsonSchemaStopHook,
} from "./hook-install.ts";
import { evaluateJsonSchemaStopHook, recordRuntimeHook } from "./stop-hook.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const workdir = mkdtempSync(join(tmpdir(), "bridge-hooks-"));
const settingsPath = join(workdir, "settings.json");
const command = buildJsonSchemaStopHookCommand(["bun", "src/cli.ts"]);
const runtimeCommand = buildRuntimeHookCommand(["bun", "src/cli.ts"]);

ok("hook command uses bun for source entry", command.startsWith("'bun' "));
ok("hook command includes full cli path", command.includes(resolve(process.cwd(), "src/cli.ts")));
ok("hook command includes internal marker", command.includes(JSON_SCHEMA_STOP_HOOK_ARG));
ok("runtime hook command includes internal marker", runtimeCommand.includes(RUNTIME_HOOK_ARG));

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

const runtimeInstalled = installRuntimeHooks({ settingsPath, command: runtimeCommand });
ok("runtime install reports changed first time", runtimeInstalled.changed);
settings = JSON.parse(readFileSync(settingsPath, "utf8")) as any;
ok("runtime install adds Stop hook", countHooks(settings, "Stop", RUNTIME_HOOK_ARG) === 1);
ok("runtime install adds MessageDisplay hook", countHooks(settings, "MessageDisplay", RUNTIME_HOOK_ARG) === 1);
const runtimeInstalledAgain = installRuntimeHooks({ settingsPath, command: runtimeCommand });
ok("runtime install is idempotent", !runtimeInstalledAgain.changed);
settings = JSON.parse(readFileSync(settingsPath, "utf8")) as any;
ok("runtime idempotent install keeps one Stop hook", countHooks(settings, "Stop", RUNTIME_HOOK_ARG) === 1);
ok("runtime idempotent install keeps one MessageDisplay hook", countHooks(settings, "MessageDisplay", RUNTIME_HOOK_ARG) === 1);

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
    ...extra,
  });

const noEnvDecision = evaluateJsonSchemaStopHook(
  JSON.stringify({ hook_event_name: "Stop" }),
  {}
);
ok("stop hook no-ops outside bridge schema sessions", noEnvDecision === null);

const assistantOnlyTranscript = join(workdir, "assistant-only.jsonl");
writeFileSync(
  assistantOnlyTranscript,
  assistantRow('{"resp":"ok"}') + "\n"
);
const assistantOnlyDecision = evaluateJsonSchemaStopHook(stopInput(assistantOnlyTranscript), env);
ok("stop hook allows valid assistant transcript text", assistantOnlyDecision === null);

const activeDecision = evaluateJsonSchemaStopHook(
  stopInput(assistantOnlyTranscript, { stop_hook_active: true, last_assistant_message: "not json" }),
  env
);
ok("stop hook allows valid transcript during active schema continuations", activeDecision === null);

const assistantMessageDecision = evaluateJsonSchemaStopHook(
  stopInput(join(workdir, "missing-transcript.jsonl"), { last_assistant_message: '{"resp":"ok"}' }),
  env
);
ok("stop hook allows valid last assistant message", assistantMessageDecision === null);

const validTranscript = join(workdir, "valid.jsonl");
writeFileSync(validTranscript, assistantRow('{"resp":"ok"}') + "\n");
const validDecision = evaluateJsonSchemaStopHook(stopInput(validTranscript), env);
ok("stop hook allows valid final assistant text", validDecision === null);

const invalidTranscript = join(workdir, "invalid.jsonl");
writeFileSync(invalidTranscript, assistantRow("not json") + "\n");
const invalidDecision = evaluateJsonSchemaStopHook(stopInput(invalidTranscript), env);
ok("stop hook blocks invalid final assistant text", invalidDecision?.decision === "block");
ok("stop hook reason asks for valid JSON", invalidDecision?.reason.includes("valid JSON") === true);

const latestWinsTranscript = join(workdir, "latest-wins.jsonl");
writeFileSync(
  latestWinsTranscript,
  assistantRow('{"resp":"ok"}') + "\n" + assistantRow('{"resp":123}') + "\n"
);
const latestWinsDecision = evaluateJsonSchemaStopHook(stopInput(latestWinsTranscript), env);
ok("stop hook validates latest assistant text", latestWinsDecision?.decision === "block");

const maxedTranscript = join(workdir, "maxed.jsonl");
writeFileSync(
  maxedTranscript,
  [
    stopFeedbackRow(),
    stopFeedbackRow(),
    stopFeedbackRow(),
    assistantRow("not json"),
  ].join("\n") + "\n"
);
const maxedDecision = evaluateJsonSchemaStopHook(stopInput(maxedTranscript), env);
ok("stop hook stops blocking after bounded retries", maxedDecision === null);

const runtimeDir = join(workdir, "runtime");
const runtimeEnv = {
  CLAUDE_BRIDGE_RUNTIME_HOOK: "1",
  CLAUDE_BRIDGE_RUN_DIR: runtimeDir,
};
recordRuntimeHook(
  JSON.stringify({ hook_event_name: "MessageDisplay", delta: "hello" }),
  runtimeEnv
);
recordRuntimeHook(
  JSON.stringify({
    hook_event_name: "Stop",
    transcript_path: "/tmp/session.jsonl",
    last_assistant_message: "hello",
  }),
  runtimeEnv
);
ok("runtime hook records message display jsonl", readFileSync(join(runtimeDir, "message-display.jsonl"), "utf8").includes("hello"));
ok("runtime hook records stop event", JSON.parse(readFileSync(join(runtimeDir, "stop-event.json"), "utf8")).last_assistant_message === "hello");

try { rmSync(workdir, { recursive: true, force: true }); } catch {}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);

function assistantRow(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  });
}

function countBridgeHooks(settings: any): number {
  return countHooks(settings, "Stop", JSON_SCHEMA_STOP_HOOK_ARG);
}

function countHooks(settings: any, event: string, marker: string): number {
  return (settings.hooks?.[event] ?? []).reduce(
    (count: number, group: any) =>
      count +
      (group.hooks ?? []).filter((hook: any) =>
        String(hook.command ?? "").includes(marker)
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
        "Stop hook feedback:\nclaude-bridge schema output required: reply again with valid JSON.",
    },
  });
}
