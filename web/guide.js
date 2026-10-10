// 导读卡：批注栏里的「导读」视图。
// 设计、状态和文案见 design/guide/interaction.md、mock.html（注释里的 A1、B2 这样的编号对应 mock）。
// 页面负责：判类型、定范围、取页文字（扫描页先识别）、渲染；服务端（features/guide.py）负责调 Claude、核对出处、缓存。
import { el, toast, api } from "./ui.js";
import { registerView, showView, setBadge } from "./panel.js";
import { registerAction } from "./registry.js";
import { currentBook, getPdf, getCurrentPage, extractText, isScanned, getOutline, revealPassage, focusPassage } from "./reader.js";
import { compose } from "./chat.js";

const root = registerView("guide", { label: "导读", order: 10, onShow: () => { S.scopePick = null; doneKeys.clear(); refresh(); } });
const gv = el("div", { className: "gv" });
root.append(gv);
// 双击导读里的按钮：第一下点击就把界面重画了，第二下按在新画出的文字上，浏览器从那里起选一段，选区的另一头落到问答栏的快捷问题和输入框。点击后半秒内的第二下按下不让它起选区
let lastPress = 0;
gv.addEventListener("click", (e) => { if (e.target.closest("button, li, p.skip")) lastPress = e.timeStamp; }, true);
gv.addEventListener("mousedown", (e) => { if (e.detail > 1 && e.timeStamp - lastPress < 500) e.preventDefault(); });
registerAction({ name: "导读", desc: "这份材料讲什么、从哪读起", run: () => showView("guide"), order: 10 });

// ───────────────────────── 常量 ─────────────────────────
const STEMS = {
  paper: [["problem", "研究什么问题"], ["method", "怎么做的"], ["finding", "发现了什么"], ["limit", "局限在哪"]],
  consensus: [["recs", "推荐了什么"], ["evidence", "证据等级多高"], ["population", "适用哪些人"], ["previous", "和旧版差在哪"]],
};
const WORK_STEM = { paper: "和你的工作有什么关系", consensus: "对业务有什么影响" };
const NAMES = { paper: ["论文", "期刊论文"], consensus: ["共识", "专家共识 / 指南"], brief: ["速", "速览"] };
const DO = { read: "精读", skim: "略读" };
const CH_RE = /^\s*(第\s*[0-9一二三四五六七八九十百]+\s*[章篇]|chapter\s+\d+|part\s+[ivx\d]+)/i;
const NUM_TITLE = /^\s*(\d{1,2})\s+[A-Z]/;                // 「1 Introduction…」「6 T cells…」这种不带 Chapter 的写法（章名可以只有一个大写字母开头的词）
const APPENDIX = /^\s*(appendix\s+[A-Z0-9]|附录)/i;
const isChapterTitle = (t) => CH_RE.test(t) || NUM_TITLE.test(t) || APPENDIX.test(t);
// 报告书前面的概要：读者最想先读的部分，算一章放在表里第一位（不参与选层，只在选定的层里补进来）
const SUMMARY = /^\s*(executive\s+summary|summary|摘要|概要|内容提要)\s*$/i;
const CH_PREFIX = /^\s*(chapter\s+\d+\s*[:：.\-–]?\s*|第\s*[0-9一二三四五六七八九十百]+\s*[章篇]\s*[:：.\-–]?\s*|\d{1,2}\s+(?=[A-Z]))/i;
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const MAX_CHAPTER = 60;
const SEG = 40;
// 版面把英文字母排得很开的论文（NEJM 的「ABSTR ACT」），去掉空白后再比一遍
const SPACED_OK = new Set(["摘要", "结构化摘要", "关键词", "参考文献", "共识", "指南"]);
const PAPER_SIGNALS = { 摘要: /abstract|摘\s*要/i, 结构化摘要: /background[\s\S]{0,1500}methods?[\s\S]{0,2500}results?|目的[\s\S]{0,600}方法[\s\S]{0,800}结果/i, 关键词: /key\s*words?|关键词/i, DOI: /\bdoi\b|10\.\d{4,9}\//i, 参考文献: /references|参\s*考\s*文\s*献/i };
const CONSENSUS_SIGNALS = {
  共识: /共\s*识|consensus/i, 指南: /指\s*南|guidelines?/i, 规范: /(技术|诊疗|诊断|操作|临床应用|管理)\s*规\s*范(?!\s*化)/, 推荐意见: /推\s*荐\s*意\s*见|recommendations?/i,
  证据等级: /证\s*据\s*(等\s*级|分\s*级|质\s*量)|level of evidence|grade of recommendation/i, GRADE: /\bGRADE\b/,
};
const REF_HEAD = /^\s*(references?|bibliography|参\s*考\s*文\s*献)\s*$/im;
const TAIL_TITLE = /^\s*(references?|further reading|bibliography|参\s*考\s*文\s*献|延伸阅读)/i;
const TOC_LINE = /^\s*第\s*[0-9一二三四五六七八九十百]+\s*[章节]|^\s*chapter\s+\d+|^\s*附录/i;

// ───────────────────────── 状态 ─────────────────────────
const S = {
  token: 0,
  key: "", title: "", n: 0,
  stage: "nobook",       // nobook detecting short choose noch building manual scope
  kind: null,            // 本地判定：short book paper consensus unknown
  why: "",
  type: null,            // 实际使用的类型：paper consensus chapter brief short unknown
  fixOpen: false,
  outline: null,         // pdf.js 书签原样
  chapters: null,        // [{no, title, from, to, kind, children}]
  chSource: "",         // outline 书签推出的 / toc 目录页建的 / scan 扫标题建的
  scope: null,           // {id, kind, label, from, to, chapterNo?}
  scopePick: null,       // 读者在「换一章」里挑的章
  manualScope: null,     // 指定页码生成过的范围
  srv: null,
  guide: null,
  idx: {},               // 章节选择器用：服务端已有导读的范围
  pickerOpen: false,
  confirmRegen: false,
  active: null,          // {qi, q, page}：展开出处的那一条
  readerPage: 1,
  dismissed: new Set(),
  build: null,           // 建章节表的进度
  manual: null,          // 指定页码的输入
  pending: null,         // 识别失败，等读者决定：{job, failed}
  err: null,
  errKeepsOld: false,
  ocrInfo: null,
  scannedBook: undefined,
  down: false,           // 本地服务没在运行，取不到已生成的导读
  bookmarkOk: false,     // 书签能推出章节表（存过章节表时，据此给「改回书签的章节表」）
};
const jobs = new Map(); // `${书}|${范围id}` -> 页面里正在做的生成（取文字、等流、轮询）

const jobKey = () => S.key + "|" + (S.scope?.id || "");
// 标签旁的点跟着任务走：只要还有生成在跑（不管在哪本书里）就保持脉动，都停了才熄灭
const anyRunning = () => [...jobs.values()].some((j) => !j.cancelled);
const doneKeys = new Set(); // 在别的书里写完、读者还没回去看的书
const badgeIdle = () => setBadge("guide", anyRunning() ? "busy" : doneKeys.size ? "done" : null);
const curJob = () => (S.scope ? jobs.get(jobKey()) : null);
const rng = (a, b) => (a === b ? `${a}` : `${a}–${b}`);
const sameBook = (key) => S.key === key;
const isShown = () => !root.hidden;

// ───────────────────────── 小工具 ─────────────────────────
const E = (tag, cls, ...kids) => el(tag, cls ? { className: cls } : {}, ...kids.flat(Infinity).filter((k) => k != null && k !== false));
const P = (tag, props, ...kids) => el(tag, props, ...kids.flat(Infinity).filter((k) => k != null && k !== false)); // 带属性、子节点可能为空的元素
const em = (v) => el("em", { textContent: String(v) });
const btn = (cls, text, onclick, props = {}) => el("button", { type: "button", className: cls, textContent: text, onclick, ...props });
const squash = (s) => s.normalize("NFKC").toLowerCase().replace(/[^0-9a-z\u3400-\u9fff]/g, "");
// PDF 换行在中文之间留下的空白去掉
const cjkTrim = (s) => s.replace(/\s+(?=[\u3400-\u9fff，。、；：！？）」（「])/g, "").replace(/(?<=[\u3400-\u9fff，。、；：！？（「])\s+/g, "").replace(/\s+/g, " ").trim();
const cnNum = (n) => {
  const d = "零一二三四五六七八九";
  if (n < 10) return d[n];
  if (n < 20) return "十" + (n % 10 ? d[n % 10] : "");
  if (n < 100) return d[Math.floor(n / 10)] + "十" + (n % 10 ? d[n % 10] : "");
  return String(n);
};
const parseNo = (title) => {
  const m = title.match(/(?:chapter|part)\s+(\d+)/i) || title.match(/第\s*(\d+)\s*[章篇]/);
  if (m) return +m[1];
  const c = title.match(/第\s*([零〇一二三四五六七八九十]+)\s*[章篇]/);
  if (!c) { const n = NUM_TITLE.exec(title); return n ? +n[1] : null; } // 「6 T cells…」章号就是开头那个数字
  const s = c[1];
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    return (a ? CN_DIGIT[a] : 1) * 10 + (b ? CN_DIGIT[b] : 0);
  }
  return CN_DIGIT[s] ?? null;
};
const when = (iso) => {
  const m = /^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d)/.exec(iso || "");
  return m ? `${+m[1]} 月 ${+m[2]} 日 ${m[3]}` : "";
};
const estLabel = (sec) => (sec <= 35 ? "约半分钟" : sec <= 55 ? "约 40 秒" : sec <= 90 ? "约 1 分钟" : "1 到 2 分钟");
const estSec = (chars) => 12 + chars / 2500;
// 服务没在运行：api() 抛 ServiceDown；fetch 直接拒绝（旧版 api）时是 TypeError
const isDown = (err) => err?.name === "ServiceDown" || err instanceof TypeError;
const RESTART = ["launchctl kickstart -k ", "gui/$(id -u)/com.albert.reading-companion"]; // 后半截不换行：窄栏里整段落到第二行，不在「-u」中间断开
const bookName = (key, title) => title || key.split("/").pop().replace(/\.pdf$/i, "");
const post = (path, body, signal) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
const countOutline = (o) => o.reduce((n, x) => n + 1 + countOutline(x.children || []), 0);
const flat = (outline, depth = 0) => outline.flatMap((o) => [{ title: o.title, page: o.page, depth }, ...flat(o.children || [], depth + 1)]);

// ───────────────────────── 类型判定（本地规则，不调 Claude）─────────────────────────
const typeKey = () => "banDu.guideType." + S.key;
const getOverride = () => { try { return localStorage.getItem(typeKey()) || null; } catch { return null; } };
const setOverride = (t) => { try { localStorage.setItem(typeKey(), t); } catch { /* 读不到就下次重新判 */ } };
const clearOverride = () => { try { localStorage.removeItem(typeKey()); } catch { /* 清不掉就还是手动选的那个 */ } };
const hits = (table, text, compact) => Object.entries(table).filter(([k, re]) => re.test(text) || (SPACED_OK.has(k) && re.test(compact))).map(([k]) => k);

