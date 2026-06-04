# Agent Instructions

This repo is `claude-bridge`, a wrapper around Claude Code that keeps the bridge as the integration boundary.

<important if="you are changing `-p`, `--print`, `--output-format`, `--json-schema`, structured output, non-interactive mode, or drop-in `claude -p` compatibility">

NEVER bypass the bridge.

`claude-bridge -p` is intended to replace `claude -p`; raw `claude -p` passthrough/delegation is not acceptable. If exact `claude -p` compatibility is needed, implement that behavior through bridge-owned prompt dispatch, reply capture, output formatting, and turn-end exit handling.
</important>

<important if="you are preparing, debugging, or documenting an npm release">

Use `docs/releasing.md` as the source of truth. Releases are automated from `master` when `package.json`'s `version` changes; do not run `npm publish` manually unless the release workflow is broken and Taras explicitly approves manual recovery.
</important>
