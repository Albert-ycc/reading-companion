// 读到哪回顾到哪：打开书回到上次读到的第 N 页，问答视图顶上出一张卡，讲「读到这里为止」讲了什么，不剧透后文。
// 页面负责：定范围（章首到 N，没有章就 N 前 15 页）、取页文字（扫描页先识别）、渲染；服务端（features/recap.py）负责调 Claude、缓存。
// 换书、卡片收起都会静默停掉手上的活：取文字的循环按 token 退出，请求靠 AbortController 断开，服务端见连接断了就杀掉 claude。
import { $, el, api } from "./ui.js";
import { currentBook, getPdf, getCurrentPage, extractText, isScanned, revealPassage } from "./reader.js";
import { showView } from "./panel.js";

const MIN_PAGES = 6;         // 文档不到这么多页不出卡
const MIN_N = 3;             // 读到第 3 页之前没什么可回顾
const DELAY = 1500;          // 开书后等这么久再出卡，让书页先画出来
const FALLBACK_SPAN = 15;    // 没有章节表时回顾 N 前这么多页
const MAX_PAGES = 30;        // 一次最多取这么多页
const MAX_CHARS = 25000;     // 一次最多送这么多字
const LAST_PAGE_CHARS = 6000; // 超预算时读者读到的那一页尽量整页留着（卡要讲的就是读到哪）
const CHAT_KEEP = 0.4;       // 问答区（#messages）至少留 #view-chat 高度的这么多：卡最多占 60% 再减去「Claude 看到」那块
const BODY_MIN = 90;         // 展开时正文至少要有这么高，放不下就折成一行
const MIN_IN_CHAPTER = 3;    // 章里读过的页不到这么多时，回顾章首到 N 太单薄，改取 N 前 15 页

let token = 0;               // 每次开书、收卡 +1：异步流程回来发现不是自己了就静默退出
let card = null;
let timer = 0;
let abort = null;
let curView = null;          // 画着的那张卡的状态（fit 要看它是不是折起、是不是已出结果）

