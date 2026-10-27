// 批注视图里的「划线与眉批」：当前这本书的全部划线按页排开，每条下面一个框写自己的一句话（眉批）。
// 眉批只存在划线库里（POST /api/highlight/note），不发给 Claude；页上带眉批的划线首行右上角有个靛色小角标，导出读书笔记时一起走。
// 划线对象是 reader.js 的 getHighlights() 里同一批（不是拷贝）：存成功后改 hl.note 再 redrawHighlight(hl)，页上的角标跟着变。
import { $, el, toast, apiOk, whyFailed } from "./ui.js";
import { registerSection, showView, currentView } from "./panel.js";
import { currentBook, getHighlights, redrawHighlight, revealHighlight, removeHighlight, focusPassage, tidyText } from "./reader.js";
import { compose } from "./chat.js";

const MAX_NOTE = 4000;      // 和服务端一致
const NEAR_LIMIT = 3600;    // 写到这么多字时在框旁边提示还剩多少
const SHORT = 700;          // 折叠时只放这么多字进页面：一条划线最长 6 万字，几百条都放全文会拖慢排版

const section = registerSection("notes", { label: "划线与眉批", order: 10, onShow: () => { if (dirty) render(); } });
const heading = section.querySelector(".sec-h");
const list = el("div", { className: "nt-list" });
const empty = el("p", { className: "nt-empty" });
section.append(list, empty);

const rows = new Map();          // 划线对象 -> 它的一行：划线增减时只增删对应的行，别的行里正在写的字不会被冲掉
const chains = new WeakMap();    // 划线对象 -> 它最近一次眉批存盘：同一条的几次存盘排队发，旧的不会晚于新的到服务端
let shownKey = null;             // 现在列表对应哪本书
let dirty = true;                // 视图看不见时发生了变化：下次显示时再排

const hlsNow = () => (currentBook() ? getHighlights() : []);

function updateCount() {
  const n = sorted().length;
  heading.textContent = n ? `划线与眉批 · ${n}` : "划线与眉批";
}

// 按页排；同一页里按划线先后（服务端是追加的，数组顺序就是先后，at 兜住撤销删除放回时顺序变了的情况）
function sorted() {
  return hlsNow()
    .map((hl, i) => ({ hl, i }))
    .filter(({ hl }) => hl && typeof hl.text === "string" && Number.isInteger(hl.page))
    .sort((a, b) => a.hl.page - b.hl.page || String(a.hl.at || "").localeCompare(String(b.hl.at || "")) || a.i - b.i)
    .map(({ hl }) => hl);
}

function render() {
  dirty = false;
  updateCount();
  const book = currentBook();
  const key = book?.key ?? null;
  if (key !== shownKey) { // 换了书：旧书的行全部丢掉（还没存的眉批先存，存盘按旧书的 key 发）
    flushAll();
    rows.clear();
    list.replaceChildren();
    shownKey = key;
  }
  const hls = sorted();
  const keep = new Set(hls);
  for (const [hl, row] of rows) if (!keep.has(hl)) { row.remove(); rows.delete(hl); }
  let at = list.firstElementChild; // 已经在位置上的行不动，只把新行插进该在的地方：正在输入的那一行不会因为重排丢掉焦点
  for (const hl of hls) {
    let row = rows.get(hl);
    if (!row) { row = makeRow(hl); rows.set(hl, row); } else syncRow(row, hl);
    if (row === at) at = at.nextElementSibling;
    else list.insertBefore(row, at);
  }
  empty.hidden = hls.length > 0;
  empty.textContent = book ? "划一句，这里就有了" : "先在书架上打开一本书";
  measure();
}