async function detect() {
  const key = S.key, pdf = getPdf();
  const same = () => { if (S.key !== key || getPdf() !== pdf) throw new Stale(); };
  const outline = S.outline ?? (S.outline = await getOutline().catch(() => []));
  same();
  const chLike = [0, 1, 2].flatMap((d) => layerOf(outline, d)).filter((o) => isChapterTitle(o.title));
  if (S.n <= 5) return { kind: "short", why: `${S.n} 页` };
  if (S.n > 100) return { kind: "book", why: "页数超过 100" };
  const first = (await extractText(1)) + "\n" + (S.n > 1 ? await extractText(2) : "");
  same();
  const head = first.slice(0, 6000);
  const title = first.slice(0, 900);
  const cHead = head.replace(/\s+/g, ""), cTitle = title.replace(/\s+/g, "");
  const cAll = hits(CONSENSUS_SIGNALS, head, cHead), pAll = hits(PAPER_SIGNALS, head, cHead);
  const TITLE_WORDS = /共\s*识|指\s*南|consensus|guideline|(技术|诊疗|诊断|操作|临床应用|管理)\s*规\s*范(?!\s*化)/i;
  if ((hits(CONSENSUS_SIGNALS, title, cTitle).length && (TITLE_WORDS.test(title) || TITLE_WORDS.test(cTitle))) || cAll.length >= 3) return { kind: "consensus", why: "前两页有" + cAll.join("、") };
  if (pAll.length >= 2) return { kind: "paper", why: "前两页有" + pAll.join("、") };
  if (chLike.length >= 3) return { kind: "book", why: `书签里有 ${chLike.length} 个「章」` };
  return { kind: "unknown", why: "" };
}

// ───────────────────────── 章节：书签、章节表 ─────────────────────────
// 第 d 层的书签（0 是最外层）
function layerOf(outline, d) {
  let cur = outline;
  for (let i = 0; i < d; i++) cur = cur.flatMap((o) => o.children || []);
  return cur.filter((o) => o.page);
}

// 章可能挂在第二、三层（根只有一条书名，或章全在「前言」下面）：0–3 层里挑章名最多的一层；
// 没有一层有 3 条以上的章名，就取第一个有 3 条以上的层。用这一层的条数和页数比来判「一页一条」
function pickOutline(outline, n) {
  const layers = [0, 1, 2, 3].map((d) => layerOf(outline, d));
  const cl = layers.map((l) => l.filter((o) => isChapterTitle(o.title)).length);
  const best = Math.max(...cl);
  const depth = best >= 3 ? cl.indexOf(best) : layers.findIndex((l) => l.length >= 3);
  if (depth < 0) return null;
  const layer = layers[depth];
  if (layer.length >= 0.8 * n) return null; // 一页一条的书签是垃圾
  let chosen = best >= 3 ? layer.filter((o) => isChapterTitle(o.title)) : layer;
  if (best >= 3) {
    const firstCh = Math.min(...chosen.map((o) => o.page));
    const sums = layer.filter((o) => SUMMARY.test(o.title) && o.page < firstCh);
    if (sums.length === 1) chosen = [sums[0], ...chosen];
  }
  const junk = chosen.filter((o) => /^(page|p\.?|第?\s*\d+\s*页?|[a-z]?\d+|封面|目录)?$/i.test(o.title.trim()));
  if (junk.length >= 0.5 * chosen.length) return null;
  if (new Set(chosen.map((o) => o.page)).size < 0.9 * chosen.length) return null;
  return { depth, chosen };
}

function chaptersFromOutline(pick, outline, n) {
  // 章的终点取下一个同层或更外层的书签（含前言、索引、附录这类非章条目）
  const bounds = Array.from({ length: pick.depth + 1 }, (_, d) => layerOf(outline, d)).flat().sort((a, b) => a.page - b.page);
  const chosen = [...pick.chosen].sort((a, b) => a.page - b.page);
  let seq = 0;
  return chosen.map((o) => {
    const next = bounds.find((t) => t.page > o.page);
    const appendix = APPENDIX.test(o.title);
    const summary = !appendix && SUMMARY.test(o.title);
    const no = appendix || summary ? null : parseNo(o.title) ?? (seq + 1);
    if (no != null) seq = no;
    return { no, title: appendix || summary ? o.title.trim() : o.title.replace(CH_PREFIX, "").trim() || o.title, from: o.page, to: next ? next.page - 1 : n, kind: appendix ? "appendix" : summary ? "summary" : "chapter", children: o.children || [] };
  });
}

async function resolveChapters() {
  if (S.chapters) return S.chapters;
  const key = S.key, pdf = getPdf();
  const outline = S.outline ?? (S.outline = await getOutline().catch(() => []));
  if (S.key !== key || getPdf() !== pdf) throw new Stale();
  // 读者建过（或重建过）的章节表优先于书签推出来的，不然重建之后一刷新又回到书签那份
  const saved = await api("/api/guide/chapters?file=" + encodeURIComponent(key)).catch((err) => { if (isDown(err)) throw err; return {}; });
  if (S.key !== key) throw new Stale();
  const pick = outline.length ? pickOutline(outline, S.n) : null;
  S.bookmarkOk = !!pick;
  if (saved.chapters?.length) { S.chSource = saved.source || "table"; return (S.chapters = saved.chapters.map((c) => ({ ...c, children: [] }))); }
  if (pick) { S.chSource = "outline"; return (S.chapters = chaptersFromOutline(pick, outline, S.n)); }
  return null;
}

// 给别的功能（导图）用：当前书的章节列表 [{no, title, from, to}]。书签可用就取书签推出的，否则取已建的章节表，都没有返回 null
export async function getChapters() {
  const book = currentBook();
  if (!book) return null;
  if (book.key !== S.key) resetBook(book);
  S.n = getPdf().numPages;
  if (S.n <= MAX_CHAPTER) return null; // 60 页以内的论文、共识没有「章」
  try {
    const list = await resolveChapters();
    return list ? list.map(({ no, title, from, to }) => ({ no, title, from, to })) : null;
  } catch (err) {
    if (staleErr(err) || isDown(err)) return null; // 读到一半换书了；服务没开时导图自己会提示
    throw err;
  }
}

const chapterAt = (page) => {
  let cur = S.chapters?.[0];
  for (const c of S.chapters || []) if (c.from <= page) cur = c;
  return cur;
};

// 章过长就按下一级书签（没有就每 40 页）切成段，返回包含 page 的那一段的范围
function segmentsOf(ch) {
  const ranges = [];
  if (ch.to - ch.from + 1 > MAX_CHAPTER) {
    const subs = (ch.children || []).filter((c) => c.page && c.page > ch.from && c.page <= ch.to).map((c) => c.page);
    let cuts = [ch.from];
    for (const p of subs) if (p - cuts.at(-1) >= SEG) cuts.push(p);
    if (!cuts.every((p, i) => (cuts[i + 1] ?? ch.to + 1) - p <= MAX_CHAPTER)) {
      cuts = [];
      for (let p = ch.from; p <= ch.to; p += SEG) cuts.push(p);
    }
    cuts.forEach((p, i) => ranges.push([p, (cuts[i + 1] ?? ch.to + 1) - 1]));
  } else ranges.push([ch.from, ch.to]);
  return ranges;
}

const scopeId = (a, b) => `chapter:${a}-${b}`;

function scopeOfChapter(ch, page) {
  const ranges = segmentsOf(ch);
  const idx = Math.max(0, ranges.findIndex(([a, b]) => page >= a && page <= b));
  const [from, to] = ranges[idx];
  const segInfo = ranges.length > 1 ? `（第 ${idx + 1} 段，共 ${ranges.length} 段）` : "";
  const label = ch.kind === "appendix" || ch.kind === "summary" || ch.no == null ? ch.title : `第 ${ch.no} 章 ${ch.title}`;
  return { id: scopeId(from, to), kind: "chapter", label: label + segInfo, from, to, ...(ch.no == null ? {} : { chapterNo: ch.no }), segInfo };
}

// ───────────────────────── 刷新：判类型 → 定范围 → 问服务端 ─────────────────────────
function resetBook(book) {
  S.build?.abort?.abort();
  Object.assign(S, {
    key: book.key, title: book.title, kind: null, why: "", type: null, fixOpen: false, outline: null, chapters: null, chSource: "", scope: null,
    scopePick: null, manualScope: null, srv: null, guide: null, idx: {}, pickerOpen: false, confirmRegen: false, active: null,
    build: null, manual: null, pending: null, err: null, errKeepsOld: false, ocrInfo: null, ocrBusy: null, scannedBook: undefined, dismissed: new Set(), down: false, bookmarkOk: false,
  });
}

async function refresh() {
  const token = ++S.token;
  const book = currentBook();
  if (!book) { Object.assign(S, { key: "", stage: "nobook", scope: null }); return render(); }
  const pdf = getPdf();
  try {
    await doRefresh(token, book);
  } catch (err) {
    if (staleErr(err, pdf) || token !== S.token) return; // 中途换书了：新那本自己会重画
    console.error("导读：刷新出错", err);
  }
}

async function doRefresh(token, book) {
  const pdf0 = getPdf();
  if (book.key !== S.key) resetBook(book);
  S.n = getPdf().numPages;
  S.readerPage = getCurrentPage() || 1;
  if (!S.kind) {
    S.stage = "detecting";
    render();
    try {
      const d = await detect();
      if (token !== S.token) return;
      S.kind = d.kind;
      S.why = d.why;
    } catch (err) {
      if (staleErr(err, pdf0) || token !== S.token || S.key !== book.key) throw err; // 换书了（reader 里 pdf 已置空），不是判不出
      console.error("导读：类型判定失败", err);
      S.kind = "unknown";
    }
  }
  const ov = getOverride();
  S.type = ov || (S.kind === "book" ? "chapter" : S.kind);
  S.scope = null;
  S.down = false;
  if (S.type === "short" || S.type === "unknown") {
    Object.assign(S, { stage: S.type === "short" ? "short" : "choose", srv: null, guide: null });
    return render();
  }
  if (S.type === "chapter") {
    let list;
    try { list = await resolveChapters(); } catch (err) { if (isDown(err) && token === S.token) return setDown(); throw err; }
    if (token !== S.token || S.key !== book.key) return;
    if (list) {
      S.scope = S.scopePick && S.scopePick.chapters === list ? S.scopePick.scope : scopeOfChapter(chapterAt(S.readerPage), S.readerPage);
    } else if (S.manualScope) {
      S.scope = S.manualScope;
    } else {
      // 没有章节表：把已经生成过的指定页码导读也取回来，列在页面上（刷新后不然找不到）
      const r = await api("/api/guide/index?file=" + encodeURIComponent(book.key)).catch((err) => (isDown(err) ? null : { scopes: {} }));
      if (token !== S.token || S.key !== book.key) return;
      if (!r) return setDown();
      S.idx = r.scopes || {};
      S.stage = S.manual ? "manual" : S.build ? "building" : "noch";
      return render();
    }
  } else {
    S.scope = { id: `${S.type}:1-${S.n}`, kind: "doc", label: "全文", from: 1, to: S.n };
  }
  await loadStatus(token);
}

