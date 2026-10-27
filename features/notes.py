"""眉批：划线上读者自己写的一句话。只存在划线库里，不发给 Claude，导出读书笔记时一起走。

POST /api/highlight/note { file, id, note }   → { ok, note }
    note 去首尾空白、最多 4000 字，空串就是删掉这条眉批。
    划线按 id 认；早期的划线没有 id，页面改带 at + text（和删除划线用同一套认法）。
    找不到这条划线（刚被删了，或另一个窗口删的）回 404。

眉批存在划线对象的 note 字段上：server.py 的 clean_highlight 认这个字段，撤销删除时整条写回，眉批跟着回来。
"""

MAX_NOTE = 4000      # 和 server.py 的 MAX_NOTE 一致：存进去的字数不能超过划线库那头认的上限
MAX_FIELD = 2000


def register(routes, ctx):
    def error(h, msg, code=400):
        return h._send_json({"error": msg}, code)

    def text_field(body, name, limit):
        v = body.get(name)
        return v if isinstance(v, str) and len(v) <= limit else None

    def post_note(h, body):
        file = text_field(body, "file", MAX_FIELD)
        if not file:
            return error(h, "缺少 file")
        hid = body.get("id")
        if hid is not None and not (isinstance(hid, str) and len(hid) <= 1000):
            return error(h, "划线 id 格式不对")
        at = body.get("at")
        if at is not None and not (isinstance(at, str) and len(at) <= 1000):
            return error(h, "划线时间格式不对")
        text = body.get("text")
        if text is not None and not isinstance(text, str):
            return error(h, "划线原文格式不对")
        if not hid and not at:
            return error(h, "缺少划线 id")
        note = body.get("note")
        if not isinstance(note, str):
            return error(h, "眉批要是文字")
        note = note.replace("\r\n", "\n").replace("\r", "\n").strip()
        if len(note) > MAX_NOTE:
            return error(h, f"眉批最多 {MAX_NOTE} 字，这条 {len(note)} 字")

        with ctx.data_lock:
            allh = ctx.read_json(ctx.HIGHLIGHTS, {})
            items = allh.get(file) if isinstance(allh, dict) else None
            if not isinstance(items, list):
                return error(h, "这条划线已经不在了，可能刚被删除", 404)
            if hid:
                hit = next((x for x in items if isinstance(x, dict) and x.get("id") == hid), None)
            else:
                hit = next((x for x in items if isinstance(x, dict) and x.get("at") == at
                            and (text is None or x.get("text") == text)), None)
            if hit is None:
                return error(h, "这条划线已经不在了，可能刚被删除", 404)
            if note:
                hit["note"] = note
            else:
                hit.pop("note", None)
            ctx.write_json(ctx.HIGHLIGHTS, allh)
        return h._send_json({"ok": True, "note": note})

    routes[("POST", "/api/highlight/note")] = post_note
