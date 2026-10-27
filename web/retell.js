// 复述批改：学习视图里的「复述」一节。读完一节，用自己的话写这节讲了什么，Claude 对照原文指出漏掉的和说错的，每条带页码、点页码跳到原文。
// 页面负责：定范围、取页文字（扫描页先识别）、渲染、概念回写；服务端（features/retell.py）负责调 Claude、核对引句、存档。
import { el, whyFailed } from "./ui.js";
import * as panel from "./panel.js";
import { registerAction } from "./registry.js";
import { currentBook, getPdf, getCurrentPage, extractText, revealPassage, gotoPage } from "./reader.js";
import { getChapters } from "./guide.js";

// ───────────────────────── 常量 ─────────────────────────
const MAX_PAGES = 40;        // 一次最多对照多少页
const MAX_CHARS = 60000;     // 一次最多交多少字原文（服务端上限 6.5 万）；15 页的中文共识整篇约 5.4 万字
const MIN_RETELL = 8;        // 复述去掉空白后至少这么多字
const MAX_RETELL = 6000;
const MIN_TEXT = 100;        // 范围里读出的原文短于这个，没东西可对照
const WHOLE_DOC = 60;        // 页数不超过它的文档，默认范围就是全文
const SPAN = 10;             // 没有章节信息时，默认取当前页前后共这么多页
const HISTORY_N = 5;

// ───────────────────────── 状态 ─────────────────────────
const S = {
  key: "", title: "", n: 0,
  mode: "edit",        // nobook edit working result
  scope: null,         // { from, to, label, kind: all | chapter | pages }
  pick: false,         // 读者手动改过范围：翻页不再改它
  editRange: false,
  rangeErr: "",
  draft: "",
  work: null,          // 进行中的批改 { token, ctrl, msg }
  runSeq: 0,
  rtoken: 0,           // refresh 的序号：旧的一次回来发现不是自己就丢掉
  rec: null,           // 正在看的那条结果
  fromHistory: false,
  history: [],
  conceptNote: "",
  err: "",
  wantFocus: false,
  wantScroll: false,   // 下一次画完，把这一节滚到学习视图顶上（结果出来时它可能在折叠线下面）
};

const sec = panel.registerSection("learn", { label: "复述", order: 35, onShow: () => { refresh(); } });
const root = el("div", { className: "rt" });
sec.append(root);

const ta = el("textarea", { className: "rt-ta", rows: 6, maxLength: MAX_RETELL, spellcheck: false });
ta.setAttribute("aria-label", "用自己的话写这节讲了什么");
ta.addEventListener("input", () => { S.draft = ta.value; saveDraft(); updateSubmit(); });
ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });

registerAction({
  name: "复述", desc: "用自己的话复述这一节，Claude 对照原文批改", order: 35,
  run: () => {
    const was = panel.currentView() === "learn";
    S.wantFocus = true;
    if (S.mode !== "working") S.mode = currentBook() ? "edit" : "nobook";
    panel.showView("learn");
    if (was) refresh();
  },
});

// ───────────────────────── 小工具 ─────────────────────────
const squash = (s) => (s || "").replace(/\s+/g, "");
const same = (key, pdf) => currentBook()?.key === key && getPdf() === pdf;
const when = (iso) => {
  const m = /^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d)/.exec(iso || "");
  return m ? `${+m[1]} 月 ${+m[2]} 日 ${m[3]}` : "";
};
const draftKey = () => "banDu.retellDraft." + S.key;
function loadDraft() { try { return localStorage.getItem(draftKey()) || ""; } catch { return ""; } }
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  const key = S.key, text = S.draft;
  draftTimer = setTimeout(() => {
    try { text.trim() ? localStorage.setItem("banDu.retellDraft." + key, text) : localStorage.removeItem("banDu.retellDraft." + key); } catch { /* 存不上就算了，草稿只在这次页面里有 */ }
  }, 300);
}

