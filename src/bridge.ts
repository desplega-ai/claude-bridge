import { type Socket } from "node:net";

export type Envelope =
  | { kind: "hello"; pid: number; channel: string }
  | { kind: "push"; id: string; content: string; meta?: Record<string, string> }
  | { kind: "reply"; chat_id: string; text: string };

export function send(sock: Socket, env: Envelope): void {
  sock.write(JSON.stringify(env) + "\n");
}

export function onLines(sock: Socket, onEnv: (env: Envelope) => void): void {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", chunk => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onEnv(JSON.parse(line) as Envelope);
      } catch (err) {
        process.stderr.write(`[bridge] bad line: ${line} (${(err as Error).message})\n`);
      }
    }
  });
}