// 服务没开：别把「取不到」画成「从没生成过」
function setDown() {
  Object.assign(S, { down: true, srv: null, guide: null, err: null, errKeepsOld: false, pending: null, stage: S.scope ? "scope" : "down" });
  render();
}

async function loadStatus(token = S.token) {
  const key = S.key, sid = S.scope.id;
  let down = false;
  const soft = (fallback) => (err) => { if (isDown(err)) down = true; return fallback; };
  const [srv, idx] = await Promise.all([
    api(`/api/guide?file=${encodeURIComponent(key)}&scope=${encodeURIComponent(sid)}`).catch(soft({ status: "none" })),
    api("/api/guide/index?file=" + encodeURIComponent(key)).catch(soft({ scopes: {}, running: [] })),
  ]);
  if (token !== S.token || key !== S.key || S.scope?.id !== sid) return;
  if (down) return setDown();
  S.down = false;
  S.srv = srv;
  S.idx = idx.scopes || {};
  S.guide = srv.status === "done" ? srv.guide : srv.previous || null;
  S.err = srv.status === "error" ? { stage: srv.stage, message: srv.message } : null;
  S.errKeepsOld = false;
  S.stage = "scope";
  if (srv.status === "running" && !jobs.has(key + "|" + sid)) attach(key, S.scope, srv);
  if (idx.running?.length) setBadge("guide", "busy");
  else if (isShown()) { doneKeys.clear(); badgeIdle(); } // 人在导读里，别的书写完留下的 done 点该消了；别的书里还在跑的任务继续脉动
  render();
}

// 服务端有任务在跑、页面没订阅（刷新过页面、从别的书切回来）：每 1.5 秒问一次，直到出结果
function attach(key, scope, srv, type = S.type, title = S.title) {
  const job = newJob(key, scope, type);
  job.title = title;
  job.phase = "stream";
  job.polling = true;
  job.misses = 0;
  job.previous = srv.previous || null;
  for (const ev of srv.partial || []) reduce(job.model, ev);
  const jk = key + "|" + scope.id;
  jobs.set(jk, job);
  setBadge("guide", "busy");
  const tick = async () => {
    if (jobs.get(jk) !== job) return;
    const r = await api(`/api/guide?file=${encodeURIComponent(key)}&scope=${encodeURIComponent(scope.id)}`).catch(() => null);
    if (jobs.get(jk) !== job) return;
    if (!r) {
      // 连着几次都问不到：服务没了，别一直装作还在生成
      if (++job.misses >= 3) return fail(job, { stage: "down", message: "伴读的本地服务没在运行，这一份没有生成完。" });
      return void setTimeout(tick, 3000);
    }
    job.misses = 0;
    if (r.status === "running") {
      job.model = newModel();
      for (const ev of r.partial || []) reduce(job.model, ev);
      if (sameBook(key) && S.scope?.id === scope.id) render();
      return void setTimeout(tick, 1500);
    }
    jobs.delete(jk);
    if (r.status === "done") return finishDone(key, scope.id, r.guide);
    badgeIdle();
    if (sameBook(key) && S.scope?.id === scope.id) { S.guide = job.previous; S.errKeepsOld = !!job.previous; S.err = r.status === "error" ? { stage: r.stage, message: r.message } : null; render(); }
    else if (!sameBook(key) && r.status === "error") toast(`《${bookName(key, job.title)}》的导读没有生成出来`);
  };
  setTimeout(tick, 1500);
}

function finishDone(key, sid, guide) {
  if (!sameBook(key)) doneKeys.add(key);
  if (anyRunning()) badgeIdle(); else setBadge("guide", "done"); // 都写完了才亮静止的点；人在别的书里时也亮，进这本书的导读后消失
  if (!sameBook(key)) toast(`《${guide.title || guide.file.split("/").pop().replace(/\.pdf$/i, "")}》的导读写好了`);
  if (sameBook(key) && S.scope?.id === sid) {
    Object.assign(S, { guide, srv: { status: "done", guide }, err: null, errKeepsOld: false, confirmRegen: false, active: null, ocrInfo: null });
  }
  if (sameBook(key)) api("/api/guide/index?file=" + encodeURIComponent(key)).then((r) => { if (sameBook(key)) { S.idx = r.scopes || {}; render(); } }).catch(() => {});
  render();
}

// ───────────────────────── 生成：取页文字 → 提交 → 订阅流 ─────────────────────────
function newModel() { return { phase: "", summary: null, path: null, qs: [], work: null, pre: [], hist: [], fresh: new Set() }; }
function newJob(key, scope, type) {
  return { key, scope, type, phase: "collect", prog: { done: 0, total: 0 }, scanTotal: 0, model: newModel(), cancelled: false, previous: null, abort: null, failed: [], pages: new Map(), sent: null };
}

function reduce(m, ev) {
  switch (ev.type) {
    case "stage": m.phase = ev.stage; break;
    case "reset": Object.assign(m, newModel()); break;
    case "summary": m.summary = ev.text; m.fresh.add("summary"); break;
    case "path": m.path = ev.items; m.fresh.add("path"); break;
    case "q": {
      const i = m.qs.findIndex((q) => (ev.k ? q.k === ev.k : q.q === ev.q));
      if (i < 0) m.qs.push(ev); else m.qs[i] = ev;
      m.fresh.add("q:" + (ev.k || ev.q));
      break;
    }
    case "work": m.work = ev; m.fresh.add("work"); break;
    case "pre": m.pre.push(ev); m.fresh.add("pre" + m.pre.length); break;
    case "hist": m.hist.push(ev); m.fresh.add("hist" + m.hist.length); break;
    default: break;
  }
}

// 书换了：异步流程里 await 回来发现读的已经不是开始时那本，就抛这个，由流程最外层静默收掉
class Stale extends Error {}
const staleErr = (err, pdf) => err instanceof Stale || (pdf !== undefined && getPdf() !== pdf) || /Transport destroyed|Worker was destroyed|Loading aborted/i.test(err?.message || "");

async function hasTextLayer(n, pdf = getPdf()) {
  if (!pdf) throw new Stale();
  try {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    return tc.items.some((it) => it.str.trim());
  } catch (err) {
    if (getPdf() !== pdf) throw new Stale(); // 切书时 pdf.js 会报 Transport destroyed
    throw err;
  }
}

// 范围内每页的文字；扫描页先识别（两页并行，进度写在 job.prog）
async function collect(job, only) {
  job.pdf ??= getPdf();
  const pdf = job.pdf;
  try {
    return await collectPages(job, only, pdf);
  } catch (err) {
    if (staleErr(err, pdf) || job.cancelled) return false; // 读到一半换书、或被取消：静默收掉
    throw err;
  }
}

async function collectPages(job, only, pdf) {
  const { from, to } = job.scope;
  const nums = only || Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const needOcr = [];
  for (const n of nums) {
    if (job.cancelled || !sameBook(job.key)) return false;
    if (await hasTextLayer(n, pdf)) job.pages.set(n, await extractText(n)); else needOcr.push(n);
  }
  if (!only) job.scanTotal = needOcr.length;
  job.prog = { done: 0, total: needOcr.length };
  job.failed = [];
  let i = 0;
  const work = async () => {
    while (i < needOcr.length && !job.cancelled && sameBook(job.key) && getPdf() === pdf) {
      const n = needOcr[i++];
      const t = await extractText(n);
      if (getPdf() !== pdf) throw new Stale();
      job.pages.set(n, t);
      if (!t.trim() && !isScanned(n)) job.failed.push(n); // 识别没成功（空白页识别成功也是空，但会记成扫描页）
      job.prog.done++;
      if (jobs.get(jobKey()) === job) render();
    }
  };
  await Promise.all([work(), work()]);
  return !job.cancelled && sameBook(job.key);
}

// 去掉参考文献：标题行所在页只留标题之前的文字，之后连续的编号条目页丢掉
function trimDocPages(pages, outline, total) {
  const nums = [...pages.keys()].sort((a, b) => a - b);
  const out = new Map(pages);
  let start = outline.filter((o) => o.page && o.page > 1).find((o) => TAIL_TITLE.test(o.title))?.page;
  if (!start) start = nums.find((n) => n >= Math.ceil(total * 0.3) && REF_HEAD.test(pages.get(n) || ""));
  if (!start || !out.has(start)) return out;
  const head = out.get(start);
  const m = REF_HEAD.exec(head);
  out.set(start, m ? head.slice(0, m.index) : head);
  const looksLikeRefs = (t) => {
    const lines = t.split("\n").filter((l) => l.trim());
    if (lines.length < 5) return false;
    return lines.filter((l) => /^\s*[\[(]?\d{1,3}[\]).]?\s+\S/.test(l) || /doi|et al|\d{4};\s*\d+/i.test(l)).length / lines.length > 0.35;
  };
  for (const n of nums) {
    if (n <= start) continue;
    if (looksLikeRefs(pages.get(n) || "")) out.delete(n); else break;
  }
  if (!(out.get(start) || "").trim()) out.delete(start);
  return out;
}

function trimChapterPages(pages, ch) {
  const out = new Map(pages);
  const tail = (ch?.children || []).filter((c) => c.page && TAIL_TITLE.test(c.title)).map((c) => c.page);
  if (tail.length) for (const n of [...out.keys()]) if (n > Math.min(...tail)) out.delete(n);
  return out;
}

async function buildHistory(scope, key) {
  const [book, chat] = await Promise.all([
    api("/api/book?file=" + encodeURIComponent(key)).catch(() => ({})),
    api("/api/chat?file=" + encodeURIComponent(key)).catch(() => ({})),
  ]);
  const items = [];
  const seen = new Set();
  const add = (kind, text, page) => {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t || seen.has(t) || items.length >= 20) return;
    seen.add(t);
    items.push({ id: "h" + (items.length + 1), kind, page, text: t.slice(0, 200) });
  };
  for (const h of book.highlights || []) if (h.page >= scope.from && h.page <= scope.to && !h.kind) add("划线", h.text, h.page);
  const asks = chat.asked || (chat.messages || []).filter((m) => m.role === "user" && m.text); // asked 含收进历史的旧对话
  for (const m of asks) if (m.page >= scope.from && m.page <= scope.to) add("提问", m.text);
  for (const m of asks.slice(-10)) add("提问", m.text);
  return items;
}

