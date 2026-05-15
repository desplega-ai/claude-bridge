# claude-tmux-channel

Proof-of-concept that combines two ideas:

- **[Shannon](https://github.com/dexhorthy/shannon)** — drive an interactive
  `claude` session inside a [tmux](https://github.com/tmux/tmux) pane instead of
  calling the API directly.
- **[Claude Code Channels](https://code.claude.com/docs/en/channels)** — a
  channel is an MCP server that Claude spawns as a subprocess and that can
  *push* events into the running session (and receive replies via a tool).

This POC welds them: a single Bun CLI spins up a Unix-socket server, starts
`claude` inside a detached tmux session with a development channel registered,
and the channel MCP — which Claude launches automatically — connects back to
the parent over the socket. The orchestrator does three things in parallel:

  1. **Push events**. Anything you type on stdin becomes a `<channel>` event
     delivered through the in-process MCP.
  2. **Stream replies**. Claude's `reply` tool calls come straight back over
     the socket and print on stdout as `{"type":"reply", ...}`.
  3. **Stream the full transcript**. The orchestrator tails Claude's on-disk
     JSONL transcript (the same file `claude` itself writes to
     `~/.claude/projects/<slug>/<session-uuid>.jsonl`) and emits every line on
     stdout as `{"type":"transcript", "row":<jsonl-line>}`. This is the
     [Shannon](https://github.com/dexhorthy/shannon) technique: snapshot the
     pre-existing `*.jsonl` set before launch, poll for a fresh file,
     poll-and-reparse it every 100 ms.

The orchestrator also pre-clears the prompts that would otherwise block
Claude's UI:

  - `~/.claude.json` is edited so `projects[<workdir>].hasTrustDialogAccepted`,
    `hasCompletedProjectOnboarding`, and `approvedMcprcServers` include our
    bridge. The previous file is backed up alongside it as
    `~/.claude.json.ctc-backup`.
  - A per-workdir `.claude/settings.local.json` sets
    `defaultMode: "bypassPermissions"` and
    `skipDangerousModePermissionPrompt: true`.
  - `claude` is launched with `--dangerously-skip-permissions
    --dangerously-load-development-channels server:bridge`.
  - The dev-channels confirmation (still shown live, not persisted) is
    auto-accepted by watching `tmux capture-pane` for the marker text and
    sending `y<Enter>`.

```
+--------------------+              +-----------------------------+
|  ctc (orchestrator)|<--socket-----|  bun src/mcp-channel.ts     |
|  - listens on .sock|   (stdio MCP)|  (spawned by claude as a    |
|  - tmux send-keys  |              |   stdio MCP subprocess)     |
+----------+---------+              +--------------+--------------+
           |                                       ^
           | tmux send-keys                        |
           v                                       |
    +------+-----------------------------+         |
    |  tmux session  ctc-<id>            |         |
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
bun ./src/cli.ts
```

The CLI prints a banner with the tmux session name and the socket path:

```
   tmux session : ctc-2026abcd
   workdir      : .runs/2026-05-15T.../
   socket       : .runs/2026-05-15T.../bridge.sock

   attach to the Claude UI in another terminal:
     tmux attach -t ctc-2026abcd

   Claude must accept the dev-channel prompt once.
   Then type a message below and press Enter to push it as a channel event.
   Replies from Claude's reply tool appear here.
   Ctrl-D to quit (kills the tmux session).

>>
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

Every transcript line is shown twice: the friendly summary on top and the
verbatim JSONL row dimmed below. `CTC_RAW=1` collapses to just the raw row;
`CTC_JSONL=1` forces JSONL even on a TTY.

```sh
bun ./src/cli.ts > run.jsonl   # JSONL when piped
bun ./src/view.ts < run.jsonl  # re-render an old log
CTC_RAW=1 bun ./src/cli.ts     # only raw JSONL rows
```

The orchestrator shows a `> ` prompt for stdin and redraws it after every
output line, so you always know where you can type.

Attach the live Claude UI in another terminal if you want to see what Claude
is doing:

```sh
tmux attach -t ctc-2026abcd
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

## Layout

- `src/cli.ts` — orchestrator (Unix-socket server + tmux launcher + stdin
  REPL + transcript tail).
- `src/mcp-channel.ts` — channel MCP (stdio server with `claude/channel`
  capability and a `reply` tool, bridged to the orchestrator over the socket).
- `src/bridge.ts` — newline-delimited JSON framing for the socket.
- `src/transcript.ts` — Shannon-style transcript discovery + poll-and-tail.
- `src/preaccept.ts` — pre-writes `~/.claude.json` trust entry +
  `.claude/settings.local.json` to suppress trust / MCP-approval prompts.
- Each run writes its `.mcp.json`, settings, and socket under `.runs/<id>/`.

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
- We rely on `--dangerously-load-development-channels server:bridge` because
  custom channels aren't on the approved allowlist during the research preview.
- The auto-acceptor for the dev-channel prompt is a regex over
  `tmux capture-pane`. If Claude's prompt copy changes the heuristic may miss
  it; you can still attach to the pane and press `y` yourself.
- Permission prompts and tool approvals are pre-bypassed via
  `--dangerously-skip-permissions`. **This effectively runs Claude in
  auto-execute mode against the workdir.** Use a throwaway workdir
  (`.runs/<id>/` is one per launch) and don't point this at sensitive paths.
- To relay permission prompts off the pane instead of bypassing them, declare
  `experimental['claude/channel/permission']` in `mcp-channel.ts` and handle
  the `notifications/claude/channel/permission_request` notification (see the
  [reference](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)).
