const DEFAULT_AUTH_ENV_NAMES = [
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

const LOCAL_AUTH_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
] as const;

// Env vars that disable Claude Code's on-disk session transcript
// (`~/.claude/projects/<slug>/<sessionId>.jsonl`). The bridge reconstructs ALL
// of its output — cost/token/duration metrics AND the streamed
// assistant/tool-use events — by reshaping that transcript, so it MUST run with
// transcript persistence enabled. We always strip these from the launched
// `claude` regardless of what the caller set; otherwise the bridge sees no
// transcript and emits only `init` + a null-metrics `result` ($0 / 0 tokens).
//
// `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` is set by agent-swarm's Claude runner
// "memory guardrails" (desplega-ai/agent-swarm#644); in Claude Code it
// suppresses the transcript the bridge depends on.
const TRANSCRIPT_BREAKING_ENV_NAMES = ["CLAUDE_CODE_SKIP_PROMPT_HISTORY"] as const;

type AuthEnvOptions = {
  localAuth: boolean;
};

export function claudeAuthEnvArgs(
  env: NodeJS.ProcessEnv,
  options: AuthEnvOptions
): string[] {
  const names = options.localAuth
    ? [...DEFAULT_AUTH_ENV_NAMES, ...LOCAL_AUTH_ENV_NAMES]
    : DEFAULT_AUTH_ENV_NAMES;

  const args: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value) args.push(`${name}=${value}`);
  }
  return args;
}

export function claudeUnsetEnvArgs(): string[] {
  return [...LOCAL_AUTH_ENV_NAMES, ...TRANSCRIPT_BREAKING_ENV_NAMES].flatMap(name => [
    "-u",
    name,
  ]);
}