const dismissKey = (key) => "banDu.recap." + key;
const dismissedAt = (key) => { try { return +localStorage.getItem(dismissKey(key)) || 0; } catch { return 0; } };
const setDismissed = (key, n) => { try { localStorage.setItem(dismissKey(key), String(n)); } catch { /* 记不下来就下次再出一次 */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
class Stale extends Error {}

function stop() {
  token++;
  clearTimeout(timer);
  abort?.abort();
  abort = null;
  card?.remove();
  card = null;
  curView = null;
}

window.addEventListener("book-opened", (e) => {
  stop();
  const my = token;
  const n = getCurrentPage() || 1; // 开书时阅读器已经落在上次的页
  const { key, title } = e.detail;
  timer = setTimeout(() => run(my, key, title, n).catch((err) => {
    if (!(err instanceof Stale) && err?.name !== "AbortError") console.error("回顾：出错", err);
  }), DELAY);
});

const typing = () => ($("#q")?.value || "").trim() !== "";

async function run(my, key, title, N) {
  const pdf = getPdf();
  const alive = () => my === token && getPdf() === pdf && currentBook()?.key === key;
  if (!pdf || !alive()) return;
  const total = pdf.numPages;
  if (total < MIN_PAGES || N < MIN_N || N > total || dismissedAt(key) === N) return;
  while (typing()) { // 输入框有字：他在打字，等他发完或删完再出
    await sleep(1500);
    if (!alive()) return;
  }
  if (!$("#view-chat") || !$("#messages")) return;

  const plan = await planRange(N, pdf);
  if (!alive()) return;
  const view = { key, N, plan, phase: "loading", asked: [], pending: [] };
  const go = () => build(title, view, alive, pdf).catch((err) => { if (!(err instanceof Stale)) console.error("回顾：出错", err); });
  mount(view, my, go);
  await go();
}

// 取缓存或生成，再取「你问过」「还没答的小问题」，画出来
async function build(title, view, alive, pdf) {
  const { key, N, plan } = view;
  const ctl = (abort = new AbortController());
  Object.assign(view, { phase: "loading", err: "" });
  paint(view);
  const range = `file=${enc(key)}&from=${plan.from}&to=${N}`;
  const side = fetchSide(key, N);
  let recap = null;
  try {
    recap = (await api(`/api/recap?${range}`).catch(() => null))?.recap || null;
    if (!alive()) return;
    let nocache = false;
    if (!recap) {
      const got = await gather(plan.from, N, alive, pdf);
      if (!alive()) return;
      if (got.chars < 80) return stop(); // 这几页没读到文字（扫描页没识别出来）：没什么可讲的，不出卡
      nocache = got.partial;
      recap = await generate({ file: key, title, from: plan.from, to: N, text: got.text, nocache, ...(got.kept ? { kept_pct: got.kept } : {}) }, ctl.signal);
      if (!alive()) return;
    }
    Object.assign(view, await side);
    if (!alive()) return;
    Object.assign(view, { phase: "done", recap });
  } catch (err) {
    if (err instanceof Stale || err?.name === "AbortError" || !alive()) return;
    Object.assign(view, { phase: "error", err: err?.message || "没回顾出来" });
  }
  paint(view);
}

// 范围：有章节表取包含 N 的那章的章首到 N，没有取 N 前 15 页；一次最多 30 页
async function planRange(N, pdf) {
  let from = Math.max(1, N - FALLBACK_SPAN), label = "";
  try {
    const { getChapters } = await import("./guide.js"); // 导读写坏了就当没有章节表
    const chs = await getChapters();
    const ch = chs?.find((c) => c.from <= N && N <= c.to);
    if (ch && N - ch.from + 1 >= MIN_IN_CHAPTER) {
      from = ch.from;
      label = ch.no == null ? ch.title : `第 ${ch.no} 章 ${ch.title}`;
    }
  } catch { /* 取不到章节表就按 N 前 15 页 */ }
  if (getPdf() !== pdf) throw new Stale();
  return { from: Math.max(from, N - MAX_PAGES + 1), label, cut: from < N - MAX_PAGES + 1 };
}

// 每页只留开头 ratio 的字（每页都留一点，章首的摘要和引言不丢）；尽量断在换行、空格或句号上。和 compare.js 的 clipText 同一个做法
function clipText(text, ratio) {
  if (ratio >= 1 || text.length < 200) return text;
  const k = Math.floor(text.length * ratio);
  const cut = text.slice(0, k);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "), cut.lastIndexOf("。"), cut.lastIndexOf(". "));
  return at > k - 120 ? cut.slice(0, at + 1) : cut;
}

// 取 from..N 的页文字。总字数超过 MAX_CHARS 时每页等比截短（读者读到的最后一页尽量整页留，其余页按剩下的预算等比），不丢最早的页。
// 有页识别失败时 partial，这次的结果服务端不缓存
async function gather(from, N, alive, pdf) {
  const pages = [];
  let partial = false;
  for (let p = from; p <= N; p++) {
    let t;
    try { t = (await extractText(p)).trim(); } catch (err) { if (getPdf() !== pdf) throw new Stale(); throw err; }
    if (!alive()) throw new Stale();
    if (!t) { if (!isScanned(p)) partial = true; continue; }
    pages.push([p, t]);
  }
  const size = (list) => list.reduce((n, [, t]) => n + t.length + 12, 0);
  let ratio = 1;
  if (size(pages) > MAX_CHARS) {
    const last = pages.at(-1);
    const keepLast = last[0] === N ? Math.min(last[1].length, LAST_PAGE_CHARS) : 0;
    const rest = keepLast ? pages.slice(0, -1) : pages;
    ratio = Math.max(0.05, (MAX_CHARS - keepLast - 12) / Math.max(1, size(rest)));
    if (keepLast) last[1] = clipText(last[1], keepLast / last[1].length);
    for (const pg of rest) pg[1] = clipText(pg[1], ratio);
  }
  const text = pages.map(([p, t]) => `[[第 ${p} 页]]\n${t}`).join("\n");
  return { text, chars: text.replace(/\s+/g, "").length, partial, kept: ratio < 1 ? Math.max(1, Math.round(ratio * 100)) : 0 };
}

async function generate(body, signal) {
  let res;
  try {
    res = await fetch("/api/recap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error("伴读的本地服务没在运行");
  }
  let data;
  try { data = await res.json(); } catch { throw new Error("本地服务回的内容读不懂"); }
  if (!res.ok || data.error || !data.recap?.summary) throw new Error(data.error || "没回顾出来");
  return data.recap;
}

// 「你问过」（page <= N 的最近 3 条）和「还没答的小问题」（接口没好就没有这一块）
async function fetchSide(key, N) {
  const [chat, quiz] = await Promise.all([
    api("/api/chat?file=" + enc(key)).catch(() => null),
    api("/api/learn/quiz?file=" + enc(key)).catch(() => null),
  ]);
  const seen = new Set();
  const asked = (Array.isArray(chat?.asked) ? chat.asked : [])
    .filter((a) => a && typeof a.text === "string" && a.text.trim() && (typeof a.page !== "number" || a.page <= N))
    .filter((a) => { const t = a.text.trim(); if (seen.has(t)) return false; seen.add(t); return true; })
    .slice(-3);
  const pending = (Array.isArray(quiz?.items) ? quiz.items : [])
    .filter((q) => q && q.status === "open" && typeof q.question === "string" && q.question.trim() && (typeof q.page !== "number" || q.page <= N))
    .slice(0, 3);
  return { asked, pending };
}

// ───────────────────────── 渲染 ─────────────────────────
function mount(view, my, retry) {
  card?.remove();
  curView = view;
  card = el("div", { id: "recap-card", className: "rcp" });
  card.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || my !== token) return;
    if (b.dataset.act === "go") { setDismissed(view.key, view.N); stop(); }
    else if (b.dataset.act === "fold") { view.folded = !view.folded; paint(view); }
    else if (b.dataset.act === "retry") retry();
    else if (b.dataset.page) revealPassage(+b.dataset.page, "").catch(() => {});
    else if (b.dataset.act === "quiz") showView("learn");
  });
  $("#messages").before(card);
  watchSize();
}

