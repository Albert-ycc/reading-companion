// 框选提问 + 粘贴截图。
// 框选：按住 ⌥ 在书页上拖出一个框（或点版心的「框选」再拖一次），松手后从 PDF 原件把这块重新渲染成高清图，
// 当作一条划线交给 Claude 看；表格、统计公式、扫描页上的图，文字划线划不了的都靠它。
// 粘贴截图：在输入框（或页面空白处）⌘V，图缩到合适大小存到本地服务，随下一次提问带走。
import { $, el, toast, api } from "./ui.js";
import { getPdf, currentBook, surfaceAt, addHighlight, removeHighlight, syncState, isScanned } from "./reader.js";
import { addAttachment, canAttach } from "./chat.js";

const MIN_W = 28, MIN_H = 18;        // 屏幕上比这还小的框当成误触
const TARGET_W = 1400;                // 区域图的目标宽度，Claude 读小字够用
const MAX_SIDE = 2400;                // 区域图、截图的长边上限
const MAX_SCALE = 10;                 // 极小的框别放大到离谱，扫描页放太大只会更糊
const NEAR_CHARS = 400;               // 框外前后文各带多少字
const REGION_TEXT_CHARS = 1500;
const EDGE = 44;                      // 拖到离阅读区上下沿这么近时自动滚动
const ATTACH_RAW_LIMIT = 3 * 1024 * 1024; // 不用缩的截图，小于这个体积原样上传，不用再编码一遍

const viewer = $("#viewer");
let armed = false;    // 点了版心「框选」：下一次拖动就是框选，用一次自动解除
let altDown = false;
let pointerIn = false;
let drag = null;      // 正在拖的框
let busy = false;     // 正在取图、上传

// ---------- 入口：版心按钮 + 悬浮提示 ----------
// 版心里的按钮：index.html 里已经有就直接用，没有就在「中英对照」后面插一个
let btn = $("#region-btn");
if (!btn) {
  btn = el("button", {
    id: "region-btn", className: "slip", type: "button", textContent: "框选", hidden: true,
    title: "在书页上拖出一个框，把图、表格或公式发给 Claude。也可以按住 ⌥ 直接拖",
  });
  $("#bi-toggle").after(btn);
}
btn.setAttribute("aria-pressed", "false");
const hint = el("div", { className: "region-hint", hidden: true });
$("#left").append(hint);

function refresh() {
  const open = !!getPdf() && !viewer.hidden;
  if (!open) armed = false;
  btn.hidden = !open;
  const hot = open && !busy && !!(drag || armed || (altDown && pointerIn));
  document.body.classList.toggle("region-on", hot);
  btn.classList.toggle("on", armed);
  btn.setAttribute("aria-pressed", String(armed));
  hint.hidden = !hot;
  hint.textContent = drag ? "松手就把这一块发给 Claude · Esc 取消"
    : armed ? "在书页上拖出一个框 · Esc 取消"
    : "现在拖动就是框选 · 松开 ⌥ 恢复划线";
}

btn.addEventListener("click", () => {
  armed = !armed;
  btn.blur();
  refresh();
});
new MutationObserver(refresh).observe(viewer, { attributes: true, attributeFilter: ["hidden"] });
window.addEventListener("book-opened", refresh);

viewer.addEventListener("mouseenter", () => { pointerIn = true; refresh(); });
viewer.addEventListener("mouseleave", () => { pointerIn = false; refresh(); });
viewer.addEventListener("mousemove", (e) => { if (e.altKey !== altDown) { altDown = e.altKey; refresh(); } }, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.key === "Alt") { altDown = true; refresh(); }
  else if (e.key === "Escape" && (drag || armed)) {
    e.stopPropagation();
    e.preventDefault();
    cancelDrag();
    armed = false;
    refresh();
  }
}, true);
window.addEventListener("keyup", (e) => { if (e.key === "Alt") { altDown = false; refresh(); } });
window.addEventListener("blur", () => { altDown = false; cancelDrag(); refresh(); });

