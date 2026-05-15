/**
 * Transcript discovery + tail loop. Mirrors the technique in
 * dexhorthy/shannon: snapshot the pre-existing *.jsonl set, poll until a new
 * file appears, then poll-and-reparse the whole file every POLL_MS.
 *
 * We do NOT compute the slug locally — Claude's slug rule has version drift
 * (e.g. it sometimes strips leading dots, sometimes doesn't). Instead we scan
 * ~/.claude/projects/* for a directory whose name contains a unique discriminator
 * (the run id), which is guaranteed to be in the path Claude uses as cwd.
 */
import { Glob } from "bun";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";

export const POLL_MS = 100;
// Generous because the dev-channels dialog auto-accept usually takes 1-3s but
// can sit longer if claude shows additional first-run screens.
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

export type TranscriptRow = Record<string, unknown> & { type?: string };

export async function readTranscript(transcriptPath: string): Promise<TranscriptRow[]> {
  const file = Bun.file(transcriptPath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as TranscriptRow;
      } catch {
        return { type: "ctc_parse_error", line };
      }
    });
}

export async function tailTranscript(
  transcriptPath: string,
  onRow: (row: TranscriptRow, index: number) => void,
  signal: AbortSignal
): Promise<void> {
  let emitted = 0;
  while (!signal.aborted) {
    const rows = await readTranscript(transcriptPath);
    for (let i = emitted; i < rows.length; i++) onRow(rows[i]!, i);
    if (rows.length > emitted) emitted = rows.length;
    await sleep(POLL_MS);
  }
}

export function sessionIdFromPath(transcriptPath: string): string {
  return basename(transcriptPath).replace(/\.jsonl$/, "");
}
