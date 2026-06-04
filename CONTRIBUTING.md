# Contributing to Claude Bridge

Thanks for your interest in contributing to Claude Bridge.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) 1.1 or newer
- `tmux`
- Claude Code on `PATH`

### Install Dependencies

```sh
git clone https://github.com/desplega-ai/claude-bridge.git
cd claude-bridge
bun install
```

## Running Locally

```sh
# Interactive bridge
bun run start

# Print-mode bridge
bun ./src/cli.ts -p "say hi"
bun ./src/cli.ts -p "say hi" --output-format json
bun ./src/cli.ts -p "say hi" --output-format stream-json
```

## Checks

Run these before opening a PR:

```sh
bun run test
bun run typecheck
npm pack --dry-run
```

The live smoke script can be run when a Claude OAuth token is available:

```sh
CLAUDE_BRIDGE_SMOKE_OUTPUT_FORMAT=json \
CLAUDE_BRIDGE_SMOKE_SCHEMA=true \
bun run ci:live-smoke
```

## Release Process

Releases are automated from `master`. To prepare a release, bump only the
package version on a branch and open a PR:

```sh
npm version --no-git-tag-version patch
```

When that PR is merged, `.github/workflows/release.yml` detects the version
change, validates the package, publishes `@desplega.ai/claude-bridge` to npm,
creates the `vX.Y.Z` git tag, and creates a GitHub Release.

Do not run `npm publish` by hand unless the release workflow is broken and the
manual publish is explicitly coordinated.

## Package Boundary

This repository may be private while the npm package is public. Keep the
published package boundary tight:

- Runtime source belongs in the `files` allowlist in `package.json`.
- Tests, CI scripts, `.github`, `AGENTS.md`, and `CLAUDE.md` should not be
  published.
- Always inspect `npm pack --dry-run --json` before changing package metadata.

## Bridge Boundary

`claude-bridge -p` is intended to replace `claude -p`. Do not bypass the bridge
by delegating to raw `claude -p`; implement compatibility through bridge-owned
prompt dispatch, transcript capture, output formatting, and turn-end exit
handling.