// ---------- 拖框 ----------
// 在 window 的捕获阶段接手：reader.js 也在 mousedown 上接管拖选，这里先拦下来，⌥ 拖动就不会变成选字
window.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || busy || drag || !(e.altKey || armed) || !getPdf()) return;
  const pageDiv = pageAt(e);
  if (!pageDiv) return;
  e.preventDefault();
  e.stopPropagation();
  getSelection().removeAllRanges();
  const vr = viewer.getBoundingClientRect();
  drag = {
    pageDiv, px: e.clientX, py: e.clientY, raf: 0,
    // 起点记成阅读区内容坐标，拖动中滚动也不会跑偏
    ax: e.clientX - vr.left + viewer.scrollLeft, ay: e.clientY - vr.top + viewer.scrollTop,
    box: el("div", { className: "region-drag" }),
  };
  document.body.append(drag.box);
  document.body.classList.add("region-dragging");
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  viewer.addEventListener("scroll", paintDrag, { passive: true });
  drag.raf = requestAnimationFrame(autoScroll);
  paintDrag();
  refresh();
}, true);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 起点在页上就是那一页；落在页边空白或两页之间（提示条说了「现在拖动就是框选」，就不能让它变成划线），吸到离得最近的一页
function pageAt(e) {
  const hit = e.target.closest?.(".page");
  if (hit && viewer.contains(hit)) return hit;
  const vr = viewer.getBoundingClientRect();
  const inArea = e.clientX >= vr.left && e.clientX < vr.left + viewer.clientWidth // 滚动条上起拖不算
    && e.clientY >= vr.top && e.clientY < vr.top + viewer.clientHeight;
  if (!inArea || !viewer.contains(e.target)) return null;
  let best = null, bestD = Infinity;
  for (const div of viewer.querySelectorAll(":scope > .page")) {
    const r = div.getBoundingClientRect();
    const d = Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
    if (d < bestD) { bestD = d; best = div; }
  }
  return best;
}

// 框夹在这一页之内。logical 用来取图（只受页边限制），visible 用来画（再切掉阅读区之外的部分）
function geometry() {
  const vr = viewer.getBoundingClientRect(), pr = drag.pageDiv.getBoundingClientRect();
  const ax = drag.ax + vr.left - viewer.scrollLeft, ay = drag.ay + vr.top - viewer.scrollTop;
  const px = clamp(drag.px, Math.max(pr.left, vr.left), Math.min(pr.right, vr.right));
  const py = clamp(drag.py, Math.max(pr.top, vr.top), Math.min(pr.bottom, vr.bottom));
  const qx = clamp(ax, pr.left, pr.right), qy = clamp(ay, pr.top, pr.bottom);
  const logical = { l: Math.min(px, qx), r: Math.max(px, qx), t: Math.min(py, qy), b: Math.max(py, qy) };
  const visible = {
    l: Math.max(logical.l, vr.left), r: Math.min(logical.r, vr.right),
    t: Math.max(logical.t, vr.top), b: Math.min(logical.b, vr.bottom),
  };
  return { logical, visible };
}

function paintDrag() {
  if (!drag) return;
  const { visible: v } = geometry();
  Object.assign(drag.box.style, {
    left: v.l + "px", top: v.t + "px", width: Math.max(0, v.r - v.l) + "px", height: Math.max(0, v.b - v.t) + "px",
  });
}

function onMove(e) {
  if (!drag) return;
  e.preventDefault();
  e.stopPropagation();
  drag.px = e.clientX;
  drag.py = e.clientY;
  paintDrag();
}

