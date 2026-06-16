#!/usr/bin/env python3
"""
Empirically test whether a real interactive Claude Code TTY session writes JSONL.

This intentionally avoids `-p`, `--print`, SDK mode, stream-json, and piped
stdio. The child `claude` process is attached to a pseudo-terminal, receives one
natural-language prompt, then is asked to exit after the turn has had time to
complete.
"""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shlex
import signal
import subprocess
import sys
import time


PROMPT = "say hello in one word"
CLAUDE = os.environ.get("CLAUDE_BIN", "/usr/bin/claude")
CLAUDE_ARGS = shlex.split(os.environ.get("CLAUDE_ARGS", ""))
TIMEOUT_SECONDS = int(os.environ.get("CLAUDE_RUNTIME_TEST_TIMEOUT", "120"))
MIN_SECONDS_AFTER_PROMPT = int(os.environ.get("CLAUDE_RUNTIME_TEST_MIN_WAIT", "25"))


def now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


def jsonl_files() -> dict[pathlib.Path, tuple[int, int]]:
    roots: list[pathlib.Path] = []
    for value in os.environ.get("CLAUDE_CONFIG_DIR", "").split(","):
        value = value.strip()
        if value:
            roots.append(pathlib.Path(value).expanduser())
    roots.extend(
        [
            pathlib.Path("~/.config/claude").expanduser(),
            pathlib.Path("~/.claude").expanduser(),
        ]
    )

    found: dict[pathlib.Path, tuple[int, int]] = {}
    for root in roots:
        projects = root / "projects"
        if not projects.exists():
            continue
        for path in projects.rglob("*.jsonl"):
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            found[path.resolve()] = (stat.st_mtime_ns, stat.st_size)
    return found


def redact_ansi(value: str) -> str:
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", value)
    return value.replace("\r", "\n")


def read_lines(path: pathlib.Path, limit: int = 6) -> list[str]:
    lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for _, line in zip(range(limit), handle):
            try:
                parsed = json.loads(line)
                lines.append(json.dumps(parsed, ensure_ascii=True)[:1200])
            except json.JSONDecodeError:
                lines.append(line.rstrip("\n")[:1200])
    return lines


def main() -> int:
    start = time.time()
    before = jsonl_files()
    master, slave = pty.openpty()
    tty_name = os.ttyname(slave)

    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")

    command = [CLAUDE, *CLAUDE_ARGS]
    print(f"[{now()}] claude_command={shlex.join(command)}")
    print(f"[{now()}] cwd={os.getcwd()}")
    print(f"[{now()}] pty_slave={tty_name}")
    print(f"[{now()}] before_jsonl_count={len(before)}")
    sys.stdout.flush()

    child = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        cwd=os.getcwd(),
        env=env,
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave)

    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    sent_prompt = False
    sent_exit = False
    prompt_sent_at = 0.0
    last_output_at = time.time()
    transcript = ""

    try:
        while True:
            if child.poll() is not None:
                break

            readable, _, _ = select.select([master], [], [], 0.25)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except BlockingIOError:
                    chunk = b""
                except OSError:
                    break
                if chunk:
                    text = chunk.decode("utf-8", errors="replace")
                    transcript += text
                    last_output_at = time.time()
                    sys.stdout.write(text)
                    sys.stdout.flush()

            elapsed = time.time() - start
            if not sent_prompt and elapsed >= 4:
                os.write(master, (PROMPT + "\r").encode())
                sent_prompt = True
                prompt_sent_at = time.time()
                print(f"\n[{now()}] sent_prompt={PROMPT!r}")
                sys.stdout.flush()

            if sent_prompt and not sent_exit:
                waited = time.time() - prompt_sent_at
                quiet = time.time() - last_output_at
                saw_answer = "hello" in redact_ansi(transcript).lower()
                if waited >= MIN_SECONDS_AFTER_PROMPT and (saw_answer or quiet >= 8):
                    os.write(master, b"/exit\r")
                    sent_exit = True
                    print(f"\n[{now()}] sent_exit_command")
                    sys.stdout.flush()

            if sent_prompt and not sent_exit and time.time() - prompt_sent_at >= TIMEOUT_SECONDS - 15:
                os.write(master, b"\x03")
                sent_exit = True
                print(f"\n[{now()}] sent_ctrl_c_timeout")
                sys.stdout.flush()

            if time.time() - start >= TIMEOUT_SECONDS:
                os.killpg(child.pid, signal.SIGTERM)
                print(f"\n[{now()}] killed_timeout")
                sys.stdout.flush()
                break

        try:
            returncode = child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            returncode = child.wait(timeout=5)
    finally:
        try:
            os.close(master)
        except OSError:
            pass

    after = jsonl_files()
    new_or_changed = [
        path
        for path, marker in after.items()
        if path not in before or before[path] != marker
    ]
    new_or_changed.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)

    print(f"\n[{now()}] returncode={returncode}")
    print(f"[{now()}] after_jsonl_count={len(after)}")
    print(f"[{now()}] new_or_changed_jsonl_count={len(new_or_changed)}")
    for path in new_or_changed:
        stat = path.stat()
        print(f"JSONL {stat.st_size} bytes {dt.datetime.fromtimestamp(stat.st_mtime, dt.UTC).isoformat()} {path}")
        for line in read_lines(path):
            print(f"  {line}")

    output_path = pathlib.Path("spikes/interactive-jsonl-runtime-test.log")
    output_path.write_text(redact_ansi(transcript), encoding="utf-8")
    print(f"[{now()}] raw_tty_log={output_path.resolve()}")

    return 0 if new_or_changed else 2


if __name__ == "__main__":
    raise SystemExit(main())
