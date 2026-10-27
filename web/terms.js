// 术语本：学习视图里的「术语」一节（列出这一章的术语，每条一句定义和页码），外加「在书页上标出」：
// 把没掌握的术语在书页上用靛色点线标出来，悬停看定义。
// 页面负责：定范围、取页文字（扫描页先识别）、渲染、匹配和画标记；服务端（features/terms.py）负责调 Claude、核对术语确实在原文里、缓存。
// 标记画在每页自己追加的一层里（.tmarks，z-index 0，在文字层和划线之下），整层不接收鼠标，所以不会挡住选字和划线；
// 悬停靠 #viewer 上的 mousemove 自己判断指针落在哪个标记里。
import { $, el, api } from "./ui.js";
import { registerSection } from "./panel.js";
import { currentBook, getPdf, getCurrentPage, extractText, revealPassage } from "./reader.js";

const MAX_SPAN = 60;          // 一次最多列这么多页
const MAX_TEXT = 380000;      // 送去的字数上限（服务端 40 万）
const MAX_MARKS = 150;        // 一页最多标这么多处
const MARKS_KEY = "banDu.terms.marks";

const enc = encodeURIComponent;
class Stale extends Error {}
const squash = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); // 字母数字和汉字（希腊字母也算），标点空白抹平
const CJK = /[㐀-鿿]/;
const getOn = () => { try { return localStorage.getItem(MARKS_KEY) === "1"; } catch { return false; } };
const setOn = (v) => { try { localStorage.setItem(MARKS_KEY, v ? "1" : "0"); } catch { /* 记不下来就下次重新开 */ } };

// ───────────────────────── 状态 ─────────────────────────
const S = {
  key: "", title: "", n: 0, pdf: null,
  scope: null,        // { from, to, label, free?, tooLong? }
  custom: null,       // 读者改过的页码 { from, to }
  items: null,        // 当前范围的术语；null＝还没列过
  busy: null,         // 正在列：{ phase: read|ask, done, total, ctl }
  err: "",
  fixOpen: false,
  showMastered: false,
  union: [],          // 这本书所有列过的术语（书页上标的就是它们里没掌握的）
  on: getOn(),
  matcher: null,
  token: 0,
};
let masteredSet = new Set();

const sec = registerSection("learn", { label: "术语", order: 40, onShow: () => refreshSection() });
const root = el("div", { className: "tm" });
sec.append(root);

// ───────────────────────── 书 ─────────────────────────
function resetBook(book) {
  S.token++;
  S.busy?.ctl.abort();
  Object.assign(S, { key: book.key, title: book.title, pdf: getPdf(), n: getPdf()?.numPages || 0, scope: null, custom: null, items: null, busy: null,
    err: "", fixOpen: false, showMastered: false, union: [], matcher: null });
}

function ensureBook() {
  const book = currentBook();
  if (!book) { if (S.key) resetBook({ key: "", title: "" }); return false; }
  if (book.key !== S.key || getPdf() !== S.pdf) { resetBook(book); loadUnion(); } // 同一本书重新打开也算：旧文档已销毁
  return true;
}

window.addEventListener("book-opened", () => {
  ensureBook();
  clearAllMarks();
  if (isShown()) refreshSection();
});

const isShown = () => !!root.offsetParent;

// ───────────────────────── 概念掌握表、这本书的术语 ─────────────────────────
// 概念表的名字常带括号或斜线（「比值比（odds ratio）」），整体和各段都当作可能的写法
const nameKeys = (name) => [name, ...String(name).split(/[（()）/、,，;；]/)].map(squash).filter((k) => k.length >= 2);

async function loadConcepts() {
  const r = await api("/api/learn/concepts").catch(() => null); // 接口没好就当没有
  const items = Array.isArray(r?.items) ? r.items : [];
  masteredSet = new Set(items.filter((c) => c && c.status === "已掌握" && typeof c.name === "string").flatMap((c) => nameKeys(c.name)));
}

const isMastered = (it) => [it.term, it.en].some((w) => w && masteredSet.has(squash(w)));