// 页比阅读区高时（一页接近一屏半），拖到上下沿要能自己滚，不然下半页框不到
function autoScroll() {
  if (!drag) return;
  const vr = viewer.getBoundingClientRect(), pr = drag.pageDiv.getBoundingClientRect();
  let d = 0;
  if (drag.py > vr.bottom - EDGE && pr.bottom > vr.bottom) d = drag.py - (vr.bottom - EDGE);
  else if (drag.py < vr.top + EDGE && pr.top < vr.top) d = drag.py - (vr.top + EDGE);
  if (d) viewer.scrollTop += Math.sign(d) * Math.min(28, 4 + Math.abs(d) * 0.4);
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag() {
  cancelAnimationFrame(drag.raf);
  window.removeEventListener("mousemove", onMove, true);
  window.removeEventListener("mouseup", onUp, true);
  viewer.removeEventListener("scroll", paintDrag);
  document.body.classList.remove("region-dragging");
}

function cancelDrag() {
  if (!drag) return;
  endDrag();
  drag.box.remove();
  drag = null;
}

function onUp(e) {
  if (!drag) return;
  e.preventDefault();
  e.stopPropagation();
  drag.px = e.clientX;
  drag.py = e.clientY;
  const { logical } = geometry();
  const { pageDiv, box } = drag;
  endDrag();
  drag = null;
  armed = false;
  if (logical.r - logical.l < MIN_W || logical.b - logical.t < MIN_H) {
    box.remove();
    refresh();
    // 原地点一下（没拖）不提示；拖了个很小的才说
    if (Math.max(logical.r - logical.l, logical.b - logical.t) > 6) toast("框太小了，再拖大一点");
    return;
  }
  box.classList.add("busy"); // 取图、上传期间框留着，脉动一下，告诉用户在处理
  busy = true;
  refresh();
  commit(pageDiv, logical).finally(() => { box.remove(); busy = false; refresh(); });
}

// 给用户看的提示一律中文：我们自己抛的错带中文，浏览器和网络层抛的英文原文换成兜底句
const zh = (err, fallback) => (/[\u3400-\u9fff]/.test(err?.message || "") ? err.message : fallback);

// ---------- 屏幕框 → 页内比例坐标 ----------
const ratio = (box, x, y) => ({ x: clamp((x - box.left) / box.width, 0, 1), y: clamp((y - box.top) / box.height, 0, 1) });

// 屏幕上一点换算成页内比例。中英对照时一页被切成原图块和译文块：点在原图块里直接换算；
// 点在译文块或块间空隙里，上沿吸到下一块原图的顶、下沿吸到上一块原图的底，框里就只剩原文
function pointInPage(div, x, y, edge) {
  const hit = surfaceAt(x, y);
  if (hit && hit.page === +div.dataset.page) return ratio(hit.box, x, y);
  const crops = [...div.querySelectorAll(":scope > .crop")];
  if (!crops.length) return ratio(div.getBoundingClientRect(), x, y);
  const rects = crops.map((c) => c.getBoundingClientRect());
  let i = rects.findIndex((r) => y >= r.top && y <= r.bottom); // 纵向在某块里，只是横向落在它左右的空白
  let yy = y;
  if (i < 0 && edge === "start") {
    i = rects.findIndex((r) => r.top >= y);
    if (i < 0) { i = rects.length - 1; yy = rects[i].bottom; } else yy = rects[i].top;
  } else if (i < 0) {
    i = rects.findLastIndex((r) => r.bottom <= y);
    if (i < 0) { i = 0; yy = rects[0].top; } else yy = rects[i].bottom;
  }
  const r = rects[i];
  return ratio(crops[i].firstElementChild.getBoundingClientRect(), clamp(x, r.left, r.right), clamp(yy, r.top, r.bottom));
}

function toPageBox(div, r) {
  const a = pointInPage(div, r.l, r.t, "start"), b = pointInPage(div, r.r, r.b, "end");
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  if (x2 - x1 < 0.01 || y2 - y1 < 0.005) return null;
  return [x1, y1, x2 - x1, y2 - y1].map((v) => Math.round(v * 10000) / 10000);
}

// 框里和框外附近的文字：文字层里中心落在框内的 span 拼起来；位置同样换成页内比例再比，
// 中英对照时每一块有自己的文字层，也能一起算。框里没字（多半是图）时，附近文字取框上下、横向有重叠的最近几行
function textAround(div, box) {
  const [bx, by, bw, bh] = box;
  const items = [...div.querySelectorAll(".textLayer span:not(.markedContent)")].filter((s) => s.textContent).map((s) => {
    const sb = (s.closest(".crop-inner") || div).getBoundingClientRect(), r = s.getBoundingClientRect();
    return {
      text: s.textContent + (s.nextSibling?.nodeName === "BR" ? "\n" : ""),
      x: ((r.left + r.right) / 2 - sb.left) / sb.width, y: ((r.top + r.bottom) / 2 - sb.top) / sb.height,
    };
  });
  const join = (list) => list.map((it) => it.text).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const inside = (it) => it.x >= bx && it.x <= bx + bw && it.y >= by && it.y <= by + bh;
  const first = items.findIndex(inside), last = items.findLastIndex(inside);
  if (first >= 0) {
    return {
      inside: join(items.slice(first, last + 1).filter(inside)).slice(0, REGION_TEXT_CHARS),
      before: join(items.slice(0, first)).slice(-NEAR_CHARS),
      after: join(items.slice(last + 1)).slice(0, NEAR_CHARS),
    };
  }
  const beside = (it) => it.x > bx - 0.05 && it.x < bx + bw + 0.05;
  return {
    inside: "",
    before: join(items.filter((it) => it.y < by && beside(it))).slice(-NEAR_CHARS),
    after: join(items.filter((it) => it.y > by + bh && beside(it))).slice(0, NEAR_CHARS),
  };
}

// ---------- 从 PDF 原件重新渲染这块区域 ----------
async function renderRegion(n, [x, y, w, h]) {
  const page = await getPdf().getPage(n);
  const base = page.getViewport({ scale: 1 });
  const rw = w * base.width, rh = h * base.height;
  const s = Math.min(TARGET_W / rw, MAX_SIDE / Math.max(rw, rh), MAX_SCALE);
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(rw * s)), height: Math.max(1, Math.round(rh * s)) });
  // offsetX/offsetY 把视口平移到区域左上角，画布只有区域那么大，不用先渲染整页再裁
  const viewport = page.getViewport({ scale: s, offsetX: -x * base.width * s, offsetY: -y * base.height * s });
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.9);
}

