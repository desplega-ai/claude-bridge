export type DesplegaArgValue = boolean | string;

export type DesplegaArg = {
  raw: string;
  name: string;
  value: DesplegaArgValue;
};

export type OutputFormat = "text" | "json" | "stream-json";

export type ParsedCliArgs = {
  help: boolean;
  claudeHelp: boolean;
  version: boolean;
  print: boolean;
  outputFormat: OutputFormat;
  jsonSchema?: string;
  claudeArgs: string[];
  initialPrompt?: string;
  desplegaArgs: DesplegaArg[];
  desplegaVerbose: boolean;
};

export type CliArgError = {
  arg: string;
  message: string;
  hint: string;
};

export type ParseCliArgsResult =
  | { ok: true; parsed: ParsedCliArgs }
  | { ok: false; error: CliArgError };

type OptionArity = "none" | "required" | "optional" | "variadic";

const BLOCKED_OPTIONS = new Map<string, { label: string; reason: string }>([
  [
    "--init-only",
    {
      label: "--init-only",
      reason: "it sets Claude Code isInteractive=false and violates the bridge billing invariant.",
    },
  ],
  [
    "--sdk-url",
    {
      label: "--sdk-url",
      reason: "Agent SDK mode sets Claude Code isInteractive=false and violates the bridge billing invariant.",
    },
  ],
  [
    "--tmux",
    {
      label: "--tmux",
      reason: "the wrapper owns tmux session creation.",
    },
  ],
  [
    "-w",
    {
      label: "-w, --worktree",
      reason: "the wrapper owns the per-run workdir.",
    },
  ],
  [
    "--worktree",
    {
      label: "-w, --worktree",
      reason: "the wrapper owns the per-run workdir.",
    },
  ],
  [
    "--replay-user-messages",
    {
      label: "--replay-user-messages",
      reason: "replay mode is not supported through this wrapper.",
    },
  ],
]);

const CLAUDE_COMMANDS = new Map<string, string>([
  ["agents", "agents"],
  ["auth", "auth"],
  ["auto-mode", "auto-mode"],
  ["doctor", "doctor"],
  ["install", "install"],
  ["mcp", "mcp"],
  ["plugin", "plugin"],
  ["plugins", "plugin"],
  ["project", "project"],
  ["setup-token", "setup-token"],
  ["ultrareview", "ultrareview"],
  ["update", "update"],
  ["upgrade", "update"],
]);

const OPTION_ARITY = new Map<string, OptionArity>([
  ["--add-dir", "variadic"],
  ["--agent", "required"],
  ["--agents", "required"],
  ["--allow-dangerously-skip-permissions", "none"],
  ["--allowedTools", "variadic"],
  ["--allowed-tools", "variadic"],
  ["--append-system-prompt", "required"],
  ["--append-system-prompt-file", "required"],
  ["--bare", "none"],
  ["--betas", "variadic"],
  ["--brief", "none"],
  ["--chrome", "none"],
  ["-c", "none"],
  ["--continue", "none"],
  ["--dangerously-skip-permissions", "none"],
  ["-d", "optional"],
  ["--debug", "optional"],
  ["--debug-file", "required"],
  ["--disable-slash-commands", "none"],
  ["--disallowedTools", "variadic"],
  ["--disallowed-tools", "variadic"],
  ["--effort", "required"],
  ["--exclude-dynamic-system-prompt-sections", "none"],
  ["--fallback-model", "required"],
  ["--file", "variadic"],
  ["--fork-session", "none"],
  ["--from-pr", "required"],
  ["-h", "none"],
  ["--help", "none"],
  ["--ide", "none"],
  ["--include-hook-events", "none"],
  ["--include-partial-messages", "none"],
  ["--input-format", "required"],
  ["--json-schema", "required"],
  ["--max-budget-usd", "required"],
  ["--mcp-config", "variadic"],
  ["--mcp-debug", "none"],
  ["--model", "required"],
  ["-n", "required"],
  ["--name", "required"],
  ["--no-chrome", "none"],
  ["--no-session-persistence", "none"],
  ["--output-format", "required"],
  ["--permission-mode", "required"],
  ["--plugin-dir", "variadic"],
  ["--plugin-url", "required"],
  ["-p", "none"],
  ["--print", "none"],
  ["--prompt-suggestions", "none"],
  ["--remote-control", "none"],
  ["--remote-control-session-name-prefix", "required"],
  ["--replay-user-messages", "variadic"],
  ["-r", "optional"],
  ["--resume", "optional"],
  ["--session-id", "required"],
  ["--setting-sources", "variadic"],
  ["--settings", "required"],
  ["--strict-mcp-config", "none"],
  ["--system-prompt", "required"],
  ["--tmux", "optional"],
  ["--tools", "variadic"],
  ["--verbose", "none"],
  ["-w", "optional"],
  ["--worktree", "optional"],
]);

