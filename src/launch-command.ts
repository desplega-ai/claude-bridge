export type ClaudeLaunchCommandOptions = {
  claudePath: string;
  claudeArgs: string[];
  unsetEnvArgs: string[];
  envArgs: string[];
  exitStatusPath: string;
  holdMs: number;
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