async function commit(pageDiv, rect) {
  const book = currentBook();
  const n = +pageDiv.dataset.page;
  try {
    const box = toPageBox(pageDiv, rect);
    if (!box) return toast("这个框里没有取到原文，换个位置再框一次");
    const text = textAround(pageDiv, box);
    const saved = await api("/api/region", { file: book.key, page: n, rect: box, dataUrl: await renderRegion(n, box) });
    if (saved.error) throw new Error(saved.error);
    if (currentBook()?.key !== book.key) return; // 取图、上传的时候换了书，这个框不属于现在这本
    const snippet = text.inside.replace(/\s+/g, " ").trim();
    const label = snippet ? `第 ${n} 页框选区域：${snippet.slice(0, 40)}${snippet.length > 40 ? "…" : ""}` : `第 ${n} 页框选区域（框内没有文字，多半是图）`;
    const hl = { page: n, kind: "region", text: label, image: saved.url, parts: [{ page: n, rects: [box] }] };
    await addHighlight(hl, {
      kind: "region", text: label, page: n, image: saved.path,
      regionText: text.inside, before: text.before, after: text.after, ocr: isScanned(n),
    });
    // addHighlight 记下的「当前页」是视口 35% 处的页；框选的页和它不一样时，以框的页为准，hook 才不会当成用户翻走了
    syncState({ page: n }).catch(() => {});
    $("#q").focus();
    toast(`已框选第 ${n} 页这一块，Claude 能看到了，直接问吧`, { label: "撤销", run: () => removeHighlight(hl) });
  } catch (err) {
    toast("框选没成功：" + zh(err, "再框一次试试"));
  }
}

// ---------- 粘贴截图 ----------
const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error("读不了这张图"));
  r.readAsDataURL(blob);
});

// 长边超过 2400 先缩；体积不大的 PNG / JPEG 原样上传，其余统一转 JPEG（先垫白底，透明截图不会变黑）
async function prepareImage(file) {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error("这张图读不出来，换成 PNG 或 JPG 截图再试"); });
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (k === 1 && file.size <= ATTACH_RAW_LIMIT && /^image\/(png|jpeg)$/.test(file.type)) {
    bmp.close();
    return readAsDataUrl(file);
  }
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  let url = canvas.toDataURL("image/jpeg", 0.9);
  if (url.length > 7.5 * 1024 * 1024) url = canvas.toDataURL("image/jpeg", 0.7); // 极端大图再压一档，别被服务端 8MB 的上限挡回来
  return url;
}

// 返回 "ok" 附上了；"full" 附件栏满了（addAttachment 已经提示，不再往后传）；"bad" 这张图本身不行（已提示）
async function attach(file) {
  // 满了就别上传：先传再被拒，数据目录里会留下没人用的图
  if (!canAttach()) {
    toast("最多附 6 张图，这张没附上");
    return "full";
  }
  try {
    const saved = await api("/api/attachment", { dataUrl: await prepareImage(file) });
    if (saved.error) throw new Error(saved.error);
    return addAttachment({ path: saved.path, url: saved.url }) === false ? "full" : "ok";
  } catch (err) {
    toast(zh(err, "截图没传上去，再试一次"));
    return "bad";
  }
}

document.addEventListener("paste", (e) => {
  // 别的输入框（书架搜索）里的粘贴不管；输入框 #q 和页面空白处的粘贴才接
  const field = e.target.closest?.("input, textarea, [contenteditable]");
  if (field && field !== $("#q")) return;
  const cd = e.clipboardData;
  const files = [...(cd?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  // 文字和图一起来的（从表格、网页里复制），按文字粘，行为和以前一样
  if (cd.getData("text/plain").trim()) return;
  e.preventDefault();
  (async () => {
    let allOk = true;
    for (const f of files) {
      const r = await attach(f);
      if (r !== "ok") allOk = false;
      if (r === "full") break;
    }
    if (allOk) toast("截图已附上，写上问题再发送（直接发送也行）");
  })();
});