export function parseCliArgs(argv: string[]): ParseCliArgsResult {
  const rawClaudeArgs: string[] = [];
  const desplegaArgs: DesplegaArg[] = [];
  let claudeHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--claude-help") {
      claudeHelp = true;
      continue;
    }
    if (arg === "--desplega") {
      return {
        ok: false,
        error: {
          arg,
          message: "`--desplega` is not a valid wrapper option.",
          hint: "Use `--desplega-<name>` or `--desplega-<name>=<value>`.",
        },
      };
    }
    if (arg.startsWith("--desplega-")) {
      const parsed = parseDesplegaArg(arg);
      if (!parsed) {
        return {
          ok: false,
          error: {
            arg,
            message: "`--desplega-` requires an option name.",
            hint: "Use `--desplega-verbose` or another `--desplega-<name>` option.",
          },
        };
      }
      if (
        parsed.value === true &&
        ["cwd", "json-schema-max-tokens", "schema-max-tokens"].includes(parsed.name) &&
        i + 1 < argv.length &&
        !looksLikeOption(argv[i + 1]!)
      ) {
        parsed.value = argv[++i]!;
      }
      desplegaArgs.push(parsed);
      continue;
    }
    rawClaudeArgs.push(arg);
  }

  if (containsHelp(rawClaudeArgs)) {
    return {
      ok: true,
      parsed: {
        help: true,
        claudeHelp,
        version: false,
        print: false,
        outputFormat: "text",
        jsonSchema: undefined,
        claudeArgs: [],
        desplegaArgs,
        desplegaVerbose: hasDesplegaVerbose(desplegaArgs),
      },
    };
  }

  const extracted = extractClaudeArgs(rawClaudeArgs);
  if (!extracted.ok) return extracted;

  return {
    ok: true,
    parsed: {
      help: false,
      claudeHelp,
      version: extracted.parsed.version,
      print: extracted.parsed.print,
      outputFormat: extracted.parsed.outputFormat,
      jsonSchema: extracted.parsed.jsonSchema,
      claudeArgs: extracted.parsed.claudeArgs,
      initialPrompt: extracted.parsed.initialPrompt,
      desplegaArgs,
      desplegaVerbose: hasDesplegaVerbose(desplegaArgs),
    },
  };
}

export function formatWrapperHelp(): string {
  const lines = [
    "Usage: claude-bridge [wrapper options] [claude options] [prompt]",
    "",
    "Starts Claude Code inside the tmux/transcript orchestrator. Normal Claude",
    "interactive options are forwarded as-is.",
    "",
    "Wrapper options:",
    "  -p, --print                     Non-interactive mode; exit after the reply",
    "  --output-format <format>        Output: text, json, or stream-json",
    "  --json-schema <schema|file>     Extract and validate final JSON in print mode",
    "  --desplega-format               Use bridge JSON envelopes in json modes",
    "  --desplega-verbose              Emit extra wrapper debug output",
    "  --desplega-cwd <path>           Run Claude in this cwd (default: current cwd)",
    "  --desplega-local-auth           Forward local Anthropic auth env vars",
    "  --desplega-install              Install the global schema Stop hook",
    "  --desplega-uninstall            Remove the global schema Stop hook",
    "  --desplega-<name>[=<value>]     Reserve a desplega wrapper option",
    "  --claude-help                   Show raw `claude -h` output",
    "  -v, --version                   Show claude-bridge and Claude CLI versions",
    "  -h, --help                      Show this help",
    "",
    "Blocked Claude options:",
    "  --tmux                          The wrapper owns tmux session creation",
    "  -w, --worktree                  The wrapper owns the per-run workdir",
    "  --replay-user-messages          Replay is not supported through this wrapper",
    "",
    "Claude subcommands are blocked. Use `claude <cmd>` directly for commands",
    "such as `doctor`, `mcp`, `plugin`, `update`, or `agents`.",
    "",
    "Most Claude interactive options are forwarded. Use `--claude-help` when",
    "you need the raw Claude help, but remember this wrapper owns print/output",
    "mode, schema extraction, tmux, workdir, and prompt delivery.",
  ];

  return lines.join("\n") + "\n";
}

