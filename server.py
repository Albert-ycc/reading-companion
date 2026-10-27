#!/usr/bin/env python3
"""伴读本地服务：托管伴读应用，记录阅读位置与划线，把提问转给本机 Claude Code 并流式返回。

书由 Chrome 直接读（用户授权的书库文件夹），本服务不碰外置盘：launchd 启动的进程读 /Volumes 会被 TCC 拦。
只监听 127.0.0.1；写接口只收本应用页面发来的 JSON，防止别的网站伪造阅读上下文或调起 Claude。
"""
import base64
import copy
import hashlib
import importlib.util
import json
import math
import os
import re
import secrets
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = Path(os.environ.get("READER_DATA") or ROOT / "data")  # 测试时指向沙盒目录，别碰用户的真数据
STATE = DATA / "current.json"
PROGRESS = DATA / "progress.json"
HIGHLIGHTS = DATA / "highlights.json"
CHATS = DATA / "chats.json"
CHAT_ARCHIVE = DATA / "chat-archive"  # 点「新对话」时收起的旧对话，每本书一个文件
LEARNER = Path(os.environ.get("READER_LEARNER") or ROOT / "learner.md")  # 读者档案；写它的功能模块只许写这个路径，沙盒测试时指向沙盒副本
ASK_CONTEXT_DIR = DATA / "ask-context"  # 每次提问专用的阅读快照，提问结束就删
PORT = int(os.environ.get("READER_PORT", "8770"))
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
# pdf.js 用 WebAssembly 解 JPEG 2000 图（扫描书常见），要放行 wasm 编译；普通 eval 仍然不许
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
       "frame-src 'none'; form-action 'self'")

CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".local/bin/claude")
ASK_TIMEOUT = 300
# 伴读只需要读：看页面图、读记忆、查资料；不给改文件和跑命令的能力
ALLOWED_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch"
DENIED_TOOLS = "Bash,Edit,Write,NotebookEdit,Agent,Task"
SESSION_GONE = "No conversation found"  # claude --resume 找不到会话时报的原文；只有这种错才换新会话重问

OCR_BIN = ROOT / "bin" / "ocr"  # tools/ocr.swift 编译出来的，install.sh 负责编译
OCR_DIR = DATA / "ocr"          # 识别结果按「书 + 页」缓存，翻回来不用再识别

TRANSLATE_DIR = DATA / "translate"       # 译文按「书 + 页 + 段落内容」缓存
TRANSLATE_MODEL = "sonnet"
TRANSLATE_SYSTEM = (
    "你是医学文献翻译，把英文段落译成简体中文，读者是一位医疗产品经理。"
    "输入是若干段英文，每段前一行是 §编号。按相同编号逐段输出：先单独一行写 §编号，下一行起写这一段的中文译文。"
    "只输出这些，不要解释，不要代码块。"
    "要求：医学和统计术语用国内教材和指南的通行译法；关键术语第一次出现时在中文后用括号保留英文原词；"
    "不增删内容；数字、单位、引用编号照抄；某段不是英文或不需要翻译时，在该编号下只写一个「-」。"
)
TRANSLATE_GROUP_CHARS = 1200  # 一组大约这么多字符，交给一个 Claude 进程
TRANSLATE_MAX_PARAS = 100     # 一页的段数和总字数上限：正常一页不过几千字，再多就是请求有问题，不为它起几十个进程
TRANSLATE_MAX_CHARS = 20000
translate_slots = threading.Semaphore(4)  # 全局最多同时跑 4 个翻译进程

MAX_BODY = 32 * 1024 * 1024  # 请求体上限；贴图最大 8MB 的 base64 也远低于它
MAX_TEXT = 20000             # 页文字这类字段的字数上限
MAX_SELECTED = 60000         # 划线、selection 里的文字上限：一条划线最多跨 3 页，字密的期刊每页约 8000 字
MAX_PAGE = 100000
MAX_IMAGE = 12 * 1024 * 1024
MAX_NOTE = 4000              # 划线上眉批的字数上限
MAX_TURN_TEXT = 500000       # 撤销删除时放回的一条消息的字数上限（一个长回答也远低于它）

ask_lock = threading.Lock()   # 同一时间只跑一个提问
ask_inflight = {}             # 书 -> {question, at}：正在跑的提问；页面刷新后靠它接回进行中的回答
ask_titles = {}               # 书 -> 提问时页面给的书名：别的书的页面显示「Claude 还在回答《…》里的提问」用
data_lock = threading.Lock()  # data/*.json 的读改写
ocr_slots = threading.Semaphore(2)  # 最多同时识别两页，翻页快时不把 CPU 占满

CTX = SimpleNamespace()  # 功能模块拿到的上下文；load_features 填，功能模块也可以往里登记自己的函数


def book_hash(key):
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def _para_digest(paras):
    """一页段落内容的指纹：译文缓存按「书 + 页 + 指纹」存"""
    return hashlib.sha1(PARA_SEP.join(paras).encode("utf-8")).hexdigest()[:12]


def archive_path(key):
    return CHAT_ARCHIVE / f"{book_hash(key)}.json"


def ocr_cache(key, page):
    return OCR_DIR / book_hash(key) / f"{page}.json"


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _iso_ok(s):
    """是不是 now_iso() 这种格式的时间串"""
    try:
        time.strptime(s, "%Y-%m-%dT%H:%M:%S%z")
    except (TypeError, ValueError):
        return False
    return True


PARA_SEP = "\n\u241e\n"  # 段落之间的分隔，只用来算指纹


def _no_constant(name):
    raise ValueError(f"非标准 JSON 常量 {name}")  # 浏览器的 JSON.parse 不认 NaN / Infinity


def _finite_float(s):
    f = float(s)
    if not math.isfinite(f):
        raise ValueError("数字超出范围")  # 1e999 解出来是 inf，写进文件浏览器读不了
    return f


def read_json(path, default):
    try:
        return json.loads(path.read_text("utf-8"), parse_constant=_no_constant, parse_float=_finite_float)
    except FileNotFoundError:
        return default
    except ValueError as e:  # JSON 语法错、坏 UTF-8、NaN 都算文件损坏
        _quarantine(path, e)
        return default


QUARANTINED = []  # 这次服务运行中被改名留底的数据文件（相对数据目录的留底文件名），/api/ping 带给页面，页面弹一次说明
START_TS = time.time()


def _quarantine(path, err):
    """损坏的数据文件改名留底再当成没有：当成空的直接写回，整份数据就被一条新记录覆盖了。
    err 是异常或一句原因；留底的文件名记进 QUARANTINED，页面据 /api/ping 提示读者"""
    stamp = time.strftime("%y%m%d-%H%M%S")
    bad, n = path.with_name(f"{path.name}.corrupt-{stamp}"), 1
    while bad.exists():  # 同一秒里留底两次：别把前一份覆盖了
        n += 1
        bad = path.with_name(f"{path.name}.corrupt-{stamp}-{n}")
    try:
        os.replace(path, bad)
    except OSError:
        return  # 另一个线程已经改走了
    why = err if isinstance(err, str) else f"{type(err).__name__}: {err}"
    print(f"数据文件损坏，已改名留底：{path} -> {bad.name}（{why}）", file=sys.stderr, flush=True)
    try:
        name = str(bad.relative_to(DATA))
    except ValueError:
        name = bad.name
    if name not in QUARANTINED:
        QUARANTINED.append(name)


def quarantined_names():
    """本次服务运行期间留底的文件：服务自己记下的，加上数据目录顶层被别的进程（Stop hook 的 qa-index.json）改名留底的"""
    names = list(QUARANTINED)
    try:
        for f in DATA.glob("*.corrupt-*"):
            # 改名不动 mtime、会动 ctime：ctime 晚于服务启动的才是这次运行里留底的
            if f.name not in names and f.stat().st_ctime >= START_TS - 1:
                names.append(f.name)
    except OSError:
        pass
    return names