async function loadUnion() {
  const key = S.key;
  if (!key) return;
  const r = await api("/api/terms?file=" + enc(key)).catch(() => null);
  if (key !== S.key) return;
  const seen = new Set();
  S.union = [];
  for (const l of Array.isArray(r?.lists) ? r.lists : []) {
    for (const it of Array.isArray(l.items) ? l.items : []) {
      const k = squash(it?.term || "");
      if (k.length >= 2 && !seen.has(k)) { seen.add(k); S.union.push(it); }
    }
  }
  if (S.on) { await loadConcepts(); if (key !== S.key) return; rebuild(); }
  render();
}

// ───────────────────────── 范围 ─────────────────────────
async function computeScope() {
  const n = S.n, N = getCurrentPage() || 1;
  if (S.custom) return { ...S.custom, label: "" };
  let chs = null;
  try { chs = await (await import("./guide.js")).getChapters(); } catch { /* 导读写坏了就当没有章节表 */ }
  const ch = chs?.find((c) => c.from <= N && N <= c.to) || chs?.find((c) => c.from > N); // 在目录、前言这些章外面时取接下来那一章
  if (ch) {
    const label = ch.no == null ? ch.title : `第 ${ch.no} 章 ${ch.title}`;
    const len = ch.to - ch.from + 1;
    if (len <= MAX_SPAN) return { from: ch.from, to: ch.to, label };
    const from = N > ch.from + MAX_SPAN - 1 ? Math.min(N - 29, ch.to - MAX_SPAN + 1) : ch.from;
    return { from, to: from + MAX_SPAN - 1, label, tooLong: len };
  }
  if (n <= MAX_SPAN) return { from: 1, to: n, label: "全文" };
  const from = Math.max(1, N - 5);
  return { from, to: Math.min(n, from + 29), label: "", free: true };
}

async function refreshSection() {
  if (!ensureBook()) return render();
  const key = S.key, token = S.token;
  render();
  loadConcepts().then(() => { if (token !== S.token) return; if (S.on) rebuild(); render(); });
  let scope;
  try { scope = await computeScope(); } catch (err) { console.error("术语本：定范围出错", err); return; }
  if (token !== S.token || key !== S.key) return;
  const changed = !S.scope || S.scope.from !== scope.from || S.scope.to !== scope.to;
  S.scope = scope;
  if (changed) {
    S.items = null;
    S.err = "";
    S.fixOpen = !!(scope.free || S.fixOpen);
    render();
    const r = await api(`/api/terms?file=${enc(key)}&from=${scope.from}&to=${scope.to}`).catch(() => null);
    if (token !== S.token || !S.scope || S.scope.from !== scope.from || S.scope.to !== scope.to) return;
    S.items = Array.isArray(r?.items) ? r.items : null;
  }
  render();
}

// 在学习视图里翻页时（没手动改过范围）跟着换章
let pageTimer = 0;
window.addEventListener("page-changed", () => {
  if (!isShown() || S.custom || S.busy) return;
  clearTimeout(pageTimer);
  pageTimer = setTimeout(refreshSection, 400);
});

// ───────────────────────── 列术语 ─────────────────────────
async function gather(from, to, job, pdf) {
  const pages = new Map();
  const nums = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  let i = 0;
  const work = async () => {
    while (i < nums.length && S.busy === job) {
      const p = nums[i++];
      let t;
      try { t = (await extractText(p)).trim(); } catch (err) { if (getPdf() !== pdf) throw new Stale(); throw err; }
      if (getPdf() !== pdf || S.busy !== job) throw new Stale();
      pages.set(p, t);
      job.done++;
      const span = root.querySelector(".tm-wait > span"); // 只改进度文字，整节重画会把正按着的「取消」换掉
      if (span) span.textContent = progressText(job); else render();
    }
  };
  await Promise.all([work(), work()]); // 扫描页要识别，两页并行
  const parts = nums.filter((p) => pages.get(p)).map((p) => `[[第 ${p} 页]]\n${pages.get(p)}`);
  const text = parts.join("\n");
  return { text, chars: text.replace(/\s+/g, "").length };
}

