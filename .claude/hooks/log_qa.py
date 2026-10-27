#!/usr/bin/env python3
"""Stop hook：把本轮「在读位置 + 划线 + 提问 + 回答」追加到 data/log/日期.md，作为之后提炼学习档案的原料；
同时往 data/qa-index.json 追加一条，供 UserPromptSubmit hook 在别的书里找「你问过」的话（跨书记忆）。

qa-index.json：一个 JSON 数组，一条一行（Grep 按行出结果）。每条
{ file, title, page, question, answer_excerpt(300 字), selection(200 字), at }。
没开书的提问不进索引（没有书可对）。索引不存在或坏了，从 log/*.md 回填重建。"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[2])
DATA = Path(os.environ.get("READER_DATA") or ROOT / "data")  # 伴读服务会传过来；沙盒实例时指向沙盒目录
INDEX = DATA / "qa-index.json"
INDEX_CAP = 5000  # 索引最多留这么多条，超了先丢旧的；完整原文都在 log/*.md
QUESTION_CHARS, EXCERPT_CHARS, SELECTION_CHARS = 400, 300, 200
ATTACH_NOTE = re.compile(r"\n*（用户附了图片，回答前先用 Read 工具看图：[^）]*）\s*$")  # 服务在问题后补的一句，不是用户说的话


def s(v):
    return v.encode("utf-8", "replace").decode("utf-8") if isinstance(v, str) else ""


def demote(text):
    """回答和提问里自带的 Markdown 标题降到三级以下：日志按行首的 `## ` 切条目，同级标题会把一条问答切成几段。
    代码块里行首的 # 也一并降级，因为切条目的一方不认代码块"""
    return re.sub(r"^( {0,3})(#{1,6})(?=\s|$)", lambda m: m.group(1) + "#" * min(len(m.group(2)) + 2, 6), text, flags=re.M)


def clip(v, n):
    """压成一行、截到 n 字"""
    return " ".join(s(v).split())[:n]


def entry_of(file, title, page, question, answer, selection, at):
    title = clip(title, 200)
    if not title:
        return None  # 没开书
    return {
        "file": clip(file, 500), "title": title, "page": page if type(page) is int else None,
        "question": clip(ATTACH_NOTE.sub("", s(question)), QUESTION_CHARS),
        "answer_excerpt": clip(answer, EXCERPT_CHARS), "selection": clip(selection, SELECTION_CHARS), "at": s(at),
    }


# ---------- 索引读写 ----------
def quarantine():
    """坏索引改名成 .corrupt-<时间> 再重建：hook 里没有服务的 ctx，自己 rename（和 server.py 的 _quarantine 同一个后缀格式），
    不然重建会把它无声覆盖掉。服务的 /api/ping 会把数据目录顶层这个时间之后出现的 .corrupt-* 带给页面提示读者"""
    stamp = datetime.now().strftime("%y%m%d-%H%M%S")
    bad, n = INDEX.with_name(f"{INDEX.name}.corrupt-{stamp}"), 1
    while bad.exists():  # 同一秒里留底两次：别把前一份覆盖了
        n += 1
        bad = INDEX.with_name(f"{INDEX.name}.corrupt-{stamp}-{n}")
    try:
        os.replace(INDEX, bad)
    except OSError:
        pass


def load_index():
    """返回条目列表；文件不存在返回 None（调用方重建）；语法坏了、形状不对（不是数组）先改名留底再返回 None"""
    try:
        text = INDEX.read_text("utf-8")
    except FileNotFoundError:
        return None
    except UnicodeDecodeError:
        quarantine()
        return None
    except OSError:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        quarantine()
        return None
    if not isinstance(data, list):
        quarantine()
        return None
    return [e for e in data if isinstance(e, dict)]


def write_index(entries):
    """一条一行写成 JSON 数组；临时文件 + 改名，读的一方不会读到半截"""
    entries = entries[-INDEX_CAP:]
    body = "[\n" + ",\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n]\n"
    tmp = INDEX.with_name(f"{INDEX.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(body, "utf-8", errors="replace")
        os.replace(tmp, INDEX)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


HEAD = re.compile(r"^## (\d{2}:\d{2})　(.*)$")
WHERE = re.compile(r"^《(.*)》(?:第 (\d+) 页)?$")
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SPLIT_QA = "\n\n**答**：\n\n"


def title_to_file():
    """回填时日志里只有书名：靠阅读进度、划线、对话三份数据里的书名和文件对上，对不上 file 留空"""
    out = {}
    try:
        prog = json.loads((DATA / "progress.json").read_text("utf-8"))
    except (OSError, ValueError):
        prog = {}
    if isinstance(prog, dict):
        for file, rec in prog.items():
            t = clip(rec.get("title"), 200) if isinstance(rec, dict) else ""
            if t:
                out.setdefault(t, file)
    return out


def backfill():
    """从 log/*.md 重建全部条目（按文件名即日期顺序）"""
    files = title_to_file()
    entries = []
    for f in sorted((DATA / "log").glob("*.md")):
        if not DAY.match(f.stem):
            continue
        try:
            text = f.read_text("utf-8", errors="replace")
        except OSError:
            continue
        blocks, cur = [], None
        for line in text.split("\n"):
            m = HEAD.match(line)
            if m:
                cur = [m.group(1), m.group(2).strip(), []]
                blocks.append(cur)
            elif cur is not None:
                cur[2].append(line)
        for hhmm, where, body in blocks:
            w = WHERE.match(where)
            if not w:
                continue  # （没开书）
            body = "\n".join(body)
            qa_at = body.find("**问**：")
            if qa_at < 0:
                continue
            head, rest = body[:qa_at], body[qa_at + len("**问**："):]
            question, _, answer = rest.partition(SPLIT_QA)
            selection = "\n".join(ln[2:] if ln.startswith("> ") else ln[1:] for ln in head.split("\n") if ln.startswith(">"))
            title = w.group(1)
            e = entry_of(files.get(clip(title, 200), ""), title, int(w.group(2)) if w.group(2) else None,
                         question, answer, selection, f"{f.stem}T{hhmm}:00")
            if e and e["question"]:
                entries.append(e)
    return entries


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
    try:
        entries = load_index()
        rebuilt = entries is None
        if rebuilt:
            entries = backfill()  # 第一次跑或文件坏了：先按现有日志回填（这一轮还没写进日志），再把这一轮追加上去
    except Exception:  # noqa: BLE001 索引是附带的：出错就跳过它，日志和 pending 的收尾照常
        entries, rebuilt = None, False

    at = s(p.get("at"))
    if not re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", at):
        at = datetime.now().astimezone().isoformat(timespec="seconds")
    day, hhmm = at[:10], at[11:16]
    title, page = " ".join(s(p.get("title")).split()), p.get("page") if type(p.get("page")) is int else None  # 书名里的换行会把标题行切断
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
    entry = entry_of(p.get("file"), title, page, p.get("prompt"), answer, selection, at)
    if entries is not None and (entry or rebuilt):
        try:
            write_index(entries + [entry] if entry else entries)
        except Exception:  # noqa: BLE001
            pass
    pending_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
