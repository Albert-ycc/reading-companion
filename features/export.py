"""导出成读书笔记：把一本书上留下的东西整理成一份 Markdown，每一条都带页码。

GET /api/export?file=<书>[&title=<页面上的书名>]  → { filename, markdown, empty, counts, warnings }
    empty     没有任何划线、问答、导图、概念、小问题、勘误（页面据此提示「没什么可导出的」，不存空文件）
    warnings  哪几节没能读出来（数据文件结构不对之类）

服务写不了外置盘（launchd 起的进程会被 TCC 拦），所以这里只出文字，存文件由页面用 File System Access API 做（web/export.js）。

结构（没有内容的节不写）：
    # 《书名》读书笔记 / 导出行 / 划线与眉批（按页）/ 问答（按划线分组）/ 导图 / 概念 / 小问题 / 勘误

数据来源：划线 ctx.HIGHLIGHTS，对话 ctx.CHATS + ctx.archive_path(书)，导图 DATA/mindmap/<书hash>/*.json（格式见 features/mindmap.py 开头），
概念 ctx.LEARNER 的「概念掌握」表，小问题 DATA/quiz.json，勘误 DATA/errata.json。后两个文件是别的模块写的，没有就跳过。

写进 Markdown 的文字分三种处理：划线、眉批、问题、导图、概念这类读者或书里的原话，压成一行或整行转义，
不让里面的 # > - ``` 之类撑出标题、列表或代码块；Claude 的回答原样放进去，只把标题降三级、没关的代码围栏补上。
"""
import re
import sys
import time
import traceback
import unicodedata

MAX_TITLE = 300
FILENAME_CHARS = 40
HEADING_LEVELS_DOWN = 3     # 回答里的 # 降到 ####：本文最深的结构标题是 ###（一组划线），回答的标题必须在它下面

CJK = "㐀-鿿"
CJK_SPACE = re.compile(rf"([{CJK}，。、；：！？）」])\s+(?=[{CJK}（「])")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
HTML_START = re.compile(r"<(?=[A-Za-z/!?])")
# 一行开头会被 Markdown 当成结构的写法：标题、引用、列表、围栏、分隔线、表格
LINE_LEAD = re.compile(r"^(#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$)|`{3,}|~{3,}|={2,}\s*$|-{2,}\s*$|\|)")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
ATX = re.compile(r"^( {0,3})(#{1,6})(\s.*|)$")
AUTO_MARK = re.compile(r"\s*[·・]\s*自动\s*\d{4}-\d{2}-\d{2}\s*$")
SOURCE_CELL = re.compile(r"^(.*?)\s*[·・]\s*第\s*(\d+)\s*页\s*$")

QUIZ_STATUS = {"open": "还没答", "right": "答对了", "half": "答对一半", "wrong": "答错了"}


# ---------- 取值：数据文件是别的模块写的，结构不对就当没有，不抛错 ----------
def as_dict(v):
    return v if isinstance(v, dict) else {}


def as_list(v):
    return v if isinstance(v, list) else []


def string(v):
    return v if isinstance(v, str) else ""


def page_of(v):
    return v if type(v) is int and v > 0 else None


# ---------- 文字处理 ----------
def clip(text, n):
    return text if len(text) <= n else text[:n].rstrip() + "…"


def one_line(text, pdf=False):
    """压成一行：换行和连续空白变一个空格；<tag 这类会被当成 HTML 的前面加转义。
    pdf=True 是从书页上选下来的原文：PDF 换行在中文之间留下的空白也去掉（和页面里的 tidyText 一样）"""
    t = re.sub(r"\s+", " ", CONTROL.sub("", string(text)))
    if pdf:
        t = CJK_SPACE.sub(r"\1", t)
    return HTML_START.sub(r"\\<", t.strip())


def soft_lines(text):
    """保留换行的文字（读者写的问题）：每行去掉缩进，行首会被当成结构的写法前面加反斜杠"""
    out = []
    for i, ln in enumerate(CONTROL.sub("", string(text)).replace("\r\n", "\n").replace("\r", "\n").split("\n")):
        ln = HTML_START.sub(r"\\<", ln.strip())
        if i and LINE_LEAD.match(ln):
            ln = re.sub(r"^(\d{1,9})([.)])", r"\1\\\2", ln) if ln[0].isdigit() else "\\" + ln
        out.append(ln)
    return "\n".join(out).strip()


def quote_lines(text, indent="  "):
    """眉批这类多行文字：每一行都放进引用块，里面写 # 或空行也撑不出引用块以外的结构"""
    body = HTML_START.sub(r"\\<", CONTROL.sub("", string(text)).replace("\r\n", "\n").replace("\r", "\n"))
    return [f"{indent}> {ln.strip()}".rstrip() for ln in body.strip().split("\n")]