def read_json_as(path, kind, default):
    """读 JSON 并校验形状：kind 是 "dict" 或 "list"。文件不存在回 default；语法坏了（read_json 已留底）回 default；
    语法对、形状不对（比如该是对象的写成了数组）也改名留底再回 default，不让下一次写入无声覆盖它"""
    if kind not in ("dict", "list"):
        raise ValueError(f"kind 要是 dict 或 list，给的是 {kind!r}")
    missing = object()
    data = read_json(path, missing)
    if data is missing:
        return default
    if not isinstance(data, dict if kind == "dict" else list):
        _quarantine(path, f"形状不对：要 {kind}，实际是 {type(data).__name__}")
        return default
    return data


def write_json(path, obj):
    # 临时文件名带线程和随机串：同一个目标并发写时互不覆盖；写完 fsync 再改名，断电后不会只剩半截
    data = clean_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False))
    tmp = path.with_name(f"{path.name}.{os.getpid()}-{threading.get_ident()}-{secrets.token_hex(3)}.tmp")
    try:
        # 模型输出里偶尔有落单代理项的转义（如 \ud83d），utf-8 编不出来，换成「?」，和请求体的 _scrub 一致
        with open(tmp, "w", encoding="utf-8", errors="replace") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------- 请求字段校验：只在这里（系统边界）拒绝坏数据，库里的数据就都是页面读得了的 ----------
