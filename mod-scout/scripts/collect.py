#!/usr/bin/env python3
"""Mod 探勘：從本機 ~/.claude/projects/ 的對話紀錄抽出使用者親手打的訊息。

輸出 JSON 到 stdout：
{"sessions": [{"id", "title", "project", "start", "messages": [{"at", "text"}]}],
 "inventory": {"hooks": [...], "pluginDirs": [...], "skills": [...]}}
金鑰、token 一律先遮蔽，原文不會離開這支程式。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SECRET = re.compile(
    r"(sk-[A-Za-z0-9_\-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[abprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}"
    r"|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
    r"|(?i:bearer)\s+[A-Za-z0-9._\-]{16,}"
    r"|(?i:(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+"
    r"|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2})"
)
# 系統塞進對話的內容，不是使用者打的
NOISE = ("<command-", "<local-command", "<system-reminder", "<task-notification", "Caveat:",
         "[Request interrupted", "This is how Claude Code surfaces", "<bash-")
REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
MAX_CHARS = 500


def redact(text: str) -> str:
    return SECRET.sub("<已遮蔽>", text)


def human_text(entry: dict) -> str | None:
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    else:
        return None
    text = REMINDER.sub("", text).strip()
    if not text or text.startswith(NOISE):
        return None
    return redact(text)[:MAX_CHARS]


def read_session(path: Path) -> dict | None:
    messages, title, project, start = [], "", "", ""
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") in ("custom-title", "summary"):
                    title = entry.get("customTitle") or entry.get("summary") or title
                project = project or entry.get("cwd") or ""
                at = entry.get("timestamp") or ""
                start = start or at
                text = human_text(entry)
                if text:
                    messages.append({"at": at[:16], "text": text})
    except OSError:
        return None
    if not messages:
        return None
    return {"id": path.stem, "title": title, "project": project, "start": start[:16], "messages": messages}


def inventory(home: Path) -> dict:
    hooks, dirs, skills = [], [], []
    for settings in (home / ".claude/settings.json", home / ".claude/settings.local.json"):
        try:
            data = json.loads(settings.read_text())
        except (OSError, ValueError):
            continue
        hooks += sorted((data.get("hooks") or {}).keys())
        env = data.get("env") or {}
        dirs += [d for d in str(env.get("CLAUDE_CODE_PLUGIN_DIRS", "")).split(os.pathsep) if d]
        dirs += [k for k, v in (data.get("enabledPlugins") or {}).items() if v]
    for root in (home / ".claude/skills",):
        if root.is_dir():
            skills += sorted(p.name for p in root.iterdir() if p.is_dir())
    return {"hooks": sorted(set(hooks)), "pluginDirs": dirs, "skills": skills}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--exclude", default="")
    args = parser.parse_args()
    home = Path.home()
    projects = home / ".claude/projects"
    files = sorted(projects.glob("*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True) if projects.is_dir() else []
    sessions = []
    for path in files:
        if args.exclude and path.stem == args.exclude:
            continue
        session = read_session(path)
        if session:
            sessions.append(session)
        if len(sessions) >= args.limit:
            break
    json.dump({"sessions": sessions, "inventory": inventory(home)}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
