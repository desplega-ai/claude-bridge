#!/usr/bin/env bun
import { formatClaudeHelp, formatWrapperHelp, parseCliArgs } from "./args.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const expectOk = (argv: string[]) => {
  const parsed = parseCliArgs(argv);
  ok(`${argv.join(" ") || "(empty)"} parses`, parsed.ok);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.parsed;
};

const expectBlocked = (argv: string[], expected: string) => {
  const parsed = parseCliArgs(argv);
  ok(`${argv.join(" ")} blocks`, !parsed.ok);
  if (parsed.ok) return;
  ok(`${argv.join(" ")} mentions ${expected}`, parsed.error.message.includes(expected));
};

const forwarded = expectOk(["--model", "sonnet", "--permission-mode", "acceptEdits", "hello"]);
ok("forwards normal Claude args", forwarded.claudeArgs.join(" ") === "--model sonnet --permission-mode acceptEdits");
ok("extracts positional prompt", forwarded.initialPrompt === "hello");

const afterPromptOption = expectOk(["say hi", "--verbose"]);
ok("allows options after positional prompt", afterPromptOption.initialPrompt === "say hi" && afterPromptOption.claudeArgs.join(" ") === "--verbose");

const printJson = expectOk(["-p", "say hi", "--output-format", "stream-json", "--verbose"]);
ok("print mode parses", printJson.print);
ok("output format parses", printJson.outputFormat === "stream-json");
ok("print prompt extracted", printJson.initialPrompt === "say hi");
ok("print/output args are not forwarded to Claude", printJson.claudeArgs.join(" ") === "--verbose");

const printJsonEquals = expectOk(["--print", "--output-format=json", "say hi"]);
ok("output format equals parses", printJsonEquals.print && printJsonEquals.outputFormat === "json");

const schema = expectOk(["-p", "--json-schema", '{"type":"object"}', "say hi"]);
ok("json schema requires wrapper ownership", schema.print && schema.jsonSchema === '{"type":"object"}');
ok("json schema is not forwarded to Claude", schema.claudeArgs.length === 0);

const schemaEquals = expectOk(["-p", "--json-schema={\"type\":\"array\"}", "say hi"]);
ok("json schema equals parses", schemaEquals.jsonSchema === '{"type":"array"}');

const desplega = expectOk(["--desplega-verbose", "--desplega-mode=debug", "--model", "opus"]);
ok("strips desplega args from Claude args", desplega.claudeArgs.join(" ") === "--model opus");
ok("sets desplega verbose", desplega.desplegaVerbose);
ok("keeps reserved desplega args typed", desplega.desplegaArgs.length === 2 && desplega.desplegaArgs[1]?.value === "debug");

const cwdSpace = expectOk(["--desplega-cwd", "/tmp", "--model", "sonnet"]);
ok("desplega cwd accepts separate value", cwdSpace.desplegaArgs.find(arg => arg.name === "cwd")?.value === "/tmp");
ok("desplega cwd is not forwarded", cwdSpace.claudeArgs.join(" ") === "--model sonnet");

const cwdEquals = expectOk(["--desplega-cwd=/tmp"]);
ok("desplega cwd accepts equals value", cwdEquals.desplegaArgs.find(arg => arg.name === "cwd")?.value === "/tmp");

const install = expectOk(["--desplega-install"]);
ok("desplega install flag parses", install.desplegaArgs.find(arg => arg.name === "install")?.value === true);

const uninstall = expectOk(["--desplega-uninstall"]);
ok("desplega uninstall flag parses", uninstall.desplegaArgs.find(arg => arg.name === "uninstall")?.value === true);

const quiet = expectOk(["--desplega-verbose=false"]);
ok("desplega verbose can be disabled explicitly", !quiet.desplegaVerbose);

const version = expectOk(["-v"]);
ok("-v is handled by wrapper", version.version && version.claudeArgs.length === 0);

const longVersion = expectOk(["--version"]);
ok("--version is handled by wrapper", longVersion.version && longVersion.claudeArgs.length === 0);

expectBlocked(["-phello"], "`-p` does not accept");
expectBlocked(["--print=true"], "`--print` does not accept");
expectBlocked(["--output-format"], "`--output-format` requires");
expectBlocked(["--output-format=xml"], "Unsupported output format");
expectBlocked(["say hi", "--output-format", "json"], "`--output-format` requires `-p`");
expectBlocked(["--json-schema"], "`--json-schema` requires a value");
expectBlocked(["say hi", "--json-schema", '{"type":"object"}'], "`--json-schema` requires `-p`");
expectBlocked(["-p", "--json-schema", '{"type":"object"}', "--json-schema", '{"type":"array"}', "hi"], "`--json-schema` can only");
expectBlocked(["--tmux"], "--tmux");
expectBlocked(["--replay-user-messages"], "--replay-user-messages");
expectBlocked(["-w"], "-w, --worktree");
expectBlocked(["-wexample"], "-w, --worktree");
expectBlocked(["--worktree"], "-w, --worktree");

expectBlocked(["doctor"], "Claude command");
expectBlocked(["--model", "sonnet", "plugins"], "Claude command");

const commandAsValue = expectOk(["--model", "doctor"]);
ok("does not treat option values as commands", commandAsValue.claudeArgs.join(" ") === "--model doctor");

const afterDashDash = expectOk(["--", "--print", "doctor"]);
ok("allows blocked-looking prompt text after --", afterDashDash.initialPrompt === "--print doctor");

const help = expectOk(["--help"]);
ok("--help is handled by wrapper", help.help);
ok("help text includes print mode", formatWrapperHelp().includes("-p, --print"));
ok("help text includes json schema", formatWrapperHelp().includes("--json-schema"));
ok("help text includes desplega cwd", formatWrapperHelp().includes("--desplega-cwd"));
ok("help text includes hook install", formatWrapperHelp().includes("--desplega-install"));
ok("help text includes version mode", formatWrapperHelp().includes("-v, --version"));
ok("help text does not dump Claude help", !formatWrapperHelp().includes("Forwarded Claude help"));

const claudeHelp = expectOk(["--claude-help"]);
ok("--claude-help is handled by wrapper", claudeHelp.claudeHelp);
ok("claude help formatter nudges wrapper ownership", formatClaudeHelp("Usage: claude").includes("claude-bridge owns"));

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
