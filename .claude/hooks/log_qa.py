#!/usr/bin/env python3
"""Stop hook：把本轮「在读位置 + 划线 + 提问 + 回答」追加到 data/log/日期.md，作为之后提炼学习档案的原料。"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[2])
DATA = Path(os.environ.get("READER_DATA") or ROOT / "data")  # 伴读服务会传过来；沙盒实例时指向沙盒目录


def s(v):
    return v.encode("utf-8", "replace").decode("utf-8") if isinstance(v, str) else ""


def demote(text):
    """回答和提问里自带的 Markdown 标题降到三级以下：日志按行首的 `## ` 切条目，同级标题会把一条问答切成几段。
    代码块里行首的 # 也一并降级，因为切条目的一方不认代码块"""
    return re.sub(r"^( {0,3})(#{1,6})(?=\s|$)", lambda m: m.group(1) + "#" * min(len(m.group(2)) + 2, 6), text, flags=re.M)


def main():
    try:
        inp = json.load(sys.stdin)
    except ValueError:
        inp = None
    inp = inp if isinstance(inp, dict) else {}
    pending_path = DATA / "pending.json"
    if inp.get("stop_hook_active") or not pending_path.exists():
        return
    try:
        p = json.loads(pending_path.read_text("utf-8"))
    except (OSError, ValueError):
        p = None
    p = p if isinstance(p, dict) else {}  # pending 坏了也记这一轮的回答，别让它卡住之后每一轮
    answer = s(inp.get("last_assistant_message")).strip() or "（未取到回答）"

    at = s(p.get("at"))
    if not re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", at):
        at = datetime.now().astimezone().isoformat(timespec="seconds")
    day, hhmm = at[:10], at[11:16]
    title, page = s(p.get("title")), p.get("page") if type(p.get("page")) is int else None
    where = f"《{title}》" + (f"第 {page} 页" if page else "") if title else "（没开书）"
    log = DATA / "log" / f"{day}.md"
    log.parent.mkdir(parents=True, exist_ok=True)
    parts = [] if log.exists() else [f"# 伴读日志 {day}\n"]
    parts.append(f"\n## {hhmm}　{where}\n")
    selection = s(p.get("selection"))
    if selection:
        parts.append("\n" + "\n".join("> " + ln for ln in selection.splitlines()) + "\n")
    parts.append(f"\n**问**：{demote(s(p.get('prompt')).strip())}\n\n**答**：\n\n{demote(answer)}\n")
    with log.open("a", encoding="utf-8") as f:
        f.write("".join(parts))
    pending_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
