#!/usr/bin/env python3
"""UserPromptSubmit hook：把阅读器同步的「在读哪本、第几页、最近划线及前后文」注入本轮提问，
同时暂存本轮提问，交给 Stop hook 配上回答写进日志。

阅读状态的来源：服务为本次提问写的快照（环境变量 READER_CONTEXT 指向它）；
READER_CONTEXT=none 表示这次提问没有可靠的阅读上下文（没开书、或页面给的书对不上），不注入书的内容；
没有这个变量（旧页面）才读全局的 current.json。

书的上下文之外还有三块附加内容，各自独立、出任何错只跳过自己：
  跨书记忆  在读某本书时，从 qa-index.json 找「别的书里问过的」相近的话
  全库提问  READER_CONTEXT=none（没开书）时，交代读过哪些书、记录放在哪，让 Claude 翻记录回答
  反问模式  mode.json 里 socratic 为真时，叮嘱 Claude 先问后讲"""
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_PROJECT_DIR") or Path(__file__).resolve().parents[2])
DATA = Path(os.environ.get("READER_DATA") or ROOT / "data")  # 伴读服务会传过来；沙盒实例时指向沙盒目录
LEARNER = Path(os.environ.get("READER_LEARNER") or ROOT / "learner.md")  # 服务启动时的环境变量，hook 继承得到；沙盒实例时指向沙盒副本
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


# ---------- 跨书记忆：提问时带上别的书里问过的话 ----------
INDEX_RECENT = 2000  # qa-index.json 只看最近这么多条
MAX_CROSS = 3        # 最多注入几条，同一本书最多两条
CROSS_BUDGET = 0.35  # 匹配最多花这么多秒，超了拿已有的结果就走（hook 整体 5 秒超时，目标 200 毫秒）
Q_CHARS = 4000       # 参与匹配的划线和提问各取前这么多字
ENTRY_CHARS = 600    # 索引里每条的各个字段取前这么多字参与匹配（正常条目：问题 ≤ 400、划线 ≤ 200、回答节选 ≤ 300）
ATTACH_NOTE = re.compile(r"\n*（用户附了图片，回答前先用 Read 工具看图：[^）]*）\s*$")  # 服务在问题后补的一句，不是用户说的话
CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]+")
ASCII_WORD = re.compile(r"[a-z0-9]+")
EN_WORD = re.compile(r"[a-z]{4,}")
# 快捷按钮和口头禅：放在哪句话里都成立，不能算「同一个问题」的证据
BOILER = ("这段什么意思", "举个例子", "和我的工作有什么关系", "什么意思", "是什么", "为什么", "怎么样", "怎么办", "怎么回事",
          "请解释", "解释一下", "讲一下", "讲讲", "帮我", "我想知道", "这句话", "这一段", "这段话", "这一句", "这个概念",
          "有什么", "可以吗", "能不能", "是不是", "有没有", "意思是", "具体", "一下")
EN_STOP = set("""that this with from have been were which their there about would could should these those other than then them
they what when where while will your into more most some such only also over under between among after before during using used
uses based both each many much very than whether within without through however because since still just like make made does
done being having however thus therefore study studies analysis results result data method methods paper show shown shows
figure table page pages""".split())


def has_term(low, words, term):
    """term（已小写）是否出现在 low（已小写）里。纯英文的词只认整词（「ai」不算 main 的一部分），中文直接找子串。
    不拿用户的文字拼正则：划线里有 . * ( 这类字符也安全"""
    if not term.isascii():
        return term in low
    if ASCII_WORD.fullmatch(term):
        return term in words
    i = low.find(term)
    while i >= 0:
        before = low[i - 1] if i else " "
        after = low[i + len(term)] if i + len(term) < len(low) else " "
        if not (before.isascii() and before.isalnum()) and not (after.isascii() and after.isalnum()):
            return True
        i = low.find(term, i + 1)
    return False


def load_concepts():
    """learner.md 概念掌握表里的概念名（含括号、斜杠分出的别名），小写，≥ 2 字"""
    try:
        text = LEARNER.read_text("utf-8")
    except (OSError, ValueError):
        return set()
    terms, in_table = set(), False
    for line in text.splitlines():
        if line.startswith("#"):
            in_table = line.lstrip("#").strip().startswith("概念掌握")
            continue
        line = line.strip()
        if not in_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells or not cells[0] or set(cells[0]) <= set("-: ") or cells[0] == "概念":
            continue
        for part in re.split(r"[（）()/／、,，;；]", cells[0]):
            part = part.strip(" *`_").lower()
            if len(part) >= 2:
                terms.add(part)
    return terms


def clean_query(v):
    v = ATTACH_NOTE.sub("", s(v))[:Q_CHARS]
    for b in BOILER:
        v = v.replace(b, " ")
    return v


