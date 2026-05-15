#!/usr/bin/env bun
/**
 * Orchestrator CLI.
 *
 *  - Starts a Unix-socket server for the in-process channel MCP.
 *  - Writes a per-run workdir with .mcp.json + .claude/settings.local.json.
 *  - Pre-accepts the trust + MCP-approval prompts in ~/.claude.json.
 *  - Spawns `claude` inside a detached tmux session with channels enabled.
 *  - Watches the tmux pane for the dev-channels confirmation and answers `y`.
 *  - Tails the on-disk JSONL transcript (Shannon-style) and streams every row
 *    to stdout as `{type:"transcript", row:<line>}`. Channel replies arrive on
 *    the socket and stream as `{type:"reply", chat_id, text}`.
 *
 * Attach to the live Claude UI from another terminal with:
 *     tmux attach -t <session-name>
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { onLines, send, type Envelope } from "./bridge.ts";
import { preAcceptProject, writeWorkdirSettings } from "./preaccept.ts";
import {
  findProjectFolderByDiscriminator,
  listTranscriptPaths,
  sessionIdFromPath,
  tailTranscript,
  waitForFreshTranscript,
  type TranscriptRow,
} from "./transcript.ts";
import { formatEnvelope } from "./view.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const MCP_ENTRY = join(HERE, "mcp-channel.ts");

const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const runDir = join(REPO, ".runs", runId);
mkdirSync(runDir, { recursive: true });

const sockPath = join(runDir, "bridge.sock");
const sessionName = `ctc-${runId.slice(-8)}`;
const channelName = "bridge";

// .mcp.json sets the env Claude will pass to the channel subprocess.
writeFileSync(
  join(runDir, ".mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        [channelName]: {
          command: "bun",
          args: [MCP_ENTRY],
          env: { CTC_SOCK: sockPath, CTC_CHANNEL_NAME: channelName },
        },
      },
    },
    null,
    2
  )
);

preAcceptProject({ workdir: runDir, mcpServerNames: [channelName] });
writeWorkdirSettings(runDir);

const ctrl = new AbortController();
const isTTY = !!process.stdout.isTTY && !process.env.CTC_JSONL;
const showRaw = !!process.env.CTC_RAW;

let rlRef: import("node:readline").Interface | null = null;
const stdoutLine = (obj: Record<string, unknown>): void => {
  let text: string;
  if (isTTY) {
    const line = formatEnvelope(obj, { showRaw });
    if (!line) return;
    text = line + "\n";
  } else {
    text = JSON.stringify(obj) + "\n";
  }
  // Clear the current input line (if any), write the message, then redraw the
  // prompt + whatever the user had typed. Keeps the `> ` always visible.
  if (rlRef && isTTY) {
    process.stdout.write("\r\x1b[2K" + text);
    rlRef.prompt(true);
  } else {
    process.stdout.write(text);
  }
};

let channelSock: Socket | null = null;

const server: NetServer = createServer(sock => {
  if (channelSock) {
    process.stderr.write("[orchestrator] second channel connection rejected\n");
    sock.end();
    return;
  }
  channelSock = sock;
  process.stderr.write("[orchestrator] channel mcp connected\n");
  onLines(sock, env => handleFromChannel(env));
  sock.on("close", () => {
    process.stderr.write("[orchestrator] channel mcp disconnected\n");
    channelSock = null;
  });
});

server.listen(sockPath, () => {
  process.stderr.write(`[orchestrator] socket: ${sockPath}\n`);
  startTmux();
  startRepl();
});

function handleFromChannel(env: Envelope): void {
  if (env.kind === "hello") {
    stdoutLine({ type: "channel_hello", pid: env.pid, channel: env.channel });
    return;
  }
  if (env.kind === "reply") {
    stdoutLine({ type: "reply", chat_id: env.chat_id, text: env.text });
    return;
  }
}

function startTmux(): void {
  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--dangerously-load-development-channels",
    `server:${channelName}`,
  ];
  const newSession = [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    runDir,
    "claude",
    ...claudeArgs,
  ];
  const res = spawnSync("tmux", newSession, { stdio: "inherit" });
  if (res.status !== 0) {
    process.stderr.write(`[orchestrator] tmux new-session exited ${res.status}\n`);
    process.exit(1);
  }
  void autoAcceptDevChannelPrompt();
  void startTranscriptTail();
  printBanner();
}

function capturePane(): string {
  const r = spawnSync("tmux", ["capture-pane", "-pt", sessionName, "-S", "-80"], {
    encoding: "utf8",
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * The --dangerously-load-development-channels flag opens a list-selector
 * dialog: "WARNING: Loading development channels" / "❯ 1. I am using this
 * for local development" / "Enter to confirm · Esc to cancel". Item 1 is
 * pre-selected, so we just send Enter. We then keep watching the pane for
 * up to a few seconds; if the dialog is still visible we resend Enter,
 * because the first keystroke can race with TUI redraws on slow startups.
 */