async function generate({ force = false, type } = {}) {
  const scope = S.scope;
  if (!scope || jobs.has(jobKey())) return; // 这一范围已经有任务在跑（双击、连点）
  const job = newJob(S.key, scope, type || S.type);
  job.previous = force ? S.guide : null;
  // 切书之后这个任务还要把请求发完：用的书名、书签、章节表、页数都在这里记下，别读 S 里已经换成新书的
  Object.assign(job, { title: S.title, outline: S.outline ?? [], allChapters: S.chapters, n: S.n });
  jobs.set(jobKey(), job);
  Object.assign(S, { pending: null, err: null, errKeepsOld: false, confirmRegen: false, ocrInfo: null });
  setBadge("guide", "busy");
  render();
  try {
    if (!(await collect(job))) return void cleanup(job);
    await afterCollect(job, null);
  } catch (err) {
    if (staleErr(err, job.pdf)) return void cleanup(job);
    if (!isDown(err)) console.error("导读：生成失败", err);
    localFail(job, err);
  }
}

const DOWN_ERR = { stage: "down", message: "伴读的本地服务没在运行，这一份没有生成出来。" };
// 页面这一侧出的错（取页文字、识别、整理页码）：别说成 Claude 返回的错误；取页文字要请求本地服务（识别），服务没了就是服务没了
const localFail = (job, err) => fail(job, isDown(err) ? DOWN_ERR : { stage: "local", message: `读这份文档的页文字时出错了：${err.message || err}` });

function cleanup(job) {
  const jk = job.key + "|" + job.scope.id;
  if (jobs.get(jk) === job) jobs.delete(jk);
  badgeIdle();
  render();
}

function fail(job, err) {
  jobs.delete(job.key + "|" + job.scope.id);
  badgeIdle();
  if (sameBook(job.key) && S.scope?.id === job.scope.id) Object.assign(S, { err, guide: job.previous || S.guide, errKeepsOld: !!job.previous });
  else if (!sameBook(job.key)) toast(`《${bookName(job.key, job.title)}》的导读没有生成出来`); // 人在别的书里：脉动点熄了，得有一句说明去了哪
  render();
}

async function afterCollect(job, skipped) {
  const jk = job.key + "|" + job.scope.id;
  if (job.failed.length && !skipped) {
    // E2：个别页识别失败，让读者决定
    jobs.delete(jk);
    badgeIdle();
    if (sameBook(job.key)) S.pending = { job, failed: [...job.failed] };
    return render();
  }
  const skip = skipped || [];
  let pages = new Map([...job.pages].filter(([n, t]) => t.trim() && !skip.includes(n)));
  if (!pages.size) return fail(job, { stage: "empty", message: "这份文档没有识别出可读的文字，没法生成导读。" });
  const outline = job.outline;
  let outlineSend = [], chaptersSend = [], history = [];
  if (job.type === "chapter") {
    const ch = (job.allChapters || []).find((c) => c.from <= job.scope.from && c.to >= job.scope.to);
    pages = trimChapterPages(pages, ch);
    outlineSend = (ch?.children || []).filter((c) => c.page && c.page >= job.scope.from && c.page <= job.scope.to).map((c) => ({ title: c.title, page: c.page, level: 1 }));
    chaptersSend = (job.allChapters || []).map((c) => ({ title: c.title, from: c.from, no: c.no ?? null })); // 前置知识的「第 N 章」要的是书里的章号，不是行号
    history = await buildHistory(job.scope, job.key);
  } else {
    pages = trimDocPages(pages, outline, job.n);
    outlineSend = flat(outline).filter((o) => o.page).map((o) => ({ title: o.title, page: o.page, level: o.depth }));
  }
  const shown = [...pages.keys()].sort((a, b) => a - b);
  job.sent = { from: shown[0], to: shown.at(-1) };
  job.phase = "stream";
  render();
  const body = {
    file: job.key, title: job.title, type: job.type, force: !!job.previous,
    scope: { id: job.scope.id, kind: job.scope.kind, label: job.scope.label, from: job.scope.from, to: job.scope.to, ...(job.scope.chapterNo ? { chapterNo: job.scope.chapterNo } : {}) },
    pages: shown.map((n) => [n, pages.get(n)]), outline: outlineSend, chapters: chaptersSend, history, skippedPages: skip,
  };
  job.abort = new AbortController();
  let res;
  try {
    res = await post("/api/guide", body, job.abort.signal);
  } catch {
    if (job.cancelled) return;
    return fail(job, DOWN_ERR);
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || "服务出错 " + res.status;
    return fail(job, { stage: res.status === 413 ? "size" : "server", message: msg });
  }
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "done") { finished = true; jobs.delete(jk); finishDone(job.key, job.scope.id, ev.guide); }
        else if (ev.type === "error") { finished = true; fail(job, { stage: ev.stage, message: ev.message }); }
        else if (ev.type === "cancelled") { finished = true; if (!job.cancelled) remoteCancelled(job); }
        else { reduce(job.model, ev); if (sameBook(job.key) && S.scope?.id === job.scope.id) render(); }
      }
    }
  } catch {
    if (job.cancelled || finished) return;
  }
  if (!finished && !job.cancelled) await dropped(job, jk);
}

// 流断了：问一下服务端，分清是页面和服务的连接断了（任务还在跑，接着跟），还是服务本身没了
async function dropped(job, jk) {
  const r = await api(`/api/guide?file=${encodeURIComponent(job.key)}&scope=${encodeURIComponent(job.scope.id)}`).catch((err) => (isDown(err) ? null : { status: "none" }));
  if (job.cancelled || (jobs.get(jk) && jobs.get(jk) !== job)) return;
  if (!r) return fail(job, { stage: "down", message: "伴读的本地服务没在运行，这一份没有生成完。" });
  if (r.status === "running") { jobs.delete(jk); attach(job.key, job.scope, r, job.type, job.title); return render(); }
  if (r.status === "done") { jobs.delete(jk); return finishDone(job.key, job.scope.id, r.guide); }
  fail(job, { stage: "net", message: r.status === "error" ? r.message : "和伴读后台的连接断了，这一份没有生成完。" });
}

// 另一个窗口取消了这个任务：按失败的路子清掉、回到空状态
function remoteCancelled(job) {
  jobs.delete(job.key + "|" + job.scope.id);
  badgeIdle();
  if (sameBook(job.key) && S.scope?.id === job.scope.id) { Object.assign(S, { err: null, guide: job.previous || null }); loadStatus(); }
  render();
}

function cancelJob(job) {
  job.cancelled = true;
  job.abort?.abort();
  jobs.delete(job.key + "|" + job.scope.id);
  badgeIdle();
  post("/api/guide/cancel", { file: job.key, scope: job.scope.id }).catch(() => {});
  S.err = null;
  if (job.previous) S.guide = job.previous;
  render();
}

// ───────────────────────── 出处跳转、接着问 ─────────────────────────
async function jump(page, quote) {
  try {
    const ok = await revealPassage(page, quote || "");
    if (!ok && quote) toast(`到了第 ${page} 页，没能定位到那几行`);
  } catch (err) {
    if (!staleErr(err)) console.error("导读：跳转出错", err); // 切书时 pdf.js 的传输已销毁，不算出错
  }
}

// 有出处的回答：这条出处成为「Claude 看到」的那句（不记划线），书页跳过去，切到问答；没有出处的判断：预填题干
async function askMore(q) {
  const refs = q.refs || [];
  if (!refs.length) return compose(q.q + "？");
  const ref = (S.active && S.active.q === q.q && refs.find((r) => r.page === S.active.page)) || refs[0];
  try { await focusPassage(ref.page, ref.quote); } catch (err) { if (!staleErr(err)) console.error("导读：接着问出错", err); return; }
  jump(ref.page, ref.quote);
  compose();
}

function toggleChip(qi, q, page) {
  if (S.active && S.active.qi === qi && S.active.page === page) { S.active = null; return render(); }
  S.active = { qi, q: q.q, page };
  render();
  jump(page, q.refs.find((r) => r.page === page)?.quote);
}

// ───────────────────────── 渲染 ─────────────────────────
function render() {
  const keep = gv.scrollTop;
  const keepPicker = gv.querySelector(".picker")?.scrollTop || 0; // 生成中每来一行就整块重画，列表不能跳回顶上
  let nodes;
  S.noticeShown = false; // 这一遍渲染里挂了提示条，chapterNotice 会置回 true
  try { nodes = build(); } catch (err) { console.error("导读：渲染出错", err); nodes = [E("p", "lead err", "导读显示出错了，切换一下标签再试。")]; }
  gv.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  gv.scrollTop = keep;
  const picker = gv.querySelector(".picker");
  if (picker && keepPicker) picker.scrollTop = keepPicker;
  curJob()?.model.fresh.clear();
}

const ruled = () => E("div", "ruled");
const lead = (text, cls = "") => E("p", "lead " + cls, text);
const pagesInfo = (n) => E("span", "info", "共 ", em(n), " 页");

function scopeRow(tag, name, info, { fixable = false, why = "" } = {}) {
  return E("div", "scope",
    el("span", { className: "tag", textContent: tag, title: why ? "判断依据：" + why : "" }),
    E("span", "t", name), info,
    fixable ? btn("fix", "判断不对？", () => { S.fixOpen = !S.fixOpen; render(); }) : null);
}

function fixRow() {
  if (!S.fixOpen) return null;
  const opts = [["paper", "论文"], ["consensus", "共识 / 指南"], ["chapter", "书的一章"], ["brief", "速览"]];
  const done = () => { S.fixOpen = false; S.pickerOpen = false; S.scopePick = null; refresh(); };
  return E("div", "seg", E("span", "lbl", "改按"), opts.map(([t, label]) => btn(S.type === t ? "on" : "", label, () => { setOverride(t); done(); })),
    getOverride() ? btn("", "按自动判断", () => { clearOverride(); done(); }) : null); // 手动选过的，要能撤回
}

// 手动选过类型的书，不论停在哪个阶段（章、没有章节表、指定页码）都能改回去
const retypeBtn = () => (getOverride() ? btn("fix retype", "判断不对？", () => { S.fixOpen = !S.fixOpen; render(); }) : null);

function chevron() {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 10 6");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M1 1l4 4 4-4");
  s.append(p);
  return s;
}

const isLatin = (t) => /[A-Za-z]/.test(t) && !/[\u3400-\u9fff]/.test(t);

function chapterHeader() {
  const sc = S.scope;
  const ch = (S.chapters || []).find((c) => c.from <= sc.from && c.to >= sc.to);
  const isRange = sc.kind === "range" || !ch; // 读者自己指定的页：即使落在某一章里，头部也不冒充那一章
  return [
    E("div", "scope ch",
      el("span", { className: "tag", textContent: "章" }),
      E("span", "t", isRange ? "指定的页" : ch.kind === "summary" ? "概要" : ch.kind === "appendix" || ch.no == null ? "附录" : ["第 ", em(ch.no), " 章"]),
      E("span", "info", "第 ", em(sc.from), "–", em(sc.to), " 页"),
      isRange ? btn("lnk", "改页码", () => { S.manual = { from: sc.from, to: sc.to }; S.pickerOpen = false; S.stage = "manual"; render(); }) : null,
      retypeBtn(),
      S.chapters?.length > 1 ? el("button", { type: "button", className: "fix pick" + (S.pickerOpen ? " open" : ""), onclick: () => { S.pickerOpen = !S.pickerOpen; render(); } }, "换一章", chevron()) : null),
    isRange ? null : E("h3", "ctitle" + (isLatin(ch.title) ? " latin" : ""), ch.title + (sc.segInfo || "")),
    fixRow(),
    S.pickerOpen ? picker() : null,
  ];
}