def demote_headings(answer):
    """回答原样放进去，只做两件事：围栏之外的标题降级；回答被截断、围栏没关时补上关闭，免得后面整份文档都成了代码块"""
    out, fence = [], None
    for ln in answer.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        m = FENCE.match(ln)
        if m and fence is None and m.group(1)[0] == "`" and "`" in m.group(2):
            m = None     # 「```a```」这种行内写法，反引号围栏的说明文字里不许有反引号，不算围栏
        if m:
            mark = m.group(1)
            if fence is None:
                fence = mark
            elif mark[0] == fence[0] and len(mark) >= len(fence) and not m.group(2).strip():
                fence = None
            out.append(ln)
            continue
        if fence is None:
            h = ATX.match(ln)
            if h:
                ln = f"{h.group(1)}{'#' * min(6, len(h.group(2)) + HEADING_LEVELS_DOWN)}{h.group(3)}"
        out.append(ln)
    if fence is not None:
        out.append(fence)
    return "\n".join(out).strip()


def tidy_title(t):
    """和书架上显示的书名同一个做法：「书名 -- 作者 -- 出版社」只留书名，下划线当空格"""
    return re.sub(r"\s+", " ", re.sub(r"_+", " ", string(t).split(" -- ")[0])).strip()


def file_stem(title):
    t = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]+', " ", title)
    t = re.sub(r"\s+", " ", t).strip(" .")
    t = t[:FILENAME_CHARS].rstrip(" .‍️")   # 按字符截，别把一个 emoji 劈成半个
    return t or "读书笔记"


def norm(s):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", string(s))).lower()


def page_tag(page, sep="："):
    return f"第 {page} 页{sep}" if page else ""


# ---------- 各节 ----------
def highlights_section(hls):
    """hls: [(page, at, 序号, 划线对象)]，已按页排好 → (行, 划线条数, 眉批条数)"""
    lines, notes = [], 0
    for page, _, _, h in hls:
        text = one_line(h["text"], pdf=True)
        if h.get("kind") == "region":
            text = re.sub(r"^第\s*\d+\s*页", "", text)
        lines.append(f"- 第 {page} 页：「{text}」")
        note = string(h.get("note")).strip()
        if note:
            notes += 1
            lines.extend(quote_lines(note))
    return lines, len(hls), notes


def collect_turns(ctx, file):
    """当前对话和收进历史的对话里的每一问一答：[{q, a, quote, page, at, interrupted, att}]"""
    lists = [as_list(as_dict(as_dict(ctx.read_json(ctx.CHATS, {})).get(file)).get("messages"))]
    for conv in as_list(ctx.read_json(ctx.archive_path(file), [])):
        lists.append(as_list(as_dict(conv).get("messages")))
    turns = []
    for msgs in lists:
        i = 0
        while i < len(msgs):
            m = as_dict(msgs[i])
            i += 1
            if m.get("role") != "user":
                continue
            nxt = as_dict(msgs[i]) if i < len(msgs) else {}
            ans = nxt if nxt.get("role") == "assistant" else None
            if ans is not None:
                i += 1
            q = string(m.get("text")).strip()
            a = string(ans.get("text")).strip() if ans else ""
            if not q and not a:
                continue
            quote = as_dict(m.get("quote"))
            turns.append({
                "q": q, "a": a, "at": string(m.get("at")),
                "page": page_of(quote.get("page")) or page_of(m.get("page")),
                "quote": quote if string(quote.get("text")).strip() else None,
                "interrupted": bool(ans and ans.get("interrupted")),
                "att": len([x for x in as_list(m.get("attachments")) if isinstance(x, dict)]),
            })
    return turns


