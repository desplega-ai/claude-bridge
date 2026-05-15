#!/usr/bin/env bun
/**
 * Smoke test: stand up a Unix-socket server, spawn mcp-channel as a stdio MCP
 * subprocess, run through `initialize` + `tools/list`, deliver a push envelope,
 * call the reply tool, verify the reply arrives back on the socket.
 *
 * This test exercises the wiring without needing a real Claude process.
 */
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onLines, send, type Envelope } from "./bridge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, "mcp-channel.ts");

const workdir = mkdtempSync(join(tmpdir(), "ctc-smoke-"));
const sockPath = join(workdir, "bridge.sock");

let received: Envelope[] = [];
const seen = (k: Envelope["kind"]) => received.find(e => e.kind === k);

let bridgeSock: Socket | null = null;
const server = createServer(sock => {
  bridgeSock = sock;
  onLines(sock, env => received.push(env));
});

const ok = (label: string, cond: boolean) => {
  console.log((cond ? "PASS" : "FAIL") + " " + label);
  if (!cond) process.exitCode = 1;
};

await new Promise<void>(r => server.listen(sockPath, r));

const child = spawn("bun", [MCP_ENTRY], {
  env: { ...process.env, CTC_SOCK: sockPath, CTC_CHANNEL_NAME: "smoke" },
  stdio: ["pipe", "pipe", "inherit"],
});

let stdoutBuf = "";
const readMessage = (): Promise<unknown> =>
  new Promise(res => {
    const tryParse = () => {
      const i = stdoutBuf.indexOf("\n");
      if (i === -1) return false;
      const line = stdoutBuf.slice(0, i);
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line.trim()) return tryParse();
      res(JSON.parse(line));
      return true;
    };
    if (tryParse()) return;
    const handler = (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      if (tryParse()) child.stdout!.off("data", handler);
    };
    child.stdout!.on("data", handler);
  });

const writeMessage = (msg: unknown) => child.stdin!.write(JSON.stringify(msg) + "\n");

const initId = 1;
writeMessage({
  jsonrpc: "2.0",
  id: initId,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  },
});

const initResp = (await readMessage()) as { id: number; result?: any };
ok("initialize returns result", initResp.id === initId && !!initResp.result);
ok(
  "channel capability declared",
  Boolean(initResp.result?.capabilities?.experimental?.["claude/channel"])
);
ok("tools capability declared", Boolean(initResp.result?.capabilities?.tools));
ok(
  "instructions mention reply tool",
  typeof initResp.result?.instructions === "string" &&
    initResp.result.instructions.includes("reply tool")
);

writeMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

// Wait for hello envelope.
const waitFor = (pred: () => boolean, ms = 2000) =>
  new Promise<void>((res, rej) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (pred()) {
        clearInterval(id);
        res();
      } else if (Date.now() - t0 > ms) {
        clearInterval(id);
        rej(new Error("timeout"));
      }
    }, 20);
  });

await waitFor(() => !!seen("hello"));
const hello = seen("hello") as Extract<Envelope, { kind: "hello" }>;
ok("hello envelope arrived", hello.channel === "smoke" && hello.pid > 0);

// Push a message and confirm it's emitted as an MCP notification with the right shape.
const pushPromise = readMessage();
send(bridgeSock!, { kind: "push", id: "abc123", content: "hi from smoke" });
const note = (await pushPromise) as { method: string; params: any };
ok("push -> notifications/claude/channel", note.method === "notifications/claude/channel");
ok("content forwarded", note.params?.content === "hi from smoke");
ok("meta.id forwarded", note.params?.meta?.id === "abc123");

// tools/list should expose `reply`.
writeMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const list = (await readMessage()) as { id: number; result?: any };
const reply = list.result?.tools?.find((t: any) => t.name === "reply");
ok("reply tool listed", !!reply);
ok("reply requires chat_id+text", reply?.inputSchema?.required?.includes("chat_id") && reply?.inputSchema?.required?.includes("text"));

// Call the reply tool, expect a reply envelope on the socket.
writeMessage({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "reply", arguments: { chat_id: "abc123", text: "yo" } },
});
const callResp = (await readMessage()) as { id: number; result?: any };
ok("reply tool returns sent", callResp.result?.content?.[0]?.text === "sent");

await waitFor(() => !!seen("reply"));
const replyEnv = seen("reply") as Extract<Envelope, { kind: "reply" }>;
ok("reply envelope chat_id matches", replyEnv.chat_id === "abc123");
ok("reply envelope text matches", replyEnv.text === "yo");

child.kill();
await new Promise(r => child.once("exit", r));
server.close();
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

console.log("\nresult: " + (process.exitCode ? "FAIL" : "PASS"));
process.exit(process.exitCode ?? 0);
