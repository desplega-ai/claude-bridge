/**
 * Human-friendly formatter for orchestrator envelopes. Used when stdout is a
 * TTY; piped consumers get raw JSONL. Stand-alone too: `cat run.jsonl | bun
 * ./src/view.ts`.
 */
type Json = Record<string, unknown>;

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  grey: "\x1b[90m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? code + s + C.reset : s);

const time = (iso?: string): string => {
  const d = iso ? new Date(iso) : new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return c(C.grey, `${hh}:${mm}:${ss}`);
};

const truncate = (s: string, n = 400): string =>
  s.length > n ? s.slice(0, n) + c(C.dim, `… (+${s.length - n} chars)`) : s;

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(p => {
        if (!p || typeof p !== "object") return "";
        const part = p as Json;
        if (part.type === "text") return String(part.text ?? "");
        if (part.type === "tool_use")
          return `[tool_use ${part.name as string} ${JSON.stringify(part.input ?? {})}]`;
        if (part.type === "tool_result") {
          const out = part.content;
          if (typeof out === "string") return `[tool_result] ${out}`;
          if (Array.isArray(out)) return `[tool_result] ${out.map(o => (o as Json).text ?? "").join("")}`;
          return "[tool_result]";
        }
        if (part.type === "thinking") return c(C.dim, `(thinking) ${String(part.thinking ?? "")}`);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

const formatTranscriptRow = (row: Json): string | null => {
  const ts = time(typeof row.timestamp === "string" ? row.timestamp : undefined);
  const type = String(row.type ?? "?");
  if (type === "user") {
    const msg = (row.message as Json | undefined) ?? {};
    const text = textFromContent(msg.content);
    if (!text.trim()) return null;
    return `${ts} ${c(C.cyan, "user      ")} ${truncate(text)}`;
  }
  if (type === "assistant") {
    const msg = (row.message as Json | undefined) ?? {};
    const text = textFromContent(msg.content);
    if (!text.trim()) return null;
    return `${ts} ${c(C.green, "assistant ")} ${truncate(text)}`;
  }
  if (type === "system") {
    const sub = String(row.subtype ?? "");
    if (sub === "init") {
      const m = (row.message as Json | undefined) ?? {};
      return `${ts} ${c(C.yellow, "system    ")} init session=${row.session_id ?? m.session_id ?? "?"}`;
    }
    if (sub === "turn_duration") {
      return `${ts} ${c(C.yellow, "system    ")} turn_duration=${row.durationMs}ms`;
    }
    return `${ts} ${c(C.yellow, "system    ")} ${sub || JSON.stringify(row).slice(0, 200)}`;
  }
  if (type === "ctc_parse_error") {
    return `${ts} ${c(C.red, "parse_err ")} ${String(row.line ?? "").slice(0, 200)}`;
  }
  // Fallback: show the type + a compact JSON preview.
  return `${ts} ${c(C.grey, type.padEnd(10).slice(0, 10))} ${truncate(JSON.stringify(row), 300)}`;
};

export interface FormatOptions {
  showRaw?: boolean;
}

export function formatEnvelope(env: Json, opts: FormatOptions = {}): string | null {
  const ts = time();
  const type = String(env.type ?? "?");
  switch (type) {
    case "push":
      return `${ts} ${c(C.bold + C.magenta, "→ push    ")} ${c(C.dim, `id=${env.id}`)} ${String(env.content ?? "")}`;
    case "reply":
      return `${ts} ${c(C.bold + C.blue, "← reply   ")} ${c(C.dim, `id=${env.chat_id}`)} ${String(env.text ?? "")}`;
    case "channel_hello":
      return `${ts} ${c(C.dim, "channel mcp connected pid=" + env.pid)}`;
    case "transcript_folder":
      return `${ts} ${c(C.dim, "transcript folder " + env.path)}`;
    case "transcript_open":
      return `${ts} ${c(C.dim, "transcript " + env.path)}`;
    case "transcript": {
      const row = (env.row as Json | undefined) ?? {};
      const friendly = formatTranscriptRow(row);
      const rawLine = `${ts} ${c(C.dim, "raw       ")} ${truncate(JSON.stringify(row), 600)}`;
      if (opts.showRaw) return rawLine;
      // Default: friendly summary + dim raw line, so the on-disk JSONL is
      // always visible alongside the readable view.
      return friendly ? `${friendly}\n${c(C.dim, rawLine)}` : rawLine;
    }
    case "ctc_warning":
      return `${ts} ${c(C.yellow, "warning   ")} ${String(env.message ?? "")}`;
    case "ctc_error":
      return `${ts} ${c(C.red, "error     ")} ${String(env.where ?? "")}: ${String(env.message ?? "")}`;
    default:
      return `${ts} ${c(C.grey, type.padEnd(10).slice(0, 10))} ${JSON.stringify(env)}`;
  }
}

if (import.meta.main) {
  // Run as a stand-alone filter: read JSONL on stdin, write formatted lines on stdout.
  const rl = (await import("node:readline")).createInterface({ input: process.stdin });
  rl.on("line", line => {
    if (!line.trim()) return;
    try {
      const env = JSON.parse(line) as Json;
      const formatted = formatEnvelope(env);
      if (formatted) console.log(formatted);
    } catch {
      console.log(line);
    }
  });
}
