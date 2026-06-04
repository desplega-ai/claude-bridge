# claude-bridge

Proof-of-concept that combines two ideas:

- **[Shannon](https://github.com/dexhorthy/shannon)** — drive an interactive
  `claude` session inside a [tmux](https://github.com/tmux/tmux) pane instead of
  calling the API directly.
- **[Claude Code Channels](https://code.claude.com/docs/en/channels)** — a
  channel is an MCP server that Claude spawns as a subprocess and that can
  *push* events into the running session (and receive replies via a tool).

`claude-bridge` welds them: a single Bun CLI spins up a Unix-socket server, starts
`claude` inside a detached tmux session with a development channel registered,
and the channel MCP — which Claude launches automatically — connects back to
the parent over the socket. The orchestrator does three things in parallel:

  1. **Push events**. Anything you type on stdin becomes a `<channel>` event
     delivered through the in-process MCP.
  2. **Stream replies**. Claude's `reply` tool calls come straight back over
     the socket as bridge `reply` events.
  3. **Stream the full transcript**. The orchestrator tails Claude's on-disk
     JSONL transcript (the same file `claude` itself writes to
     `~/.claude/projects/<slug>/<session-uuid>.jsonl`) and emits every line as
     a bridge `transcript` event with the raw row nested under `row`. This is the
     [Shannon](https://github.com/dexhorthy/shannon) technique: snapshot the
     pre-existing `*.jsonl` set before launch, poll for a fresh file,
     poll-and-reparse it every 100 ms.

The orchestrator also pre-clears the prompts that would otherwise block
Claude's UI:

  - Claude's global config is edited so
    `projects[<workdir>].hasTrustDialogAccepted`,
    `hasCompletedProjectOnboarding`, and `approvedMcprcServers` include our
    bridge. This is `~/.claude.json` by default, or
    `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set. The
    previous file is backed up alongside it as
    `.claude.json.claude-bridge-backup`.
  - A per-workdir `.claude/settings.local.json` sets
    `defaultMode: "bypassPermissions"` and
    `skipDangerousModePermissionPrompt: true`.
  - `claude` is launched with `--dangerously-skip-permissions
    --dangerously-load-development-channels server:bridge`.
  - The dev-channels confirmation (still shown live, not persisted) is
    auto-accepted by watching `tmux capture-pane` for the marker text and
    sending `Enter`.

```
+--------------------+              +-----------------------------+
| claude-bridge      |<--socket-----|  bun src/mcp-channel.ts     |
|  - listens on .sock|   (stdio MCP)|  (spawned by claude as a    |
|  - tmux send-keys  |              |   stdio MCP subprocess)     |
+----------+---------+              +--------------+--------------+
           |                                       ^
           | tmux send-keys                        |
           v                                       |
    +------+-----------------------------+         |
    |  tmux session  claude-bridge-<id>  |         |
    |   pane 0: claude --dangerously-... |---------+ (spawns)
    |             load-development-      |
    |             channels server:bridge |
    +------------------------------------+
```

## Requirements

- [Bun](https://bun.sh) (`>= 1.1`)
- `claude` CLI on PATH, version `>= 2.1.80`, authenticated against claude.ai or
  a Console API key. Channels are **not available** on Bedrock, Vertex, or
  Foundry.
- `tmux` on PATH.

## Install

```sh
bun install
```

## Run

```sh
# Interactive bridge
bun ./src/cli.ts
bun ./src/cli.ts --model sonnet "start by listing the files"

# `claude -p` replacement during local development
bun ./src/cli.ts -p "say hi"
bun ./src/cli.ts -p "say hi" --output-format json
bun ./src/cli.ts -p "say hi" --output-format stream-json
bun ./src/cli.ts -p "summarize this" --json-schema schema.json --output-format json
printf 'say hi\n' | bun ./src/cli.ts --print

# Wrapper metadata/help
bun ./src/cli.ts --version
bun ./src/cli.ts --help
```

If you run the package bin, the command-shape replacement is:

```sh
claude -p "say hi" --output-format json
claude-bridge -p "say hi" --output-format json
```

This is drop-in compatibility for common `claude -p` automation, not a
byte-for-byte clone of every Claude CLI mode. In print mode the wrapper starts
an interactive Claude session in tmux, waits for the channel and pane to become
ready, pushes the prompt through the bridge channel, prints the requested
format, then kills the tmux session.

## Print output

`-p`/`--print` requires a prompt argument or piped stdin. `--output-format`
requires print mode and accepts `text`, `json`, or `stream-json`; the default is
`text`. `--json-schema` is also print-only.

The final result normally comes from Claude calling the bridge `reply` tool. If
the transcript reaches Claude's `system` `turn_duration` row first, the wrapper
falls back to the last assistant text it saw, so `chat_id` may be absent. In
schema mode the bridge reply is required; missing bridge replies are treated as
errors instead of accepting assistant transcript text.

- `text`: prints only the final answer text plus a trailing newline. Wrapper
  errors go to stderr and exit non-zero.
- `json`: prints one final JSON object. Success looks like
  `{"type":"result","subtype":"success","is_error":false,"result":"..."}` and
  may include `chat_id` and `session_id` when available. Errors use
  `subtype:"error"`, `is_error:true`, and an `error` string.
- `stream-json`: prints newline-delimited bridge events as the run progresses,
  then a final `result` event. This is a custom `claude-bridge` event stream,
  not Claude's native `stream-json` schema.

Typical `stream-json` event types are:

```jsonc
{"type":"channel_hello","pid":80123,"channel":"bridge"}
{"type":"push","id":"ab12cd34","content":"say hi"}
{"type":"transcript_folder","path":"/Users/.../.claude/projects/..."}
{"type":"transcript_open","path":"/Users/.../<uuid>.jsonl","session_id":"..."}
{"type":"transcript","row":{"type":"assistant","message":{...}}}
{"type":"reply","chat_id":"ab12cd34","text":"Hi."}
{"type":"result","subtype":"success","is_error":false,"result":"Hi.","chat_id":"ab12cd34","session_id":"..."}
```

For `transcript` events, `row` is the raw parsed Claude transcript JSONL row.
If you think of the event as a path, that raw Claude data lives at
`transcript.row`; consumers should switch on the outer bridge `type` first.

## Structured JSON

`--json-schema <schema|file>` is bridge-owned. It is not forwarded to raw
`claude -p`; the wrapper keeps the normal bridge path, injects schema guidance
with `--append-system-prompt`, waits for Claude's bridge reply, extracts the
last JSON value from the reply text, and validates it locally with Zod.

Existing user-provided `--append-system-prompt` values are preserved. When a
schema is present, the wrapper merges those prompts with its schema instruction
instead of replacing them.

Schema print mode also installs a global Claude Code `Stop` hook in
`~/.claude/settings.json`. The hook is inert outside `claude-bridge` schema
runs; during a schema run it checks the latest bridge reply before Claude stops
and blocks the stop if the reply is missing or does not validate. That gives
Claude a bounded number of extra turns to call the bridge `reply` tool with
valid JSON instead of letting the wrapper silently fall back to transcript text.

Control that hook explicitly with:

```sh
bun ./src/cli.ts --desplega-install
bun ./src/cli.ts --desplega-uninstall
```

Install is append-only and idempotent: unrelated hooks are preserved, and stale
old `claude-bridge` hook commands are replaced with the current command.

The schema argument may be inline JSON or a path to a JSON file:

```sh
bun ./src/cli.ts -p "Return the repo name" \
  --json-schema '{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}' \
  --output-format json

bun ./src/cli.ts -p "Return the repo name" \
  --json-schema ./schema.json \
  --output-format text
```

Extraction is intentionally simple and deterministic:

1. Try the whole reply as JSON.
2. Otherwise use the last fenced `json` block.
3. Otherwise use the final balanced JSON object or array in the reply.

Validation uses Zod's `z.fromJSONSchema()` converter. That API is still marked
experimental by Zod, but it keeps the bridge aligned with Zod's JSON Schema
support instead of maintaining a handwritten validator here. If Zod cannot
convert the schema, the wrapper treats that as a print-mode error.

With `--output-format text`, successful schema mode prints the extracted JSON
value as compact JSON. With `json` or `stream-json`, the final result includes
`structured_output` and `structured_output_source` alongside the original
reply text in `result`.

If schema extraction or validation fails after Claude replies, `json` and
`stream-json` error results include `raw_response` with the unmodified Claude
reply. In `text` mode the same raw reply is printed to stderr under
`Raw Claude reply:`.

The compact stringified schema is capped before Claude starts. The default cap
is roughly `15000` tokens, estimated as `ceil(chars / 4)`. Configure it with:

```sh
CLAUDE_BRIDGE_JSON_SCHEMA_MAX_TOKENS=30000 bun ./src/cli.ts -p "..." --json-schema schema.json
bun ./src/cli.ts -p "..." --json-schema schema.json --desplega-json-schema-max-tokens=30000
```

## Wrapper-owned vs forwarded

The wrapper owns these options and does not forward them to Claude:

- `-p`/`--print`, `--output-format`, and `--json-schema`
- `--desplega-verbose` and other `--desplega-<name>[=<value>]` flags
- `--claude-help`
- `-h`/`--help`
- `-v`/`--version`

Most interactive `claude -h` options pass through to the spawned Claude session,
for example `--model sonnet`, `--permission-mode acceptEdits`, `--append-system-prompt`,
or `--allowed-tools`. The wrapper always prepends its own launch flags:
`--dangerously-skip-permissions --dangerously-load-development-channels server:bridge`.

The initial prompt is wrapper-owned too. It is not passed to Claude as a CLI
argument; once the channel and pane are ready, the wrapper sends it as a channel
event. In non-print mode, stdin remains a small REPL that sends each entered
line through the same channel.

Claude subcommands are intentionally blocked; run `claude <cmd>` directly for
commands such as `doctor`, `mcp`, `plugin`, `update`, `agents`, or `auth`.
Claude modes that conflict with the bridge are also blocked: `--tmux`,
`--replay-user-messages`/`--replay*`, and `-w`/`--worktree`.

Use `--claude-help` to see raw Claude help, with the caveat that wrapper-owned
modes behave as described here. Use `-v`/`--version` to print the wrapper
package version, the full `claude` path from `which claude`, and the
`claude -v` output.

Use `--desplega-verbose` for extra wrapper debug output and raw transcript
rows. Other `--desplega-<name>[=<value>]` flags are reserved for future wrapper
features and are not forwarded to Claude.

## Future notes

Structured output should stay bridge-native. Future AI SDK integration can be a
repair or fallback layer after the bridge reply, not a replacement for the
bridge turn. Plausible provider knobs are
`--desplega-structured-provider=anthropic|openai|google|openrouter` with the
usual `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` /
`GEMINI_API_KEY`, or `OPENROUTER_API_KEY` env vars. That mode would validate
the bridge reply first, then optionally ask a provider to repair invalid JSON
into the schema.

Remote/SSH support should also keep the bridge boundary. The likely shape is a
transport abstraction (`stdio` today, HTTP MCP later) plus a tunnel abstraction
(`none`, Tailscale Serve/Funnel, SSH reverse tunnel, cloudflared, ngrok). For a
remote Claude session, the remote host still needs `claude`, `tmux`, Bun, and
the bridge MCP entrypoint. Tunnels only expose/connect the MCP transport; they
do not remove the need for Claude Code to load the bridge channel. Public
tunnels such as Tailscale Funnel must require a per-run bearer token and should
default to localhost binding unless explicitly exposed.

The CLI prints a banner with the tmux session name and the socket path:

```
   tmux session : claude-bridge-2026abcd
   cwd          : /path/to/current/project
   run state    : .runs/2026-05-15T.../
   socket       : .runs/2026-05-15T.../bridge.sock

   attach to the Claude UI in another terminal:
     tmux attach -t claude-bridge-2026abcd

   Type a message + Enter on stdin to push a channel event.
   Replies and useful transcript rows print below.
   Use --desplega-verbose for raw transcript rows and wrapper debug.
   Ctrl-D to quit (kills the tmux session).

>
```

When stdout is a TTY, the orchestrator pretty-prints a human-friendly feed:

```
14:02:17 channel mcp connected pid=80123
14:02:17 transcript /Users/taras/.claude/projects/.../<uuid>.jsonl
14:02:21 → push     id=a1b2c3 what files exist?
14:02:22 user       what files exist?
14:02:22 assistant  Let me check.
                    [tool_use Bash {"command":"ls"}]
14:02:23 user       [tool_result] file.txt\n.gitignore
14:02:23 assistant  I found two files: file.txt and .gitignore.
14:02:23 system     turn_duration=2345ms
14:02:23 ← reply    id=a1b2c3 There are two files: file.txt and .gitignore.
```

By default, TTY output hides raw transcript metadata and only shows useful
human-friendly rows. `--desplega-verbose` adds wrapper debug output and the
verbatim JSONL row dimmed below each friendly transcript summary.

```sh
bun ./src/cli.ts > run.jsonl                 # JSONL when piped
bun ./src/view.ts < run.jsonl                # re-render an old log
bun ./src/cli.ts --desplega-verbose          # friendly rows plus raw rows
```

The orchestrator shows a `> ` prompt for stdin and redraws it after every
output line, so you always know where you can type.

Attach the live Claude UI in another terminal if you want to see what Claude
is doing:

```sh
tmux attach -t claude-bridge-2026abcd
```

The orchestrator pre-accepts the trust and MCP-approval prompts, and watches
for the dev-channel confirmation and answers it for you. You shouldn't need to
touch the pane.

Now type in the orchestrator window:

```
what's in the current directory?
```

Stdout will show, in order: the `push` envelope, a stream of `transcript`
envelopes as Claude works (each row is whatever Claude wrote to the JSONL —
user, assistant, tool_use, tool_result, system, etc.), and finally a `reply`
envelope when Claude calls the in-process channel's `reply` tool:

```jsonc
{"type":"push","id":"ab12cd34","content":"what's in the current directory?"}
{"type":"transcript_open","path":"/Users/.../<uuid>.jsonl","session_id":"..."}
{"type":"transcript","row":{"type":"user","message":{...}}}
{"type":"transcript","row":{"type":"assistant","message":{...}}}
{"type":"transcript","row":{"type":"tool_use","name":"Bash","input":{...}}}
{"type":"transcript","row":{"type":"tool_result","output":"..."}}
{"type":"reply","chat_id":"ab12cd34","text":"I see one file, .mcp.json — the channel registration."}
```

Ctrl-D on the orchestrator kills the tmux session and exits.

## Smoke test (no tmux, no claude)

A hermetic test stands up the Unix socket, spawns `mcp-channel.ts` as a stdio
MCP subprocess, drives it through `initialize` / `tools/list` / `tools/call`,
and asserts that push envelopes become channel notifications and that reply
tool calls produce reply envelopes back on the socket:

```sh
bun run test:smoke
```

Expected: 13 PASS lines and `result: PASS`.

## CI

`.github/workflows/ci.yml` runs deterministic tests and typechecking on pushes
and pull requests.

The workflow also has a gated live smoke job. If the GitHub Actions environment
has `CLAUDE_CODE_OAUTH_TOKEN` available, it installs `tmux` and Claude Code,
seeds the runner's ephemeral `~/.claude/.credentials.json` from that token, and
then runs:

```sh
bun ./src/cli.ts -p "Return exactly a JSON object with resp set to ok." \
  --model sonnet \
  --output-format json \
  --json-schema '{"type":"object","properties":{"resp":{"type":"string"}},"required":["resp"],"additionalProperties":false}'
```

If the secret is not available, the live smoke is skipped while the
deterministic job still runs. Keep the token in Claude's credentials file; do
not remap it to `ANTHROPIC_AUTH_TOKEN`, because that starts Claude in bearer
auth mode and disables the channel surface that the bridge requires.

## Layout

- `src/cli.ts` — orchestrator (Unix-socket server + tmux launcher + stdin
  REPL + transcript tail).
- `src/mcp-channel.ts` — channel MCP (stdio server with `claude/channel`
  capability and a `reply` tool, bridged to the orchestrator over the socket).
- `src/bridge.ts` — newline-delimited JSON framing for the socket.
- `src/transcript.ts` — Shannon-style transcript discovery + poll-and-tail.
- `src/preaccept.ts` — pre-writes Claude's global trust entry +
  `.claude/settings.local.json` to suppress trust / MCP-approval prompts.
- `src/hook-install.ts` and `src/stop-hook.ts` — install and execute the
  schema-only global Stop hook.
- Each run writes its `.mcp.json`, schema copy, and socket under `.runs/<id>/`.

## Bridge protocol

Envelopes are JSON, newline-delimited:

```ts
type Envelope =
  | { kind: "hello"; pid: number; channel: string }                       // mcp -> orchestrator on connect
  | { kind: "push"; id: string; content: string; meta?: Record<string,string> } // orchestrator -> mcp
  | { kind: "reply"; chat_id: string; text: string };                     // mcp -> orchestrator
```

`push` becomes a `notifications/claude/channel` event for Claude; the `id`
travels in `meta.id`, so Claude sees:

```
<channel source="bridge" id="ab12cd34">what's in the current directory?</channel>
```

The channel's `instructions` tell Claude to call `reply` with `chat_id` set to
that same id so the orchestrator can correlate replies.

## Notes / known limitations

- This is a single-pane POC. A real version would multiplex multiple sessions
  per orchestrator and persist transcripts.
- This wrapper deliberately blocks Claude subcommands and bridge-conflicting
  modes: `--tmux`, `-w`/`--worktree`, and
  `--replay-user-messages`/`--replay*`. Run `claude <cmd>` or raw `claude`
  directly for those modes.
- Claude Code Channels are not available on Bedrock, Vertex, or Foundry, so
  this bridge does not support those Claude backends.
- We rely on `--dangerously-load-development-channels server:bridge` because
  custom channels aren't on the approved allowlist during the research preview.
- The auto-acceptor for the dev-channel prompt is a regex over
  `tmux capture-pane`. If Claude's prompt copy changes the heuristic may miss
  it; you can still attach to the pane and press `Enter` yourself.
- Permission prompts and tool approvals are pre-bypassed via
  `--dangerously-skip-permissions`. **This effectively runs Claude in
  auto-execute mode against the target cwd.** By default that is the current
  directory; use `--desplega-cwd <path>` when you need to point the run
  somewhere else, and do not point this at sensitive paths.
- To relay permission prompts off the pane instead of bypassing them, declare
  `experimental['claude/channel/permission']` in `mcp-channel.ts` and handle
  the `notifications/claude/channel/permission_request` notification (see the
  [reference](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)).