async function list(force) {
  if (S.busy || !S.scope || !ensureBook()) return;
  const key = S.key, pdf = getPdf(), { from, to } = S.scope, token = S.token;
  const job = { phase: "read", done: 0, total: to - from + 1, ctl: new AbortController() };
  Object.assign(S, { busy: job, err: "" });
  render();
  const alive = () => S.busy === job && S.token === token && getPdf() === pdf;
  try {
    const got = await gather(from, to, job, pdf);
    if (!alive()) return;
    if (got.chars < 80) throw new Error("这几页没读到文字（扫描页可能没识别出来），列不了术语");
    if (got.text.length > MAX_TEXT) throw new Error("这段文字太长，缩小页码范围再试");
    job.phase = "ask";
    render();
    let res;
    try {
      res = await fetch("/api/terms", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: key, title: S.title, from, to, text: got.text, force: !!force }), signal: job.ctl.signal });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      throw new Error("伴读的本地服务没在运行");
    }
    let data;
    try { data = await res.json(); } catch { throw new Error("本地服务回的内容读不懂"); }
    if (!alive()) return;
    if (!res.ok || data.error || !Array.isArray(data.items)) throw new Error(data.error || "没列出来");
    if (S.scope && S.scope.from === from && S.scope.to === to) S.items = data.items;
    S.busy = null;
    await loadUnion();
  } catch (err) {
    if (!(err instanceof Stale || err?.name === "AbortError" || !alive())) S.err = err?.message || "没列出来";
  } finally {
    if (S.busy === job) { S.busy = null; render(); } // 被换书、取消打断的也要放开「正在列」
  }
  render();
}

// ───────────────────────── 渲染（学习视图里的一节）─────────────────────────
const E = (tag, cls, ...kids) => el(tag, cls ? { className: cls } : {}, ...kids.flat().filter((k) => k != null && k !== false));
const btn = (cls, text, onclick, props = {}) => el("button", { type: "button", className: cls, textContent: text, onclick, ...props });

function render() {
  if (!root.isConnected) return;
  if (!S.key) return root.replaceChildren(E("p", "tm-note", "先在书架上打开一本书。"));
  const kids = [];

  // 开关：在书页上标出
  const sw = el("button", { type: "button", className: "tm-sw", role: "switch", onclick: toggleMarks });
  sw.setAttribute("aria-checked", String(S.on));
  const shown = S.union.filter((it) => !isMastered(it)).length;
  kids.push(E("div", "tm-swrow", sw, E("span", "tm-swl", "在书页上标出", E("small", "", S.on
    ? (S.union.length ? `只标没掌握的，目前 ${shown} 个` : "还没列过术语，先列一章")
    : "没掌握的术语在书页上划点线，悬停看定义"))));

  // 范围
  const sc = S.scope;
  if (sc) {
    const pages = `第 ${sc.from}–${sc.to} 页`;
    const row = E("div", "tm-scope", E("span", "tm-sl", "范围"), E("span", "tm-st", sc.label ? E("b", "", sc.label) : null, sc.label ? " · " : "", pages));
    row.append(btn("tm-lnk", S.fixOpen ? "收起" : "改页码", () => { S.fixOpen = !S.fixOpen; render(); }));
    kids.push(row);
    if (sc.tooLong) kids.push(E("p", "tm-note", `这一章有 ${sc.tooLong} 页，一次最多列 ${MAX_SPAN} 页，先按这一段列；要列别处就改页码。`));
    if (sc.free) kids.push(E("p", "tm-note", `这本书 ${S.n} 页，没有章节表，一次最多列 ${MAX_SPAN} 页。按你读到的位置填了一段，可以改。`));
    if (S.fixOpen) kids.push(fixRow(sc));
  }

  // 动作与状态
  if (S.busy) {
    const b = S.busy;
    kids.push(E("div", "tm-wait", E("i", "tm-dot"), E("span", "", progressText(b)), btn("tm-lnk", "取消", cancel)));
  } else if (sc) {
    if (S.err) kids.push(E("p", "tm-err", S.err));
    if (!S.items) kids.push(E("div", "tm-act", btn("btn solid sm", S.err ? "再试一次" : sc.label ? `列出${sc.label === "全文" ? "全文" : "这章"}的术语` : "列出这几页的术语", () => list(false))));
  }

  // 列表
  if (S.items && !S.busy) kids.push(...listView(S.items));
  root.replaceChildren(...kids);
}

