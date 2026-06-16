export type ClaudeLaunchCommandOptions = {
  claudePath: string;
  claudeArgs: string[];
  unsetEnvArgs: string[];
  envArgs: string[];
  exitStatusPath: string;
  holdMs: number;
};

export type ClaudePrintLaunchCommandOptions = ClaudeLaunchCommandOptions & {
  promptFile: string;
  stdoutFile: string;
};

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeLaunchCommand(opts: ClaudeLaunchCommandOptions): string {
  const envCommand = [
    "env",
    ...opts.unsetEnvArgs,
    ...opts.envArgs,
    opts.claudePath,
    ...opts.claudeArgs,
  ]
    .map(shellQuote)
    .join(" ");
  const holdSeconds = Math.max(1, Math.ceil(opts.holdMs / 1000));
  const script = [
    envCommand,
    "status=$?",
    `printf '%s\\n' "$status" > ${shellQuote(opts.exitStatusPath)}`,
    `printf '\\n[claude-bridge] claude exited with status %s\\n' "$status" >&2`,
    `sleep ${holdSeconds}`,
    `exit "$status"`,
  ].join("\n");

  return `/bin/sh -lc ${shellQuote(script)}`;
}

/**
 * Build a launch command for print mode that runs Claude with `-p` and
 * redirects stdout to a file. This bypasses the JSONL transcript dependency
 * that broke with Claude Code v2.1.x (transcripts are no longer written).
 *
 * The prompt is read from `opts.promptFile` via stdin pipe. Claude's
 * stream-json stdout is written to `opts.stdoutFile` for the bridge to tail.
 *
 * INVARIANT VIOLATION — SLATED FOR REMOVAL. See startTmuxPrintMode in cli.ts.
 */
export function buildClaudePrintLaunchCommand(opts: ClaudePrintLaunchCommandOptions): string {
  const envCommand = [
    "env",
    ...opts.unsetEnvArgs,
    ...opts.envArgs,
    opts.claudePath,
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    ...opts.claudeArgs,
  ]
    .map(shellQuote)
    .join(" ");
  const holdSeconds = Math.max(1, Math.ceil(opts.holdMs / 1000));
  const stderrFile = opts.stdoutFile.replace(/\.jsonl$/, ".stderr.log");
  const script = [
    `cat ${shellQuote(opts.promptFile)} | ${envCommand} > ${shellQuote(opts.stdoutFile)} 2>${shellQuote(stderrFile)}`,
    "status=$?",
    `printf '%s\\n' "$status" > ${shellQuote(opts.exitStatusPath)}`,
    `printf '\\n[claude-bridge] claude exited with status %s\\n' "$status" >&2`,
    `sleep ${holdSeconds}`,
    `exit "$status"`,
  ].join("\n");

  return `/bin/sh -lc ${shellQuote(script)}`;
}