def grams_of(text):
    out = set()
    for run in CJK_RUN.findall(text):
        out.update(run[i:i + 4] for i in range(len(run) - 3))
    return out


def words_of(low):
    return {w[:-1] if w.endswith("s") and len(w) > 4 else w for w in EN_WORD.findall(low)} - EN_STOP


def load_index():
    try:
        data = json.loads((DATA / "qa-index.json").read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return [e for e in data if isinstance(e, dict)][-INDEX_RECENT:] if isinstance(data, list) else []


def same_book(e, cur_file, cur_title):
    f, t = s(e.get("file")), " ".join(s(e.get("title")).split())
    return bool((f and cur_file and f == cur_file) or (t and cur_title and t == cur_title))


def find_cross(selection, prompt, cur_file, cur_title):
    """在别的书的问答里找和这一轮相近的：概念表里的概念同时出现，或共享 ≥ 4 个汉字的连续片段 / ≥ 2 个英文词"""
    t0 = time.monotonic()
    entries = [e for e in load_index() if isinstance(e.get("question"), str) and e.get("question").strip()
               and not same_book(e, cur_file, cur_title)]
    if not entries:
        return []
    q = clean_query(selection) + "\n" + clean_query(prompt)
    qlow = q.lower()
    qwords = set(ASCII_WORD.findall(qlow))
    hit_terms = [t for t in load_concepts() if has_term(qlow, qwords, t)]
    qgrams, qen = grams_of(q), words_of(qlow)
    if not (hit_terms or qgrams or len(qen) >= 2):
        return []
    n = len(entries)
    seen = []  # (条目, 概念命中数, 共享汉字片段, 共享英文词)
    gram_df, word_df = {}, {}
    need_words = any(ASCII_WORD.fullmatch(t) for t in hit_terms)  # 纯英文单词的概念要按整词找，才需要给每条切词
    for e in entries:
        if time.monotonic() - t0 > CROSS_BUDGET:
            break
        # 汉字片段、英文词只和那条「问题」比（划线原文和回答节选只给概念用）：两本书的划线都是专业文字，共用几个词太容易，不算同一个问题。
        # 条目这边不必再去掉口头禅：q 里已经没有它们，共享的片段不会落在口头禅里
        body = s(e.get("question"))[:ENTRY_CHARS]  # 索引是普通文件，谁都可能手改成一条几兆的问题，每条只取前面一段
        blow = body.lower()
        eg = qgrams & grams_of(body) if qgrams else set()
        ew = qen & words_of(blow) if qen else set()
        terms = 0
        if hit_terms:
            full = blow + "\n" + s(e.get("selection"))[:ENTRY_CHARS].lower() + "\n" + s(e.get("answer_excerpt"))[:ENTRY_CHARS].lower()
            fwords = set(ASCII_WORD.findall(full)) if need_words else ()
            terms = sum(1 for t in hit_terms if has_term(full, fwords, t))
        if eg or ew or terms:
            seen.append((e, terms, eg, ew))
            for g in eg:
                gram_df[g] = gram_df.get(g, 0) + 1
            for w in ew:
                word_df[w] = word_df.get(w, 0) + 1
    scored = []
    for order, (e, terms, eg, ew) in enumerate(seen):
        if n >= 20:  # 几乎每条里都有的片段和词（「医学统计」「kidney」）不算证据
            eg = {g for g in eg if gram_df[g] <= n * 0.15}
            ew = {w for w in ew if word_df[w] <= n * 0.25}
        score = terms * 4 + len(eg) + (len(ew) if len(ew) >= 2 else 0)
        if terms or eg or len(ew) >= 2:
            scored.append((score, order, e))
    scored.sort(key=lambda x: (-x[0], -x[1]))  # 同分的新问答在前（索引按时间追加，order 大的更新）
    out, per_book, keys = [], {}, set()
    for _, _, e in scored:
        book = (s(e.get("file")), s(e.get("title")))
        key = (book, e.get("page"), s(e.get("question"))[:30])
        if key in keys or per_book.get(book, 0) >= 2:
            continue
        keys.add(key)
        per_book[book] = per_book.get(book, 0) + 1
        out.append(e)
        if len(out) >= MAX_CROSS:
            break
    return out


def squash(v, n):
    v = " ".join(re.sub(r"[*#`>|]+", " ", s(v)[:n * 4]).split())
    return (v[:n] + "…") if len(v) > n else v, len(v) > n


def cross_block(st, prompt):
    sel = d(st.get("selection"))
    selection = s(sel.get("regionText")) if sel.get("kind") == "region" else s(sel.get("text"))
    hits = find_cross(selection, prompt, s(st.get("file")), " ".join(s(st.get("title")).split()))
    if not hits:
        return None
    lines = ["【你在别的书里问过的】"]
    for e in hits:
        page = e.get("page")
        where = f"《{s(e.get('title'))}》" + (f"第 {page} 页" if type(page) is int else "")
        question, _ = squash(e.get("question"), 60)
        line = f"- {where}：问「{question}」"
        excerpt, cut = squash(e.get("answer_excerpt"), 150)
        if excerpt and excerpt != "（未取到回答）":
            line += f"，当时讲的是「{excerpt}{'' if excerpt.endswith('…') else '…'}（节选）」"
        lines.append(line)
    lines.append("用户问到同一个概念时可以说「你在《X》第 N 页问过这个」接着讲，并引用当时的说法；对不上就别硬扯。")
    return "\n".join(lines)


# ---------- 全库提问：没开书时问答栏就是全库 ----------
MAX_BOOKS = 30


def book_title(file, rec):
    t = " ".join(s(rec.get("title")).split())
    if not t:
        t = re.sub(r"\.pdf$", "", s(file).rsplit("/", 1)[-1], flags=re.I).strip()
    return (t[:80] + "…") if len(t) > 80 else (t or "（无书名）")


def library_block():
    try:
        prog = json.loads((DATA / "progress.json").read_text("utf-8"))
    except (OSError, ValueError):
        prog = {}
    try:
        hls = json.loads((DATA / "highlights.json").read_text("utf-8"))
    except (OSError, ValueError):
        hls = {}
    prog, hls = d(prog), d(hls)
    books = sorted(((f, r) for f, r in prog.items() if isinstance(r, dict)), key=lambda x: s(x[1].get("at")), reverse=True)[:MAX_BOOKS]
    if not books:
        return "【全库提问】用户没开书，在书架上提问。用户还没读过书。"
    lines = ["【全库提问】用户没开书，在书架上提问。他读过的书（进度来自 progress.json）："]
    for f, r in books:
        parts = []
        if pnum(r.get("numPages")) is not None:
            parts.append(f"共 {r['numPages']} 页")
        if pnum(r.get("page")) is not None:
            parts.append(f"读到第 {r['page']} 页")
        h = hls.get(f)
        parts.append(f"划线 {sum(1 for x in h if isinstance(x, dict)) if isinstance(h, list) else 0} 条")
        if re.match(r"\d{4}-\d{2}-\d{2}", s(r.get("at"))):
            parts.append(f"最近 {s(r.get('at'))[:10]}")
        lines.append(f"- 《{book_title(f, r)}》" + "，".join(parts))
    data, learner = os.path.abspath(DATA), os.path.abspath(LEARNER)
    lines.append(
        f"他读过的记录都在 {data} 下：log/*.md 是每轮问答原文（按「## 时间　《书名》第 N 页」分条）；highlights.json 是划线（note 字段是他写的眉批）；"
        f"chat-archive/ 是收起的旧对话；guide/ 是导读；mindmap/ 是导图；{learner} 是学习者档案。"
        "问到「我在哪本书里问过 X」「两本书对 Y 的说法有什么不同」「我划过哪些关于 Z 的」时，先用 Grep / Read 翻这些文件再答，"
        "回答带书名和页码；和读过的书无关的问题直接答。")
    return "\n".join(lines)


# ---------- 反问模式 ----------
SOCRATIC = ("【反问模式】用户开了反问模式：先用一到两个问题确认他已经懂了什么、卡在哪，等他答了再讲；"
            "他答了就按他的答案接着往下，每轮最多两个问题；他明确说「直接讲」就直接讲。")


def socratic_on():
    try:
        mode = json.loads((DATA / "mode.json").read_text("utf-8"))
    except (OSError, ValueError):
        return False
    return d(mode).get("socratic") is True


def extra_blocks(st, lines, prompt):
    """三块附加内容各自 try：一块出错不影响别的，更不影响书的基础上下文"""
    out = []
    for make in (
        lambda: library_block() if os.environ.get("READER_CONTEXT") == "none" else (cross_block(st, prompt) if lines else None),
        lambda: SOCRATIC if socratic_on() else None,
    ):
        try:
            block = make()
        except Exception:  # noqa: BLE001
            block = None
        if block:
            out.append(block)
    return out


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
    sections = ["\n".join(lines)] if lines else []
    sections += extra_blocks(st, lines, prompt)
    if sections:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": "\n\n".join(sections),
        }}, ensure_ascii=False))
    # 没有可注入的阅读上下文时也留一份只含提问的 pending，Stop hook 照常记日志
    shown = st if lines else {}
    page = shown.get("page") if type(shown.get("page")) is int else None
    try:
        (DATA / "pending.json").write_text(json.dumps({
            "prompt": prompt,
            "at": now.isoformat(timespec="seconds"),
            "file": s(shown.get("file")) or None,
            "title": s(shown.get("title")) or None,
            "page": page,
            "selection": s(d(shown.get("selection")).get("text")),
        }, ensure_ascii=False), "utf-8")
    except OSError:
        pass


if __name__ == "__main__":
    main()