async function autoAcceptDevChannelPrompt(): Promise<void> {
  const debug = !!process.env.CTC_DEBUG;
  const t0 = Date.now();
  const dialog = /(Loading development channels|Enter to confirm)/i;
  let lastFire = 0;
  let fires = 0;
  while (Date.now() - t0 < 45_000 && !ctrl.signal.aborted) {
    const pane = capturePane();
    if (debug) {
      const tail = pane.split("\n").slice(-12).join("\n");
      process.stderr.write(`[orchestrator][debug] pane tail:\n${tail}\n---\n`);
    }
    const present = dialog.test(pane);
    if (present && Date.now() - lastFire > 600) {
      spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
      lastFire = Date.now();
      fires++;
      process.stderr.write(`[orchestrator] sent Enter to dev-channel dialog (#${fires})\n`);
      if (fires >= 3) {
        // 3 Enters across ~1.8s. If the dialog still didn't accept, it's
        // probably not really a dev-channel dialog any more.
        await sleep(800);
        if (!dialog.test(capturePane())) {
          process.stderr.write("[orchestrator] dev-channel dialog cleared\n");
          return;
        }
      }
    } else if (!present && fires > 0) {
      process.stderr.write("[orchestrator] dev-channel dialog cleared\n");
      return;
    }
    await sleep(150);
  }
  if (fires === 0) {
    process.stderr.write(
      "[orchestrator] dev-channel dialog not detected within 45s — attach to the tmux pane if it's stuck\n"
    );
  }
}

async function startTranscriptTail(): Promise<void> {
  // The run id is a unique substring of the workdir, so it's guaranteed to be
  // in whatever slug Claude picks for ~/.claude/projects/<slug>/.
  let projectFolder: string;
  try {
    projectFolder = await findProjectFolderByDiscriminator(runId, ctrl.signal);
  } catch (err) {
    stdoutLine({
      type: "ctc_error",
      where: "transcript-folder",
      message: (err as Error).message,
    });
    return;
  }
  stdoutLine({ type: "transcript_folder", path: projectFolder });
  const before = await listTranscriptPaths(projectFolder);
  let transcriptPath: string;
  try {
    transcriptPath = await waitForFreshTranscript(projectFolder, before, ctrl.signal);
  } catch (err) {
    stdoutLine({
      type: "ctc_error",
      where: "transcript-discovery",
      message: (err as Error).message,
    });
    return;
  }
  const sessionId = sessionIdFromPath(transcriptPath);
  stdoutLine({ type: "transcript_open", path: transcriptPath, session_id: sessionId });
  await tailTranscript(
    transcriptPath,
    (row: TranscriptRow) => stdoutLine({ type: "transcript", row }),
    ctrl.signal
  );
}

function printBanner(): void {
  process.stderr.write(
    [
      "",
      `   tmux session : ${sessionName}`,
      `   workdir      : ${runDir}`,
      `   socket       : ${sockPath}`,
      "",
      `   attach to the Claude UI in another terminal:`,
      `     tmux attach -t ${sessionName}`,
      "",
      `   Type a message + Enter on stdin to push a channel event.`,
      `   Streamed transcript rows + channel replies print on stdout as JSONL.`,
      `   Ctrl-D to quit (kills the tmux session).`,
      "",
    ].join("\n")
  );
}

function startRepl(): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
    prompt: "> ",
  });
  rlRef = rl;
  if (isTTY) {
    process.stdout.write("\n");
    rl.prompt();
  }
  rl.on("line", line => {
    const text = line.trim();
    if (!text) {
      if (isTTY) rl.prompt();
      return;
    }
    if (!channelSock) {
      stdoutLine({ type: "ctc_warning", message: "channel mcp not connected yet" });
      return;
    }
    const id = randomUUID().slice(0, 8);
    send(channelSock, { kind: "push", id, content: text });
    stdoutLine({ type: "push", id, content: text });
  });
  rl.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  ctrl.abort();
  try {
    if (channelSock) channelSock.end();
    server.close();
  } catch {}
  spawn("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" }).on("exit", () =>
    process.exit(0)
  );
  setTimeout(() => process.exit(0), 1500);
}
