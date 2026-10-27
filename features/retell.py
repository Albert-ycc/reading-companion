"""读完一节的复述批改：读者用自己的话写这节讲了什么，Claude 对照原文指出漏掉的和说错的，每条标页码。

POST /api/retell {file, title, from, to, text, retelling, label?, truncated?, asked_to?, skipped?}
  text 是范围内各页的文字，每页前一行「【第 N 页】」；retelling 是读者写的复述
  → {id, at, feedback, missed: [{point, page, quote}], wrong: [{said, actually, page, quote}],
     concepts: [{name, status, page}], dropped, scope}
  quote 是服务端在该页原文里核对过的引句（逐字能找到才给，找不到就是空串，只剩页码）；
  生成失败回 {"error"}；页面中途断开（换书、取消）就杀掉 claude、不回话、不存档
GET /api/retell?file=&n=5 → {items: [...]}：这本书最近 n 次（默认 5，最多 30），最新的在前
存档：DATA/retell/<book_hash>.json，每本书最多留 30 次。
"""
import json
import re
import select
import socket
import sys
import threading
import unicodedata

MODEL = "sonnet"
TIMEOUT = 200            # 一次调用；输出读不懂时再调一次，所以最长约两倍
RESULT_KEYS = ("feedback", "missed", "wrong", "concepts")
RETRY_NOTE = "\n\n（上一次的输出不是合法 JSON。这次只输出 JSON 对象本身；字符串里不要出现英文双引号，要引用用「」。）"
MAX_TEXT = 65000          # 原文上限（页面一次最多交 6 万字，留一点余量）
MIN_TEXT = 100            # 原文短于这个，没东西可对照
MAX_RETELL = 6000
MIN_RETELL = 8            # 去掉空白后至少这么多字，一个字两个字的不算复述
KEEP = 30
PROFILE_CHARS = 1200
MIN_QUOTE = 10            # 引句至少这么多字（去空白后）核对上才算数
MAX_QUOTE = 80
MAX_ITEMS = 8
MAX_CONCEPTS = 8

SYSTEM = """你是「伴读」里批改复述的老师。读者读完一节书，用自己的话写了这节讲什么；你把他写的和原文逐点对照，告诉他漏了什么、说错了什么。
你面向「聪明的外行」：用大白话，直接说，不绕。你只依据给你的原文判断，原文没写的不凭常识评判对错。"""

RULES = """做法：
1. 先在心里把原文这一节的核心要点列出来（一般 4 到 8 条：结论、关键概念、因果、条件和例外），再逐条看他写没写、写对没有。
2. missed（漏掉的）：原文的核心要点而他完全没提到。按重要性排序，最多 5 条，每条 point 一句话、40 字以内。细节、例子、具体数字不算漏，除非它本身就是这节的结论。他只是说得简略但方向对，不算漏。
3. wrong（说错的）：他写的和原文相悖、或明显曲解了原文。说得不够精确、用词不同但意思对的不算错。said 写他的意思，actually 写原文的意思，两处都直接写内容，不要以「你说」「原文说」「原文其实」开头。没有就给空数组。
4. 每条 missed 和 wrong 必须带 page（取原文里「【第 N 页】」标记的 N）和 quote（原文里支撑这条的一句，逐字照抄，不改字、不加省略号、不拼接两处，10 到 60 个字）。
5. feedback（总评）两三句：先说他写对了哪几点，再说最要紧的一个差距。没有差距就只说他抓住了什么。
6. concepts：这节真正要掌握的概念，最多 6 个（不是术语表）。name 只写概念本身的名称，12 个字以内，不带括号里的列举；他复述对了的 status 写「已掌握」，漏掉的或说错的写「半懂」；page 写它在原文里讲得最清楚的一页。
7. 原文可能是扫描识别出来的，个别字、数字、单位可能认错：拿不准的数字不据此判他说错。
8. 他的复述里夹着的问题、感想不用批改。

JSON 里的字符串不要出现英文双引号：要引用就用「」；quote 是原文的话，原文这句里有英文双引号时，换一句没有的，或只取双引号之前的部分。

只输出一个 JSON 对象，不要代码块，不要别的文字，形状如下（没有的项给空数组 []，不要写成字符串）：
{"feedback": "…", "missed": [{"point": "漏掉的要点，一句话", "page": 12, "quote": "原文一句"}], "wrong": [{"said": "他写的", "actually": "原文其实说的", "page": 12, "quote": "原文一句"}], "concepts": [{"name": "概念名", "status": "已掌握", "page": 12}]}"""

