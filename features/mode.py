"""反问模式开关。

GET  /api/mode → {"socratic": bool}
POST /api/mode {socratic: bool} → {"ok": true, "socratic": bool}
存 DATA/mode.json（一个 JSON 对象，现在只有 socratic 一个键）。提问时 UserPromptSubmit hook（.claude/hooks/inject_reading.py）
读这个文件，为真就在上下文末尾注入「先问后讲」的叮嘱。文件不存在、坏了、不是对象、socratic 不是 true，一律当关。
"""


def register(routes, ctx):
    path = ctx.DATA / "mode.json"

    def load():
        return ctx.read_json_as(path, "dict", {})  # 不是对象（比如写成了数组）就改名留底再当没有，下一次写入不会无声覆盖它

    def get(h, params):
        return h._send_json({"socratic": load().get("socratic") is True})

    def post(h, body):
        value = body.get("socratic") if isinstance(body, dict) else None
        if not isinstance(value, bool):
            return h._send_json({"error": "socratic 要是 true 或 false"}, 400)
        with ctx.data_lock:
            data = load()  # 保留文件里别的键，只改这一个
            data["socratic"] = value
            ctx.write_json(path, data)
        return h._send_json({"ok": True, "socratic": value})

    routes[("GET", "/api/mode")] = get
    routes[("POST", "/api/mode")] = post