async function postJson(path, body, signal) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw Object.assign(new Error("伴读的本地服务没在运行"), { name: "ServiceDown" });
  }
  try {
    return { status: res.status, data: await res.json() };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw Object.assign(new Error("本地服务回的内容读不懂"), { name: "BadResponse" });
  }
}

// ───────────────────────── 范围 ─────────────────────────
async function defaultScope() {
  const key = S.key, pdf = getPdf(), n = pdf.numPages, page = getCurrentPage() || 1;
  if (n <= WHOLE_DOC) return { from: 1, to: n, label: "全文", kind: "all" };
  let chapters = null;
  try { chapters = await getChapters(); } catch (err) { console.error("复述：取章节表失败", err); }
  if (!same(key, pdf)) return null;
  const ch = chapters?.find((c) => c.from <= page && page <= c.to);
  if (ch) return { from: ch.from, to: ch.to, label: ch.no != null ? `第 ${ch.no} 章 ${ch.title}` : ch.title, kind: "chapter" };
  const from = Math.max(1, Math.min(page - Math.floor(SPAN / 2), n - SPAN + 1));
  return { from, to: Math.min(n, from + SPAN - 1), label: "", kind: "pages" };
}

const scopeText = (sc) => (sc.label ? sc.label + " · " : "") + `第 ${sc.from}–${sc.to} 页`;

// ───────────────────────── 刷新 ─────────────────────────
function resetBook(book) {
  cancelWork(true);
  Object.assign(S, {
    key: book.key, title: book.title || "", n: 0, mode: "edit", scope: null, pick: false, editRange: false, rangeErr: "",
    draft: "", rec: null, fromHistory: false, history: [], conceptNote: "", err: "",
  });
  S.draft = loadDraft();
  ta.value = S.draft;
}

async function refresh() {
  const book = currentBook();
  if (!book) {
    ++S.rtoken;
    cancelWork(true);
    Object.assign(S, { key: "", mode: "nobook", scope: null, rec: null, history: [] });
    return render();
  }
  if (book.key !== S.key) resetBook(book);
  else if (S.mode === "nobook") S.mode = "edit";
  S.n = getPdf().numPages;
  render();
  loadHistory();
  await rescope();
}

// 定默认范围。写了一半草稿、或手动改过范围时不动它
async function rescope() {
  const token = ++S.rtoken;
  const drafting = S.draft.trim().length > 0;
  if (S.mode !== "edit" || (S.scope && (S.pick || drafting))) return;
  const pdf = getPdf(), key = S.key;
  const sc = await defaultScope();
  if (token !== S.rtoken || !sc || !same(key, pdf) || S.mode !== "edit") return;
  S.scope = sc;
  if (sc.kind === "pages") S.editRange = true;
  render();
}

async function loadHistory() {
  const key = S.key;
  if (!key) return;
  let r;
  try { r = await (await fetch("/api/retell?file=" + encodeURIComponent(key))).json(); } catch { return; }
  if (S.key !== key || !Array.isArray(r?.items)) return;
  S.history = r.items.slice(0, HISTORY_N);
  render();
}

// 默认范围跟着读到哪一页走；写了一半草稿、或手动改过范围时不动
let pageTimer = null;
window.addEventListener("page-changed", () => {
  if (panel.currentView() !== "learn" || S.mode !== "edit" || S.pick || S.draft.trim()) return;
  clearTimeout(pageTimer);
  pageTimer = setTimeout(rescope, 500);
});
window.addEventListener("book-opened", () => {
  clearTimeout(pageTimer);
  const book = currentBook();
  if (book && book.key !== S.key) resetBook(book);
  if (panel.currentView() === "learn") refresh();
});