const progressText = (b) => (b.phase === "read" ? `正在读第 ${b.done} / ${b.total} 页的文字…` : "正在列术语，约 20 秒…");

function fixRow(sc) {
  const n = S.n;
  const mk = (v) => el("input", { type: "number", className: "tm-num", min: 1, max: n, value: v });
  const a = mk(sc.from), b = mk(sc.to);
  const err = E("p", "tm-err");
  err.hidden = true;
  const use = () => {
    const f = +a.value, t = +b.value;
    const why = !Number.isInteger(f) || !Number.isInteger(t) || f < 1 || t < f || t > n ? `页码要在 1 到 ${n} 之间，起页不大于止页`
      : t - f + 1 > MAX_SPAN ? `一次最多 ${MAX_SPAN} 页` : "";
    err.textContent = why;
    err.hidden = !why;
    if (why) return;
    S.custom = { from: f, to: t };
    refreshSection();
  };
  const row = E("div", "tm-fix", "第", a, "到", b, "页", btn("btn sm", "用这个范围", use));
  if (S.custom) row.append(btn("tm-lnk", "按当前章", () => { S.custom = null; S.fixOpen = false; refreshSection(); }));
  return E("div", "tm-fixwrap", row, err);
}

function cancel() {
  S.busy?.ctl.abort();
  S.busy = null;
  render();
}

function listView(items) {
  const open = items.filter((it) => !isMastered(it));
  const done = items.filter(isMastered);
  const out = [E("div", "tm-head", E("span", "", `共 ${items.length} 条${done.length ? `，其中 ${done.length} 条你已掌握` : ""}`),
    btn("tm-lnk", "重新列", () => list(true)))];
  const ul = E("ul", "tm-list", ...open.map((it) => itemView(it, false)));
  out.push(open.length ? ul : E("p", "tm-note", "这一段的术语你都已经掌握了。"));
  if (done.length) {
    out.push(btn("tm-fold", `已掌握（${done.length}）${S.showMastered ? " ▴" : " ▾"}`, () => { S.showMastered = !S.showMastered; render(); }));
    if (S.showMastered) out.push(E("ul", "tm-list dim", ...done.map((it) => itemView(it, true))));
  }
  return out;
}

function itemView(it, dim) {
  const pg = typeof it.page === "number" ? btn("tm-pg", `第 ${it.page} 页`, () => revealPassage(it.page, it.term).catch(() => {})) : null;
  return E("li", "tm-it" + (dim ? " dim" : ""),
    E("div", "tm-l1", E("b", "tm-term", it.term), it.en && squash(it.en) !== squash(it.term) ? E("i", "tm-en", it.en) : null, pg),
    E("p", "tm-def", it.definition));
}

// ───────────────────────── 书页上的标记 ─────────────────────────
function toggleMarks() {
  S.on = !S.on;
  setOn(S.on);
  if (S.on) loadConcepts().then(() => { rebuild(); render(); });
  else { S.matcher = null; clearAllMarks(); hideTip(); }
  render();
}

// 按术语（term、en）建匹配器：中文精确匹配，英文不分大小写、整词（可带复数 s）；2–3 个大写字母的缩写（OR、HR）区分大小写，不然 or 到处都是。
// 所有术语合成一条正则，每页只扫一遍文字
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
const norm = (s) => String(s).normalize("NFKC").replace(/\s+/g, " ").trim().replace(/(?<=[㐀-鿿]) (?=[㐀-鿿])/g, "");