export function formatClaudeHelp(claudeHelp: string): string {
  return [
    "Raw Claude help follows. Note: claude-bridge owns -p/--print, --output-format,",
    "--json-schema, --tmux, --worktree, and prompt delivery; use `claude <cmd>`",
    "directly for Claude subcommands.",
    "",
    claudeHelp.trimEnd(),
    "",
  ].join("\n");
}

type ExtractedClaudeArgs = {
  version: boolean;
  print: boolean;
  outputFormat: OutputFormat;
  jsonSchema?: string;
  claudeArgs: string[];
  initialPrompt?: string;
};

type ExtractClaudeArgsResult =
  | { ok: true; parsed: ExtractedClaudeArgs }
  | { ok: false; error: CliArgError };

function extractClaudeArgs(args: string[]): ExtractClaudeArgsResult {
  const claudeArgs: string[] = [];
  const promptParts: string[] = [];
  let version = false;
  let print = false;
  let outputFormat: OutputFormat = "text";
  let outputFormatSpecified = false;
  let jsonSchema: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "--") {
      promptParts.push(...args.slice(i + 1));
      break;
    }

    const blocked = blockedOption(arg);
    if (blocked) {
      return {
        ok: false,
        error: {
          arg,
          message: `Unsupported Claude option ${blocked.label}: ${blocked.reason}`,
          hint: `Run \`claude ${argName(arg)}\` directly if you need that mode.`,
        },
      };
    }

    if (arg === "-p" || arg === "--print") {
      print = true;
      continue;
    }

    if (arg === "-v" || arg === "--version") {
      version = true;
      continue;
    }

    if (!arg.startsWith("--") && arg.startsWith("-p")) {
      return {
        ok: false,
        error: {
          arg,
          message: "`-p` does not accept an attached value.",
          hint: "Use `-p \"your prompt\"` or `--print \"your prompt\"`.",
        },
      };
    }

    if (arg.startsWith("--print=")) {
      return {
        ok: false,
        error: {
          arg,
          message: "`--print` does not accept a value.",
          hint: "Use `-p` or `--print`, then provide the prompt as a separate argument.",
        },
      };
    }

    if (arg === "--output-format" || arg.startsWith("--output-format=")) {
      const parsed = parseOutputFormat(args, i);
      if (!parsed.ok) return parsed;
      outputFormat = parsed.value;
      outputFormatSpecified = true;
      i = parsed.nextIndex;
      continue;
    }

    if (arg === "--json-schema" || arg.startsWith("--json-schema=")) {
      const parsed = parseRequiredValue(args, i, "--json-schema");
      if (!parsed.ok) return parsed;
      if (jsonSchema !== undefined) {
        return {
          ok: false,
          error: {
            arg,
            message: "`--json-schema` can only be provided once.",
            hint: "Pass one JSON Schema object or one schema file path.",
          },
        };
      }
      jsonSchema = parsed.value;
      i = parsed.nextIndex;
      continue;
    }

    if (looksLikeOption(arg)) {
      claudeArgs.push(arg);
      const name = argName(arg);
      if (arg.includes("=")) continue;

      const arity = OPTION_ARITY.get(name);
      if (arity === "required") {
        if (i + 1 < args.length) claudeArgs.push(args[++i]!);
      } else if (arity === "optional") {
        if (i + 1 < args.length && !looksLikeOption(args[i + 1]!)) {
          claudeArgs.push(args[++i]!);
        }
      } else if (arity === "variadic") {
        while (i + 1 < args.length && !looksLikeOption(args[i + 1]!)) {
          claudeArgs.push(args[++i]!);
        }
      }
      continue;
    }

    if (promptParts.length === 0) {
      const command = CLAUDE_COMMANDS.get(arg);
      if (command) {
        return {
          ok: false,
          error: {
            arg,
            message: `Claude command \`${arg}\` is not supported by this wrapper.`,
            hint: `Use \`claude ${arg}\` directly.`,
          },
        };
      }
    }

    promptParts.push(arg);
  }

  if (outputFormatSpecified && !print) {
    return {
      ok: false,
      error: {
        arg: "--output-format",
        message: "`--output-format` requires `-p`/`--print`.",
        hint: "Use `-p \"your prompt\" --output-format stream-json`.",
      },
    };
  }

  if (jsonSchema !== undefined && !print) {
    return {
      ok: false,
      error: {
        arg: "--json-schema",
        message: "`--json-schema` requires `-p`/`--print`.",
        hint: "Use `-p \"your prompt\" --json-schema schema.json --output-format json`.",
      },
    };
  }

  return {
    ok: true,
    parsed: {
      print,
      version,
      outputFormat,
      jsonSchema,
      claudeArgs,
      initialPrompt: promptParts.length ? promptParts.join(" ") : undefined,
    },
  };
}