// ───────────────────────── 提交 ─────────────────────────
// 范围内各页文字，每页前一行「【第 N 页】」。超过 40 页或 6 万字就截断，截到哪一页写在返回里
async function gather(sc, alive, progress) {
  const last = Math.min(sc.to, sc.from + MAX_PAGES - 1);
  const parts = [], skipped = [];
  let chars = 0, to = last, truncated = last < sc.to;
  for (let n = sc.from; n <= last; n++) {
    if (!alive()) return null;
    progress(`正在读第 ${n} 页（${n - sc.from + 1} / ${last - sc.from + 1}）`);
    const t = ((await extractText(n)) || "").trim();
    if (!alive()) return null;
    if (!t) { skipped.push(n); continue; }
    const room = MAX_CHARS - chars;
    if (room <= 0) { to = n - 1; truncated = true; break; }
    if (t.length > room) {
      parts.push(`【第 ${n} 页】\n${t.slice(0, room)}`);
      chars += room; to = n; truncated = true;
      break;
    }
    parts.push(`【第 ${n} 页】\n${t}`);
    chars += t.length;
  }
  return { text: parts.join("\n"), chars, to, truncated, skipped };
}

function cancelWork(silent) {
  const w = S.work;
  if (!w) return;
  S.work = null;
  w.ctrl.abort();
  if (S.mode === "working") S.mode = "edit";
  panel.setBadge("learn", null);
  if (!silent) render();
}

function progressLine(msg) {
  if (S.work) S.work.msg = msg;
  const p = root.querySelector(".rt-progress");
  if (p) p.textContent = msg;
}

async function submit() {
  if (S.mode !== "edit") return;
  const book = currentBook();
  const retelling = ta.value.trim();
  const sc = S.scope;
  if (!book || book.key !== S.key || !sc) return;
  if (squash(retelling).length < MIN_RETELL) return;
  if (!(Number.isInteger(sc.from) && Number.isInteger(sc.to) && sc.from >= 1 && sc.to >= sc.from && sc.to <= S.n)) { S.rangeErr = `页码要在 1–${S.n} 之间，起页不大于止页`; S.editRange = true; return render(); }
  const key = S.key, title = S.title, pdf = getPdf();
  const token = ++S.runSeq;
  const ctrl = new AbortController();
  S.work = { token, ctrl, msg: "正在读原文…" };
  S.mode = "working";
  S.err = "";
  S.rangeErr = "";
  panel.setBadge("learn", "busy");
  S.wantScroll = true;
  render();
  const alive = () => S.work?.token === token && same(key, pdf);
  try {
    const got = await gather(sc, alive, progressLine);
    if (!got) return; // 换书或取消了：静默收掉
    if (got.chars < MIN_TEXT) {
      S.work = null; S.mode = "edit"; panel.setBadge("learn", null);
      S.err = got.skipped.length
        ? `第 ${sc.from}–${sc.to} 页里几乎读不出文字（第 ${got.skipped.slice(0, 6).join("、")} 页${got.skipped.length > 6 ? "等" : ""}识别失败或是空白页），没有原文可以对照。`
        : `第 ${sc.from}–${sc.to} 页里读出的文字太少，没有原文可以对照。`;
      return render();
    }
    progressLine("Claude 正在对照原文，通常半分钟到一分钟");
    const { status, data } = await postJson("/api/retell", {
      file: key, title, from: sc.from, to: got.to, text: got.text, retelling,
      label: sc.label, truncated: got.truncated, asked_to: sc.to, skipped: got.skipped.slice(0, 100),
    }, ctrl.signal);
    if (!alive()) return;
    if (status >= 400 || data?.error) throw Object.assign(new Error(data?.error || `服务端回了 ${status}`), { name: status >= 500 ? "ServerError" : "Rejected" });
    if (!data || !Array.isArray(data.missed) || !Array.isArray(data.wrong)) throw Object.assign(new Error("本地服务回的内容读不懂"), { name: "BadResponse" });
    S.work = null;
    S.mode = "result";
    S.rec = data;
    S.fromHistory = false;
    S.draft = ""; ta.value = ""; saveDraft();
    S.history = [data, ...S.history.filter((h) => h.id !== data.id)].slice(0, HISTORY_N);
    S.conceptNote = data.concepts?.length ? "正在记入概念表…" : "";
    panel.setBadge("learn", "done");
    S.wantScroll = true;
    render();
    writeConcepts(data, key, title);
  } catch (err) {
    if (!alive()) return; // 换书或取消：不提示
    S.work = null;
    S.mode = "edit";
    panel.setBadge("learn", null);
    const reason = err?.name === "ServiceDown" || err?.name === "BadResponse" ? err.message
      : err?.name === "Rejected" || err?.name === "ServerError" ? (err.message || "").slice(0, 160) : whyFailed(err, "");
    S.err = "对照没成功。" + (reason || "再交一次试试。");
    render();
  }
}