function picker() {
  const here = chapterAt(S.readerPage);
  const rebuilt = S.chSource === "toc" || S.chSource === "scan" || S.chSource === "outline"; // 书签推出来的也可能缺章、错章
  const rows = (S.chapters || []).map((c) => {
    const have = segmentsOf(c).some(([a, b]) => S.idx[scopeId(a, b)]); // 范围 id 精确相等才算：指定页码的导读落在这章里不算
    const viewing = S.scope && S.scope.kind !== "range" && S.scope.from >= c.from && S.scope.to <= c.to;
    return P("li", { className: viewing ? "viewing" : "", onclick: () => pickChapter(c) },
      E("span", "no", c.kind === "appendix" ? "附" : c.kind === "summary" ? "要" : String(c.no ?? "")),
      E("span", "nm" + (isLatin(c.title) ? " latin" : ""), c.title),
      have ? E("span", "have", "已有导读") : null,
      here === c ? E("span", "here", E("i", "dot run"), "读到这里") : null,
      E("span", "pr", rng(c.from, c.to)));
  });
  const mine = rangeGuides();
  const own = mine.length ? [P("li", { className: "sep" }, "指定页码生成过的导读"), mine.map(([id, x]) =>
    P("li", { className: S.scope?.id === id ? "viewing" : "", onclick: () => pickRange(id, x) },
      E("span", "no", "页"), E("span", "nm", "指定的页"), E("span", "pr", rng(x.from, x.to))))] : null;
  const revert = S.bookmarkOk && S.chSource !== "outline"; // 书签能用、又存过章节表：重建错了要有路回到书签那份
  const tools = el("li", { className: "tools" }, ...[revert ? btn("lnk", "改回书签的章节表", revertToBookmark) : null, rebuilt ? btn("lnk", "重建章节表", rebuildTable) : null, btn("lnk", "自己指定页码", startManual)].filter(Boolean));
  return E("ul", "picker", rows, own, tools);
}

// 服务端存着的、读者自己指定页码生成的导读（页面里没有入口时靠这个找回来）
const rangeGuides = () => Object.entries(S.idx).filter(([, x]) => x.type === "chapter" && x.kind === "range").sort(([, a], [, b]) => a.from - b.from);

// page 不给：章分成几段时优先落在已经有导读的那一段
function pickChapter(c, page) {
  const seg = page ?? segmentsOf(c).find(([a, b]) => S.idx[scopeId(a, b)])?.[0] ?? c.from;
  Object.assign(S, { pickerOpen: false, scopePick: { chapters: S.chapters, scope: scopeOfChapter(c, seg) }, active: null, confirmRegen: false });
  refresh();
}

function pickRange(id, x) {
  const scope = { id, kind: "range", label: `第 ${rng(x.from, x.to)} 页`, from: x.from, to: x.to };
  if (S.chapters) S.scopePick = { chapters: S.chapters, scope }; else S.manualScope = scope;
  Object.assign(S, { pickerOpen: false, active: null, confirmRegen: false });
  refresh();
}

function build() {
  switch (S.stage) {
    case "nobook": return [lead("打开一本书之后，这里可以生成它的导读。", "dim"), ruled()];
    case "detecting": return [E("div", "scope", E("i", "dot run"), E("span", "t", "正在判断文档类型…")), ruled()];
    case "short": return buildShort();
    case "choose": return buildChoose();
    case "noch": return buildNoChapters();
    case "building": return buildBuilding();
    case "manual": return buildManual();
    case "scope": return buildScope();
    case "down": return buildDown();
    default: return [ruled()];
  }
}

function typeHeader() {
  if (S.type === "chapter") return chapterHeader();
  const [tag, name] = NAMES[S.type] || NAMES.paper;
  const fixable = (S.kind !== "short" && S.kind !== "unknown") || !!getOverride();
  return [scopeRow(tag, name, pagesInfo(S.n), { fixable, why: S.why }), fixRow()];
}

function buildScope() {
  const job = curJob();
  const head = typeHeader();
  if (S.pending && S.pending.job.scope.id === S.scope.id) return [head, buildOcrFail()];
  if (job) return [head, job.phase === "collect" ? buildCollecting(job) : buildStreaming(job)];
  if (S.down) return [head, buildDown()];
  if (S.guide) return [head, buildCard(fromGuide(S.guide), true)];
  if (S.err) return [head, buildError()];
  return [head, buildEmpty()];
}

// ----- 空状态 A1 / A2 -----
// 异步查一下这个范围里有几页没有文字层、其中几页已经识别过，回来重画
async function scanInfo(sc) {
  if (S.ocrInfo?.scopeId === sc.id || S.ocrBusy === sc.id) return;
  S.ocrBusy = sc.id;
  const key = S.key, pdf = getPdf();
  let total = 0, todo = 0;
  try {
    for (let n = sc.from; n <= Math.min(sc.to, sc.from + 79); n++) {
      if (!sameBook(key) || getPdf() !== pdf) return;
      if (await hasTextLayer(n, pdf)) continue;
      total++;
      const r = await api(`/api/ocr?file=${encodeURIComponent(key)}&page=${n}`).catch(() => ({}));
      if (!r.lines) todo++;
    }
    if (!sameBook(key) || S.scope?.id !== sc.id) return;
    S.ocrInfo = { scopeId: sc.id, total, todo };
    if (total) render();
  } catch (err) {
    if (!staleErr(err, pdf)) console.error("导读：查识别进度出错", err); // 切书打断的不算出错
  } finally {
    if (S.ocrBusy === sc.id) S.ocrBusy = null;
  }
}

function buildEmpty() {
  const t = S.type;
  const sc = S.scope;
  const pageCount = sc.to - sc.from + 1;
  const sec = estSec(pageCount * (t === "chapter" ? 2400 : 2200));
  scanInfo(sc);
  const ocr = S.ocrInfo && S.ocrInfo.scopeId === sc.id && S.ocrInfo.total ? S.ocrInfo : null;
  const kids = [];
  let label = "生成导读";
  if (t === "paper" || t === "consensus") {
    kids.push(lead(`导读先讲${t === "paper" ? "这篇" : "这份共识"}在说什么、建议从哪页读起，再回答下面五个问题。每个回答都带原文出处，点一下就跳到那几行。`));
    kids.push(E("ol", "idx", [...STEMS[t].map((s) => s[1]), WORK_STEM[t]].map((s, i) => E("li", "", E("b", "", String(i + 1)), s))));
  } else if (t === "brief") {
    kids.push(lead("速览只有一句话和至多三个问题，每个问题带原文出处。"));
    label = "生成速览";
  } else {
    kids.push(lead("导读先讲这章在说什么、哪些节细读，再回答几个关键问题，并列出读这章之前要先懂的概念。"));
    label = sc.kind === "range" ? `生成这 ${pageCount} 页的导读` : "生成这一章的导读";
  }
  let note = t === "brief" ? "约 15 秒。生成后会保存，下次打开直接显示。" : `${estLabel(sec)}。生成后会保存，下次打开直接显示。`;
  if (ocr) {
    const mostly = ocr.total >= pageCount * 0.5;
    kids.push(E("p", "scan", E("i", "dot hollow"), E("span", "", mostly ? `这${t === "chapter" ? "一章" : "份文档"}是扫描版。生成前要先逐页识别文字：` : `其中有 ${ocr.total} 页没有文字层（多半是整页的图），生成前要先识别它们：`,
      em(ocr.total), " 页约 ", em(Math.round(ocr.total * 1.3)), " 秒，已识别 ", em(ocr.total - ocr.todo), " 页。")));
    if (ocr.todo) {
      label = "识别文字并生成导读";
      note = `共约 ${Math.round(ocr.todo * 1.3 + sec)} 秒，识别过的页以后不用再识别。`;
    }
  }
  kids.push(E("div", "cta", btn("btn solid big", label, () => generate()), E("span", "note", note)), ruled());
  return kids;
}

// ----- 识别中 A3 -----
function stepsList(items) {
  return E("ul", "steps", items.map(([state, text, small]) =>
    E("li", state, E("i", state === "cur" ? "dot run" : state === "done" ? "dot" : "dot hollow"), small ? E("div", "", text, E("small", "", small)) : E("span", "", text))));
}

function buildCollecting(job) {
  const { done, total } = job.prog;
  const whole = job.scope.kind === "range" ? `第 ${rng(job.scope.from, job.scope.to)} 页` : job.scope.kind === "chapter" ? "这一章" : "全文";
  if (!total) return [lead(["正在取出第 ", em(rng(job.scope.from, job.scope.to)), " 页的文字…"], "run"), E("div", "tail", btn("lnk", "取消", () => cancelJob(job)))];
  return [
    lead("正在逐页识别文字", "run"),
    E("div", "prog", E("div", "bar", el("i", { style: `width:${Math.round((done / total) * 100)}%` })), E("div", "cnt", em(done), " / ", em(total), " 页")),
    E("p", "sub", `还要约 ${Math.max(0, Math.round((total - done) * 1.3))} 秒。`),
    stepsList([["cur", "识别文字"], ["", "通读" + whole], ["", "写出导读"]]),
    E("div", "tail", btn("lnk", "取消", () => cancelJob(job))),
  ];
}

// ----- 识别失败 E2 -----
function buildOcrFail() {
  const { job, failed } = S.pending;
  const many = failed.length > 1 ? "几" : "";
  return [
    E("p", "lead err", `第 ${failed.join("、")} 页没有识别出文字。`),
    E("p", "why", `其余 ${Math.max(0, job.scanTotal - failed.length)} 页已经识别好了。跳过这${many}页也能生成，导读里会写明哪${many}页没读到。`),
    E("div", "cta col",
      btn("btn solid big", `跳过这${many}页，继续生成`, () => resume(S.pending, S.pending.failed)),
      btn("btn big", `只重新识别这${many}页`, () => retryOcr(S.pending))),
    ruled(),
  ];
}

async function resume(p, skip) {
  S.pending = null;
  const job = p.job;
  job.phase = "collect";
  jobs.set(job.key + "|" + job.scope.id, job);
  setBadge("guide", "busy");
  render();
  try { await afterCollect(job, skip); } catch (err) { if (staleErr(err, job.pdf)) return void cleanup(job); localFail(job, err); }
}

