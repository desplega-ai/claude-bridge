/**
 * Transcript discovery + tail loop. Mirrors the technique in
 * dexhorthy/shannon: snapshot the pre-existing *.jsonl set, poll until a new
 * file appears, then poll-and-reparse the whole file every POLL_MS.
 *
 * We do NOT rely on a computed slug in production — Claude's slug rule has
 * version drift (e.g. it sometimes strips leading dots, sometimes doesn't).
 * Instead, the CLI snapshots transcript files before launch and waits for a
 * fresh transcript whose rows report the target cwd.
 */
import { Glob } from "bun";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";

export const POLL_MS = 100;
// Generous because Claude may show first-run screens before writing the
// transcript.
export const START_TIMEOUT_MS = 60_000;

export function claudeProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

/**
 * Legacy slug rule from Shannon's research notes. Kept for the unit test.
 * The real folder name is discovered at runtime via
 * findProjectFolderByDiscriminator because Claude's slug rule drifts.
 */
export function projectKeyForCwd(cwd: string): string {
  return resolve(cwd).normalize("NFC").replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function claudeProjectFolder(cwd: string, home: string = homedir()): string {
  return join(claudeProjectsRoot(home), projectKeyForCwd(cwd));
}

/**
 * Find the ~/.claude/projects/<slug>/ directory Claude is using for the given
 * discriminator (a unique substring of the cwd, like our run id). Polls until
 * one appears or START_TIMEOUT_MS elapses.
 */
export async function findProjectFolderByDiscriminator(
  discriminator: string,
  signal?: AbortSignal
): Promise<string> {
  const root = claudeProjectsRoot();
  const t0 = Date.now();
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const entries = await readdir(root);
      const match = entries.find(name => name.includes(discriminator));
      if (match) return join(root, match);
    } catch {
      // root may not exist yet
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out finding project folder for ${discriminator} under ${root}`);
}

export async function listTranscriptPaths(projectFolder: string): Promise<Set<string>> {
  const glob = new Glob("*.jsonl");
  const paths = new Set<string>();
  try {
    for await (const name of glob.scan(projectFolder)) paths.add(join(projectFolder, name));
  } catch {
    return paths;
  }
  return paths;
}

export async function listAllTranscriptPaths(root: string = claudeProjectsRoot()): Promise<Set<string>> {
  const paths = new Set<string>();
  let projectFolders: string[] = [];
  try {
    projectFolders = (await readdir(root)).map(name => join(root, name));
  } catch {
    return paths;
  }
  for (const folder of projectFolders) {
    for (const path of await listTranscriptPaths(folder)) paths.add(path);
  }
  return paths;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function waitForFreshTranscript(
  projectFolder: string,
  before: Set<string>,
  signal?: AbortSignal
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error("aborted");
    const paths = await listTranscriptPaths(projectFolder);
    const fresh = [...paths].filter(p => !before.has(p)).sort();
    if (fresh[0]) return fresh[0];
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for a fresh transcript in ${projectFolder}`);
}

export async function waitForFreshTranscriptForCwd(
  cwd: string,
  before: Set<string>,
  signal?: AbortSignal,
  root: string = claudeProjectsRoot()
): Promise<string> {
  const targetCwd = resolve(cwd);
  const startedAt = Date.now();
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    if (signal?.aborted) throw new Error("aborted");
    const paths = await listAllTranscriptPaths(root);
    const fresh = [...paths].filter(p => !before.has(p)).sort();
    for (const path of fresh) {
      const rows = await readTranscript(path);
      if (rows.some(row => typeof row.cwd === "string" && resolve(row.cwd) === targetCwd)) {
        return path;
      }
      // A just-created transcript may not have its init row yet. Keep polling.
      if (rows.length === 0) continue;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for a fresh transcript for cwd ${targetCwd}`);
}

export type TranscriptRow = Record<string, unknown> & { type?: string };
type TranscriptEntry = { row: TranscriptRow; line: string };

export async function readTranscript(transcriptPath: string): Promise<TranscriptRow[]> {
  return (await readTranscriptEntries(transcriptPath)).map(entry => entry.row);
}

export async function readTranscriptLines(transcriptPath: string): Promise<string[]> {
  return (await readTranscriptEntries(transcriptPath)).map(entry => entry.line);
}

async function readTranscriptEntries(transcriptPath: string): Promise<TranscriptEntry[]> {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return { row: JSON.parse(line) as TranscriptRow, line };
      } catch {
        return { row: { type: "bridge_parse_error", line }, line };
      }
    });
}

export async function tailTranscript(
  transcriptPath: string,
  onRow: (row: TranscriptRow, index: number, rawLine: string) => void,
  signal: AbortSignal
): Promise<void> {
  let emitted = 0;
  while (!signal.aborted) {
    const entries = await readTranscriptEntries(transcriptPath);
    for (let i = emitted; i < entries.length; i++) {
      const entry = entries[i]!;
      onRow(entry.row, i, entry.line);
      if (signal.aborted) break;
    }
    if (entries.length > emitted) emitted = entries.length;
    await sleep(POLL_MS);
  }
}

export async function tailTranscriptLines(
  transcriptPath: string,
  onLine: (line: string, index: number) => void,
  signal: AbortSignal
): Promise<void> {
  let offset = 0;
  let buffer = "";
  let emitted = 0;
  while (!signal.aborted) {
    try {
      const size = statSync(transcriptPath).size;
      if (size < offset) {
        offset = 0;
        buffer = "";
        emitted = 0;
      }
      if (size > offset) {
        const chunk = readFileSync(transcriptPath).subarray(offset, size).toString("utf8");
        offset = size;
        buffer += chunk;
        const newline = buffer.lastIndexOf("\n");
        if (newline >= 0) {
          const complete = buffer.slice(0, newline).split("\n");
          buffer = buffer.slice(newline + 1);
          for (const line of complete) {
            if (!line) continue;
            onLine(line, emitted++);
            if (signal.aborted) break;
          }
        }
      }
    } catch {
      // The transcript may not exist at the exact moment the tail starts.
    }
    await sleep(POLL_MS);
  }
}

/**
 * The terminal row Claude writes for a turn. It lands *after* the Stop hook
 * fires (and after the stop_hook_summary row), so it's the reliable signal that
 * the transcript for the turn has been fully flushed to disk.
 */
export function isTurnDurationRow(row: TranscriptRow): boolean {
  return row.type === "system" && (row as { subtype?: unknown }).subtype === "turn_duration";
}

export async function transcriptHasTurnEnd(transcriptPath: string): Promise<boolean> {
  return (await readTranscript(transcriptPath)).some(isTurnDurationRow);
}

/**
 * Poll until the transcript contains its terminal turn_duration row, or the
 * timeout elapses. Returns true if the turn-end row landed. Used to avoid
 * truncating streamed JSONL: the Stop hook fires before Claude appends the
 * final stop_hook_summary + turn_duration rows.
 */
export async function waitForTranscriptTurnEnd(
  transcriptPath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const startedAt = Date.now();
  while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
    if (await transcriptHasTurnEnd(transcriptPath)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

export function sessionIdFromPath(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/, "");
}

export function projectFolderFromTranscript(transcriptPath: string): string {
  return dirname(transcriptPath);
}
