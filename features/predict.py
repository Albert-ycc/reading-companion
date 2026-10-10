"""划线后的输入预测：猜读者接下来最可能在提问框里打出的三条完整的话。

POST /api/predict {file, title, page, selection: {text, before, after, ocr}}
  → {"predictions": ["…", "…", "…"], "deep": 2}：前两条是他最可能打的，deep 指向那条「深一层」的问题（没猜出来时为 -1）；
  生成失败回 {"error"}；页面中途取消（换了一句划线）就杀掉 claude、不回话

参照 Claude Code 的 prompt suggestion（services/PromptSuggestion/promptSuggestion.ts）：
检验标准一样（他看到时会想「我正要打这句」），过滤规则同一个思路（去掉 Claude 口吻、评价、多句）；
不同的是它在 Claude 答完后猜一条、明令不许猜问句，这里在划线后猜三条，问句正是要猜的。
"""
import json
import re
import select
import socket
import threading

MODEL = "sonnet"
TIMEOUT = 60
QUOTE_CHARS = 1500    # 划线本身最多交多少字
BEFORE_CHARS = 400
AFTER_CHARS = 300
ANSWER_CHARS = 500    # 上一轮回答节选
HISTORY_N = 8         # 他问过的话最多带几条
PROFILE_CHARS = 1500
MIN_CHARS, MAX_CHARS = 4, 80  # 深一层那条实测常写到 40 到 55 字

SYSTEM = """你在「伴读」里做输入预测。用户在读书，刚在书上划了一句；你给他三条可以直接发出的完整的话：
两条是他接下来最可能在提问框里打的，一条是深一层、值得他问的问题。你不回答、不讲解，只写问题。"""

RULES = """规则：
1. 前两条的检验标准：他看到时会想「我正要打这句」。猜他会打的，不是你觉得他应该问的。
2. 每条都落在这句划线上：点名划线里具体的一个词或说法，直接写这个词，不加引号、不整句复述原文，用「这里」「这句」指代划线。不写「这段什么意思」「举个例子」这种放在哪句后面都成立的泛问。
3. 用他的口吻：第一人称、口语、简短，跟他问过的话一个风格；从他问过的话看得出习惯（爱追问现状、爱联系工作、爱要例子……）就照着习惯猜。
4. 前两条角度不同：比如一条问某个词或说法到底指什么，一条往下追问（为什么、还有哪些、现在怎么样）或接到他的工作上。
5. 第三条是深一层的问题：他自己未必想得到、但真读懂这句要过的那一关。从这几个方向里挑对这句最要紧的一个往下挖：这句默认了什么前提；它凭什么成立；什么情况下不成立（边界、反例、代价）；和前后文或他已经知道的东西哪里对不上。要具体到这句说的内容，回答它得真想明白，不是查个定义就完；不用「本质」「深层含义」「意义」这类空词。
6. 每条一句话，可以是问句也可以是指令（「用医院里的例子讲讲……」）。前两条 10 到 30 个字，越像他随手打的越好；第三条 10 到 40 个字，也用他的口吻。
7. 不用 Claude 的口吻（「让我」「我来」），不写评价（「明白了」「谢谢」），不编号、不加引号、不解释。

只输出三行：前两行各一条他最可能打的，第三行以「深一层：」开头。别的什么都不写。"""

LEAD = re.compile(r"^\s*(?:[-*•·]|\d{1,2}\s*[.、．)）:：]|[（(]\d{1,2}[)）])\s*")
PAIRS = {"「": "」", "『": "』", "“": "”", '"': '"', "'": "'", "‘": "’", "`": "`"}
CLAUDE_VOICE = re.compile(r"^(让我|我来|我会|我可以|好的|当然|下面|以下|这是|你可以|你应该)")
# 只看句首：书里讲的就可能是「预测」「输出」，「什么叫很好地拟合」也是正经问题
EVALUATIVE = re.compile(r"^(谢谢|多谢|明白了|懂了|不错|很好|太好了)")
META = re.compile(r"^(以下|下面是|这三条|三条预测|无法预测|没有足够)")
DEEP = re.compile(r"^(?:深一层|深一层的问题)\s*[:：]\s*")


def clean_predictions(text):
    """模型输出 → (预测列表, 深一层那条的下标)：前面至多两条他最可能打的，深一层的排最后；没有深一层时下标为 -1。
    逐行去编号、去引号，筛掉 Claude 口吻、评价、太短太长、多行解释、重复的。
    深一层先认行首的「深一层：」；模型偶尔漏写这个标记（实测 3 次里 1 次），三行都没标时按位置认第三行"""
    lines, seen = [], set()
    for ln in (text or "").splitlines():
        s = LEAD.sub("", ln).strip()
        is_deep = bool(DEEP.match(s))
        s = DEEP.sub("", s).strip()
        if len(s) > 1 and PAIRS.get(s[0]) == s[-1] and s[1:-1].count(s[0]) == 0:  # 整句被一对引号包着才去掉，「拟合」在这里…不动
            s = s[1:-1].strip()
        if not s or len(s) < MIN_CHARS or len(s) > MAX_CHARS:
            continue
        if CLAUDE_VOICE.search(s) or EVALUATIVE.search(s) or META.search(s) or "**" in s:
            continue
        key = re.sub(r"[\s，。？！?!,.、]", "", s)
        if key in seen:
            continue
        seen.add(key)
        lines.append((s, is_deep))
    marked = [s for s, d in lines if d]
    if marked:
        likely, deep = [s for s, d in lines if not d][:2], marked[0]
    else:
        likely, deep = [s for s, _ in lines[:2]], (lines[2][0] if len(lines) >= 3 else None)
    return (likely + [deep], len(likely)) if deep else (likely, -1)