async function retryOcr(p) {
  S.pending = null;
  const job = p.job;
  job.phase = "collect";
  jobs.set(job.key + "|" + job.scope.id, job);
  setBadge("guide", "busy");
  render();
  try {
    if (!(await collect(job, p.failed))) return void cleanup(job);
    await afterCollect(job, null);
  } catch (err) { if (staleErr(err, job.pdf)) return void cleanup(job); localFail(job, err); }
}

// ----- 生成中 B0 / B1 / F2 -----
function pendingRow(n, stem, writing) {
  return E("section", "qa pending", E("div", "qh", E("b", "", String(n)), stem, writing ? E("span", "writing", E("i", "dot run"), "正在写…") : null));
}

// 取消：从通读到写完全程都在（写出第一行之后也是），重新生成时取消就是保留原来那份
const cancelTail = (job) => E("div", "tail", btn("lnk", job.previous ? "取消，保留原来的" : "取消", () => cancelJob(job)));

function buildStreaming(job) {
  const m = job.model;
  if (m.summary) return buildCard(m, false, job);
  const regen = !!job.previous;
  const queued = m.phase === "queued"; // 服务端同时只写一份，前面还有别的在写
  const range = rng(job.sent?.from ?? job.scope.from, job.sent?.to ?? job.scope.to);
  const old = regen ? `原来那份（${when(job.previous.generatedAt)}）还在，写完才会替换。` : "";
  const kids = [
    lead(queued ? "前面还有一份导读在生成，这一份在排队…" : [regen ? "Claude 正在重新通读第 " : "Claude 正在通读第 ", em(range), " 页…"], "run"),
    E("p", "sub", queued ? `${old}轮到这一份才开始通读，可以先去读别处，好了导读标签上会亮一个点。` : regen ? old : "通常要半分钟。可以先去读别处，生成在后台继续，好了导读标签上会亮一个点。"),
  ];
  if (STEMS[job.type]) {
    kids.push(E("h4", "h", "五个问题"), [...STEMS[job.type].map((s) => s[1]), WORK_STEM[job.type]].map((s, i) => pendingRow(i + 1, s, false)));
  }
  kids.push(cancelTail(job));
  return kids;
}

// ----- 出错 E1 -----
function buildError() {
  const e = S.err;
  const reason = e.stage === "timeout" ? "Claude 等了 5 分钟还没写完，已经停掉。" : e.stage === "claude" ? `Claude 返回了错误：${e.message}` : e.message;
  return [
    E("p", "lead err", "这次没有生成出来。"),
    E("p", "why", reason),
    e.stage === "down" ? restartHint("服务起来后再点「再试一次」：") : null,
    e.stage === "empty" ? null : E("div", "cta", btn("btn solid big", "再试一次", () => generate())),
    ruled(),
  ];
}

// 服务不在时怎么拉起来：和离线页（sw.js）里是同一行命令
const restartHint = (lead) => [E("p", "why", "打开「终端」，粘贴下面这行回车，" + lead), E("pre", "cmd", RESTART[0], E("span", "nb", RESTART[1]))];

function buildDown() {
  return [
    E("p", "lead err", "没连上伴读的本地服务。"),
    E("p", "why", "已经生成的导读存在服务那边，连上之后才看得到，现在也生成不了新的。"),
    restartHint("再点「重试」："),
    E("div", "cta", btn("btn solid big", "重试", () => refresh())),
    ruled(),
  ];
}

// ----- 短文档 D2 / 判不出 D3 -----
function buildShort() {
  return [
    E("div", "scope", el("span", { className: "tag", textContent: "短" }), E("span", "t", "短文档"), pagesInfo(S.n)),
    lead(`只有 ${S.n} 页，直接读比读导读更快。`),
    E("div", "cta", btn("btn big", "还是生成一份速览", async () => { setOverride("brief"); S.scopePick = null; await refresh(); if (S.scope) generate(); }), E("span", "note", "一句话加至多三个问题，约 15 秒。")),
  ];
}

function buildChoose() {
  const opts = [["paper", "按论文读", "研究问题、做法、发现、局限"], ["consensus", "按共识 / 指南读", "推荐意见、证据等级、适用人群"],
    ["chapter", "按书的一章读", "要先有章节划分，没有的话再指定页码"], ["brief", "只要速览", "一句话加至多三个问题"]];
  return [
    E("div", "scope", el("span", { className: "tag", textContent: "？" }), E("span", "t", "没能判断这是什么文档"), pagesInfo(S.n)),
    lead("它不像论文，也不像共识或指南。选一个最接近的，导读按那种读法来写："),
    E("div", "choices", opts.map(([t, h, d]) => el("button", { type: "button", className: "choice", onclick: async () => {
      setOverride(t);
      S.scopePick = null;
      await refresh();
      if (S.scope) generate();
    } }, E("b", "", h), E("span", "", d)))),
    ruled(),
  ];
}

// ───────────────────────── 生成完的卡片 B2 / C1 / C2 ─────────────────────────
function fromGuide(g) {
  return { phase: "done", summary: g.summary, path: g.path, qs: g.questions, work: g.work || null, pre: g.pre || [], hist: g.history || [], fresh: new Set(), guide: g };
}

function chipBtn(page, on, onclick) {
  const b = btn("chip" + (on ? " on" : ""), "", onclick);
  b.setAttribute("aria-pressed", String(on));
  b.append("原文 · 第", em(page), "页");
  return b;
}

function qaRow(qi, q, fresh) {
  const refs = q.refs || [];
  const pages = [...new Set(refs.map((r) => r.page))];
  const act = S.active && S.active.qi === qi ? S.active.page : null;
  const row = E("section", "qa" + (q.missing ? " miss" : "") + (fresh ? " fade" : ""),
    E("div", "qh", E("b", "", String(qi + 1)), q.q),
    E("p", "a", q.a),
    E("div", "refs",
      pages.map((p) => chipBtn(p, act === p, () => toggleChip(qi, q, p))),
      refs.length ? null : E("span", "nosrc", "原文没讲"),
      btn("more", "接着问 ›", () => askMore(q))));
  if (act != null) for (const r of refs.filter((x) => x.page === act)) row.append(E("blockquote", "quote", el("mark", { textContent: cjkTrim(r.quote) })));
  return row;
}

function pathBlock(items) {
  const go = (it) => jump(it.pages[0], it.anchorOk ? it.anchor : "");
  const rows = items.filter((it) => it.do !== "skip").map((it) => el("li", { onclick: () => go(it) },
    E("div", "row", E("span", "do " + it.do, DO[it.do] || "略读"), E("span", "name", it.label), E("span", "leader"), E("span", "pg", rng(it.pages[0], it.pages[1]))),
    E("p", "why", it.why)));
  const skips = items.filter((it) => it.do === "skip").map((it) => el("p", { className: "skip", onclick: () => go(it) },
    E("span", "", "不用读"), it.label, E("span", "leader"), E("span", "pg", rng(it.pages[0], it.pages[1]))));
  return [E("ol", "path", rows), skips];
}

function preRow(p, fresh) {
  const mm = /^(.*?)（(.*)）$/.exec(p.term);
  const go = p.page ? btn("goto", "", () => jump(p.page, "")) : null;
  go?.append("书里第", em(p.chapter), "章 ›");
  return el("li", { className: fresh ? "fade" : "" },
    E("div", "row", E("span", "term", mm ? mm[1] : p.term), mm ? E("span", "en", mm[2]) : null, E("span", "leader"), go),
    E("p", "why", p.why));
}

function histRow(h, fresh) {
  const you = h.kind === "划线"
    ? E("p", "you hl", E("span", "k", "划线 · 第", em(h.page), "页"), el("mark", { textContent: h.text }))
    : E("p", "you", E("span", "tag mini", "问"), h.text);
  const r = h.refs[0];
  return el("li", { className: fresh ? "fade" : "" }, you, E("p", "a", h.note), E("div", "refs", chipBtn(r.page, false, () => jump(r.page, r.quote))));
}

// 读者读进了另一章（或同一章的另一段）：返回那一章。读到第一章之前的封面、前言时「读到的章」就是正在看的这一章，不提示
function noticeChapter() {
  if (S.type !== "chapter" || !S.chapters || !S.scope) return null;
  const rc = chapterAt(S.readerPage);
  if (!rc || (S.readerPage >= S.scope.from && S.readerPage <= S.scope.to) || S.dismissed.has(rc.from)) return null;
  return scopeOfChapter(rc, S.readerPage).id === S.scope.id ? null : rc;
}

function chapterNotice() {
  const rc = noticeChapter();
  if (!rc) return null;
  S.noticeShown = true;
  return E("div", "notice",
    E("span", "", rc.kind === "appendix" || rc.kind === "summary" || rc.no == null ? "你已经读到 " : ["你已经读到第 ", em(rc.no), " 章 · "], rc.title, "。"),
    E("span", "", btn("lnk", "看这一章的导读", () => pickChapter(rc, S.readerPage)), btn("x", "×", () => { S.dismissed.add(rc.from); render(); }, { title: "不再提示这一章" })));
}

function buildCard(m, final, job) {
  const t = job?.type || S.type;
  const fixed = STEMS[t];
  const fr = (k) => m.fresh.has(k);
  const out = [];
  if (final) out.push(chapterNotice());
  if (final && S.err && S.errKeepsOld) {
    out.push(E("div", "notice", E("span", "", `重新生成没有成功，保留的是 ${when(m.guide.generatedAt)} 的那份。`), btn("lnk", "重试", () => generate({ force: true }))));
  }
  out.push(E("p", "summary" + (fr("summary") ? " fade" : ""), m.summary));
  if (m.path?.length) out.push(E("h4", "h", "从哪读起", E("small", "", "点一行跳过去")), pathBlock(m.path));
  const title = t === "chapter" ? "这章要回答的问题" : t === "brief" ? "几个问题" : "五个问题";
  out.push(E("h4", "h", title, final || !fixed ? E("small", "", "每条回答都能点回原文") : E("small", "", `写到第 ${Math.min(m.qs.length + 1, 5)} 个`)));
  if (fixed) {
    let writing = false;
    fixed.forEach(([k, stem], i) => {
      const q = m.qs.find((x) => x.k === k);
      if (q) out.push(qaRow(m.qs.indexOf(q), q, fr("q:" + k)));
      else if (!final) { out.push(pendingRow(i + 1, stem, !writing)); writing = true; }
    });
  } else m.qs.forEach((q, i) => out.push(qaRow(i, q, fr("q:" + (q.k || q.q)))));
  if (m.work) {
    out.push(E("section", "qa judge" + (fr("work") ? " fade" : ""),
      E("div", "qh", E("span", "tag solo", "批"), m.work.stem),
      E("p", "a", m.work.text),
      E("div", "refs", E("span", "by", "Claude 的判断，没有原文出处"), btn("more", "接着问 ›", () => compose(m.work.stem + "？")))));
  } else if (fixed && !final) out.push(pendingRow(5, WORK_STEM[t], m.qs.length >= fixed.length));
  if (m.pre?.length) out.push(E("h4", "h", "读这章之前，最好先懂", E("small", "", "书里哪一章讲了它")), E("ul", "pre", m.pre.map((p, i) => preRow(p, fr("pre" + (i + 1))))));
  if (m.hist?.length) out.push(E("h4", "h", "你读这本书时问过的", E("small", "", "和这章有关的")), E("ul", "hist", m.hist.map((h, i) => histRow(h, fr("hist" + (i + 1))))));
  if (final) out.push(footer(m.guide));
  else if (job) out.push(cancelTail(job));
  return out;
}