def qa_section(turns):
    groups = {}   # 键 -> {page, at, title, turns}
    for t in turns:
        quote = t["quote"]
        if quote:
            page = page_of(quote.get("page")) or t["page"]
            key = ("hl", quote["hl"]) if isinstance(quote.get("hl"), str) and quote["hl"] else ("q", page, string(quote["text"]))
            text = one_line(quote["text"], pdf=True)
            if quote.get("kind") == "region":
                text = re.sub(r"^第\s*\d+\s*页", "", text)
            title = f"{page_tag(page, '')}「{clip(text, 50)}」".strip()
        else:
            page = t["page"]
            key = ("p", page)
            title = (f"第 {page} 页" if page else "页码没记下来") + " · 直接提问"
        g = groups.setdefault(key, {"page": page, "at": t["at"], "title": title, "turns": []})
        g["at"] = min(g["at"], t["at"]) if g["at"] and t["at"] else (g["at"] or t["at"])
        g["turns"].append(t)
    lines = []
    for g in sorted(groups.values(), key=lambda g: (g["page"] is None, g["page"] or 0, g["at"])):
        lines += [f"### {g['title']}", ""]
        for t in sorted(g["turns"], key=lambda t: t["at"]):
            att = f"（附图 {t['att']} 张）" if t["att"] else ""
            lines += [f"**问**：{soft_lines(t['q']) or '（只发了图）'}{att}", ""]
            if t["a"]:
                lines += ["**答**：", "", demote_headings(t["a"])]
                if t["interrupted"]:
                    lines += ["", "*（这条回答没答完）*"]
            else:
                lines += ["**答**：（没有记下回答）"]
            lines += [""]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def mindmap_section(ctx, file):
    d = ctx.DATA / "mindmap" / ctx.book_hash(file)
    maps = []
    for f in sorted(d.glob("*.json")) if d.is_dir() else []:
        if f.name.endswith((".prev.json", ".results.json", ".issued.json")):
            continue
        m = as_dict(ctx.read_json(f, None))
        root = as_dict(m.get("root"))
        if not root:
            continue
        pages = as_list(as_dict(m.get("scope")).get("pages"))
        maps.append((page_of(pages[0]) if pages else None, f.name, m, root))
    maps.sort(key=lambda t: (t[0] is None, t[0] or 0, t[1]))
    blocks = []
    for _, _, m, root in maps:
        lines, filled, seen = [], False, 0
        stack = [(c, 0) for c in reversed(as_list(root.get("children")))]
        while stack and seen < 3000:      # 导图存盘时服务端限过 1200 个节点；这里再设一道，坏数据不会拖死导出
            n, depth = stack.pop()
            n = as_dict(n)
            seen += 1
            topic = one_line(n.get("topic"))
            if topic and depth <= 8:
                page = page_of(n.get("page"))
                lines.append(f"{'  ' * depth}- {topic}" + (f"（第 {page} 页）" if page else ""))
                if n.get("src") in ("claude", "user") and not n.get("skel"):
                    filled = True
            stack.extend((c, depth + 1) for c in reversed(as_list(n.get("children"))))
        if lines and filled:     # 只有书签骨架、没人往里填过要点的导图，不算读书笔记
            scope = as_dict(m.get("scope"))
            blocks.append((one_line(scope.get("title") or root.get("topic") or scope.get("id")), lines))
    out = []
    for title, lines in blocks:
        if len(blocks) > 1:
            out += [f"### {title or '导图'}", ""]
        out += lines + [""]
    while out and out[-1] == "":
        out.pop()
    return out


def split_cells(line):
    cells = re.split(r"(?<!\\)\|", line.strip())
    if cells and cells[0].strip() == "":
        cells = cells[1:]
    if cells and cells[-1].strip() == "":
        cells = cells[:-1]
    return [c.replace("\\|", "|").strip() for c in cells]


def concept_rows(learner_text):
    """学习者档案「## 概念掌握」下的表格行 → [(概念, 状态, 来源, 备注)]"""
    rows, on = [], False
    for line in learner_text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            on = s.lstrip("#").strip().startswith("概念掌握")
            continue
        if not on or not s.startswith("|"):
            continue
        cells = split_cells(s)
        if len(cells) < 3 or not any(c for c in cells):
            continue
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c) or cells[0] == "概念":
            continue
        rows.append((cells[0], cells[1], cells[2], cells[3] if len(cells) > 3 else ""))
    return rows