const cut = (s, n) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

function pageBtn(n, text) {
  const b = el("button", { type: "button", className: "rcp-pg", textContent: text });
  b.dataset.page = n;
  return b;
}

// 正文里的「第 N 页」做成能点的：点了跳过去，书页底部出「回到第 N 页」
function linkify(text, total) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/第\s*(\d{1,6})(?:\s*[–—~-]\s*(\d{1,6}))?\s*页/g)) { // 「第 12 页」「第111–112页」，后者跳到起页
    const n = +m[1];
    if (n < 1 || n > total) continue;
    out.push(text.slice(last, m.index), pageBtn(n, m[2] ? `第 ${n}–${m[2]} 页` : `第 ${n} 页`));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function paint(v) {
  if (!card || !card.isConnected) return;
  const total = getPdf()?.numPages || 0;
  const act = (cls, text, a) => { const b = el("button", { type: "button", className: cls, textContent: text }); b.dataset.act = a; return b; };
  // 「接着读」和「展开 / 收起」放在头一行：卡再矮、正文再长，关闭按钮总在最上面，不会被下面的输入区或预测盖住
  const acts = el("div", { className: "rcp-acts" }, act("rcp-go", "接着读", "go"));
  if (v.phase === "error") acts.append(act("rcp-lnk", "重试", "retry"));
  if (v.phase === "done") acts.append(act("rcp-lnk rcp-fold", v.folded ? "展开" : "收起", "fold"));
  const kids = [el("div", { className: "rcp-head" },
    el("span", { className: "rcp-tag", textContent: "回顾" }),
    el("b", { className: "rcp-title", textContent: `上次读到第 ${v.N} 页` }),
    el("span", { className: "rcp-sub", textContent: "前面讲了什么" }),
    acts)];
  if (v.phase === "loading") {
    kids.push(el("p", { className: "rcp-wait" }, el("i", { className: "rcp-dot" }), "正在回顾前面讲了什么…"));
  } else if (v.phase === "error") {
    kids.push(el("p", { className: "rcp-err", textContent: v.err }));
  } else {
    const body = el("div", { className: "rcp-body" });
    body.append(el("p", { className: "rcp-sum" }, ...linkify(v.recap.summary, total)));
    const pg = Array.isArray(v.recap.pages) ? v.recap.pages : [v.plan.from, v.N];
    const basis = `${v.plan.label ? v.plan.label + " · " : ""}依据第 ${pg[0] === pg[1] ? pg[0] : `${pg[0]}–${pg[1]}`} 页`
      + (v.recap.kept_pct ? `（字数多，每页取了前 ${v.recap.kept_pct}%）` : "")
      + (v.plan.cut ? `（这一章比 ${MAX_PAGES} 页长，只取靠近这一页的 ${MAX_PAGES} 页）` : "");
    body.append(el("p", { className: "rcp-basis", textContent: basis }));
    if (v.asked.length) {
      const ul = el("ul", { className: "rcp-list" });
      for (const a of v.asked) {
        const li = el("li");
        if (typeof a.page === "number") li.append(pageBtn(a.page, `第 ${a.page} 页`), " ");
        li.append(cut(a.text, 60));
        ul.append(li);
      }
      body.append(el("div", { className: "rcp-blk" }, el("h4", { textContent: "你问过" }), ul));
    }
    if (v.pending.length) {
      const ul = el("ul", { className: "rcp-list" });
      for (const q of v.pending) {
        const li = el("li");
        if (typeof q.page === "number") li.append(pageBtn(q.page, `第 ${q.page} 页`), " ");
        li.append(cut(q.question, 70));
        ul.append(li);
      }
      const go = el("button", { type: "button", className: "rcp-lnk", textContent: "去答" });
      go.dataset.act = "quiz";
      body.append(el("div", { className: "rcp-blk" }, el("h4", {}, "还没答的小问题 ", go), ul));
    }
    kids.push(body);
  }
  card.replaceChildren(...kids);
  fit();
}

// 卡的高度跟 #view-chat 剩下的高度走：卡 + 「Claude 看到」最多占 60%，问答区（#messages）总留 40% 以上。
// 展开放不下（正文不到 BODY_MIN）就折成一行标题加「接着读」，一行也放不下就先藏起来（空间回来再出）。
// #view-chat 的高度会因窗口缩放、输入区长高（划线后出输入预测）而变，所以盯着它和 #sees 的尺寸
let ro = null;
function watchSize() {
  if (ro || typeof ResizeObserver === "undefined") return;
  ro = new ResizeObserver(() => fit());
  for (const sel of ["#view-chat", "#sees"]) { const n = $(sel); if (n) ro.observe(n); }
}
window.addEventListener("view-changed", () => fit());

function fit() {
  const v = curView;
  if (!card?.isConnected || !v) return;
  const view = $("#view-chat");
  const H = view?.clientHeight || 0;
  if (!H || view.hidden) return; // 问答视图不在前台量不出来，回来时 view-changed 再量
  const sees = $("#sees");
  const used = sees && !sees.hidden ? sees.offsetHeight : 0;
  const margin = parseFloat(getComputedStyle(card).marginTop) || 0;
  const cap = Math.floor(H * (1 - CHAT_KEEP) - used - margin);
  card.style.maxHeight = Math.max(cap, 0) + "px";
  card.hidden = false;
  card.classList.add("line");
  const lineH = card.offsetHeight;
  if (lineH > cap) { card.hidden = true; return; }
  const canFull = v.phase === "done" && cap >= lineH + BODY_MIN;
  card.classList.toggle("line", !!v.folded || !canFull);
  card.classList.toggle("noroom", !canFull);
}