function buildMatcher() {
  const ci = new Map(), cs = new Map(); // 写法 -> 术语
  const add = (w, it, isEn) => {
    w = norm(w || "");
    if (!w) return;
    const cjk = CJK.test(w);
    const caps = /^[A-Z0-9][A-Z0-9-]*$/.test(w) && /[A-Z]/.test(w) && w.length <= 6;
    if (cjk ? w.length < 2 : w.length < (caps ? 2 : isEn ? 4 : 3)) return;
    const map = caps ? cs : ci;
    const k = caps ? w : w.toLowerCase();
    if (!map.has(k)) map.set(k, it);
  };
  for (const it of S.union) {
    if (isMastered(it)) continue;
    add(it.term, it, false);
    add(it.en, it, true);
  }
  const pattern = (map) => {
    if (!map.size) return null;
    const alts = [...map.keys()].sort((a, b) => b.length - a.length).map((w) => {
      const word = /^[A-Za-z0-9]/.test(w), tail = /[A-Za-z0-9]$/.test(w);
      return (word ? "(?<![A-Za-z0-9])" : "") + esc(w) + (tail ? "(?:s|es)?(?![A-Za-z0-9])" : "");
    });
    return new RegExp(alts.join("|"), "g");
  };
  const m = { ci: pattern(ci), cs: pattern(cs), ciMap: ci, csMap: cs };
  return m.ci || m.cs ? m : null;
}

function rebuild() {
  S.matcher = S.on ? buildMatcher() : null;
  refreshAllMarks();
}

const pagesWithText = () => [...document.querySelectorAll("#viewer .page")].filter((d) => d.querySelector(".textLayer span"));
function refreshAllMarks() { for (const d of pagesWithText()) markPage(d); }
function clearAllMarks() { document.querySelectorAll("#viewer .tmarks").forEach((x) => x.remove()); }

window.addEventListener("page-rendered", (e) => { if (S.on && S.matcher && e.detail.div?.isConnected) markPage(e.detail.div); });
window.addEventListener("page-cleared", (e) => { const d = document.querySelector(`#viewer .page[data-page="${e.detail.page}"]`); d?.querySelectorAll(".tmarks").forEach((x) => x.remove()); });

const markItem = new WeakMap(); // 标记元素 -> 术语

function markPage(div) {
  div.querySelectorAll(".tmarks").forEach((x) => x.remove());
  if (!S.on || !S.matcher) return;
  const jobs = [...div.querySelectorAll(".textLayer")].map((tl) => ({ surface: tl.parentElement, found: scan(tl) }));
  for (const { surface, found } of jobs) { // 先量完再写，中间不触发重排
    if (!found.length) continue;
    const layer = el("div", { className: "tmarks" });
    for (const { rect, item } of found) {
      const m = el("div", { className: "tm-mark" });
      m.dataset.term = item.term;
      Object.assign(m.style, { left: rect[0] * 100 + "%", top: rect[1] * 100 + "%", width: rect[2] * 100 + "%", height: rect[3] * 100 + "%" });
      markItem.set(m, item);
      layer.append(m);
    }
    surface.append(layer);
  }
}

