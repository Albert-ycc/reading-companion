"""框选提问 + 粘贴截图的存图与读图。

框选：页面把 PDF 原件里这块区域重新渲染成 JPEG 发来，存 DATA/regions/；
粘贴截图：存 DATA/attachments/。两处的图都必须落在数据目录里，/api/ask 才肯当附图收（valid_attachments 的要求）。
图片文件的清理：附图被移除时页面调 /api/attachment/delete；删掉框选划线时服务端把区域图挪进回收站，
「撤销」把同一条划线写回时再放回来，回收站里的文件一天后清掉。
"""
import base64
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

MAX_BYTES = 8 * 1024 * 1024
NAME_RE = re.compile(r"^\d{6}-\d{6}-[0-9a-f]{6}\.(jpg|png)$")  # 读图只认自己生成的名字，路径穿越走不通
TYPES = {"jpg": "image/jpeg", "png": "image/png"}


def decode_image(data_url, allowed):
    """data URL -> (字节, 扩展名)；类型以文件头为准，不信请求里自称的 MIME"""
    if not isinstance(data_url, str):
        return None, "图片格式不对"
    header, _, b64 = data_url.partition(",")
    if not header.startswith("data:image/") or not header.endswith(";base64") or not b64:
        return None, "图片格式不对"
    if len(b64) > MAX_BYTES * 4 // 3 + 16:
        return None, "图片太大（上限 8MB）"
    try:
        raw = base64.b64decode(b64, validate=True)
    except ValueError:
        return None, "图片数据损坏"
    if len(raw) > MAX_BYTES:
        return None, "图片太大（上限 8MB）"
    ext = "jpg" if raw[:3] == b"\xff\xd8\xff" else "png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else None
    if ext not in allowed:
        return None, "只收 " + " / ".join(sorted(allowed)).upper() + " 图片"
    return (raw, ext), None


def register(routes, ctx):
    regions = ctx.DATA / "regions"
    attachments = ctx.DATA / "attachments"
    trash = regions / ".trash"

    def store(folder, route, data_url, allowed):
        img, err = decode_image(data_url, allowed)
        if err:
            return {"error": err}, 400
        raw, ext = img
        name = f"{time.strftime('%y%m%d-%H%M%S')}-{secrets.token_hex(3)}.{ext}"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        path.write_bytes(raw)
        return {"id": name.rsplit(".", 1)[0], "path": str(path), "url": f"{route}?id={name}"}, 200

    def save_region(h, body):
        page, rect = body.get("page"), body.get("rect")
        if type(page) is not int or not (isinstance(rect, list) and len(rect) == 4 and all(isinstance(v, (int, float)) for v in rect)):
            return h._send_json({"error": "bad request"}, 400)
        obj, code = store(regions, "/api/region-image", body.get("dataUrl"), {"jpg"})
        return h._send_json(obj, code)

    def save_attachment(h, body):
        obj, code = store(attachments, "/api/attachment-image", body.get("dataUrl"), {"jpg", "png"})
        return h._send_json(obj, code)

    def serve(folder):
        def handle(h, params):
            name = params.get("id", "")
            path = folder / name
            if not NAME_RE.match(name) or not path.is_file():
                return h._send_json({"error": "not found"}, 404)
            raw = path.read_bytes()
            h.send_response(200)
            h.send_header("Content-Type", TYPES[name.rsplit(".", 1)[1]])
            h.send_header("Content-Length", str(len(raw)))
            h.send_header("X-Content-Type-Options", "nosniff")
            h.end_headers()
            h.wfile.write(raw)
        return handle

    def delete_attachment(h, body):
        # 只许删数据目录 attachments/ 下自己生成的文件名；其余路径一律拒绝
        raw = body.get("path")
        try:
            path = Path(raw).resolve()
        except (TypeError, ValueError, OSError):
            return h._send_json({"error": "path 要是附图路径"}, 400)
        if path.parent != attachments.resolve() or not NAME_RE.match(path.name):
            return h._send_json({"error": "只能删数据目录里的附图"}, 400)
        try:
            path.unlink()
        except FileNotFoundError:
            return h._send_json({"ok": True, "removed": False})
        return h._send_json({"ok": True, "removed": True})

    def region_name(url):
        """划线记录里的 image 是 /api/region-image?id=<文件名>；取出文件名，格式不对返回 None"""
        if not isinstance(url, str):
            return None
        u = urlparse(url)
        name = parse_qs(u.query).get("id", [""])[0]
        return name if u.path == "/api/region-image" and NAME_RE.match(name) else None

    def trash_region_image(url):
        name = region_name(url)
        if name and (regions / name).is_file():
            trash.mkdir(exist_ok=True)
            os.replace(regions / name, trash / name)
            os.utime(trash / name)  # 回收站按挪进来的时间算一天

    def restore_region_image(url):
        name = region_name(url)
        if name and (trash / name).is_file() and not (regions / name).exists():
            os.replace(trash / name, regions / name)

    def sweep():
        """启动时清一遍：回收站里超过一天的；regions/ 里超过一天、又没被任何框选划线引用的图
        （上传取图后页面没来得及记划线，比如中途换书，会留下没人要的图）"""
        day_ago = time.time() - 86400
        if trash.is_dir():
            for f in trash.iterdir():
                if f.stat().st_mtime < day_ago:
                    f.unlink(missing_ok=True)
        if not (regions.is_dir() and ctx.HIGHLIGHTS.exists()):
            return  # 没有划线库就不知道哪些图在用，一张都不动
        allh = ctx.read_json(ctx.HIGHLIGHTS, None)  # 读到损坏的文件会被改名留底并返回 None，同样一张不动
        if not isinstance(allh, dict):
            return
        used = {region_name(h.get("image")) for items in allh.values() if isinstance(items, list)
                for h in items if isinstance(h, dict) and h.get("kind") == "region"}
        for f in regions.iterdir():
            if f.is_file() and NAME_RE.match(f.name) and f.name not in used and f.stat().st_mtime < day_ago:
                f.unlink(missing_ok=True)

    sweep()
    # 划线的删除、写回在 server.py 里（同一把数据锁），通过 ctx 调到这里
    ctx.trash_region_image = trash_region_image
    ctx.restore_region_image = restore_region_image
    routes[("POST", "/api/region")] = save_region
    routes[("POST", "/api/attachment")] = save_attachment
    routes[("POST", "/api/attachment/delete")] = delete_attachment
    routes[("GET", "/api/region-image")] = serve(regions)
    routes[("GET", "/api/attachment-image")] = serve(attachments)