// ───────────────────────── 一行 ─────────────────────────
function makeRow(hl) {
  const row = el("article", { className: "nt-row" });
  const act = (label, run, cls = "") => el("button", { type: "button", className: cls, textContent: label, onclick: run });
  const top = el("div", { className: "nt-top" },
    el("button", { type: "button", className: "nt-page", textContent: `第 ${hl.page} 页`, title: "跳回书页上的这一处", onclick: () => jump(hl) }),
    el("span", { className: "nt-acts" },
      act("跳回", () => jump(hl)),
      ...(hl.kind ? [] : [act("问这句", () => askAbout(hl))]), // 框选区域的区域图和框内文字没存在划线里，没法重新交给 Claude
      act("删除", () => removeHighlight(hl), "danger")));
  row.append(top);

  if (hl.kind === "region" && hl.image) {
    const img = el("img", { className: "nt-img", src: hl.image, alt: "框选的区域", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.replaceWith(textBlock(row, hl)), { once: true }); // 划线删掉后图会进回收站取不到
    row.append(img);
  } else {
    row.append(textBlock(row, hl));
  }

  const ta = el("textarea", {
    className: "nt-ta", rows: 1, maxLength: MAX_NOTE, spellcheck: false, placeholder: "写一句自己的话",
    ariaLabel: `第 ${hl.page} 页这句划线的眉批`,
  });
  ta.value = typeof hl.note === "string" ? hl.note : "";
  const count = el("span", { className: "nt-count", hidden: true });
  const state = el("span", { className: "nt-state", hidden: true });
  const err = el("p", { className: "nt-err", hidden: true });
  row.append(el("div", { className: "nt-note" }, el("span", { className: "nt-tag", textContent: "批", title: "眉批：只存在这里，不发给 Claude" }), el("div", { className: "nt-field" }, ta, state, count)), err);
  row._ui = { ta, count, state, err };

  ta.addEventListener("blur", () => save(hl, row));
  ta.addEventListener("input", () => {
    const left = MAX_NOTE - ta.value.length;
    count.hidden = left > MAX_NOTE - NEAR_LIMIT;
    count.textContent = `还能写 ${left} 字`;
    state.hidden = true;
  });
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); } // 失焦就存
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ta.value = typeof hl.note === "string" ? hl.note : ""; ta.blur(); }
  });
  syncRow(row, hl);
  return row;
}

// 折叠的原文：超过三行时出「展开」。一条很长的划线折叠时只放前 700 字
function textBlock(row, hl) {
  const long = hl.text.length > SHORT;
  const words = el("mark", { textContent: long ? tidyText(hl.text.slice(0, SHORT)) + "…" : tidyText(hl.text) });
  const p = el("p", { className: "nt-text" }, words);
  const more = el("button", { type: "button", className: "nt-more", textContent: "展开", hidden: true });
  more.addEventListener("click", () => {
    const open = row.classList.toggle("open");
    words.textContent = open || !long ? tidyText(hl.text) : tidyText(hl.text.slice(0, SHORT)) + "…";
    more.textContent = open ? "收起" : "展开";
    if (!open) row.scrollIntoView({ block: "nearest" });
  });
  const wrap = el("div", { className: "nt-quote" }, p, more);
  wrap._more = { p, more, long };
  return wrap;
}

// 重排时已有的行：眉批文字以划线对象为准，但正在写的那一行不动
function syncRow(row, hl) {
  const { ta } = row._ui;
  const note = typeof hl.note === "string" ? hl.note : "";
  if (document.activeElement !== ta && ta.value.trim() !== note && !row.classList.contains("failed") && !row.classList.contains("saving")) ta.value = note;
  row.classList.toggle("has-note", !!note.trim());
}

// 哪些行的原文放不下三行：先统一读、再统一写，几百条也只排一次版
function measure() {
  if (currentView() !== "notes") return;
  const todo = [...list.querySelectorAll(".nt-quote")].map((q) => {
    const { p, more, long } = q._more;
    return { more, show: long || q.closest(".nt-row").classList.contains("open") || p.scrollHeight > p.clientHeight + 1 };
  });
  for (const { more, show } of todo) more.hidden = !show;
}
new ResizeObserver(() => { if (currentView() === "notes") measure(); }).observe(list); // 拖版心改宽度之后，折不折叠要重新判断