def client_gone(h):
    """页面那一端已经断开（换了一句划线、关页）：连接上读得到 EOF"""
    try:
        ready, _, _ = select.select([h.connection], [], [], 0)
        return bool(ready) and h.connection.recv(1, socket.MSG_PEEK) == b""
    except OSError:
        return True


def register(routes, ctx):
    def profile():
        try:
            return (ctx.ROOT / "learner.md").read_text("utf-8").strip()[:PROFILE_CHARS]
        except OSError:
            return ""

    def history(key):
        """他问过的话（这本书的在后，最近的在最后），外加这本书当前对话里 Claude 的上一轮回答。
        这本书问得少时用别的书里问过的话补足，只为学他的口吻"""
        chats = ctx.read_json(ctx.CHATS, {})
        chats = chats if isinstance(chats, dict) else {}
        def user_qs(msgs):
            return [m.get("text", "").strip() for m in msgs if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("text"), str)]
        here_msgs = (chats.get(key) or {}).get("messages") or []
        here = []
        archived = ctx.read_json(ctx.DATA / "chat-archive" / f"{ctx.book_hash(key)}.json", [])
        for c in archived if isinstance(archived, list) else []:
            if isinstance(c, dict):
                here += user_qs(c.get("messages") or [])
        here += user_qs(here_msgs)
        others = []
        for k, v in chats.items():
            if k != key and isinstance(v, dict):
                others += user_qs(v.get("messages") or [])
        here = here[-HISTORY_N:]
        need = HISTORY_N - len(here)
        qs = [q for q in (others[-need:] if need > 0 else []) + here if q]
        last = next((m.get("text", "") for m in reversed(here_msgs) if isinstance(m, dict) and m.get("role") == "assistant"), "")
        return qs, last if isinstance(last, str) else ""

    def predict(h, body):
        if not isinstance(body, dict):
            return h._send_json({"error": "请求不对"}, 400)
        sel = body.get("selection")
        text = sel.get("text") if isinstance(sel, dict) else None
        if not isinstance(text, str) or not text.strip():
            return h._send_json({"error": "没有划线"}, 400)
        key = body.get("file") if isinstance(body.get("file"), str) else ""
        title = body.get("title") if isinstance(body.get("title"), str) else ""
        page = body.get("page") if type(body.get("page")) is int else None
        before = (sel.get("before") if isinstance(sel.get("before"), str) else "").strip()[-BEFORE_CHARS:]
        after = (sel.get("after") if isinstance(sel.get("after"), str) else "").strip()[:AFTER_CHARS]
        qs, last = history(key)
        blocks = [
            f"【书】《{title[:200]}》" + (f"第 {page} 页" if page else ""),
            "【他刚划的这句】" + ("（扫描版识别出的文字，个别字可能认错）" if sel.get("ocr") is True else ""),
            text.strip()[:QUOTE_CHARS],
            "【前文】", before or "（无）",
            "【后文】", after or "（无）",
            "【他问过的话（越往下越近）】", "\n".join("- " + q.replace("\n", " ")[:120] for q in qs) or "（还没问过）",
        ]
        if last:
            blocks += ["【这本书里 Claude 上一轮的回答（节选）】", last.strip()[:ANSWER_CHARS]]
        prof = profile()
        if prof:
            blocks += ["【他是谁】", prof]
        prompt = "\n".join(blocks) + "\n\n" + RULES

        # claude_once 放到子线程跑，这边盯着连接：页面换了一句划线（中止请求）就杀掉 claude
        gone, box = threading.Event(), {}

        def work():
            try:
                box["res"] = ctx.claude_once(SYSTEM, prompt, model=MODEL, timeout=TIMEOUT, cancel=gone)
            except Exception as e:  # noqa: BLE001
                box["res"] = ("", f"{type(e).__name__}: {e}")
        th = threading.Thread(target=work, daemon=True)
        th.start()
        while th.is_alive():
            th.join(0.3)
            if not gone.is_set() and client_gone(h):
                gone.set()
        if gone.is_set():
            return
        out, err = box.get("res", ("", "没有结果"))
        preds, deep = clean_predictions(out)
        if not preds:
            return h._send_json({"error": err or "没猜出来"}, 502)
        h._send_json({"predictions": preds, "deep": deep})

    routes[("POST", "/api/predict")] = predict