function footer(g) {
  if (S.confirmRegen) {
    return E("div", "foot confirm", E("span", "", "重新生成会替换现在这一份。"),
      E("span", "acts", btn("btn solid sm", "替换", () => generate({ force: true })), btn("btn sm", "取消", () => { S.confirmRegen = false; render(); })));
  }
  const notes = [];
  if (g.dropped) notes.push(`有 ${g.dropped} 条回答因为在原文里找不到出处，没有列出。`);
  if (g.skippedPages?.length) notes.push(`第 ${g.skippedPages.join("、")} 页没读到文字，这份导读没有用到它们。`);
  const main = E("div", "foot", E("span", "", `生成于 ${when(g.generatedAt)} · 第 ${rng(g.scope.from, g.scope.to)} 页`), btn("lnk", "重新生成", () => { S.confirmRegen = true; render(); }));
  return notes.length ? E("div", "", main, notes.map((n) => E("p", "note-line", n))) : main;
}

// ───────────────────────── 书签不可用：建章节表 E3 / E4 / E5 ─────────────────────────
async function probeScanned() {
  S.scannedBook = null;
  const key = S.key, pdf = getPdf();
  try {
    const flags = [];
    for (const n of [Math.min(20, S.n), Math.min(21, S.n), Math.min(22, S.n)]) flags.push(!(await hasTextLayer(n, pdf)));
    if (!sameBook(key) || getPdf() !== pdf) return;
    S.scannedBook = flags.filter(Boolean).length >= 2;
    render();
  } catch (err) {
    if (!staleErr(err, pdf)) console.error("导读：判断扫描版出错", err);
    if (sameBook(key) && S.scannedBook === null) S.scannedBook = undefined;
  }
}

const bookHead = (info) => [E("div", "scope", el("span", { className: "tag", textContent: "书" }), E("span", "t", "整本书"), info, retypeBtn()), fixRow()];

function buildNoChapters() {
  if (S.scannedBook === undefined) probeScanned();
  const scanned = S.scannedBook;
  const nOutline = countOutline(S.outline || []);
  const kids = [
    bookHead(E("span", "info", "共 ", em(S.n), " 页", scanned ? " · 扫描版" : "")),
    lead(nOutline ? `这本书的书签是一页一条，共 ${nOutline} 条，分不出章。` : "这本书没有书签，分不出章。"),
  ];
  if (scanned) {
    kids.push(E("p", "why", "可以从目录页给它建一份章节表：识别前 30 页，找到目录，读出每章从哪页开始。"),
      E("div", "cta", btn("btn solid big", "从目录页建章节表", () => buildTable("toc")), E("span", "note", "约 40 秒，只做一次。")));
  } else if (scanned === false) {
    kids.push(E("p", "why", "可以扫一遍每页的标题，找出「第 X 章」「Chapter N」，建一份章节表。"),
      E("div", "cta", btn("btn solid big", "扫描标题建章节表", () => buildTable("scan")), E("span", "note", `约 ${Math.max(5, Math.round(S.n / 40))} 秒，只做一次。`)));
  }
  kids.push(E("p", "alt", btn("lnk", "不建了，自己指定页码", startManual)));
  const mine = rangeGuides();
  if (mine.length) {
    kids.push(E("h4", "h", "指定页码生成过的导读"), E("ul", "ranges", mine.map(([id, x]) =>
      P("li", { onclick: () => pickRange(id, x) }, E("span", "", "第 ", em(rng(x.from, x.to)), " 页"), E("span", "leader"), E("span", "at", when(x.at))))));
  }
  kids.push(ruled());
  return kids;
}

function startManual() {
  const a = S.readerPage || 1;
  S.manual = { from: a, to: Math.min(S.n, a + 19) };
  S.pickerOpen = false; // 从「换一章」里点进来的：列表收起，不然指定完页码回到章头，列表还摊着
  S.stage = "manual";
  render();
}

function buildManual() {
  const mn = S.manual;
  // 起页填得比止页大就当对调，夹在 1 到总页数之间
  const norm = () => {
    const a = Math.max(1, Math.min(S.n, Math.round(mn.from) || 1)), b = Math.max(1, Math.min(S.n, Math.round(mn.to) || a));
    return a <= b ? [a, b] : [b, a];
  };
  const clamp = () => { [mn.from, mn.to] = norm(); };
  const inputs = {};
  const go = el("button", { type: "button", className: "btn solid big" });
  const note = E("span", "note");
  // 改页码只更新输入框、按钮上的字和旁注，不整块重画：按钮刚被按下，重画会把它换掉，这一下点击就落空了
  const label = () => {
    const [a, b] = norm();
    const len = b - a + 1;
    const over = len > MAX_CHAPTER;
    go.textContent = `生成这 ${len} 页的导读`;
    go.disabled = over;
    note.textContent = over ? "最长 60 页" : "约 40 秒。扫描版另加识别时间。";
  };
  const sync = () => { clamp(); inputs.from.value = mn.from; inputs.to.value = mn.to; label(); };
  const input = (field) => {
    const i = el("input", { type: "number", value: mn[field], min: 1, max: S.n });
    i.addEventListener("input", () => { mn[field] = +i.value; label(); });
    i.addEventListener("change", sync);
    inputs[field] = i;
    return i;
  };
  const step = (field, d) => btn("", d > 0 ? "＋" : "−", () => {
    mn[field] += d;
    if (field === "from" && mn.from > mn.to) mn.to = mn.from; // 按钮一格格调：顶到另一头就推着走，不对调
    if (field === "to" && mn.to < mn.from) mn.from = mn.to;
    sync();
  });
  go.onclick = async () => {
    sync();
    if (go.disabled) return;
    S.type = "chapter";
    S.manualScope = { id: scopeId(mn.from, mn.to), kind: "range", label: `第 ${mn.from}–${mn.to} 页`, from: mn.from, to: mn.to };
    S.scope = S.manualScope;
    if (S.chapters) S.scopePick = { chapters: S.chapters, scope: S.manualScope }; // 有章节表的书里指定的页，翻页刷新时别又弹回章
    S.manual = null;
    S.guide = null;
    S.stage = "scope";
    await loadStatus();
    if (!S.guide && S.srv?.status === "none") generate();
  };
  const nodes = [
    bookHead(pagesInfo(S.n)),
    lead(S.chapters ? "告诉我这一段从哪页读到哪页，导读按这一段来写。" : "没找到目录。告诉我这一段从哪页读到哪页，导读按这一段来写。"),
    E("div", "range", E("span", "", "从第"), E("div", "num", step("from", -1), input("from"), step("from", 1)), E("span", "", "页到第"),
      E("div", "num", step("to", -1), input("to"), step("to", 1)), E("span", "", "页")),
    E("p", "why", "默认是你正在读的这一页起往后 20 页。最长 60 页。"),
    E("div", "cta", go, note),
    E("p", "alt", btn("lnk", S.chapters ? "回到章" : "回去建章节表", () => { S.manual = null; S.manualScope = null; refresh(); })),
    ruled(),
  ];
  label();
  return nodes;
}

function buildBuilding() {
  const b = S.build;
  if (!b) return [ruled()];
  const head = bookHead(E("span", "info", "共 ", em(S.n), " 页", b.mode === "toc" ? " · 扫描版" : ""));
  if (b.pick) {
    // 首章和末章算出的页码差对不上，裁决不了，让读者定
    const { first, last } = b.pick;
    return [head, lead("页码对不上。", "err"),
      E("p", "why", `目录里第一章从第 ${first.printed} 页起，在书里翻到第 ${first.at} 页，差 ${first.offset} 页；最后一章从第 ${last.printed} 页起，在第 ${last.at} 页，差 ${last.offset} 页。两个差对不上，可能中间插过页。`),
      stepsList(b.steps),
      E("div", "cta col",
        btn("btn solid big", `按第一章的差 ${first.offset} 页建`, () => b.pick.apply(first.offset)),
        btn("btn big", `按最后一章的差 ${last.offset} 页建`, () => b.pick.apply(last.offset)),
        btn("btn big", "自己指定页码", () => { S.build = null; startManual(); }))];
  }
  return [head,
    b.error ? lead("没能建出章节表。", "err") : lead("正在建章节表", "run"),
    b.error ? E("p", "why", b.error) : null,
    stepsList(b.steps),
    E("div", "tail", b.error
      ? E("span", "", btn("btn solid sm", "自己指定页码", () => { S.build = null; startManual(); }), " ", btn("btn sm", "返回", () => { S.build = null; refresh(); }))
      : btn("lnk", "取消", () => { b.cancelled = true; b.abort.abort(); S.build = null; refresh(); }))];
}

// 删掉存下的章节表，回到书签推出的那份
async function revertToBookmark() {
  const key = S.key;
  let r;
  try { r = await api("/api/guide/chapters/delete", { file: key }); } catch (err) { return void toast(isDown(err) ? "伴读的本地服务没在运行，没能改回书签的章节表" : "没能改回书签的章节表"); }
  if (r?.error) return void toast("没能改回书签的章节表");
  if (!sameBook(key)) return;
  Object.assign(S, { chapters: null, chSource: "", bookmarkOk: false, pickerOpen: false, scopePick: null, manualScope: null, guide: null, srv: null, err: null });
  refresh();
}

// 已建的章节表出了问题（缺章、页码错）：重新建一遍。扫描书走目录页，文字书扫标题
async function rebuildTable() {
  if (S.scannedBook === undefined) await probeScanned();
  Object.assign(S, { pickerOpen: false, scopePick: null, manualScope: null, guide: null, srv: null, err: null });
  S.chapters = null;
  buildTable(S.scannedBook ? "toc" : "scan");
}

const CN_NUM = (n) => cnNum(n);
const tocLineCount = (t) => t.split("\n").filter((l) => TOC_LINE.test(l)).length;
// 以数字结尾的行：目录条目后面跟着页码
const numberLines = (t) => t.split("\n").filter((l) => /(?:^|[\s/·.…])\d{1,4}\s*$/.test(l.trim())).length;