// 一层文字层里的命中：返回 [{ rect: [x, y, w, h]（相对 surface 的 0–1 比例）, item }]
function scan(tl) {
  const surface = tl.parentElement;
  const spans = [...tl.querySelectorAll("span:not(.markedContent)")].filter((s) => s.firstChild?.nodeType === 3)
    .sort((a, b) => (a.dataset.i ?? 0) - (b.dataset.i ?? 0));
  if (!spans.length) return [];
  // 压成一条串：空白折成一个空格（汉字之间的不要），换行（br）当空格；每个字符记下它来自哪个片段的第几位
  const orig = [], low = [], own = [], off = [];
  let pend = false, prev = "";
  spans.forEach((sp, si) => {
    const t = sp.firstChild.data;
    for (let k = 0; k < t.length; k++) {
      const ch = t[k];
      if (/\s/.test(ch)) { pend = true; continue; }
      for (const c of ch.normalize("NFKC")) {
        if (pend && prev && !(CJK.test(prev) && CJK.test(c))) { orig.push(" "); low.push(" "); own.push(own.at(-1)); off.push(off.at(-1)); }
        pend = false;
        const lc = c.toLowerCase();
        orig.push(c); low.push(lc.length === 1 ? lc : c); own.push(si); off.push(k);
        prev = c;
      }
    }
    if (sp.nextSibling?.nodeName === "BR") pend = true;
  });
  const O = orig.join(""), L = low.join("");
  const M = S.matcher, hits = [];
  const lookup = (map, text) => map.get(text) || map.get(text.replace(/(?:es|s)$/, ""));
  if (M.ci) for (const m of L.matchAll(M.ci)) { const it = lookup(M.ciMap, m[0]); if (it) hits.push([m.index, m.index + m[0].length, it]); }
  if (M.cs) for (const m of O.matchAll(M.cs)) { const it = lookup(M.csMap, m[0]); if (it) hits.push([m.index, m.index + m[0].length, it]); }
  hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
  const sbox = surface.getBoundingClientRect();
  if (!sbox.width || !sbox.height) return [];
  const range = document.createRange();
  const out = [];
  let end = -1, count = 0;
  for (const [a, b, item] of hits) {
    if (a < end) continue; // 和前一处压着：留先到的、长的
    if (count >= MAX_MARKS) break;
    const s1 = spans[own[a]], s2 = spans[own[b - 1]];
    if (!s1 || !s2) continue;
    try {
      range.setStart(s1.firstChild, off[a]);
      range.setEnd(s2.firstChild, off[b - 1] + 1);
    } catch { continue; }
    const rects = lineRects([...range.getClientRects()]);
    if (!rects.length) continue;
    end = b;
    count++;
    for (const r of rects) out.push({ item, rect: [(r.left - sbox.left) / sbox.width, (r.top - sbox.top) / sbox.height, r.width / sbox.width, r.height / sbox.height] });
  }
  return out;
}

// getClientRects 同时返回 span 盒子和文字盒子：按行合并成一条
function lineRects(rects) {
  const out = [];
  for (const r of rects.filter((r) => r.width >= 1 && r.height >= 1).sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom) || a.left - b.left)) {
    const cy = (r.top + r.bottom) / 2;
    const m = out.find((o) => Math.abs((o.top + o.bottom) / 2 - cy) < Math.min(o.bottom - o.top, r.height) / 2 && r.left <= o.right + 8 && r.right >= o.left - 8);
    if (m) { m.left = Math.min(m.left, r.left); m.right = Math.max(m.right, r.right); m.top = Math.min(m.top, r.top); m.bottom = Math.max(m.bottom, r.bottom); }
    else out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return out.map((o) => ({ ...o, width: o.right - o.left, height: o.bottom - o.top }));
}

// ───────────────────────── 悬停气泡（不用 title）─────────────────────────
let tip = null, tipFor = null, raf = 0, last = null;

function hideTip() {
  if (tip) tip.hidden = true;
  tipFor = null;
}

function showTip(mark, r) {
  const it = markItem.get(mark);
  if (!it) return hideTip();
  if (tipFor === mark) return;
  tipFor = mark;
  tip ??= document.body.appendChild(el("div", { id: "tm-tip", hidden: true }));
  tip.replaceChildren(
    E("div", "tt-h", E("b", "", it.term), it.en && squash(it.en) !== squash(it.term) ? E("i", "", it.en) : null),
    E("p", "tt-d", it.definition),
    typeof it.page === "number" ? E("small", "", `术语本 · 第 ${it.page} 页`) : null);
  tip.style.visibility = "hidden";
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const top = r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8;
  Object.assign(tip.style, { left: left + "px", top: top + "px", visibility: "" });
}

function hit(x, y) {
  const page = document.elementFromPoint(x, y)?.closest?.("#viewer .page");
  if (!page) return hideTip();
  for (const m of page.querySelectorAll(".tm-mark")) {
    const r = m.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return showTip(m, r);
  }
  hideTip();
}

const viewer = $("#viewer");
viewer?.addEventListener("mousemove", (e) => {
  if (!S.on) return;
  if (e.buttons) return hideTip(); // 正在拖选
  last = e;
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (S.on) hit(last.clientX, last.clientY); });
});
viewer?.addEventListener("mouseleave", hideTip);
viewer?.addEventListener("scroll", hideTip, { passive: true });

// 已经开着一本书时（模块加载比开书晚）接上
if (currentBook()) { ensureBook(); if (S.on) loadConcepts().then(rebuild); }
