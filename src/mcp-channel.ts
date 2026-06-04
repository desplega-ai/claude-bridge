#!/usr/bin/env bun
/**
 * Channel MCP server. Spawned by Claude Code as a stdio subprocess
 * when started with --dangerously-load-development-channels server:bridge.
 *
 * Bridges the running Claude session to the parent orchestrator over a
 * Unix domain socket whose path is provided via CLAUDE_BRIDGE_SOCK.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createConnection } from "node:net";
import { onLines, send, type Envelope } from "./bridge.ts";

const SOCK = process.env.CLAUDE_BRIDGE_SOCK;
const CHANNEL_NAME = process.env.CLAUDE_BRIDGE_CHANNEL_NAME ?? "bridge";
if (!SOCK) {
  process.stderr.write("[mcp-channel] CLAUDE_BRIDGE_SOCK env var is required\n");
  process.exit(1);
}

const mcp = new Server(
  { name: CHANNEL_NAME, version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      `Messages arrive as <channel source="${CHANNEL_NAME}" id="..."> tags. ` +
      `For every inbound channel message, you MUST reply by calling the reply tool with chat_id set to the value of the id attribute. ` +
      `Keep replies concise.`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: `Send a reply back to the ${CHANNEL_NAME} channel. Pass chat_id equal to the id attribute of the incoming <channel> tag.`,
      inputSchema: {
        type: "object",
        properties: {
          chat_id: { type: "string", description: "The id of the inbound message you are replying to." },
          text: { type: "string", description: "The reply text." },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

const sock = createConnection(SOCK);
const pendingPushes: Extract<Envelope, { kind: "push" }>[] = [];
let socketReady = false;
let mcpReady = false;
let clientInitialized = false;
let helloSent = false;

sock.on("connect", () => {
  process.stderr.write(`[mcp-channel] connected to ${SOCK}\n`);
  socketReady = true;
  maybeSendHello();
});

sock.on("error", err => {
  process.stderr.write(`[mcp-channel] socket error: ${err.message}\n`);
  process.exit(1);
});

sock.on("close", () => {
  process.stderr.write("[mcp-channel] socket closed; exiting\n");
  process.exit(0);
});

onLines(sock, async env => {
  if (env.kind === "push") {
    if (!mcpReady) {
      pendingPushes.push(env);
      return;
    }
    await notifyClaude(env);
  }
});

function maybeSendHello(): void {
  if (!socketReady || !mcpReady || !clientInitialized || helloSent) return;
  helloSent = true;
  send(sock, { kind: "hello", pid: process.pid, channel: CHANNEL_NAME });
  void flushPendingPushes();
}

async function flushPendingPushes(): Promise<void> {
  while (pendingPushes.length > 0) {
    const env = pendingPushes.shift();
    if (env) await notifyClaude(env);
  }
}

async function notifyClaude(env: Extract<Envelope, { kind: "push" }>): Promise<void> {
  const meta: Record<string, string> = { id: env.id, ...(env.meta ?? {}) };
  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: env.content, meta },
  });
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== "reply") {
    return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
  }
  const args = (req.params.arguments ?? {}) as { chat_id?: unknown; text?: unknown };
  if (typeof args.chat_id !== "string" || typeof args.text !== "string") {
    return { content: [{ type: "text", text: "chat_id and text must be strings" }], isError: true };
  }
  const env: Envelope = { kind: "reply", chat_id: args.chat_id, text: args.text };
  send(sock, env);
  return { content: [{ type: "text", text: "sent" }] };
});

mcp.oninitialized = () => {
  process.stderr.write("[mcp-channel] client initialized\n");
  clientInitialized = true;
  maybeSendHello();
};

await mcp.connect(new StdioServerTransport());
process.stderr.write("[mcp-channel] mcp connected over stdio\n");
mcpReady = true;
maybeSendHello();