function parseRequiredValue(
  args: string[],
  index: number,
  name: string
): { ok: true; value: string; nextIndex: number } | { ok: false; error: CliArgError } {
  const arg = args[index]!;
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
  if (!value) {
    return {
      ok: false,
      error: {
        arg,
        message: `\`${name}\` requires a value.`,
        hint: `Use \`${name} schema.json\` or \`${name} '{"type":"object"}'\`.`,
      },
    };
  }

  return {
    ok: true,
    value,
    nextIndex: arg.includes("=") ? index : index + 1,
  };
}

function parseOutputFormat(
  args: string[],
  index: number
): { ok: true; value: OutputFormat; nextIndex: number } | { ok: false; error: CliArgError } {
  const parsed = parseRequiredValue(args, index, "--output-format");
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        ...parsed.error,
        hint: "Use `--output-format text`, `--output-format json`, or `--output-format stream-json`.",
      },
    };
  }
  const arg = args[index]!;
  const value = parsed.value;

  if (!isOutputFormat(value)) {
    return {
      ok: false,
      error: {
        arg,
        message: `Unsupported output format \`${value}\`.`,
        hint: "Use `text`, `json`, or `stream-json`.",
      },
    };
  }

  return {
    ok: true,
    value,
    nextIndex: parsed.nextIndex,
  };
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json" || value === "stream-json";
}

function parseDesplegaArg(arg: string): DesplegaArg | null {
  const body = arg.slice("--desplega-".length);
  if (!body) return null;
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return null;
  return {
    raw: arg,
    name,
    value: eq === -1 ? true : parseDesplegaValue(body.slice(eq + 1)),
  };
}

function parseDesplegaValue(value: string): DesplegaArgValue {
  const normalized = value.trim().toLowerCase();
  if (["", "1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}

function hasDesplegaVerbose(args: DesplegaArg[]): boolean {
  const flag = args.find(arg => arg.name === "verbose");
  return flag ? flag.value !== false : false;
}

function containsHelp(args: string[]): boolean {
  for (const arg of claudeArgsBeforeDashDash(args)) {
    if (arg === "-h" || arg === "--help") return true;
  }
  return false;
}

function* claudeArgsBeforeDashDash(args: string[]): Generator<string> {
  for (const arg of args) {
    if (arg === "--") return;
    yield arg;
  }
}

function blockedOption(arg: string): { label: string; reason: string } | undefined {
  const name = argName(arg);
  if (name.startsWith("--replay")) {
    return BLOCKED_OPTIONS.get("--replay-user-messages");
  }
  if (!arg.startsWith("--") && arg.startsWith("-w")) return BLOCKED_OPTIONS.get("-w");
  return BLOCKED_OPTIONS.get(name);
}

function looksLikeOption(arg: string): boolean {
  return arg !== "-" && arg.startsWith("-");
}

function argName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}
