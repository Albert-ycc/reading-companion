#!/usr/bin/env python3
"""UserPromptSubmit hook：把阅读器同步的「在读哪本、第几页、最近划线及前后文」注入本轮提问，
同时暂存本轮提问，交给 Stop hook 配上回答写进日志。

阅读状态的来源：服务为本次提问写的快照（环境变量 READER_CONTEXT 指向它）；
READER_CONTEXT=none 表示这次提问没有可靠的阅读上下文（没开书、或页面给的书对不上），不注入书的内容；
没有这个变量（旧页面）才读全局的 current.json。"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[2])
DATA = Path(os.environ.get("READER_DATA") or ROOT / "data")  # 伴读服务会传过来；沙盒实例时指向沙盒目录
STALE_HOURS = 6  # 阅读器超过这么久没动静，视为没在读，不注入


def parse(ts):
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S%z")


def s(v):
    # 状态文件里的字段类型不可信：不是文字一律当没有；落单代理项这类写不进文件的字符换掉
    return v.encode("utf-8", "replace").decode("utf-8") if isinstance(v, str) else ""


def d(v):
    return v if isinstance(v, dict) else {}


def exists(p):
    try:
        return bool(p) and Path(p).exists()
    except (OSError, ValueError):
        return False


def minutes_ago(now, ts):
    try:
        return int((now - parse(ts)).total_seconds() // 60)
    except (TypeError, ValueError):
        return "?"


def pnum(v):
    return v if type(v) is int else None


def reading_line(st, page, page_to=None):
    """「正在读」那一行：书名、页码、总页数缺哪个就不写哪个，别把字面的 None 写进 Claude 的上下文。
    page_to 有值时是双页阅读，页码写成「23–24」"""
    title, total = s(st.get("title")).strip(), pnum(st.get("numPages"))
    out = "正在读："
    if title:
        out += f"《{title}》"
    if page is not None:
        pages = f"{page}–{page_to}" if page_to else f"{page}"
        out += f"第 {pages} / {total} 页" if total is not None else f"第 {pages} 页"
    elif total is not None:
        out += f"共 {total} 页"
    file = s(st.get("file"))
    return out + (f"（文件：{file}）" if file else "")


def load_state():
    ctx = os.environ.get("READER_CONTEXT")
    if ctx == "none":
        return None
    try:
        st = json.loads((Path(ctx) if ctx else DATA / "current.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return st if isinstance(st, dict) else None


def is_fresh(st, now):
    try:
        return (now - parse(st["updatedAt"])).total_seconds() <= STALE_HOURS * 3600
    except (KeyError, TypeError, ValueError):
        return False


def build_lines(st, now):
    page = pnum(st.get("page"))
    page_to = pnum(st.get("pageTo"))
    spread = page is not None and page_to is not None and page_to > page  # 双页阅读：左页 page、右页 page_to 并排在眼前
    shown = [page, page_to] if spread else [page]  # 眼前的页
    sel = d(st.get("selection"))
    sel_page = pnum(sel.get("page"))
    on_screen = sel_page is not None and sel_page in shown  # 划线、框选所在页还在眼前
    at_page = f"第 {sel_page} 页" if sel_page is not None else "某一页"  # 划线、框选所在页
    now_page = f"第 {page}、{page_to} 页" if spread else f"第 {page} 页"  # 只在页码已知时用（见下面的判断）
    imgs = {}  # 页码 -> 这一页扫描原图的路径，只收眼前的页
    for field in ("pageImage", "pageImage2"):
        img = d(st.get(field))
        path = s(img.get("path"))
        if img.get("page") in shown and img.get("page") is not None and img.get("page") not in imgs and exists(path):
            imgs[img.get("page")] = path

    def ocr_note(pages):
        note = ("扫描版，下面是识别出的文字，个别字可能认错（实测出现过 μg 认成 pg、「穿入」认成「穿人」）；"
                "涉及数字、单位、公式、表格或拿不准的字，用 Read 看原图核对，以原图为准")
        paths = [(p, imgs[p]) for p in pages if p in imgs]
        if not paths:
            return f"（{note}）"
        if len(paths) == 1 and not spread:
            return f"（{note}：{paths[0][1]}）"
        return f"（{note}：" + "；".join(f"第 {p} 页 {path}" for p, path in paths) + "）"

    lines = [
        "【伴读上下文】由阅读器自动同步，不是用户输入。用户说「这句 / 这段 / 这里」时指的就是下面的内容。",
        reading_line(st, page, page_to if spread else None),
    ]
    if spread:
        lines.append(f"（双页阅读：左页第 {page} 页、右页第 {page_to} 页同时摊在用户眼前。"
                     "用户说「这页」没指明哪边时两页都要考虑，引用原文标明页码）")
    is_region = sel.get("kind") == "region"
    has_text = bool(s(sel.get("text")))
    if is_region:
        lines.append(f"最近一次框选：{at_page}，{minutes_ago(now, s(sel.get('at')))} 分钟前")
        if page is not None and sel_page is not None and not on_screen:
            lines.append(f"（框选之后用户翻到了{now_page}；问题明显指当前页时以当前页为准）")
        region_img = s(sel.get("image"))
        if exists(region_img):
            lines.append(f"用户框选了{at_page}的一块区域（可能是图、表、公式）：图像在 {region_img}，"
                         "回答前先用 Read 工具看图，以图为准。")
        else:
            lines.append(f"用户框选了{at_page}的一块区域，但这张图已经找不到了；按下面的文字回答，并告诉用户可以重新框一次。")
        lines += [
            ("区域里的文字（扫描版识别结果，个别字可能认错，以图为准）：" if sel.get("ocr")
             else "区域里的文字（来自页面文字层，可能不全；没有文字多半是图）："),
            s(sel.get("regionText")).strip() or "（无）",
            "附近的文字，前文：", s(sel.get("before")).strip() or "（无）",
            "附近的文字，后文：", s(sel.get("after")).strip() or "（无）",
        ]
    elif has_text:
        lines.append(f"最近一次划线：{at_page}，{minutes_ago(now, s(sel.get('at')))} 分钟前")
        if page is not None and sel_page is not None and not on_screen:
            lines.append(f"（划线之后用户翻到了{now_page}；问题明显指当前页时以当前页为准）")
        if sel.get("ocr"):
            lines.append(ocr_note([sel_page]))
        lines += [
            "划线原文：", f"「{s(sel.get('text'))}」",
            "前文：", s(sel.get("before")).strip() or "（无）",
            "后文：", s(sel.get("after")).strip() or "（无）",
        ]
    if not (is_region or has_text) or not on_screen:
        page_text = s(st.get("pageText")).strip()
        where = f"当前{now_page}" if page is not None else "当前页"
        if page_text:
            label = f"{where}正文（截取，按【第 N 页】分段）" if spread else f"{where}正文（截取）"
            lines += [label + (ocr_note(shown) if st.get("ocr") else "") + "：", page_text]
        elif imgs:
            lines.append(f"{where}是扫描版，没识别出文字。画面：" + "；".join(f"第 {p} 页 {path}" for p, path in imgs.items())
                         + "。回答前先用 Read 工具看图，按图里的原文来讲。")
        elif not (is_region or has_text):
            lines.append("当前页提取不到文字（可能是扫描版），需要时请用户截图或描述。")
    return lines


def main():
    try:
        inp = json.load(sys.stdin)
    except ValueError:
        inp = None
    prompt = s(d(inp).get("prompt"))
    now = datetime.now().astimezone()
    st = load_state()
    lines = None
    if st is not None and is_fresh(st, now):
        try:
            lines = build_lines(st, now)
        except Exception:  # noqa: BLE001 字段对不上就不注入，提问和日志照常
            lines = None
    # 没有可注入的阅读上下文时也留一份只含提问的 pending，Stop hook 照常记日志
    shown = st if lines else {}
    page = shown.get("page") if type(shown.get("page")) is int else None
    (DATA / "pending.json").write_text(json.dumps({
        "prompt": prompt,
        "at": now.isoformat(timespec="seconds"),
        "title": s(shown.get("title")) or None,
        "page": page,
        "selection": s(d(shown.get("selection")).get("text")),
    }, ensure_ascii=False), "utf-8")

    if lines:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n".join(lines),
        }}, ensure_ascii=False))


if __name__ == "__main__":
    main()