// ───────────────────────── 存眉批 ─────────────────────────
function save(hl, row) {
  const { ta, state, err } = row._ui;
  const text = ta.value.trim();
  const saved = typeof hl.note === "string" ? hl.note : "";
  if (text === saved) {
    ta.value = text;
    row.classList.remove("failed");
    err.hidden = true;
    return Promise.resolve();
  }
  const file = shownKey; // 这一行属于哪本书就按哪本书存，换书途中也不会存串
  if (!file) return Promise.resolve();
  const body = { file, id: hl.id, note: text, ...(hl.id ? {} : { at: hl.at, text: hl.text }) }; // 早期的划线没有 id，服务端按 at + 原文认
  const run = (chains.get(hl) || Promise.resolve()).catch(() => {}).then(() => apiOk("/api/highlight/note", body));
  chains.set(hl, run);
  row.classList.add("saving");
  return run.then(() => {
    if (text) hl.note = text; else delete hl.note;
    row.classList.remove("saving", "failed");
    err.hidden = true;
    row.classList.toggle("has-note", !!text);
    if (ta.value.trim() === text && document.activeElement !== ta) {
      ta.value = text;
      state.textContent = text ? "已存" : "已清";
      state.hidden = false;
      setTimeout(() => { state.hidden = true; }, 1500);
    }
    if (hlsNow().includes(hl)) redrawHighlight(hl); // 页上的眉批角标
  }, (e) => {
    row.classList.remove("saving");
    if (!hlsNow().includes(hl)) return; // 删除和存眉批撞在一起，这条已经没了：不再报
    const why = whyFailed(e, "再试一次");
    row.classList.add("failed");
    err.replaceChildren(`没存上：${why}　`, el("button", { type: "button", textContent: "重试", onclick: () => save(hl, row) }));
    err.hidden = false;
    toast(`眉批没存上：${why}`, undefined, 4500);
  });
}

// 离开批注视图、换书之前，把还停在输入框里没失焦的眉批存掉（浏览器隐藏正在输入的框时不一定发 blur）
function flushAll() {
  for (const [hl, row] of rows) {
    if (row._ui.ta.value.trim() !== (typeof hl.note === "string" ? hl.note : "")) save(hl, row);
  }
}
window.addEventListener("view-changed", (e) => { if (e.detail?.view !== "notes") flushAll(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushAll(); });

// ───────────────────────── 行尾的动作 ─────────────────────────
async function jump(hl) {
  if (!currentBook()) return toast("这本书没打开，跳不过去");
  if ($("#viewer").hidden) return toast("书架开着：先打开这本书，再点跳回");
  if (!(await revealHighlight({ text: hl.text, page: hl.page, hl: hl.id }))) toast(`第 ${hl.page} 页上没找到这句，停在了这一页`);
}

async function askAbout(hl) {
  await focusPassage(hl.page, hl.text); // 让 Claude 看到这一句，不记成新划线
  compose(); // 切到问答并聚焦输入框，不发送
}

// 标题里的数量、列表：书打开、划线增删时跟着变（看不见时只标脏，下次显示再排）
function refresh() {
  updateCount();
  if (currentView() === "notes") render(); else dirty = true;
}
let queued = false;
const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; refresh(); }); } };
// highlights-changed：新增、删除、撤销写回（含框选划线）都发；换书发 book-opened
for (const name of ["book-opened", "highlights-changed"]) window.addEventListener(name, later);

// 点页上划线的菜单「眉批」：跳到批注视图，把这一行滚到眼前、光标放进框里
window.addEventListener("highlight-note", (e) => {
  const hl = e.detail;
  showView("notes");
  render(); // 已经在批注视图时 showView 什么也不做；排一遍（行都在时只是对一下）
  const row = rows.get(hl) || [...rows].find(([h]) => hl?.id && h.id === hl.id)?.[1];
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  row.classList.remove("nt-flash");
  void row.offsetWidth;
  row.classList.add("nt-flash");
  setTimeout(() => row.classList.remove("nt-flash"), 1800);
  row._ui.ta.focus({ preventScroll: true });
});

refresh();