// 复述对的概念记成已掌握，漏的、错的记成半懂：交给学习模块的概念表。接口没有（404）或失败只提示，不影响结果
async function writeConcepts(rec, key, title) {
  const items = (rec.concepts || []).map((c) => ({
    name: c.name, status: c.status, book: title, page: c.page ?? rec.scope?.from, note: c.status === "已掌握" ? "复述时讲对了" : "复述时漏了或说错了",
  }));
  if (!items.length) return;
  let note;
  try {
    const { status, data } = await postJson("/api/learn/concepts", { items });
    note = status < 400 && !data?.error ? `已记入概念表 ${items.length} 条` : "概念没记上";
  } catch { note = "概念没记上"; }
  if (S.key !== key || S.rec !== rec) return;
  S.conceptNote = note;
  render();
}

// ───────────────────────── 渲染 ─────────────────────────
const jump = (page, quote) => async () => {
  try {
    if (!(quote ? await revealPassage(page, quote) : false)) gotoPage(page);
  } catch { gotoPage(page); }
};
const pageBtn = (page, quote) => el("button", { type: "button", className: "rt-pg", textContent: `第 ${page} 页`, title: quote ? "跳到原文这一句" : "跳到这一页", onclick: jump(page, quote) });

function rangeRow() {
  const sc = S.scope;
  const row = el("div", { className: "rt-scope" });
  if (!sc) { row.append(el("span", { className: "rt-muted", textContent: "正在定范围…" })); return row; }
  row.append(el("span", { className: "rt-scope-t", textContent: scopeText(sc) }));
  if (S.mode === "edit") row.append(el("button", { type: "button", className: "rt-link", textContent: S.editRange ? "收起" : "改范围", onclick: () => { S.editRange = !S.editRange; S.rangeErr = ""; render(); } }));
  return row;
}

function rangeEditor() {
  const sc = S.scope;
  const num = (v) => el("input", { type: "number", className: "rt-num", min: 1, max: S.n, value: v, inputMode: "numeric" });
  const a = num(sc.from), b = num(sc.to);
  const apply = () => {
    const from = Number(a.value), to = Number(b.value);
    if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from && to <= S.n)) { S.rangeErr = `页码要在 1–${S.n} 之间，起页不大于止页`; return render(); }
    S.scope = { from, to, label: "", kind: "pages" };
    S.pick = true; S.rangeErr = ""; S.editRange = false;
    render();
  };
  for (const i of [a, b]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
  return el("div", { className: "rt-edit" },
    el("div", { className: "rt-edit-row" }, "第 ", a, " 至 ", b, ` 页（共 ${S.n} 页）`, el("button", { type: "button", className: "btn sm", textContent: "确定", onclick: apply })),
    ...(S.scope.kind === "pages" && !S.pick ? [el("p", { className: "rt-hint", textContent: "没有章节信息，默认取当前页前后 10 页，可以改。" })] : []),
    ...(S.rangeErr ? [el("p", { className: "rt-err", textContent: S.rangeErr })] : []));
}

function lengthHint() {
  const sc = S.scope;
  if (!sc) return null;
  const len = sc.to - sc.from + 1;
  return len > MAX_PAGES ? el("p", { className: "rt-hint", textContent: `这一段有 ${len} 页，一次只对照前 ${MAX_PAGES} 页（或前 6 万字）；想对照后面的，改范围分段写。` }) : null;
}

