# Releasing

This repo publishes the public npm package `@desplega.ai/claude-bridge`.

Releases are automated by `.github/workflows/release.yml`. Do not create the
git tag locally and do not run `npm publish` manually unless the workflow is
broken and Taras explicitly approves manual recovery.

## Prerequisites

- GitHub environment `npm-release` has `NPM_TOKEN` configured.
- Local development has Bun installed.
- `gh` is authenticated if you want to check workflow or release state from the
  terminal.

## Normal Release

Prepare the version bump on a branch:

```sh
git switch master
git pull --ff-only
git switch -c release/vX.Y.Z

bun run release patch
git push -u origin release/vX.Y.Z
```

Open a PR, wait for CI, and merge it into `master`. The release workflow runs
from the merge commit when `package.json`'s `version` changed.

The release helper accepts `patch`, `minor`, `major`, `prepatch`, `preminor`,
`premajor`, `prerelease`, or an explicit version like `1.2.3`. It runs tests,
typecheck, and `npm pack --dry-run --json`, then commits `Release vX.Y.Z`.

Use `--no-verify` only when you already ran the same checks in the current
working tree. Keep version tagging out of local commands; the workflow owns tag
creation.

## What The Workflow Does

When `package.json` changes on `master`, the workflow:

1. Detects whether the package version changed.
2. Installs dependencies with `bun install --frozen-lockfile`.
3. Runs `bun run test`.
4. Runs `bun run typecheck`.
5. Validates the npm tarball with `npm pack --dry-run --json`.
6. Publishes `@desplega.ai/claude-bridge@X.Y.Z` with `npm publish --access public`.
7. Creates git tag `vX.Y.Z`.
8. Creates the GitHub Release.

If npm already has that exact version, the workflow skips `npm publish` and
continues to tag and GitHub Release creation.

## Verify A Release

Check the workflows:

```sh
gh run list --branch master --limit 10
gh run view <release-run-id> --json status,conclusion,url,headSha
gh run view <ci-run-id> --json status,conclusion,url,headSha
```

Check the GitHub Release:

```sh
gh release view vX.Y.Z --json tagName,url,publishedAt,isDraft,isPrerelease
```

Check npm status and installability:

```sh
npm view @desplega.ai/claude-bridge@X.Y.Z name version dist-tags --json
bunx @desplega.ai/claude-bridge@X.Y.Z --version
```

`npm publish` can complete before the package document is immediately visible
through every registry endpoint. If the workflow log shows
`+ @desplega.ai/claude-bridge@X.Y.Z` but `npm view` still returns `E404`, wait a
few minutes and retry. Installability is not confirmed until `npm view` or
`bunx` succeeds.

## Package Boundary

`package.json` uses a `files` allowlist. The public package should include only
the runtime sources, `README.md`, `LICENSE`, and `package.json`.

Keep these out of the tarball:

- `.github/`
- `scripts/`
- `.claude/`
- `AGENTS.md`
- `CLAUDE.md`
- `bun.lock`
- `src/test-*`

Run this before release commits that touch package metadata:

```sh
npm pack --dry-run --json
```

The release workflow enforces the same boundary. Note that `npm pack` does not
resolve imports, so it will happily build a tarball that omits a runtime source
a shipped file imports (this is how v0.2.0 shipped without `src/claude-compat.ts`
and crashed on launch). The `test:package-files` test guards against that by
asserting every non-test `src/*.ts` is present in the `files` allowlist; it runs
as part of `bun test`.

## Recovery

If `npm publish` succeeds but tag or GitHub Release creation fails:

```sh
git tag vX.Y.Z <release-commit-sha>
git push origin vX.Y.Z
gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag
```

If the GitHub Release exists but npm installability is not confirmed, do not
republish blindly. First inspect the release workflow log, check whether the
version already exists, and verify npm access from an authenticated maintainer
account.

If npm emits a publish-time warning like:

```text
npm auto-corrected some errors in your package.json when publishing
```

run this locally, inspect the diff, and only commit the change if it is the
intended package metadata normalization:

```sh
npm pkg fix
git diff -- package.json
```