class BadRequest(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.msg, self.code = msg, code


def _text(v, name, maxlen=MAX_TEXT):
    if not isinstance(v, str):
        raise BadRequest(f"{name} 要是文字")
    if len(v) > maxlen:
        raise BadRequest(f"{name} 太长")
    return v


def _int(v, name, lo=1, hi=MAX_PAGE):
    if type(v) is not int or not lo <= v <= hi:  # bool 也是 int，要排除
        raise BadRequest(f"{name} 要是 {lo} 到 {hi} 的整数")
    return v


def _bool(v, name):
    if not isinstance(v, bool):
        raise BadRequest(f"{name} 要是 true 或 false")
    return v


def _flag(v):
    """可选的开关字段（比如 force）：true、非零数字、「1」「true」「yes」算开，其余（含没带、null、乱写）算关，不报错"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0 and v == v  # 排除 NaN
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "y", "on")
    return False


_SURROGATE = re.compile("[\ud800-\udfff]")
_SURROGATE_PAIR = re.compile("([\ud800-\udbff])([\udc00-\udfff])")


def clean_text(s):
    """成对的代理项拼回成一个字符（一个 emoji 被拆在两段里再拼起来就是这样），真落单的换成 ?。
    落单的代理项编不进 UTF-8：推给页面、写盘前都要过这一道，请求体、流式输出、JSON 响应、数据文件共用它"""
    if not _SURROGATE.search(s):
        return s
    s = _SURROGATE_PAIR.sub(lambda m: chr(0x10000 + ((ord(m[1]) - 0xD800) << 10) + (ord(m[2]) - 0xDC00)), s)
    return _SURROGATE.sub("?", s)


class TextJoiner:
    """流式输出里一个 emoji 可能被拆在两个 text_delta 里（各是一个落单代理项）：
    一段的末尾是高代理项就先扣住，下一段来了拼上再往下送；流结束还扣着的，flush 时当作落单的换成 ?"""

    def __init__(self):
        self.held = ""

    def feed(self, text):
        text, self.held = self.held + text, ""
        if text and "\ud800" <= text[-1] <= "\udbff":
            text, self.held = text[:-1], text[-1]
        return clean_text(text)

    def flush(self):
        held, self.held = self.held, ""
        return clean_text(held)


def _scrub(o):
    """JSON 里的落单代理项（\\ud800）解出来是写不进 UTF-8 文件的字符，统一规整"""
    if isinstance(o, str):
        return clean_text(o)
    if isinstance(o, list):
        return [_scrub(x) for x in o]
    if isinstance(o, dict):
        return {_scrub(k): _scrub(v) for k, v in o.items()}
    return o


SELECTION_FIELDS = (("text", "text", MAX_SELECTED), ("before", "text", MAX_SELECTED), ("after", "text", MAX_SELECTED),
                    ("regionText", "text", MAX_SELECTED), ("kind", "text", 1000), ("image", "text", 1000),
                    ("page", "int", None), ("ocr", "bool", None))
# pageTo：眼前这一排的最后一页。双页阅读时是右页（比 page 大），pageText 是两页的文字；单页时等于 page
STATE_FIELDS = (("title", "text", 1000), ("numPages", "int", None), ("page", "int", None), ("pageTo", "int", None),
                ("pageText", "text", MAX_TEXT), ("ocr", "bool", None))
CLIPPED = "…（后面的内容已截断）"


def _clean_fields(src, fields, prefix, lenient):
    """逐个字段校验。lenient（提问快照用）时文字超长就截断、类型不对只丢这一个字段，不连累别的字段"""
    out = {}
    for k, kind, limit in fields:
        v = src.get(k)
        if v is None:
            continue
        try:
            if kind == "text":
                if lenient and isinstance(v, str) and len(v) > limit:
                    v = v[:limit - len(CLIPPED)] + CLIPPED
                out[k] = _text(v, prefix + k, limit)
            elif kind == "int":
                out[k] = _int(v, prefix + k)
            else:
                out[k] = _bool(v, prefix + k)
        except BadRequest:
            if not lenient:
                raise
    return out


def clean_selection(sel, lenient=False):
    if sel is None:
        return None
    if not isinstance(sel, dict):
        if lenient:
            return None
        raise BadRequest("selection 要是对象或 null")
    out = _clean_fields(sel, SELECTION_FIELDS, "selection.", lenient)
    return None if lenient and "page" not in out else out  # 页码都读不出来的划线，Claude 没法按页对照，整条不要


def clean_state(body, lenient=False):
    """阅读状态只收这几个字段；没带（或为 null）的字段保持原样，页面分几次上报。
    file 是必须的，lenient 时也一样：书都对不上，其余字段没有意义"""
    if not isinstance(body, dict):
        raise BadRequest("阅读状态要是对象")
    file = _text(body.get("file"), "file", 2000)
    if not file:
        raise BadRequest("缺少 file")
    out = {"file": file, **_clean_fields(body, STATE_FIELDS, "", lenient)}
    if "selection" in body:  # null 是有意义的：清掉「Claude 看到」的那段
        out["selection"] = clean_selection(body["selection"], lenient)
    return out


def clean_highlight(h):
    if not isinstance(h, dict):
        raise BadRequest("highlight 要是对象")
    out = dict(h)  # 页面以后加的字段（比如「问过」标记）原样保留，只校验结构
    out["page"] = _int(h.get("page"), "highlight.page")
    out["text"] = _text(h.get("text"), "highlight.text", MAX_SELECTED)
    parts = h.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 10:
        raise BadRequest("highlight.parts 要是 1 到 10 项的数组")
    out["parts"] = []
    for p in parts:
        rects = p.get("rects") if isinstance(p, dict) else None
        if not isinstance(rects, list) or not 1 <= len(rects) <= 5000:
            raise BadRequest("highlight.parts[].rects 要是数组")
        for r in rects:
            if not (isinstance(r, list) and len(r) == 4 and all(type(v) in (int, float) and -10 <= v <= 10 for v in r)):
                raise BadRequest("划线矩形要是 [x, y, w, h]")
        out["parts"].append({**p, "page": _int(p.get("page"), "highlight.parts[].page"), "rects": rects})
    for k in ("id", "kind", "image", "at"):
        if k in h:
            out[k] = _text(h[k], f"highlight.{k}", 1000)
    # 眉批：划线上的一段批语。空的不留字段；撤销删除时整条原样写回，批语跟着回来
    if h.get("note") is None or h.get("note") == "":
        out.pop("note", None)
    else:
        out["note"] = _text(h["note"], "highlight.note", MAX_NOTE)
    out.setdefault("at", now_iso())
    if len(json.dumps(out, ensure_ascii=False)) > 500_000:
        raise BadRequest("highlight 太大")
    return out


def jpeg_bytes(data_url, name="图片"):
    header, _, b64 = _text(data_url, name, MAX_IMAGE * 4 // 3 + 64).partition(",")
    if header != "data:image/jpeg;base64" or not b64:
        raise BadRequest(f"{name}格式不对")
    try:
        raw = base64.b64decode(b64, validate=True)
    except ValueError:
        raise BadRequest(f"{name}数据损坏")
    if raw[:3] != b"\xff\xd8\xff":
        raise BadRequest(f"{name}不是 JPEG")
    return raw


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
    }
    timeout = 30  # 连接读超时：半截请求不会一直占着线程；回答期间服务端不读 socket，不受影响

    def __init__(self, *args, **kwargs):
        # 父类的构造函数会直接处理请求，这几个状态要先设好
        self._head_sent = False  # 响应头是不是已经发了：兜底出错时决定回 500 还是往流里写 error
        self._ndjson = False
        self._gone = False       # 页面是不是已经断开
        self._say_lock = threading.Lock()
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] " + (fmt % args) + "\n")

    def send_response(self, code, message=None):
        self._head_sent = True
        super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "content-type" and "ndjson" in str(value):
            self._ndjson = True
        super().send_header(keyword, value)

    def end_headers(self):
        # 应用更新后不让 Chrome 用旧文件；没改的文件仍会走 304
        self.send_header("Cache-Control", "no-cache")
        # 只许加载和连接本机服务：回答里万一混进外链或脚本，也发不出去、跑不起来
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    # ---------- 安全检查 ----------
    def _host_ok(self):
        if self.headers.get("Host") in ALLOWED_HOSTS:
            return True
        self.send_error(403, "forbidden host")
        return False

    def _write_ok(self):
        # 写入的内容会进 Claude 的上下文，/api/ask 还会调起 Claude：只收本页面发来的 JSON。
        # 别的网站跨域 POST 时 Origin 不符；强制 application/json 也会触发浏览器预检而被挡下。
        origin = self.headers.get("Origin")
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
        if (origin is None or origin in {"http://" + h for h in ALLOWED_HOSTS}) and ctype == "application/json":
            return True
        self.send_error(403, "forbidden origin")
        return False

    # ---------- 工具 ----------
    def _send_json(self, obj, code=200):
        body = clean_text(json.dumps(obj, ensure_ascii=False)).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _emit(self, obj):
        self.wfile.write((clean_text(json.dumps(obj, ensure_ascii=False)) + "\n").encode("utf-8"))
        self.wfile.flush()

    def _begin_ndjson(self):
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.end_headers()
        except OSError:
            self._gone = True

    def _say(self, obj):
        """往页面推一行事件。页面断开后不再写、也不抛错：提问照常跑完存盘；翻译靠 _client_gone 发现断开并中止"""
        with self._say_lock:
            if self._gone:
                return
            try:
                self._emit(obj)
            except OSError:
                self._gone = True

    def _client_gone(self):
        """页面那一端已经断开（中止请求、关页）：请求体早读完了，连接上再读到东西只会是 EOF"""
        try:
            ready, _, _ = select.select([self.connection], [], [], 0)
            return bool(ready) and self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def _body(self):
        raw = self.headers.get("Content-Length")
        if raw is None:
            raise BadRequest("请求缺少 Content-Length", 411)
        if not (raw.isascii() and raw.isdigit() and len(raw) <= 10):
            raise BadRequest("Content-Length 不对")
        n = int(raw)
        if n > MAX_BODY:
            raise BadRequest("请求体太大", 413)
        try:
            data = self.rfile.read(n)
        except (TimeoutError, socket.timeout):  # 3.10 起 socket.timeout 才是 TimeoutError 的别名，正式服务跑在 3.9 上
            raise BadRequest("请求读取超时", 408)
        if len(data) < n:
            raise BadRequest("请求体不完整")
        if not data:
            return {}
        try:
            body = json.loads(data.decode("utf-8"), parse_constant=_no_constant, parse_float=_finite_float)
        except (ValueError, RecursionError):  # JSON 语法、坏 UTF-8、NaN、超长整数、嵌套过深
            raise BadRequest("请求体不是合法 JSON")
        if not isinstance(body, dict):
            raise BadRequest("请求体要是 JSON 对象")
        if re.search(rb"\\u[dD][89a-fA-F]", data):
            body = _scrub(body)
        return body

    def _guarded(self, fn):
        """路由的总兜底：校验不过回 400，其余意外异常回 500 并写日志，不让连接直接断掉"""
        try:
            fn()
        except BadRequest as e:
            if not self._head_sent:
                self._send_json({"error": e.msg}, e.code)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout):
            pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            sys.stderr.flush()
            msg = f"服务端出错了（{type(e).__name__}），详情在服务日志里"
            try:
                if not self._head_sent:
                    self._send_json({"error": msg}, 500)
                elif self._ndjson:
                    self._say({"type": "error", "message": msg})
            except OSError:
                pass

    # ---------- 路由 ----------
    def do_GET(self):
        self._guarded(self._get)

    def _get(self):
        if not self._host_ok():
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        key = q.get("file", [""])[0]
        if url.path == "/api/ping":
            return self._send_json({"ok": True, "quarantined": quarantined_names()})
        if url.path == "/api/state":
            return self._send_json(read_json(STATE, {}))
        if url.path == "/api/library":
            return self._send_json(read_json(PROGRESS, {}))
        if url.path == "/api/book":
            # 打开一本书时取：上次读到的页 + 已有划线
            return self._send_json({
                "page": read_json(PROGRESS, {}).get(key, {}).get("page", 1),
                "highlights": read_json(HIGHLIGHTS, {}).get(key, []),
            })
        if url.path == "/api/desk":
            # 书架上「正在读」那本的卡片：划线数、提问数（含收进历史的）、最近划的一句，
            # 以及阅读器里正开着这本时当前页的开头（没划过线的书，卡片上显示「读到这里」）
            hls = [h for h in read_json(HIGHLIGHTS, {}).get(key, []) if isinstance(h, dict)]
            last = max((h for h in hls if h.get("text")), key=lambda h: h.get("at") or "", default=None)
            asked = sum(1 for c in read_json(archive_path(key), []) if isinstance(c, dict)
                        for m in c.get("messages", []) if m.get("role") == "user")
            asked += sum(1 for m in read_json(CHATS, {}).get(key, {}).get("messages", []) if m.get("role") == "user")
            cur = read_json(STATE, {})
            excerpt = None
            if cur.get("file") == key and cur.get("pageText"):
                text = re.sub(r"\s+", " ", re.sub(r"【第 \d+ 页】", " ", cur["pageText"])).strip()
                if text:
                    excerpt = {"text": text[:200], "page": cur.get("page")}
            return self._send_json({
                "highlights": len(hls), "questions": asked,
                "last": {"text": last["text"], "page": last.get("page"), "at": last.get("at")} if last else None,
                "excerpt": excerpt,
            })
        if url.path == "/api/chat":
            # messages 是当前这段对话；asked 是这本书问过的全部问题（含收进历史的），导读找「你问过的」用；
            # inflight 是这本书正在跑的提问（页面刷新后据此接回），没有就是 null；cid 是当前这段对话的身份（还没问过就是 null），删单条问答时带上
            entry = read_json(CHATS, {}).get(key) or {}
            current = entry.get("messages", [])
            asked = [{"text": m.get("text", ""), "page": m.get("page")} for c in read_json(archive_path(key), [])
                     for m in c.get("messages", []) if m.get("role") == "user"]
            asked += [{"text": m.get("text", ""), "page": m.get("page")} for m in current if m.get("role") == "user"]
            # busyElsewhere：别的书有提问在跑（同一时间只跑一个），页面据此在发问前就说明「为什么发不了」
            other = next((k for k in list(ask_inflight) if k != key), None)
            busy = None if other is None else {"file": other, "title": ask_titles.get(other) or _title_of(other)}
            return self._send_json({"messages": current, "asked": asked, "inflight": ask_inflight.get(key), "busyElsewhere": busy, "cid": entry.get("cid")})
        if url.path == "/api/chat/history":
            # 不带 id：只给列表（标题、时间、问了几次），点开哪段再取哪段的全文，历史再多也不拖慢
            convs = read_json(archive_path(key), [])
            cid = q.get("id", [""])[0]
            if cid:
                hit = next((c for c in convs if c.get("id") == cid), None)
                return self._send_json({"conversation": hit} if hit else {"error": "没有这段对话"}, 200 if hit else 404)
            items = [{k: c.get(k) for k in ("id", "title", "startedAt", "endedAt", "count")} for c in reversed(convs)]
            return self._send_json({"items": items})
        if url.path == "/api/ocr":
            # 先问缓存；没有的话页面再渲染高清图 POST 过来
            page = q.get("page", [""])[0]
            if not re.fullmatch(r"[0-9]{1,6}", page):  # str.isdigit 把上标 ² 也算数字，int() 却转不了
                return self._send_json({"error": "bad page"}, 400)
            return self._send_json(read_json(ocr_cache(key, int(page)), {"cached": False}))
        fn = ROUTES.get(("GET", url.path))
        if fn:
            return fn(self, {k: v[0] for k, v in q.items()})
        return super().do_GET()

    def do_POST(self):
        self._guarded(self._post)

    def _post(self):
        if not (self._host_ok() and self._write_ok()):
            return
        body = self._body()
        path = urlparse(self.path).path
        if path == "/api/ask":
            return self._ask(body)
        if path == "/api/ocr":
            return self._ocr(body)
        if path == "/api/translate":
            return self._translate(body)
        with data_lock:
            if path == "/api/state":
                return self._save_state(clean_state(body))
            if path == "/api/highlight":
                key, item = _text(body.get("file"), "file", 2000), clean_highlight(body.get("highlight"))
                if not key:
                    raise BadRequest("缺少 file")
                allh = read_json(HIGHLIGHTS, {})
                allh.setdefault(key, []).append(item)
                write_json(HIGHLIGHTS, allh)
                if item.get("kind") == "region" and hasattr(CTX, "restore_region_image"):
                    CTX.restore_region_image(item.get("image"))  # 删除后「撤销」写回时，把区域图从回收站放回来
                return self._send_json({"ok": True})
            if path == "/api/highlight/delete":
                # 新划线按页面给的 id 删；旧划线没有 id，按写入时间加原文认
                key = _text(body.get("file", ""), "file", 2000)
                hid, at, text = body.get("id"), body.get("at"), body.get("text")
                for name, v in (("id", hid), ("at", at), ("text", text)):
                    if v is not None:
                        _text(v, name, 1000 if name != "text" else MAX_SELECTED)
                allh = read_json(HIGHLIGHTS, {})
                if key not in allh or not (hid or at):
                    return self._send_json({"ok": True, "removed": 0, "removed_items": []})
                same = (lambda h: h.get("id") == hid) if hid else (lambda h: h.get("at") == at and h.get("text") == text)
                items = allh[key]
                gone = [h for h in items if same(h)]
                allh[key] = [h for h in items if not same(h)]
                write_json(HIGHLIGHTS, allh)
                if hasattr(CTX, "trash_region_image"):
                    for h in gone:
                        if h.get("kind") == "region":
                            CTX.trash_region_image(h.get("image"))
                # removed_items：被删的整条（含另一个窗口刚写的眉批），页面「撤销」时写回的是这份，不是自己内存里可能过期的那份
                return self._send_json({"ok": True, "removed": len(gone), "removed_items": gone})
            if path == "/api/page-image":
                return self._save_page_image(body)
            if path == "/api/chat/reset":
                # 新对话：当前这段收进历史（不删），Claude 换一个新会话
                key = _text(body.get("file", ""), "file", 2000)
                chats = read_json(CHATS, {})
                archived = archive_current(chats, key) is not None
                write_json(CHATS, chats)
                return self._send_json({"ok": True, "archived": archived})
            if path == "/api/chat/restore":
                return self._chat_restore(body)
            if path == "/api/chat/delete":
                return self._chat_delete(body)
            if path == "/api/chat/restore-turn":
                return self._chat_restore_turn(body)
        fn = ROUTES.get(("POST", path))
        if fn:
            return fn(self, body)
        return self._send_json({"error": "not found"}, 404)

    # ---------- 历史对话放回当前、删单条问答（调用方已持有 data_lock）----------
    def _chat_restore(self, body):
        """把存档里的一段放回当前对话，Claude 会话也接上；当前对话已有内容就先收进历史。取走的那段从历史里拿掉"""
        key = _text(body.get("file", ""), "file", 2000)  # 空串是书架上的「全库」那段对话，合法
        cid = _text(body.get("id", ""), "id", 200)
        if not cid:
            raise BadRequest("缺少 id")
        chats = read_json(CHATS, {})
        conv = next((c for c in read_json(archive_path(key), []) if isinstance(c, dict) and c.get("id") == cid), None)
        if conv is None:
            if (chats.get(key) or {}).get("cid") == cid:  # 已经是当前对话（连点了两下）
                return self._send_json({"ok": True, "restored": False, "already": True})
            return self._send_json({"error": "没有这段对话"}, 404)
        if key in ask_inflight:  # 回答期间换掉当前对话，这一问的答案就落进被收起的那段里，界面上看不见
            return self._send_json({"error": "Claude 还在回答这本书里的提问，答完再接着聊旧的对话"}, 409)
        archived = archive_current(chats, key) is not None
        rest = [c for c in read_json(archive_path(key), []) if not (isinstance(c, dict) and c.get("id") == cid)]
        write_json(archive_path(key), rest)
        msgs = conv.get("messages") if isinstance(conv.get("messages"), list) else []
        chats[key] = {"messages": msgs, "cid": cid, "session": conv.get("session")}
        write_json(CHATS, chats)
        return self._send_json({"ok": True, "restored": True, "archived": archived, "count": sum(1 for m in msgs if m.get("role") == "user"),
                                "session": bool(conv.get("session"))})

    def _chat_delete(self, body):
        """删当前对话里的一问一答：按提问那条的 at 认，连同紧跟的回答。cid 给了就必须是当前这段对话，对不上不删。
        回包带被删的消息和位置，页面「撤销」时原样交给 /api/chat/restore-turn。Claude 会话里那一轮仍在，这里只管记录"""
        key = _text(body.get("file", ""), "file", 2000)
        at = _text(body.get("at", ""), "at", 100)
        cid = body.get("cid")
        if cid is not None:
            _text(cid, "cid", 200)
        if not at:
            raise BadRequest("缺少 at")
        chats = read_json(CHATS, {})
        entry = chats.get(key)
        if not isinstance(entry, dict) or (cid and entry.get("cid") != cid):
            return self._send_json({"ok": True, "removed": 0})
        msgs = entry.get("messages") if isinstance(entry.get("messages"), list) else []
        i = next((i for i, m in enumerate(msgs) if isinstance(m, dict) and m.get("role") == "user" and m.get("at") == at), None)
        if i is None:
            return self._send_json({"ok": True, "removed": 0})
        j = i + 2 if i + 1 < len(msgs) and isinstance(msgs[i + 1], dict) and msgs[i + 1].get("role") == "assistant" else i + 1
        gone = msgs[i:j]
        entry["messages"] = msgs[:i] + msgs[j:]
        write_json(CHATS, chats)
        return self._send_json({"ok": True, "removed": 1, "index": i, "cid": entry.get("cid"), "messages": gone})

    def _chat_restore_turn(self, body):
        """撤销删除：把 /api/chat/delete 回给页面的那一问一答放回原来的位置。当前对话已经换了就放不回去"""
        key = _text(body.get("file", ""), "file", 2000)
        cid = body.get("cid")
        if cid is not None:
            _text(cid, "cid", 200)
        index = _int(body.get("index"), "index", 0, 1000000)
        raw = body.get("messages")
        if not isinstance(raw, list) or not 1 <= len(raw) <= 2:
            raise BadRequest("messages 要是 1 到 2 条消息")
        msgs = []
        for m in raw:
            if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
                raise BadRequest("消息要有 role")
            item = {"role": m["role"], "text": _text(m.get("text"), "text", MAX_TURN_TEXT), "at": _text(m.get("at"), "at", 100)}
            if "page" in m and type(m["page"]) is int:
                item["page"] = m["page"]
            if isinstance(m.get("quote"), dict):
                item["quote"] = m["quote"]
            if isinstance(m.get("attachments"), list):
                item["attachments"] = [{"url": a["url"]} for a in m["attachments"] if isinstance(a, dict) and isinstance(a.get("url"), str)][:6]
            if isinstance(m.get("interrupted"), str):
                item["interrupted"] = m["interrupted"][:1000]
            msgs.append(item)
        chats = read_json(CHATS, {})
        entry = chats.get(key)
        if not isinstance(entry, dict) or (cid and entry.get("cid") != cid):
            return self._send_json({"error": "这段对话已经收进历史或换掉了，放不回去"}, 409)
        cur = entry.get("messages") if isinstance(entry.get("messages"), list) else []
        if any(isinstance(m, dict) and m.get("role") == "user" and m.get("at") == msgs[0]["at"] for m in cur):
            return self._send_json({"ok": True, "restored": False})  # 已经在了（撤销点了两下）
        at = min(index, len(cur))
        entry["messages"] = cur[:at] + msgs + cur[at:]
        write_json(CHATS, chats)
        return self._send_json({"ok": True, "restored": True})

    def _save_state(self, new):
        state = read_json(STATE, {})
        if new["file"] != state.get("file"):
            state = {}  # 换书了，旧划线不再算当前上下文
        state.update(new)
        state["updatedAt"] = now_iso()
        if new.get("selection"):
            state["selection"]["at"] = state["updatedAt"]
        write_json(STATE, state)
        if state.get("file") and state.get("page"):
            prog = read_json(PROGRESS, {})
            prog[state["file"]] = {
                "page": state["page"], "numPages": state.get("numPages"),
                "title": state.get("title"), "at": state["updatedAt"],
            }
            write_json(PROGRESS, prog)
        return self._send_json({"ok": True})

    def _save_page_image(self, body):
        # 扫描版没有文字层：存下当前页的渲染图，hook 让 Claude 直接看图。
        # 双页阅读时右页（阅读状态里的 pageTo）存另一张，不盖掉左页
        key, page = _text(body.get("file", ""), "file", 2000), _int(body.get("page"), "page")
        raw = jpeg_bytes(body.get("dataUrl"))
        state = read_json(STATE, {})
        right = state.get("file") == key and page == state.get("pageTo") and page != state.get("page")
        img, field = (DATA / "page2.jpg", "pageImage2") if right else (DATA / "page.jpg", "pageImage")
        img.write_bytes(raw)
        if state.get("file") == key:
            state[field] = {"page": page, "path": str(img), "at": now_iso()}
            write_json(STATE, state)
        return self._send_json({"ok": True})

    # ---------- 扫描页识别：macOS Vision，返回每行文字和位置 ----------
    def _ocr(self, body):
        key, page = _text(body.get("file", ""), "file", 2000), _int(body.get("page"), "page")
        cache = ocr_cache(key, page)
        force = _flag(body.get("force"))  # 页角的「重新识别」：跳过缓存重识别一遍，成功了覆盖缓存，失败了旧缓存原样留着
        cached = None if force else read_json(cache, None)
        if cached is not None:
            return self._send_json(cached)
        if not isinstance(body.get("dataUrl"), str):
            raise BadRequest("缺少要识别的页图（dataUrl）")  # 没有缓存可走、或 force 重识别时，必须带图
        raw = jpeg_bytes(body.get("dataUrl"))
        if not OCR_BIN.exists():
            return self._send_json({"error": "识别工具还没编译，在伴读目录运行 ./install.sh"}, 503)
        # 临时图放系统临时目录：识别途中服务被重启时，不在数据目录里留整页图
        with ocr_slots, tempfile.NamedTemporaryFile(suffix=".jpg") as img:
            img.write(raw)
            img.flush()
            try:
                r = subprocess.run([str(OCR_BIN), img.name], capture_output=True, timeout=60)
            except subprocess.TimeoutExpired:
                return self._send_json({"error": "识别超时"}, 504)
        if r.returncode != 0:
            return self._send_json({"error": r.stderr.decode("utf-8", "replace").strip()[-300:]}, 500)
        try:
            result = json.loads(r.stdout)
        except ValueError:
            return self._send_json({"error": "识别结果读不出来"}, 500)
        cache.parent.mkdir(parents=True, exist_ok=True)
        write_json(cache, result)
        return self._send_json(result)

    # ---------- 中英对照：一页的段落分组并行交给 Claude 翻译，逐段流回页面 ----------
    def _translate(self, body):
        key, title = _text(body.get("file") or "", "file", 2000), _text(body.get("title") or "", "title", 1000)
        page, paras = _int(body.get("page"), "page"), body.get("paragraphs")
        if not isinstance(paras, list) or not all(isinstance(p, str) for p in paras):
            raise BadRequest("paragraphs 要是文字数组")
        if len(paras) > TRANSLATE_MAX_PARAS or sum(map(len, paras)) > TRANSLATE_MAX_CHARS:
            raise BadRequest("这一页的文字太多，翻译不了", 413)
        force = _flag(body.get("force"))  # 译文块的「重译」：跳过缓存重新译，译完覆盖
        # 重译一段时，页面带上整页的段落（pageParagraphs）和这段在其中的序号（index）：译完把整页缓存里这一段也换成新译文，
        # 否则翻走再翻回来，读到的还是整页缓存里的旧译文
        whole, at = body.get("pageParagraphs"), body.get("index")
        if whole is not None and (not isinstance(whole, list) or not all(isinstance(p, str) for p in whole)
                                  or len(whole) > TRANSLATE_MAX_PARAS or sum(map(len, whole)) > TRANSLATE_MAX_CHARS):
            raise BadRequest("pageParagraphs 要是文字数组，且不能超过一页的上限")
        if at is not None:
            _int(at, "index", 0, TRANSLATE_MAX_PARAS)
        self._begin_ndjson()
        if not paras:
            return self._say({"type": "done"})
        digest = _para_digest(paras)
        cache = TRANSLATE_DIR / book_hash(key) / f"{page}-{digest}.json"
        cached = None if force else read_json(cache, None)
        if isinstance(cached, list) and len(cached) == len(paras):
            for i, text in enumerate(cached):
                self._say({"type": "para", "i": i, "text": text})
            return self._say({"type": "done"})
        # 一组一个 Claude 进程同时译：一个进程从头译到尾，一页要半分钟
        groups, size = [[]], 0
        for i, text in enumerate(paras):
            if groups[-1] and size + len(text) > TRANSLATE_GROUP_CHARS:
                groups.append([])
                size = 0
            groups[-1].append(i)
            size += len(text)
        out, errors = [""] * len(paras), []
        cancel = threading.Event()  # 页面中止请求（关掉对照、换书、关窗口）时置位：排队的组不再启动，在跑的 claude 立刻杀掉

        def work(idx):
            def on_para(k, text):
                out[idx[k]] = text
                self._say({"type": "para", "i": idx[k], "text": text})
            while not translate_slots.acquire(timeout=0.3):  # 排队时也盯着取消
                if cancel.is_set():
                    return
            try:
                if cancel.is_set():
                    return
                err = self._run_translate(title, page, [paras[i] for i in idx], on_para, cancel)
            except Exception as e:  # noqa: BLE001 线程里的意外异常也要记成失败：否则空译文会被当成译完写进缓存
                traceback.print_exc()
                err = f"翻译出错（{type(e).__name__}）"
            finally:
                translate_slots.release()
            if err:
                errors.append(err)

        threads = [threading.Thread(target=work, args=(g,), daemon=True) for g in groups]
        for t in threads:
            t.start()
        while any(t.is_alive() for t in threads):
            time.sleep(0.2)
            if not cancel.is_set() and (self._gone or self._client_gone()):
                cancel.set()
        if cancel.is_set():
            return  # 这一页没译完就不写缓存
        if errors:
            return self._say({"type": "error", "message": errors[0]})
        cache.parent.mkdir(parents=True, exist_ok=True)
        write_json(cache, out)
        if force and whole and len(paras) == 1 and at is not None and at < len(whole) and whole[at] == paras[0] and out[0]:
            page_cache = TRANSLATE_DIR / book_hash(key) / f"{page}-{_para_digest(whole)}.json"
            full = read_json(page_cache, None)
            if isinstance(full, list) and len(full) == len(whole):
                full[at] = out[0]
                write_json(page_cache, full)
        self._say({"type": "done"})

    def _run_translate(self, title, page, paras, on_para, cancel):
        buf, current, sent = "", None, set()
        prompt = f"以下段落来自《{title}》第 {page} 页。\n\n" + "\n\n".join(f"§{i + 1}\n{p}" for i, p in enumerate(paras))

        def finish(i, text):
            if 0 <= i < len(paras) and i not in sent:
                sent.add(i)
                text = text.strip()
                on_para(i, "" if text in ("-", "－", "—") else text)

        def flush(upto_end):
            # 每看到下一个 §编号，上一段就译完了，立刻推给页面
            nonlocal buf, current
            while True:
                # 编号后面要跟着非数字才算完整（流式输出时「§1」可能是「§12」的前半截）
                m = re.search(r"^§(\d+)(?=\D)[ \t]*\n?", buf, re.M)
                if not m:
                    break
                if current is not None:
                    finish(current, buf[:m.start()])
                current, buf = int(m.group(1)) - 1, buf[m.end():]
            if upto_end and current is not None:
                finish(current, buf)
                current, buf = None, ""

        def on_text(t):
            nonlocal buf
            buf += t
            flush(False)

        _, error = claude_once(TRANSLATE_SYSTEM, prompt, model=TRANSLATE_MODEL, timeout=ASK_TIMEOUT, on_text=on_text, cancel=cancel)
        flush(True)
        if not error and len(sent) < len(paras):
            error = "有段落没译出来"
        return error

    # ---------- 提问：转给 Claude Code，逐字流回页面 ----------
    def _ask(self, body):
        question, key = body.get("question") or "", body.get("file") or ""
        if not isinstance(question, str) or not isinstance(key, str):
            raise BadRequest("question、file 要是文字")
        if len(question) > 50000 or len(key) > 2000:
            raise BadRequest("问题太长")
        question = question.strip()
        attachments = valid_attachments(body.get("attachments"))
        if not question and attachments:
            question = "看看这张图"
        if not question:
            return self._send_json({"error": "问题是空的"}, 400)
        prompt = question
        if attachments:
            prompt += "\n\n（用户附了图片，回答前先用 Read 工具看图：" + "；".join(a["path"] for a in attachments) + "）"
        if not ask_lock.acquire(blocking=False):
            return self._send_json({"error": "Claude 还在回答上一个问题"}, 409)
        snap_path = None
        try:
            ask_inflight[key] = {"question": question, "at": now_iso()}
            title = (body.get("context") or {}).get("title") if isinstance(body.get("context"), dict) else None
            ask_titles[key] = title.strip()[:200] if isinstance(title, str) else ""
            self._begin_ndjson()
            ctx_env, snap, snap_path = self._ask_snapshot(key, body)
            sel = (snap or {}).get("selection") or {}
            with data_lock:
                quote = quote_of(sel, hit_of(read_json(HIGHLIGHTS, {}), key, sel))
            if quote:  # 这一问对着的那段：页面据此把问、答排进那句划线的一组；刷新后从 inflight 接回时也带上
                ask_inflight[key]["quote"] = quote
                self._say({"type": "quote", "quote": quote})
            with data_lock:
                chats = read_json(CHATS, {})
                entry = chats.get(key)
                if entry is not None and not entry.get("cid"):
                    entry["cid"] = new_cid()  # 对话的身份：回答期间对话被收进历史时，靠它找到该补进哪一段
                    write_json(CHATS, chats)
                resumed = entry.get("session") if entry else None
                cid = entry.get("cid") if entry else None
            answer, session, error = self._run_claude(prompt, resumed, ctx_env)
            if error and not answer and resumed and SESSION_GONE in error:
                # 只有会话确实没了（被清理或换了机器）才开新会话重问；临时错误（过载、网络）换会话会丢掉全部上下文
                answer, session, error = self._run_claude(prompt, None, ctx_env)
            if error and not answer:
                return self._say({"type": "error", "message": error})
            now = now_iso()
            page = (snap or {}).get("page")  # 提问时读到哪页，导读按章筛历史用
            msgs = [
                {"role": "user", "text": question, "at": now, **({"page": page} if page else {}),
                 **({"attachments": [{"url": a.get("url", "")} for a in attachments]} if attachments else {}),
                 **({"quote": quote} if quote else {})},
                {"role": "assistant", "text": answer, "at": now, **({"interrupted": error} if error else {})},
            ]
            with data_lock:
                saved_cid = save_turn(key, cid, msgs, session)
                # 问的是一条划线时，在划线记录上标「问过」，导图据此给节点加外圈
                hls = read_json(HIGHLIGHTS, {})
                hit = hit_of(hls, key, sel)
                if hit and not hit.get("asked"):
                    hit["asked"] = True
                    write_json(HIGHLIGHTS, hls)
            if error:  # 出错前已有半截回答：存了，并让页面标明不完整
                self._say({"type": "interrupted", "message": error})
            self._say({"type": "done", "at": now, "cid": saved_cid})  # at、cid：这一轮存盘的时间和落进的对话，页面凭它们认出这一轮（删单条问答）
            fire_after_turn({
                "file": key, "title": ask_titles.get(key) or _title_of(key), "question": question, "answer": answer, "page": page,
                "quote": quote, "at": now, "cid": saved_cid, "interrupted": error or None,
            })
        finally:
            ask_inflight.pop(key, None)
            ask_titles.pop(key, None)
            if snap_path:
                snap_path.unlink(missing_ok=True)
            ask_lock.release()

    def _ask_snapshot(self, key, body):
        """提问时页面看到的阅读状态，写成本次专用的快照文件，交给 hook 读，不再读全局 current.json
        （发问后换书、两个窗口各读一本时，全局状态是另一本书的）。
        返回 (READER_CONTEXT 的值, 快照内容, 快照文件)；值为 None 表示让 hook 照旧读 current.json。"""
        cur = read_json(STATE, {})
        if "context" not in body:
            # 旧页面不带快照：current.json 恰好是这本书才沿用，对不上宁可不注入
            return (None, cur, None) if cur.get("file") == key else ("none", None, None)
        try:
            snap = clean_state(body["context"], lenient=True)  # 单个字段超长或不合格只截断、丢弃那一个，书名页码照常交给 Claude
        except BadRequest:  # null（没开书）、file 为空
            return "none", None, None
        if snap["file"] != key:
            return "none", None, None
        snap["updatedAt"] = now_iso()
        same_book = cur.get("file") == key
        sel, cur_sel = snap.get("selection"), cur.get("selection") if same_book else None
        if sel:
            seen = isinstance(cur_sel, dict) and cur_sel.get("text") == sel.get("text") and cur_sel.get("page") == sel.get("page")
            # 页面的 selection 不带 at：同一句划线沿用服务端记下的划线时间，其余（或时间格式不对）补当前时间，hook 靠它算「几分钟前」
            sel["at"] = cur_sel["at"] if seen and _iso_ok(cur_sel.get("at")) else snap["updatedAt"]
        img = cur.get("pageImage") if same_book else None
        if isinstance(img, dict) and img.get("page") == snap.get("page"):
            snap["pageImage"] = img
        img2 = cur.get("pageImage2") if same_book else None
        if isinstance(img2, dict) and img2.get("page") == snap.get("pageTo") and snap.get("pageTo") != snap.get("page"):
            snap["pageImage2"] = img2
        ASK_CONTEXT_DIR.mkdir(exist_ok=True)
        path = ASK_CONTEXT_DIR / f"{secrets.token_hex(8)}.json"
        write_json(path, snap)
        return str(path), snap, path

    def _run_claude(self, question, session, ctx_env):
        cmd = [CLAUDE_BIN, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
               "--strict-mcp-config", "--allowedTools", ALLOWED_TOOLS, "--disallowedTools", DENIED_TOOLS]
        if session:
            cmd += ["--resume", session]
        # hook 按这两个找阅读状态和读者档案；沙盒实例时指向沙盒目录。显式传，不靠 hook 继承服务进程的环境
        env = _claude_env(READER_DATA=str(DATA), READER_LEARNER=str(LEARNER))
        env.pop("READER_CONTEXT", None)
        if ctx_env:
            env["READER_CONTEXT"] = ctx_env
        parts = []
        # 模型偶尔在思考或调用工具前先吐一小段文本块：一两个字的杂字（实测出现过「um」「е」），或「的Read the image.」这样的半句自言自语，
        # 正文在后面。文本块先扣住：超过 HOLD 个字（去掉首尾空白算）或带换行才开始逐字推送；整块都没超过就等下一块，
        # 下一块是思考或工具调用则丢掉，是正文则照常补发；整个回答就这么短（比如「好的」）也照常给。
        # 超过 HOLD 字或分了行的，是真在讲解，哪怕后面跟着工具调用也留着
        HOLD = 40
        block = None       # 当前文本块里还没推送的字；None 表示当前不是文本块
        streaming = False  # 当前文本块是否已经开始推送
        pending = ""       # 已结束、还没决定去留的短文本块

        def commit(text, new_block):
            if new_block and parts:
                text = "\n\n" + text  # 和上一段之间空一行
            parts.append(text)
            self._say({"type": "delta", "text": text})

        joiner = TextJoiner()

        def push(text):
            nonlocal block, streaming
            if block is None:
                block, streaming = "", False
            if streaming:
                commit(text, False)
            else:
                block += text
                held = block.strip()
                if len(held) > HOLD or "\n" in held:
                    commit(block, True)
                    streaming = True

        def flush_held():
            held = joiner.flush()
            if held:
                push(held)

        def on_event(ev):
            nonlocal block, streaming, pending
            if ev.get("type") != "stream_event":
                return
            e = ev.get("event") or {}
            etype = e.get("type")
            if etype == "content_block_start":
                flush_held()
                cb = e.get("content_block") or {}
                if cb.get("type") == "text":
                    if pending:
                        commit(pending, True)
                    block, streaming, pending = "", False, ""
                else:
                    pending, block = "", None
                    if cb.get("type") == "tool_use":
                        self._say({"type": "tool", "name": cb.get("name")})
            elif etype == "content_block_delta" and (e.get("delta") or {}).get("type") == "text_delta":
                raw = e["delta"].get("text")
                if not isinstance(raw, str):
                    return
                text = joiner.feed(raw)
                if text:
                    push(text)
            elif etype == "content_block_stop":
                flush_held()
                if block is not None and not streaming and block.strip():
                    pending = block
                block = None

        # 问题走 stdin，避免以「-」开头时被当成命令行参数
        try:
            session, error = run_claude(cmd, question, ROOT, env, on_event, ASK_TIMEOUT, session)
        except Exception as e:  # noqa: BLE001 进程已由 run_claude 收掉；已有的半截回答照样交给调用方存盘
            traceback.print_exc()
            error = f"服务出错（{type(e).__name__}）"
        flush_held()
        if pending:
            commit(pending, True)  # 整个回答就这么短（比如「好的」），照常给
        elif block is not None and not streaming and block.strip():
            commit(block, True)  # 流在文本块中间断了（出错、超时），扣着的这一小段也是回答的一部分
        return "".join(parts).strip(), session, error


def _title_of(file):
    """页面没给书名时的替代：文件名最后一段去掉 .pdf"""
    return re.sub(r"\.pdf$", "", file.rsplit("/", 1)[-1], flags=re.I)


def new_cid():
    return uuid.uuid4().hex[:12]


def hit_of(hls, key, sel):
    """selection 对应划线库里的哪一条：同页、同文字的最后一条；不是划线（导读里「接着问」的那段）返回 None"""
    return next((h for h in reversed(hls.get(key, [])) if sel.get("text") and h.get("text") == sel.get("text") and h.get("page") == sel.get("page")), None)


QUOTE_CHARS = 2000  # 记在提问上的划线原文最多留多少字：对话栏只显示前几行，跳回原文按划线 id 或开头几十字找


def quote_of(sel, hit):
    """这一问是对着哪段问的：提问时 Claude 看到的划线、框选，或导读、导图里「接着问」的那段。
    记在提问上，对话栏据此把划线、问题、回答排成一组，点它跳回书页上那个位置。没划线直接问的返回 None。
    hit 是划线库里对应的那条：有它就记下 id（跳回时按位置找），框选的缩略图也取它的（selection 里存的是本机路径）"""
    text = sel.get("text") if isinstance(sel.get("text"), str) else ""
    page = sel.get("page")
    if not text.strip() or type(page) is not int:
        return None
    quote = {"text": text[:QUOTE_CHARS], "page": page}
    if isinstance(sel.get("kind"), str) and sel["kind"]:
        quote["kind"] = sel["kind"]
    if hit:
        if hit.get("id"):
            quote["hl"] = hit["id"]
        if isinstance(hit.get("image"), str) and hit["image"]:
            quote["image"] = hit["image"]
    return quote


def archive_current(chats, key):
    """把这本书的当前对话收进历史：从 chats 里拿掉，追加到存档文件。调用方持有 data_lock，并负责把 chats 写回。
    返回收进去的那一段；当前对话里没有消息时什么都不存、返回 None"""
    old = chats.pop(key, None) or {}
    msgs = old.get("messages") or []
    if not msgs:
        return None
    first = next((m.get("text", "") for m in msgs if m.get("role") == "user"), "")
    conv = {
        "id": old.get("cid") or new_cid(), "title": " ".join(first.split())[:40] or "（没有提问）",
        "startedAt": msgs[0].get("at"), "endedAt": msgs[-1].get("at"),
        "count": sum(1 for m in msgs if m.get("role") == "user"),
        "session": old.get("session"), "messages": msgs,
    }
    CHAT_ARCHIVE.mkdir(parents=True, exist_ok=True)
    convs = read_json(archive_path(key), [])
    convs.append(conv)
    write_json(archive_path(key), convs)
    return conv


def save_turn(key, cid, msgs, session):
    """存一轮问答，返回它落进的那段对话的 id。cid 是开问时这段对话的身份；回答期间对话被另一个窗口收进历史了，
    就补进那一段，不动新对话（否则这一问成了新对话的第一条，还把新对话接回旧的 Claude 会话）。调用方持有 data_lock"""
    chats = read_json(CHATS, {})
    entry = chats.get(key)
    if (entry.get("cid") if entry else None) == cid:
        entry = chats.setdefault(key, {"messages": []})
        entry.setdefault("cid", new_cid())
        entry["session"] = session
        entry["messages"] += msgs
        write_json(CHATS, chats)
        return entry["cid"]
    convs = read_json(archive_path(key), [])
    conv = next((c for c in convs if c.get("id") == cid), None) if cid else None
    if conv is None:
        first = msgs[0].get("text", "")
        conv = {"id": cid or new_cid(), "title": " ".join(first.split())[:40], "startedAt": msgs[0].get("at"), "messages": []}
        convs.append(conv)
    conv["messages"] += msgs
    conv["endedAt"] = msgs[-1].get("at")
    conv["count"] = sum(1 for m in conv["messages"] if m.get("role") == "user")
    conv["session"] = session
    CHAT_ARCHIVE.mkdir(parents=True, exist_ok=True)
    write_json(archive_path(key), convs)
    return conv["id"]


# ---------- 一轮问答落盘之后的回调：功能模块用 ctx.after_turn(fn) 登记 ----------
AFTER_TURN = []


def after_turn(fn):
    """登记回调 fn(turn)：每一轮问答存盘、页面收到 done 之后，为每个回调起一个守护线程调用，互不等待。
    turn = {file, title, question, answer, page, quote, at, cid, interrupted}（interrupted 是出错原因，正常答完为 None）。
    回调抛什么都只记日志，不影响回答和别的回调；每个回调拿到的是自己的一份拷贝；要读写数据文件先拿 ctx.data_lock"""
    if not callable(fn):
        raise TypeError("after_turn 要传一个可调用对象")
    AFTER_TURN.append(fn)
    return fn


def _run_after_turn(fn, turn):
    try:
        fn(turn)
    except Exception:  # noqa: BLE001 回调是别的模块写的，任何错误只记日志
        print(f"after_turn 回调 {getattr(fn, '__qualname__', fn)} 出错：", file=sys.stderr, flush=True)
        traceback.print_exc()
        sys.stderr.flush()


def fire_after_turn(turn):
    for fn in list(AFTER_TURN):
        try:
            threading.Thread(target=_run_after_turn, args=(fn, copy.deepcopy(turn)), daemon=True).start()
        except Exception:  # noqa: BLE001 起线程、拷贝失败也不能连累这一轮问答
            traceback.print_exc()


def valid_attachments(items):
    """只认数据目录里的图片：附件由功能模块存进 data/ 下，路径不许指到别处"""
    out = []
    for a in items if isinstance(items, list) else []:
        if not isinstance(a, dict) or not isinstance(a.get("path"), str):
            continue
        p = Path(a["path"])
        try:
            p.resolve().relative_to(DATA.resolve())
            ok = p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg"}
        except (ValueError, OSError):  # 路径在数据目录外，或带了 NUL 之类的非法字符
            continue
        if ok:
            url = a.get("url")
            out.append({"path": str(p), "url": url[:1000] if isinstance(url, str) else ""})
    return out[:6]


# ---------- 调 Claude 子进程：提问、翻译、导读、导图都走这里 ----------
# `claude setup-token` 生成的一年期令牌，tools/claude-token.sh 存进来（权限 600）。
# 有它就不靠命令行登录：那份登录会过期、刷不动，后台提问就全报 OAuth 错误
TOKEN_FILE = DATA / "claude-oauth-token"


def _claude_env(**extra):
    env = dict(os.environ)
    env["PATH"] = f"{Path(CLAUDE_BIN).parent}:/usr/local/bin:/usr/bin:/bin:" + env.get("PATH", "")
    try:  # 每次现读：换了令牌不用重启服务，删掉文件就回到命令行登录
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    env.update(extra)
    return env


def _result_error(ev):
    r = ev.get("result")
    if isinstance(r, str) and r.strip():
        return r.strip()
    errs = ev.get("errors")  # 会话找不到这类错误，result 里没有字，原因在 errors 数组里
    if isinstance(errs, list) and errs:
        return "；".join(str(x) for x in errs)
    return ev.get("subtype") or "Claude 返回错误"


def run_claude(cmd, prompt, cwd, env, on_event, timeout, session=None, cancel=None):
    """起一个 claude 子进程，把 prompt 写进 stdin，每读到一个 JSON 事件就调 on_event(ev)。
    不管怎么结束（超时、取消、on_event 抛异常），子进程都在 finally 里收掉。
    返回 (session_id, 错误)；错误为 None 表示正常结束，cancel 置位后半秒内杀进程、错误为「已取消」。"""
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    except OSError as e:  # claude 正被更新替换、路径不对
        return session, f"没能启动 claude：{e.strerror or e}"
    timed_out = threading.Event()

    def on_timeout():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(timeout, on_timeout)
    timer.daemon = True
    timer.start()
    err_tail = [""]

    def drain():
        # stderr 要边跑边读：写满管道（约 64KB）claude 就卡在写上，直到超时
        try:
            for line in proc.stderr:
                err_tail[0] = (err_tail[0] + line)[-2000:]
        except (OSError, ValueError):
            pass

    drainer = threading.Thread(target=drain, daemon=True)
    drainer.start()
    if cancel is not None:
        def watch():  # 模型还在读原文、没吐字时也能停
            while proc.poll() is None:
                if cancel.wait(0.5):
                    proc.kill()
                    return
        threading.Thread(target=watch, daemon=True).start()
    error = None
    try:
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except OSError:
            pass  # claude 一启动就退出时写不进去，下面按退出码和 stderr 报错
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(ev, dict):
                continue
            kind = ev.get("type")
            if (kind == "system" and ev.get("subtype") == "init") or kind == "result":
                session = ev.get("session_id") or session
            if kind == "result" and (ev.get("is_error") or ev.get("subtype") != "success"):
                error = _result_error(ev)
            on_event(ev)
        proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        drainer.join(2)
        for f in (proc.stdout, proc.stderr):
            try:
                f.close()
            except OSError:
                pass
    if cancel is not None and cancel.is_set():
        error = "已取消"
    elif timed_out.is_set():
        error = f"等了 {timeout} 秒还没答完，已中止"
    elif proc.returncode != 0 and not error:
        error = err_tail[0].strip()[-400:] or f"claude 退出码 {proc.returncode}"
    return session, error


def claude_once(system, prompt, model="sonnet", timeout=240, on_text=None, tools="", thinking=False, cancel=None):
    """一次性调 Claude（不带任何 hook 和 CLAUDE.md——伴读的、用户全局的都不带，不留会话记录）。
    on_text 给了就流式回调每段增量文字；cancel 是 threading.Event，置位后半秒内杀掉进程，错误返回「已取消」。
    返回 (全文, 错误)。翻译、导读、导图这类生成任务用。"""
    work = DATA / "claude-work"
    work.mkdir(parents=True, exist_ok=True)
    # 用户全局的 CLAUDE.md、记忆索引和 SessionStart hook 跟翻译一段英文毫无关系，却每个进程都带着：
    # 实测一次翻译输入 22079 token、首字 2.3–3.7 秒；关掉后 835 token、首字 2 秒
    cmd = [CLAUDE_BIN, "-p", "--model", model, "--system-prompt", system, "--tools", tools,
           "--strict-mcp-config", "--setting-sources", "user", "--no-session-persistence",
           "--settings", json.dumps({"enabledPlugins": {"pua@pua-skills": False}, "disableAllHooks": True}),
           "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    env = _claude_env()
    env["CLAUDE_CODE_DISABLE_CLAUDE_MDS"] = "1"
    if not thinking:  # 关掉思考：实测三段翻译从 12 秒降到 4 秒
        env["MAX_THINKING_TOKENS"] = "0"
    parts, joiner = [], TextJoiner()

    def emit_text(text):
        parts.append(text)
        if on_text:
            on_text(text)

    def on_event(ev):
        if ev.get("type") != "stream_event":
            return
        e = ev.get("event") or {}
        delta = e.get("delta") or {}
        if e.get("type") == "content_block_delta" and delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
            text = joiner.feed(delta["text"])
            if text:
                emit_text(text)

    _, error = run_claude(cmd, prompt, work, env, on_event, timeout, cancel=cancel)
    tail = joiner.flush()
    if tail:
        emit_text(tail)
    return "".join(parts), error


# ---------- 功能模块：features/*.py 各自注册路由，写坏一个不影响别的 ----------
ROUTES = {}  # (方法, 路径) -> fn(handler, 参数)；GET 的参数是查询串字典，POST 的是 JSON 请求体


def load_features():
    vars(CTX).update(
        ROOT=ROOT, DATA=DATA, STATE=STATE, PROGRESS=PROGRESS, HIGHLIGHTS=HIGHLIGHTS, CHATS=CHATS,
        read_json=read_json, write_json=write_json, now_iso=now_iso, book_hash=book_hash,
        data_lock=data_lock, claude_once=claude_once, ocr_cache=ocr_cache,
        LEARNER=LEARNER, CHAT_ARCHIVE=CHAT_ARCHIVE, archive_path=archive_path, title_of=_title_of, after_turn=after_turn,
        quarantine=_quarantine, read_json_as=read_json_as,
    )
    for f in sorted((ROOT / "features").glob("*.py")):
        if f.name.startswith("_"):
            continue
        try:
            spec = importlib.util.spec_from_file_location(f"features.{f.stem}", f)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.register(ROUTES, CTX)
            print(f"功能模块已加载：{f.name}", flush=True)
        except Exception as e:  # noqa: BLE001 写坏一个模块只记日志，服务照常起
            print(f"功能模块 {f.name} 加载失败：{e!r}", file=sys.stderr, flush=True)


def main():
    DATA.mkdir(exist_ok=True)
    shutil.rmtree(ASK_CONTEXT_DIR, ignore_errors=True)  # 上次服务被杀时没来得及删的提问快照
    load_features()
    (DATA / "log").mkdir(exist_ok=True)
    # socketserver 的 listen 队列默认只有 5：页面一次并发请求几十个文件（功能模块 + 样式）时，多出来的连接会被直接重置，
    # 控制台里就是随机几个「功能模块加载失败」。加到 128
    ThreadingHTTPServer.request_queue_size = 128
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"伴读：http://127.0.0.1:{PORT}/  claude={CLAUDE_BIN}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