def concepts_section(ctx, title):
    try:
        text = ctx.LEARNER.read_text("utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    raw = string(title).split(" -- ")[0]
    # 自动回写的行写的是「书名 -- 作者」截掉作者、再截 30 字的那一段；手写的行可能写全名，也认
    mine = {norm(raw), norm(raw[:30]), norm(tidy_title(title)), norm(tidy_title(title)[:30]), norm(title), norm(tidy_title(string(title)))} - {""}
    found = []
    for name, status, source, note in concept_rows(text):
        m = SOURCE_CELL.match(source)
        book, page = (m.group(1), int(m.group(2))) if m else (source, None)
        if not name or norm(book) not in mine:
            continue
        found.append((page is None, page or 0, name, status, page, note))
    lines = []
    for _, _, name, status, page, note in sorted(found, key=lambda t: t[:3]):
        inner = "，".join(x for x in (one_line(status), f"第 {page} 页" if page else "") if x)
        note = one_line(AUTO_MARK.sub("", note))
        lines.append(f"- **{one_line(name)}**" + (f"（{inner}）" if inner else "") + (f"：{note}" if note else ""))
    return lines


def quiz_section(ctx, file):
    items = [as_dict(x) for x in as_list(as_dict(ctx.read_json(ctx.DATA / "quiz.json", {})).get(file))]
    items = [x for x in items if string(x.get("question")).strip() and x.get("status") != "dismissed"]
    items.sort(key=lambda x: (page_of(x.get("page")) is None, page_of(x.get("page")) or 0, string(x.get("asked_at"))))
    lines = []
    for x in items:
        status = QUIZ_STATUS.get(x.get("status"), "")
        lines.append(f"- {page_tag(page_of(x.get('page')))}{one_line(x['question'])}" + (f"（{status}）" if status else ""))
        for label, key in (("我的回答", "answer"), ("反馈", "feedback")):
            if string(x.get(key)).strip():
                if lines[-1].lstrip().startswith(">"):
                    lines.append("  >")      # 两段话之间空一行，不然引用块里连成一段
                lines.extend(quote_lines(f"{label}：{one_line(x[key])}"))
    return lines


def errata_section(ctx, file):
    items = [as_dict(x) for x in as_list(as_dict(ctx.read_json(ctx.DATA / "errata.json", {})).get(file))]
    items = [x for x in items if string(x.get("original")).strip() or string(x.get("correction")).strip()]
    items.sort(key=lambda x: (page_of(x.get("page")) is None, page_of(x.get("page")) or 0, string(x.get("at"))))
    lines = []
    for x in items:
        kind = one_line(x.get("kind"))
        why = one_line(x.get("why"))
        lines.append(f"- {page_tag(page_of(x.get('page')), '')}" + (f"（{kind}）" if kind else "") + "："
                     + f"「{clip(one_line(x.get('original')), 200)}」→「{clip(one_line(x.get('correction')), 200)}」"
                     + (f"——{why}" if why else ""))
    return lines


# ---------- 总装 ----------
def build(ctx, file, page_title=""):
    prog = as_dict(as_dict(ctx.read_json(ctx.PROGRESS, {})).get(file))
    title = tidy_title(page_title) or tidy_title(prog.get("title")) or tidy_title(ctx.title_of(file)) or "未命名"
    raw_title = string(page_title) or string(prog.get("title")) or string(ctx.title_of(file))

    hls = []
    for i, h in enumerate(as_list(as_dict(ctx.read_json(ctx.HIGHLIGHTS, {})).get(file))):
        if isinstance(h, dict) and string(h.get("text")).strip() and page_of(h.get("page")):
            hls.append((h["page"], string(h.get("at")), i, h))
    hls.sort(key=lambda t: t[:3])

    sections, warnings, counts = [], [], {}

    def add(name, heading, make):
        try:
            lines = make()
        except Exception:     # noqa: BLE001 一节读坏了不拖累别的节，页面会提示是哪一节
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
            warnings.append(name)
            return
        if lines:
            sections.append((heading, lines))

    notes = [0]

    def make_highlights():
        lines, n, notes[0] = highlights_section(hls)
        counts["highlights"] = n
        return lines
    add("划线", "划线与眉批（按页）", make_highlights)
    counts["notes"] = notes[0]

    asked = []

    def make_qa():
        asked.extend(collect_turns(ctx, file))
        return qa_section(asked)
    add("问答", "问答（按划线分组）", make_qa)
    counts["questions"] = len(asked)

    add("导图", "导图", lambda: mindmap_section(ctx, file))
    add("概念", "概念", lambda: concepts_section(ctx, raw_title))
    add("小问题", "小问题", lambda: quiz_section(ctx, file))
    add("勘误", "勘误", lambda: errata_section(ctx, file))
    counts["sections"] = len(sections)

    head = ["导出：" + time.strftime("%Y-%m-%d")]
    page, total = page_of(prog.get("page")), page_of(prog.get("numPages"))
    if page:
        head.append(f"读到第 {page} / {total} 页" if total else f"读到第 {page} 页")
    head += [f"划线 {len(hls)}", f"提问 {len(asked)}"]
    md = [f"# 《{one_line(title)}》读书笔记", "", " · ".join(head)]
    for heading, lines in sections:
        md += ["", f"## {heading}", ""] + lines
    return {
        "filename": f"{file_stem(title)}-读书笔记-{time.strftime('%Y%m%d')}.md",
        "markdown": "\n".join(md) + "\n",
        "empty": not sections,
        "counts": counts,
        "warnings": warnings,
    }


def register(routes, ctx):
    def get_export(h, q):
        file = q.get("file", "")
        if not file or len(file) > 2000:
            return h._send_json({"error": "缺少 file"}, 400)
        with ctx.data_lock:
            out = build(ctx, file, q.get("title", "")[:MAX_TITLE])
        return h._send_json(out)

    routes[("GET", "/api/export")] = get_export