let submitBtn = null;
function updateSubmit() {
  if (!submitBtn) return;
  const ok = squash(ta.value).length >= MIN_RETELL && S.mode === "edit" && !!S.scope;
  submitBtn.disabled = !ok;
  const c = root.querySelector(".rt-count");
  if (c) c.textContent = squash(ta.value).length < MIN_RETELL ? "至少写一两句" : `${squash(ta.value).length} 字`;
}

function prompt() {
  return el("p", { className: "rt-prompt", textContent: "用自己的话写三句这节讲了什么" });
}

function viewEdit(working) {
  const nodes = [rangeRow()];
  if (S.mode === "edit" && S.editRange && S.scope) nodes.push(rangeEditor());
  if (S.mode === "edit") { const h = lengthHint(); if (h) nodes.push(h); }
  nodes.push(prompt());
  ta.readOnly = !!working;
  nodes.push(ta);
  submitBtn = el("button", { type: "button", className: "btn solid", textContent: working ? "对照中…" : "交给 Claude 对照", onclick: submit });
  const bar = el("div", { className: "rt-bar" }, submitBtn);
  if (working) {
    submitBtn.disabled = true;
    bar.append(el("button", { type: "button", className: "rt-link", textContent: "取消", onclick: () => cancelWork() }));
  } else {
    bar.append(el("span", { className: "rt-count" }));
  }
  nodes.push(bar);
  if (working) nodes.push(el("p", { className: "rt-progress", textContent: S.work?.msg || "" }));
  if (S.err && !working) nodes.push(el("p", { className: "rt-err", textContent: S.err }));
  return nodes;
}

function noteLines(rec) {
  const sc = rec.scope || {};
  const out = [];
  if (sc.truncated) out.push(`原文太长，这次只对照到第 ${sc.to} 页` + (sc.asked_to && sc.asked_to > sc.to ? `（你选的范围到第 ${sc.asked_to} 页）` : "") + "。");
  if (sc.skipped?.length) out.push(`第 ${sc.skipped.slice(0, 8).join("、")} 页${sc.skipped.length > 8 ? "等" : ""}没读出文字，没参与对照。`);
  if (rec.dropped > 0) out.push(`另有 ${rec.dropped} 条在原文里找不到出处，没有列出。`);
  return out;
}

function viewResult(rec) {
  const sc = rec.scope || { from: 0, to: 0 };
  const nodes = [
    el("div", { className: "rt-scope" },
      el("span", { className: "rt-scope-t", textContent: scopeText({ from: sc.from, to: sc.to, label: sc.label }) }),
      el("span", { className: "rt-when", textContent: when(rec.at) })),
    el("details", { className: "rt-mine" }, el("summary", { textContent: "我写的" }), el("p", { textContent: rec.retelling || "" })),
  ];
  if (rec.feedback) nodes.push(el("p", { className: "rt-feedback", textContent: rec.feedback }));

  nodes.push(el("h4", { className: "rt-h", textContent: "漏掉的" }, el("small", { textContent: rec.missed.length ? ` ${rec.missed.length} 条` : "" })));
  if (rec.missed.length) {
    nodes.push(el("ul", { className: "rt-list missed" }, ...rec.missed.map((m) =>
      el("li", {}, el("span", { className: "rt-point", textContent: m.point }), " ", pageBtn(m.page, m.quote)))));
  } else nodes.push(el("p", { className: "rt-none", textContent: "对照下来没有漏掉的要点。" }));

  nodes.push(el("h4", { className: "rt-h", textContent: "说错的" }, el("small", { textContent: rec.wrong.length ? ` ${rec.wrong.length} 条` : "" })));
  if (rec.wrong.length) {
    nodes.push(el("ul", { className: "rt-list wrong" }, ...rec.wrong.map((w) =>
      el("li", {},
        el("div", { className: "rt-said" }, el("b", { textContent: "你说" }), w.said),
        el("div", { className: "rt-act" }, el("b", { textContent: "原文其实是" }), w.actually, " ", pageBtn(w.page, w.quote))))));
  } else nodes.push(el("p", { className: "rt-none", textContent: "没有说错的。" }));

  if (rec.concepts?.length) {
    nodes.push(el("h4", { className: "rt-h", textContent: "这次涉及的概念" }, el("small", { textContent: S.fromHistory ? "" : " " + S.conceptNote })));
    nodes.push(el("div", { className: "rt-chips" }, ...rec.concepts.map((c) =>
      el("span", { className: "rt-chip " + (c.status === "已掌握" ? "ok" : "half"), textContent: c.name, title: c.status }, el("i", { textContent: c.status })))));
  }
  for (const line of noteLines(rec)) nodes.push(el("p", { className: "rt-hint", textContent: line }));
  nodes.push(el("div", { className: "rt-acts" },
    el("button", { type: "button", className: "btn sm", textContent: "补充后再交一次", onclick: () => again(rec, true) }),
    el("button", { type: "button", className: "btn sm", textContent: "写一段新的", onclick: () => again(rec, false) })));
  return nodes;
}