MARK = re.compile(r"^【第\s*(\d{1,6})\s*页】[ \t]*$", re.M)
NEGATION = re.compile(r"^[\s（(\[]*(无|没有|没有(?:明显)?(?:漏掉?|遗漏|说错|错误|错|漏)(?:的|之处|的地方)?|无(?:遗漏|错误)|暂无|空|none|null|n/a|-|—)[\s。.）)\]]*$", re.I)
STATUSES = {"已掌握": "已掌握", "掌握": "已掌握", "懂了": "已掌握", "right": "已掌握", "半懂": "半懂", "没懂": "半懂", "卡住": "半懂", "half": "半懂", "wrong": "半懂"}


def norm(s):
    """复述长度用：全半角统一、去掉所有空白"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or ""))


FOLD = str.maketrans({"\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
                      "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"'})
JOIN = "-\u2010\u2011"  # 行尾的真连字符才接回去，破折号、范围号不动


def build(text):
    """核对引句用的索引：返回 (规整后的字符串, 每个字符在原文里的下标)。
    规整＝全半角统一（NFKC）、各种横线和引号统一、去掉所有空白、大小写不分、行尾连字符（ob-\\nserved）接回去"""
    hay, org = [], []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in JOIN:
            j = i + 1
            while j < n and text[j] in " \t\r":
                j += 1
            if j < n and text[j] == "\n":
                k = j + 1
                while k < n and text[k].isspace():
                    k += 1
                i = k
                continue
        for ch in unicodedata.normalize("NFKC", c).translate(FOLD):
            if not ch.isspace():
                for lo in ch.lower():
                    hay.append(lo)
                    org.append(i)
        i += 1
    return "".join(hay), org


def split_pages(text, frm, to):
    """text → {页码: 原文}；没有「【第 N 页】」标记时整段算在一个键 None 下"""
    marks = list(MARK.finditer(text))
    if not marks:
        return {None: text}
    pages = {}
    for i, m in enumerate(marks):
        n = int(m.group(1))
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        if frm <= n <= to:
            pages[n] = pages.get(n, "") + text[m.end():end]
    return pages


def find_json(s, keys=None):
    """从模型输出里取出第一个完整的 JSON 对象（容忍代码块围栏、前后多余的话、字符串里的裸换行）。
    keys 给了就只认含其中任一个键的对象：外层 JSON 写坏时，不能把里面某一条 {"point": …} 当成整个结果"""
    s = (s or "").strip()
    s = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", s)
    start = s.find("{")
    while start >= 0:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(s)):
            c = s[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(s[start:i + 1], strict=False)
                    except ValueError:
                        break
                    if isinstance(obj, dict) and (not keys or any(k in obj for k in keys)):
                        return obj
                    break
        start = s.find("{", start + 1)
    return None


def as_list(v):
    """missed / wrong / concepts 该是数组：模型写成字符串时，「没有」之类当空数组，别的当成一条没有结构的话交给后面按页码核对"""
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return [v]
    if isinstance(v, str):
        s = v.strip()
        if not s or NEGATION.match(s):
            return []
        return [{"_loose": s}]
    return []


def text_of(v, limit):
    return v.strip()[:limit] if isinstance(v, str) else ""


def int_page(v):
    if type(v) is int:
        return v
    if isinstance(v, str) and re.fullmatch(r"\s*\d{1,6}\s*", v):
        return int(v)
    if isinstance(v, float) and v == int(v):
        return int(v)
    return None


def locate(quote, page, idx, frm, to):
    """核对引句，返回 (页码, 引句)。引句取原文里那一段的原样（页面按它定位，大小写、全半角、空白都以原文为准）。
    先在模型给的那一页找，找不到再找别的页（模型常把页码记偏）；整句找不到时取开头能对上的最长一段（至少 MIN_QUOTE 字）。
    引句完全对不上：页码在范围内就只给页码（引句留空），页码也不在范围内就返回 (None, "")"""
    in_range = isinstance(page, int) and frm <= page <= to
    if quote:
        order = ([page] if page in idx else []) + [n for n in sorted(idx, key=lambda x: (x is None, x)) if n != page]
        for cut in range(len(quote), 0, -1):
            key = build(quote[:cut])[0]
            if len(key) < MIN_QUOTE:
                break
            for n in order:
                hay, org, text = idx[n]
                at = hay.find(key)
                if at >= 0:
                    found = re.sub(r"\s+", " ", text[org[at]:org[at + len(key) - 1] + 1]).strip()
                    return (page if n is None and in_range else n if n is not None else None), found
    return (page if in_range else None), ""


# 界面上已经有「你说」「原文其实是」两个小标，模型常把它们再写进正文开头
LEAD_SAID = re.compile(r"^你(?:写的?|说的?|复述里?(?:说|写)的?)[:：，,]?\s*")
LEAD_ACTUALLY = re.compile(r"^原文(?:其实|实际上?|里)?(?:是|说|写的?)?[:：，,]?\s*")


def strip_lead(s, pat):
    t = pat.sub("", s, count=1).strip()
    return t if len(t) >= 4 else s


def shape_missed(raw, idx, frm, to):
    out, dropped = [], 0
    for it in as_list(raw):
        if not isinstance(it, dict):
            continue
        loose = it.get("_loose")
        point = text_of(loose if loose else it.get("point"), 300)
        page = int_page(it.get("page"))
        if loose:
            m = re.search(r"第\s*(\d{1,6})\s*页", loose)
            page = int(m.group(1)) if m else None
        quote = text_of(it.get("quote"), MAX_QUOTE)
        if not point:
            continue
        page, quote = locate(quote, page, idx, frm, to)
        if page is None:
            dropped += 1  # 没有页码、原文里也找不到出处的，不给读者一条没法核对的话
            continue
        out.append({"point": point, "page": page, "quote": quote})
    return out[:MAX_ITEMS], dropped


def shape_wrong(raw, idx, frm, to):
    out, dropped = [], 0
    for it in as_list(raw):
        if not isinstance(it, dict) or it.get("_loose"):
            dropped += 1 if isinstance(it, dict) else 0
            continue
        said = strip_lead(text_of(it.get("said"), 300), LEAD_SAID)
        actually = strip_lead(text_of(it.get("actually"), 400), LEAD_ACTUALLY)
        if not said or not actually:
            continue
        page, quote = locate(text_of(it.get("quote"), MAX_QUOTE), int_page(it.get("page")), idx, frm, to)
        if page is None:
            dropped += 1
            continue
        out.append({"said": said, "actually": actually, "page": page, "quote": quote})
    return out[:MAX_ITEMS], dropped


def shape_concepts(raw, frm, to):
    out, seen = [], set()
    for it in as_list(raw):
        if not isinstance(it, dict) or it.get("_loose"):
            continue
        name = text_of(it.get("name"), 40)
        status = STATUSES.get(text_of(it.get("status"), 10).lower()) or STATUSES.get(text_of(it.get("status"), 10))
        if not name or not status or name in seen:
            continue
        seen.add(name)
        page = int_page(it.get("page"))
        out.append({"name": name, "status": status, "page": page if page is not None and frm <= page <= to else None})
    return out[:MAX_CONCEPTS]


def client_gone(h):
    """页面那一端已经断开（换书、取消、关页）：连接上读得到 EOF"""
    try:
        ready, _, _ = select.select([h.connection], [], [], 0)
        return bool(ready) and h.connection.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def register(routes, ctx):
    def store_path(key):
        return ctx.DATA / "retell" / f"{ctx.book_hash(key)}.json"

    def load_items(key):
        data = ctx.read_json_as(store_path(key), "dict", {})  # 形状不对的改名留底
        items = data.get("items")
        return [x for x in items if isinstance(x, dict)] if isinstance(items, list) else []

    def profile():
        path = getattr(ctx, "LEARNER", None) or (ctx.ROOT / "learner.md")
        try:
            return path.read_text("utf-8").strip()[:PROFILE_CHARS]
        except OSError:
            return ""

    def bad(h, msg, code=400):
        return h._send_json({"error": msg}, code)

    def get_list(h, params):
        key = params.get("file") if isinstance(params.get("file"), str) else ""
        if not key:
            return bad(h, "缺少 file")
        try:
            n = max(1, min(KEEP, int(params.get("n") or 5)))
        except ValueError:
            n = 5
        with ctx.data_lock:
            items = load_items(key)
        h._send_json({"items": list(reversed(items))[:n]})

    def post(h, body):
        if not isinstance(body, dict):
            return bad(h, "请求不对")
        key = body.get("file") if isinstance(body.get("file"), str) else ""
        title = body.get("title") if isinstance(body.get("title"), str) else ""
        frm, to = int_page(body.get("from")), int_page(body.get("to"))
        text = body.get("text") if isinstance(body.get("text"), str) else ""
        retelling = body.get("retelling") if isinstance(body.get("retelling"), str) else ""
        if not key:
            return bad(h, "缺少 file")
        if frm is None or to is None or frm < 1 or to < frm:
            return bad(h, "页码范围不对")
        if len(norm(retelling)) < MIN_RETELL:
            return bad(h, "复述太短，至少写一两句再交")
        if len(text.strip()) < MIN_TEXT:
            return bad(h, "这个范围里取不到几个字，没有原文可以对照（扫描页没识别出来？）")
        truncated = bool(body.get("truncated")) or len(text) > MAX_TEXT
        text = text.strip()[:MAX_TEXT]
        retelling = retelling.strip()[:MAX_RETELL]
        pages = split_pages(text, frm, to)
        if not pages or not any(t.strip() for t in pages.values()):
            return bad(h, "原文格式不对")

        blocks = [
            f"【书】《{title[:200]}》第 {frm} 到 {to} 页" + ("（超长，只给了前一部分）" if truncated else ""),
            "【原文】", text,
            "【他的复述】", retelling,
        ]
        prof = profile()
        if prof:
            blocks += ["【他是谁（判断哪些算「外行也该抓住的要点」用）】", prof]
        prompt = "\n".join(blocks) + "\n\n" + RULES

        gone = threading.Event()

        def ask(pr):
            """调一次模型，盯着连接：页面断开（换书、取消）就杀掉 claude，返回 None"""
            box = {}

            def work():
                try:
                    box["res"] = ctx.claude_once(SYSTEM, pr, model=MODEL, timeout=TIMEOUT, cancel=gone)
                except Exception as e:  # noqa: BLE001
                    box["res"] = ("", f"{type(e).__name__}: {e}")
            th = threading.Thread(target=work, daemon=True)
            th.start()
            while th.is_alive():
                th.join(0.3)
                if not gone.is_set() and client_gone(h):
                    gone.set()
            return None if gone.is_set() else box.get("res", ("", "没有结果"))

        idx = {n: (*build(t), t) for n, t in pages.items()}

        def digest(out):
            """模型输出 → 批改结果；读不懂、或解析后什么都没有时返回 None"""
            obj = find_json(out, RESULT_KEYS)
            if obj is None:
                return None
            missed, d1 = shape_missed(obj.get("missed"), idx, frm, to)
            wrong, d2 = shape_wrong(obj.get("wrong"), idx, frm, to)
            feedback = text_of(obj.get("feedback"), 800)
            if not feedback and not missed and not wrong:
                return None
            return {"feedback": feedback, "missed": missed, "wrong": wrong, "concepts": shape_concepts(obj.get("concepts"), frm, to), "dropped": d1 + d2}

        res = ask(prompt)
        if res is None:
            return
        out, err = res
        got = digest(out)
        if got is None and not err:  # 进程正常结束但输出读不懂（常见：字符串里有没转义的双引号）：再要一次
            print(f"复述批改：第一次输出读不懂，重试：{(out or '')[:300]!r}", file=sys.stderr, flush=True)
            res = ask(prompt + RETRY_NOTE)
            if res is None:
                return
            out, err = res
            got = digest(out)
        if got is None:
            print(f"复述批改：模型输出读不懂（error={err!r}）：{(out or '')[:400]!r}", file=sys.stderr, flush=True)
            return bad(h, err or "Claude 回的内容读不懂，再交一次试试", 502)
        skipped = [p for p in (body.get("skipped") if isinstance(body.get("skipped"), list) else []) if type(p) is int and 1 <= p <= 100000][:100]
        asked_to = int_page(body.get("asked_to"))
        label = text_of(body.get("label"), 80)
        rec = {
            "id": ctx.now_iso() + "-" + ctx.book_hash(retelling + ctx.now_iso())[:6],
            "at": ctx.now_iso(),
            "scope": {"from": frm, "to": to, "label": label, "truncated": truncated,
                      **({"asked_to": asked_to} if asked_to and asked_to >= to else {}), **({"skipped": skipped} if skipped else {})},
            "retelling": retelling,
            **got,
        }
        with ctx.data_lock:
            items = load_items(key)
            items.append(rec)
            path = store_path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            ctx.write_json(path, {"file": key, "title": title[:200], "items": items[-KEEP:]})
        h._send_json(rec)

    routes[("POST", "/api/retell")] = post
    routes[("GET", "/api/retell")] = get_list