async function buildTable(mode) {
  const key = S.key;
  const b = { mode, cancelled: false, error: "", steps: [], pick: null, abort: new AbortController() };
  S.build = b;
  S.stage = "building";
  const set = (i, state, text, small) => { b.steps[i] = [state, text, small || ""]; if (S.build === b) render(); };
  const pdf = getPdf();
  const alive = () => !b.cancelled && sameBook(key) && getPdf() === pdf;
  const save = async (list, source, offset, note) => {
    await post("/api/guide/chapters", { file: key, chapters: list, source, offset, note, numPages: S.n });
    S.chapters = list.map((c) => ({ ...c, children: [] }));
    S.chSource = source;
    S.build = null;
    S.scopePick = null;
    if (sameBook(key)) refresh();
  };
  try {
    if (mode === "toc") {
      const limit = Math.min(30, S.n);
      b.steps = [["cur", `识别前 ${limit} 页`, `逐页识别，约 ${Math.round(limit * 1.3)} 秒`], ["", "找到目录页"], ["", "读出章节"], ["", "核对页码"], ["", "存下章节表"]];
      render();
      const texts = new Map();
      let next = 1, done = 0;
      const worker = async () => {
        while (next <= limit && alive()) {
          const n = next++;
          texts.set(n, await extractText(n));
          done++;
          set(0, "cur", `识别前 ${limit} 页`, `第 ${done} / ${limit} 页`);
        }
      };
      await Promise.all([worker(), worker()]);
      if (!alive()) return;
      set(0, "done", `识别前 ${limit} 页`);
      // 目录页：连续几页，每页有 ≥ 6 行「第 X 章 / 第 X 节」
      const text = (n) => texts.get(n) || "";
      let best = [], cur = [];
      for (let n = 1; n <= limit; n++) {
        if (tocLineCount(text(n)) < 6) continue;
        if (cur.length && n - cur.at(-1) <= 2) cur.push(n); else { if (cur.length > best.length) best = cur; cur = [n]; }
      }
      if (cur.length > best.length) best = cur;
      if (!best.length) throw new Error(`前 ${limit} 页里没找到目录。`);
      // 目录最后一页常常只剩几条章名（不到 6 行）：连续段两端各放宽一页，页上有「目录」二字，或有章名而且大半是带页码的条目
      const looksToc = (n) => n >= 1 && n <= limit && !best.includes(n) && (squash(text(n).slice(0, 200)).includes("目录") || (tocLineCount(text(n)) >= 1 && numberLines(text(n)) >= 6));
      const before = best[0] - 1, after = best.at(-1) + 1;
      if (looksToc(before)) best.unshift(before);
      if (looksToc(after)) best.push(after);
      set(1, "done", "找到目录页", `第 ${rng(best[0], best.at(-1))} 页`);
      set(2, "cur", "读出章节", "交给 Claude 整理，约 10 秒");
      const res = await post("/api/guide/toc", { file: key, pages: best.map((n) => [n, text(n)]) }, b.abort.signal);
      const toc = await res.json();
      if (!alive()) return;
      if (!res.ok || !toc.chapters?.length) throw new Error(toc.error || "没能从目录页读出章节。");
      const chs = toc.chapters;
      const real = chs.filter((c) => c.kind === "chapter");
      const nApp = chs.filter((c) => c.kind === "appendix").length;
      const label = (c) => (c.kind === "appendix" ? "附录 " : c.no ? `第${cnNum(c.no)}章 ` : "") + c.title;
      const first = real[0] || chs[0], last = real.at(-1) || chs.at(-1);
      set(2, "done", `读出 ${real.length} 章${nApp ? `、${nApp} 个附录` : ""}`, `${label(first)} … ${label(last)}`);
      set(3, "cur", "核对页码");
      // 目录写某章从印刷页码 p 起，到预计的页附近找这一章的「第X章」标题（不看书名，书名常常也印在目录页上）
      const find = async (c, from, to) => {
        if (!c.no) return null;
        const want = [squash(`第${CN_NUM(c.no)}章`), squash(`第${CN_NUM(c.no)}草`)]; // 识别常把「章」认成「草」
        for (let p = Math.max(1, from); p <= Math.min(S.n, to); p++) {
          const head = squash((await extractText(p)).slice(0, 160));
          if (want.some((w) => head.includes(w))) return p;
        }
        return null;
      };
      const p1 = await find(first, best.at(-1) + 1, best.at(-1) + 9);
      if (!alive()) return;
      if (!p1) throw new Error(`目录写${label(first)}从第 ${first.printedPage} 页起，但在目录之后的几页里没找到「第${CN_NUM(first.no || 1)}章」的标题，页码对不上。`);
      let offset = p1 - first.printedPage;
      let note = "";
      const infoFirst = `目录写${label(first)}从第 ${first.printedPage} 页起，在书里翻到第 ${p1} 页看到「第${CN_NUM(first.no)}章」，差 ${offset} 页`;
      if (last !== first) {
        const exp = last.printedPage + offset;
        const p2 = await find(last, exp - 3, exp + 3);
        if (!alive()) return;
        const o2 = p2 == null ? null : p2 - last.printedPage;
        if (o2 == null) note = "最后一章的标题没找到，章范围可能差几页。";
        else if (o2 !== offset) {
          // 两头的差不一样：拿中间一章裁决；恰好一个对得上就用它，分不出就停下来让读者定
          const o1 = offset;
          const mid = real[Math.floor(real.length / 2)];
          const hit = async (o) => (await find(mid, mid.printedPage + o, mid.printedPage + o)) === mid.printedPage + o;
          const [m1, m2] = [await hit(o1), await hit(o2)];
          if (m1 !== m2) { offset = m1 ? o1 : o2; note = `首尾两章的页码差不同（${o1} 和 ${o2}），按中间一章对得上的 ${offset} 页建。`; }
          else {
            set(3, "cur", "核对页码", `${infoFirst}；最后一章差 ${o2} 页，对不上`);
            const finish = async (o) => { b.pick = null; set(3, "done", "核对页码", `按差 ${o} 页建，章范围可能差几页。`); set(4, "cur", "存下章节表"); await finishToc(chs, o, `首尾两章的页码差不同（${o1} 和 ${o2}），读者选了 ${o} 页。`); };
            b.pick = { first: { offset: o1, printed: first.printedPage, at: p1 }, last: { offset: o2, printed: last.printedPage, at: p2 }, apply: finish };
            if (S.build === b) render();
            return;
          }
        }
      }
      set(3, "done", "核对页码", infoFirst + (note ? "。" + note : ""));
      set(4, "cur", "存下章节表");
      await finishToc(chs, offset, note);
      set(4, "done", "存下章节表");
    } else {
      b.steps = [["cur", "扫描每页标题", ""], ["", "找出章"], ["", "存下章节表"]];
      render();
      const cand = [], numbered = [];
      for (let n = 1; n <= S.n; n++) {
        if (!alive()) return;
        const lines = (await extractText(n)).split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.filter((l) => CH_RE.test(l)).length >= 4) continue; // 目录页：一页里列着好几章，不是章的开头
        const at = lines.slice(0, 3).findIndex((l) => CH_RE.test(l));
        if (at >= 0) {
          const no = parseNo(lines[at]);
          // 标题常常在「CHAPTER 6」的下一行
          const rest = lines[at].replace(CH_PREFIX, "").trim() || lines[at + 1] || lines[at];
          if (no != null && !/^(figure|table|图|表)\s*\d/i.test(rest)) cand.push({ from: n, no, title: rest });
        } else if (lines[0] && lines[0].length <= 90 && NUM_TITLE.test(lines[0])) {
          numbered.push({ from: n, no: +NUM_TITLE.exec(lines[0])[1], title: lines[0].replace(CH_PREFIX, "").trim() });
        }
        if (n % 40 === 0) set(0, "cur", "扫描每页标题", `第 ${n} / ${S.n} 页`);
      }
      // 「1 Introduction」这种数字开头的写法：页眉也长这样，同一个数字出现在 3 页以上的当页眉丢掉
      const fromNumbered = () => {
        const count = new Map();
        for (const c of numbered) count.set(c.no, (count.get(c.no) || 0) + 1);
        return numbered.filter((c) => count.get(c.no) <= 2);
      };
      const pool = cand.length >= 3 ? cand : fromNumbered();
      // 图表清单、目录里也会出现「Chapter N」：每个章号取最后一次出现（正文的章头在它们后面），再保证页码随章号往上走
      const byNo = new Map();
      for (const c of pool) byNo.set(c.no, c);
      const found = [];
      for (const c of [...byNo.values()].sort((x, y) => x.no - y.no)) if (!found.length || c.from > found.at(-1).from) found.push(c);
      if (found.length < 3) throw new Error(`逐页扫描标题，只找到 ${found.length} 个「章」。`);
      set(0, "done", "扫描每页标题");
      set(1, "done", `找出 ${found.length} 章`);
      const list = found.map((f, i) => ({ no: f.no ?? i + 1, kind: "chapter", title: f.title, from: f.from, to: (found[i + 1]?.from ?? S.n + 1) - 1 }));
      await save(list, "scan", null, "");
      return;
    }
  } catch (err) {
    if (staleErr(err, pdf) || !alive()) return; // 取消、或建到一半换书了：静默收掉
    console.error("导读：建章节表失败", err);
    if (S.build === b) {
      b.error = String(err.message || err);
      b.steps = b.steps.map(([s2, t, sm]) => [s2 === "cur" ? "" : s2, t, sm]);
      render();
    }
  }

  // 目录建表的最后一步：按页码差算出每章在书里的起止页，存起来
  async function finishToc(chs, offset, note) {
    // 参考书目、索引这类「back」只用来标出最后一章在哪里结束，不进章节表
    const all = chs.map((c) => ({ no: c.no, kind: c.kind, title: c.title, from: Math.min(S.n, Math.max(1, c.printedPage + offset)) }));
    all.forEach((c, i) => { c.to = Math.max(c.from, (all[i + 1]?.from ?? S.n + 1) - 1); });
    await save(all.filter((c) => c.kind !== "back"), "toc", offset, note);
  }
}

// ───────────────────────── 事件 ─────────────────────────
window.addEventListener("book-opened", () => {
  const book = currentBook();
  if (book) resetBook(book);
  S.stage = "nobook";
  badgeIdle();
  if (book) api("/api/guide/index?file=" + encodeURIComponent(book.key)).then((r) => { if (r.running?.length && sameBook(book.key)) setBadge("guide", "busy"); }).catch(() => {});
  if (isShown()) refresh(); else render();
});

window.addEventListener("page-changed", (e) => {
  S.readerPage = e.detail.page;
  if (!isShown() || S.type !== "chapter" || !S.chapters || !S.scope || S.stage !== "scope") return;
  const outside = S.readerPage < S.scope.from || S.readerPage > S.scope.to;
  // 还没有导读可看（空状态）就跟着读到的章走；已经有导读在显示就只挂提示条
  if (outside && !S.guide && !curJob() && !S.err && !S.pending && !S.scopePick) return void refresh();
  const want = outside && !!S.guide && !!noticeChapter();
  if (want !== S.noticeShown) render();
});

render();