// 回到输入：补充时把上次的复述放回去、范围用上次的；写新的就空着，范围按当前页重新算
function again(rec, keep) {
  S.mode = "edit"; S.rec = null; S.err = ""; S.conceptNote = "";
  if (keep && rec.scope?.from) {
    S.scope = { from: rec.scope.from, to: rec.scope.asked_to || rec.scope.to, label: rec.scope.label || "", kind: "pages" };
    S.pick = true;
    S.draft = rec.retelling || "";
  } else { S.draft = ""; if (!S.pick) S.scope = null; }
  ta.value = S.draft;
  saveDraft();
  S.wantFocus = true;
  refresh();
}

function viewHistory() {
  if (!S.history.length || S.mode === "working") return null;
  return el("div", { className: "rt-hist" },
    el("h4", { className: "rt-h", textContent: "最近的复述" }),
    el("ul", {}, ...S.history.map((h) => {
      const sc = h.scope || {};
      const on = S.mode === "result" && S.rec?.id === h.id;
      return el("li", {}, el("button", {
        type: "button", className: "rt-row" + (on ? " on" : ""),
        onclick: () => { S.mode = "result"; S.rec = h; S.fromHistory = true; S.wantScroll = true; render(); },
      }, el("span", { className: "rt-row-a", textContent: `${when(h.at)} · ${sc.label ? sc.label + " · " : ""}第 ${sc.from}–${sc.to} 页` }),
        el("span", { className: "rt-row-b", textContent: `漏 ${h.missed?.length ?? 0} · 错 ${h.wrong?.length ?? 0}` })));
    })));
}

function render() {
  const hadFocus = document.activeElement === ta;
  const pos = hadFocus ? [ta.selectionStart, ta.selectionEnd] : null;
  const nodes = [];
  if (S.mode === "nobook") {
    nodes.push(el("p", { className: "rt-muted", textContent: "打开一本书，读完一节再来这里写复述。" }));
  } else if (S.mode === "result" && S.rec) {
    nodes.push(...viewResult(S.rec));
  } else {
    nodes.push(...viewEdit(S.mode === "working"));
  }
  const hist = viewHistory();
  if (hist) nodes.push(hist);
  root.replaceChildren(...nodes);
  if (S.mode === "edit" || S.mode === "working") updateSubmit();
  const scrollTop = S.wantScroll || (S.wantFocus && S.mode === "edit");
  S.wantScroll = false;
  if (S.wantFocus && S.mode === "edit") {
    S.wantFocus = false;
    ta.focus({ preventScroll: true });
  } else if (hadFocus && pos && root.contains(ta)) {
    ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(pos[0], pos[1]); } catch { /* 焦点放回就行 */ }
  }
  if (scrollTop) {
    const secs = sec.closest(".secs");
    if (secs) secs.scrollTop += sec.getBoundingClientRect().top - secs.getBoundingClientRect().top - 4;
  }
}

// 学习视图第一次显示之前页面可能已经开着书：先按当前书初始化，onShow 再刷新
{
  const book = currentBook();
  if (book) resetBook(book); else S.mode = "nobook";
  render();
}
