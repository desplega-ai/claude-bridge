#!/usr/bin/env bun
import { claudeAuthEnvArgs, claudeUnsetEnvArgs } from "./auth-env.ts";

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

const env = {
  HOME: "/home/taras",
  CLAUDE_CONFIG_DIR: "/home/taras/.claude",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token",
  ANTHROPIC_API_KEY: "sk-ant-api",
  ANTHROPIC_AUTH_TOKEN: "auth-token",
  ANTHROPIC_BASE_URL: "https://example.test",
  ANTHROPIC_CUSTOM_HEADERS: "x-test: yes",
  ANTHROPIC_MODEL: "claude-sonnet",
  OTHER_AUTHISH_ENV: "ignored",
};

const defaultArgs = claudeAuthEnvArgs(env, { localAuth: false });
ok("default forwards HOME", defaultArgs.includes("HOME=/home/taras"));
ok("default forwards CLAUDE_CONFIG_DIR", defaultArgs.includes("CLAUDE_CONFIG_DIR=/home/taras/.claude"));
ok("default forwards CLAUDE_CODE_OAUTH_TOKEN", defaultArgs.includes("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-token"));
ok("default does not forward ANTHROPIC_API_KEY", !defaultArgs.some(arg => arg.startsWith("ANTHROPIC_API_KEY=")));
ok("default unsets local Anthropic env", claudeUnsetEnvArgs().includes("ANTHROPIC_API_KEY"));

const localArgs = claudeAuthEnvArgs(env, { localAuth: true });
ok("local auth forwards ANTHROPIC_API_KEY", localArgs.includes("ANTHROPIC_API_KEY=sk-ant-api"));
ok("local auth forwards ANTHROPIC_AUTH_TOKEN", localArgs.includes("ANTHROPIC_AUTH_TOKEN=auth-token"));
ok("local auth forwards ANTHROPIC_BASE_URL", localArgs.includes("ANTHROPIC_BASE_URL=https://example.test"));
ok("local auth forwards ANTHROPIC_CUSTOM_HEADERS", localArgs.includes("ANTHROPIC_CUSTOM_HEADERS=x-test: yes"));
ok("local auth forwards ANTHROPIC_MODEL", localArgs.includes("ANTHROPIC_MODEL=claude-sonnet"));
ok("local auth still clears stale tmux Anthropic env first", claudeUnsetEnvArgs().includes("ANTHROPIC_API_KEY"));
ok("local auth does not forward unrelated env", !localArgs.some(arg => arg.startsWith("OTHER_AUTHISH_ENV=")));

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
