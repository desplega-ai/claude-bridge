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
  return LOCAL_AUTH_ENV_NAMES.flatMap(name => ["-u", name]);
}
