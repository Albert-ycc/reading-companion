// 导图：批注栏里的第三个视图。骨架取自文档自带的目录（书签、编号标题、版式），Claude 只往里填要点，
// 每个要点都带能在原文里找到的出处；点节点跳回原文，节点可以自己改、加、删、拖，改动存盘，重新生成不冲掉你动过的。
// 设计与文案出处：design/mindmap/interaction.md。服务端：features/mindmap.py。
import MindElixir from "./vendor/mind-elixir/MindElixir.js";
import { el } from "./ui.js";
import { registerView, showView, setBadge, currentView } from "./panel.js";
import { registerAction } from "./registry.js";
import { currentBook, getPdf, getCurrentPage, extractText, getOutline, revealPassage, focusPassage, isScanned } from "./reader.js";
import { compose } from "./chat.js";

const MAX_PAGES = 60; // 一次最多出 60 页，和导读的「指定页码」同一上限
const MAX_TOPIC = 200; // 节点名上限，服务端同样是 200，超过会被拒绝
const MAX_DEPTH = 3; // 含根共 4 层：根(0) → 一级(1) → 二级(2) → 三级(3)
const CJK = /[㐀-鿿]/;
const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const newId = () => "n" + Math.random().toString(16).slice(2, 10).padEnd(8, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));
// 截断和计数一律按字符（码点），不按 UTF-16 下标：下标截断会把 emoji 劈成落单的代理项，服务端存盘时编码出错，整张导图都存不上
const charLen = (s) => Array.from(s).length;
const cut = (s, n) => { const a = Array.from(String(s ?? "")); const t = a.length > n ? a.slice(0, n).join("") : a.join(""); return t.toWellFormed ? t.toWellFormed() : t; };
const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes("百")) return NaN;
  if (s === "十") return 10;
  if (s.startsWith("十")) return 10 + (CN_NUM[s[1]] ?? 0);
  if (s.includes("十")) { const [a, b] = s.split("十"); return (CN_NUM[a] ?? NaN) * 10 + (b ? CN_NUM[b] ?? NaN : 0); }
  return CN_NUM[s] ?? NaN;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { status: res.status });
  return res.json();
}
async function postJSON(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ─────────────────────────── 骨架：书签 ───────────────────────────
const SKIP_TITLE = /^(references?|bibliography|further reading|suggested reading|acknowledg(e)?ments?|disclosures?|funding|conflicts? of interest|supplementa(l|ry)[\w\s]*|index|参考文献|延伸阅读|致谢|利益冲突|索引|目录|版权)$/i;
const FIGURE_TITLE = /^(figures?|tables?|fig\.|图|表)\s*[\d一二三四五六七八九十]+[a-z]?$/i;

function flatOutline(tree, out = []) {
  for (const n of tree) {
    out.push({ title: String(n.title || "").replace(/\s+/g, " ").trim(), page: n.page, depth: n.depth });
    flatOutline(n.children || [], out);
  }
  return out;
}

// 书签可不可用：每页一条、标题只是页码、顺序对不上、指不到页，都不能当骨架
function judgeOutline(flat, numPages) {
  if (!flat.length) return { usable: false, reasons: ["没有书签"], count: 0, examples: [] };
  const reasons = [];
  const withPage = flat.filter((x) => x.page != null);
  if (withPage.length < flat.length * 0.9) reasons.push(`${flat.length - withPage.length} 条书签没有指向页`);
  const distinct = new Set(withPage.map((x) => x.page)).size;
  if (flat.length >= 8 && flat.length >= numPages * 0.6 && distinct / flat.length > 0.9) reasons.push(`书签 ${flat.length} 条、${numPages} 页，几乎每页一条`);
  const pageLike = flat.filter((x) => /^(第\s*\d+\s*页|page\s*\d+|p\.?\s*\d+|\d+)$/i.test(x.title)).length;
  if (pageLike > flat.length * 0.5) reasons.push("多数书签标题只是页码");
  let back = 0;
  for (let i = 1; i < withPage.length; i++) if (withPage[i].page < withPage[i - 1].page) back++;
  if (withPage.length > 4 && back > withPage.length * 0.2) reasons.push("书签顺序和页码对不上");
  if (flat.filter((x) => x.depth === 0).length < 2 && flat.length < 3) reasons.push("书签太少，撑不起骨架");
  // 正文和补充材料拼成一个文件时，书签是被拼进来的文件名，不是章节
  const top = flat.filter((x) => x.depth === 0);
  if (top.some((x) => /\.(pdf|docx?|pptx?|xlsx?)$/i.test(x.title))) reasons.push("书签是合并文件留下的文件名");
  else if (flat.length <= 4 && top.length <= 3 && numPages / Math.max(1, top.length) >= 10) reasons.push("书签只有几条、每条跨十几页，不是章节");
  return { usable: reasons.length === 0, reasons, count: flat.length, examples: flat.slice(0, 3).map((x) => x.title) };
}

const skelNode = (title, page) => ({ id: newId(), title, page, off: 0, children: [] });

// 论文：范围内最浅的一层是一级，下一层是二级；更深的只给 Claude 看
function skeletonFromOutline(flat, [a, b]) {
  const kept = flat.filter((x) => x.page != null && x.page >= a && x.page <= b && x.title && !SKIP_TITLE.test(x.title) && !FIGURE_TITLE.test(x.title));
  if (!kept.length) return { nodes: [], deeper: [] };
  const d0 = Math.min(...kept.map((x) => x.depth));
  const nodes = [], deeper = [];
  let cur = null;
  for (const it of kept) {
    const rel = it.depth - d0;
    if (rel === 0) { cur = skelNode(it.title, it.page); nodes.push(cur); }
    else if (rel === 1 && cur) cur.children.push(skelNode(it.title, it.page));
    else if (rel >= 2) deeper.push({ title: it.title, page: it.page, under: cur?.title || "" });
  }
  return { nodes, deeper };
}

// 书的一章（范围来自导读的章节表）：范围内最浅且起始页等于 from 的书签作根，它之后到下一个同级或更浅书签之前的条目里，
// 一级 = 下一层，二级 = 再下一层
function skeletonFromRange(flat, from, to) {
  const inr = flat.map((x, i) => ({ ...x, i })).filter((x) => x.page != null && x.page >= from && x.page <= to);
  if (!inr.length) return null;
  const d0 = Math.min(...inr.map((x) => x.depth));
  const root = inr.find((x) => x.depth === d0 && x.page === from) || inr.find((x) => x.depth === d0);
  let end = root.i + 1;
  while (end < flat.length && flat[end].depth > root.depth) end++;
  const sub = flat.slice(root.i + 1, end).filter((x) => x.page != null && x.page >= from && x.page <= to && x.title && !SKIP_TITLE.test(x.title) && !FIGURE_TITLE.test(x.title));
  const nodes = [], deeper = [];
  let cur = null;
  for (const it of sub) {
    const rel = it.depth - root.depth;
    if (rel === 1) { cur = skelNode(it.title, it.page); nodes.push(cur); }
    else if (rel === 2 && cur) cur.children.push(skelNode(it.title, it.page));
    else if (rel >= 3) deeper.push({ title: it.title, page: it.page, under: cur?.title || "" });
  }
  return { rootTitle: root.title, nodes, deeper };
}

// ─────────────────────────── 骨架：版式（编号标题、字号） ───────────────────────────
// 文字流按 pdf.js 的顺序取行（片段按 hasEOL 分行），和阅读器的 extractText 同一种拼法；扫描页没有文字层，行取自识别结果
async function pageLinesOf(n, pdf = getPdf()) {
  try {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const styles = tc.styles || {};
    const lines = [];
    let cur = null;
    for (const it of tc.items) {
      cur ||= { text: "", size: 0, font: "", vertical: false, first: true };
      if (cur.first && it.str.trim()) {
        cur.first = false;
        cur.font = (styles[it.fontName]?.fontFamily || "") + " " + it.fontName;
        cur.vertical = Math.abs(it.transform[1]) > Math.abs(it.transform[0]);
      }
      cur.text += it.str;
      if (it.str.trim()) cur.size = Math.max(cur.size, Math.hypot(it.transform[2], it.transform[3]));
      if (it.hasEOL) { if (cur.text.trim()) lines.push(cur); cur = null; }
    }
    if (cur?.text.trim()) lines.push(cur);
    const out = lines.map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), size: Math.round(l.size * 10) / 10, font: l.font, vertical: l.vertical, page: n })).filter((l) => l.text);
    if (out.length) return out;
  } catch {}
  // 快速换书时，这本书已经关了：取不到就当这一页没有字，由调用方按「书变了」静默退出
  if (getPdf() !== pdf) return [];
  let text;
  try { text = await extractText(n); } catch { return []; }
  return text.split("\n").map((t) => ({ text: t.replace(/\s+/g, " ").trim(), size: 0, font: "", vertical: false, page: n })).filter((l) => l.text);
}

// 编号写法。章、节后面不一定有空格：识别出来的「第一节概述」常常中间没有空格。
// 阿拉伯数字层级编号（中文共识、规范常用）：「1 标题」「2.1 标题」「3.1.3 标题」，层数 = 点号个数 + 1
const CN_N = "零〇一二三四五六七八九十\\d";
const ARABIC_NOT_TITLE = /^(例|个|种|名|次|天|周|月|年|岁|倍|项|组|人|级|度|分|mg|g\b|ml|kg|%|％|\d)/i;
const FAMS = [
  { k: "chap", re: new RegExp(`^第\\s*([${CN_N}]+)\\s*章[\\s\\u3000:：]*(\\S.*)?$`) },
  { k: "sec", re: new RegExp(`^第\\s*([${CN_N}]+)\\s*节[\\s\\u3000:：]*(\\S.*)?$`) },
  { k: "cn1", re: /^([一二三四五六七八九十]{1,3})\s*[、.．]\s*(\S.*)$/ },
  { k: "cn2", re: /^[（(]([一二三四五六七八九十]{1,3})[）)]\s*(\S.*)$/ },
  { k: "ar1", re: /^(\d{1,2})[\s\u3000]+(\S.*)$/ },
  { k: "ar2", re: /^(\d{1,2})\.(\d{1,2})[\s\u3000]+(\S.*)$/ },
  { k: "ar3", re: /^(\d{1,2})\.(\d{1,2})\.(\d{1,2})[\s\u3000]+(\S.*)$/ },
];

// 编号标题：单独成短行（≤ 40 字符），编号连续递增；下一层的编号允许每个上层标题之后重新从一开始。
// 阿拉伯数字的「2.1」必须挂在「2」下面（前面的数字要和上一个一级的编号对得上）
function numberedSkeleton(lines) {
  const heads = [];
  const tidy = (t) => t.replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, "$1").trim(); // 识别和排版常在汉字之间留空格：「小 结」
  lines.forEach((l, idx) => {
    if (l.vertical) return;
    // 「2.1 传统的检测方法：黏弹性……」这种标题和正文连在一行的，标题取冒号前面那一段
    const run = /^(.{3,44}?)[：:](?:\s*\S|\s*$)/.exec(l.text);
    const text = run ? run[1].trim() : l.text;
    if (text.length > 40) return;
    for (const f of FAMS) {
      const m = f.re.exec(text);
      if (!m) continue;
      if (f.k.startsWith("ar")) {
        const nums = m.slice(1, -1).map(Number), title = tidy(m.at(-1));
        // 只认汉字标题：英文论文里流程图方框的「1 … 2 …」、页码「1 of 3」会凑成连续编号，英文的走字号版式
        if (ARABIC_NOT_TITLE.test(title) || /[。；;，,]$/.test(title) || !CJK.test(title)) continue;
        heads.push({ fam: f.k, num: nums.at(-1), path: nums, title, page: l.page, idx });
      } else heads.push({ fam: f.k, num: cnNumber(m[1]), title: tidy((m[2] || text).trim()), page: l.page, idx });
      break;
    }
  });
  const valid = (fam, resetAt) => {
    const out = [];
    let exp = 1, owner = null;
    for (const h of heads) {
      if (resetAt?.has(h)) { exp = 1; owner = h; }
      if (h.fam !== fam) continue;
      if (h.path && owner?.path && h.path.length === owner.path.length + 1 && !owner.path.every((v, i) => v === h.path[i])) continue; // 2.1 要挂在 2 下面，3.1.1 要挂在 3.1 下面
      if (h.num === exp) { out.push(h); exp++; } else if (h.num === 1) { out.push(h); exp = 2; }
    }
    return out;
  };
  let l1 = null, l1fam = -1;
  for (let i = 0; i < FAMS.length; i++) {
    const v = valid(FAMS[i].k);
    if (v.length >= 2) { l1 = v; l1fam = i; break; }
  }
  if (!l1) return [];
  const resets = new Set(l1);
  let l2 = null, l2fam = -1;
  for (let i = l1fam + 1; i < FAMS.length; i++) {
    const v = valid(FAMS[i].k, resets);
    if (v.length >= 2) { l2 = v; l2fam = i; break; }
  }
  const nodes = l1.map((h) => skelNode(h.title, h.page));
  nodes.forEach((n, i) => { n._idx = l1[i].idx; });
  const ownerOf = (list, idx) => { let o = null; list.forEach((n) => { if (n._idx <= idx) o = n; }); return o; };
  for (const h of l2 || []) {
    const n = skelNode(h.title, h.page);
    n._idx = h.idx;
    ownerOf(nodes, h.idx)?.children.push(n);
  }
  // 再下一层的编号只给 Claude 看清结构，不做节点
  const deeper = [];
  if (l2fam >= 0 && l2fam + 1 < FAMS.length) {
    const l3 = valid(FAMS[l2fam + 1].k, new Set(l2));
    for (const h of l3) {
      const o1 = ownerOf(nodes, h.idx), o2 = ownerOf(nodes.flatMap((n) => n.children), h.idx);
      const own = o2 && (!o1 || o2._idx > o1._idx) ? o2 : o1;
      if (own) deeper.push({ title: h.title, page: h.page, under: own.title });
    }
  }
  nodes.forEach((n) => { delete n._idx; n.children.forEach((c) => delete c._idx); });
  nodes.deeper = deeper;
  return nodes;
}

const SECTION_WORDS = /^(abstract|introduction|background|methods?|materials and methods|patients and methods|results?|discussion|conclusions?|limitations|摘要|前言|引言|背景|方法|结果|讨论|结论)$/i;
// 英文论文没有编号：标准章节名当一级，夹在两个一级之间的、首字母大写的短标题当二级
function styledSkeleton(lines) {
  const all = lines.filter((l) => !l.vertical && l.size > 0);
  if (all.length < 30) return [];
  const mode = (vals, weights) => {
    const m = new Map();
    vals.forEach((v, i) => m.set(v, (m.get(v) || 0) + weights[i]));
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const bodySize = mode(all.map((l) => Math.round(l.size)), all.map((l) => l.text.length));
  const bodyFont = mode(all.map((l) => l.font), all.map((l) => l.text.length));
  const nodes = [];
  let cur = null;
  for (const l of all) {
    const t = l.text;
    if (t.length > 60 || t.length < 2 || (/[.。]$/.test(t) && !SECTION_WORDS.test(t.replace(/[.。]$/, "")))) continue;
    if (/^\d+$/.test(t) || /www\.|doi|©|\bvol\b|manuscript/i.test(t)) continue;
    // 小型大写的标题（NEJM 等）抽出来是「A BS TR AC T」「M ETHODS」「Me thods」：短行里字母被空格隔开时，去掉空格再认章节名
    const squeezed = t.length <= 24 && /^[A-Za-z][A-Za-z\s]+$/.test(t) ? t.replace(/\s+/g, "") : t;
    const named = SECTION_WORDS.test(squeezed);
    const bigger = l.size >= bodySize * 1.15 && l.size < bodySize * 2.2;
    const diffFont = l.font !== bodyFont && l.size >= bodySize * 0.95 && t.length <= 40;
    if (!(named || bigger || diffFont)) continue;
    if (SKIP_TITLE.test(t) || /^(disclosures?|funding|affiliations?|supplemental material|keywords?)$/i.test(t)) { cur = null; continue; }
    if (named) {
      const title = squeezed.replace(/^./, (c) => c.toUpperCase()).replace(/^([A-Z])([A-Z]+)$/, (_, a, b) => a + b.toLowerCase());
      // 结构化摘要里的 Background、Methods、Results、Conclusions 和摘要在同一页：归到摘要下面，不当一级
      const abs = nodes.find((n) => /^(abstract|摘要)$/i.test(n.title));
      if (abs && l.page === abs.page && !/^(abstract|摘要|introduction|前言|引言)$/i.test(title)) { abs.children.push(skelNode(title, l.page)); continue; }
      cur = skelNode(title, l.page);
      nodes.push(cur);
    } else if (cur && /^[A-Z一-龥]/.test(t) && t.split(/\s+/).length <= 9 && !/[,;，；]$/.test(t) && !/\d{2,}/.test(t) && !/[()]/.test(t)) {
      cur.children.push(skelNode(t, l.page));
    }
  }
  return nodes;
}

// ─────────────────────────── 状态 ───────────────────────────
const S = {
  inst: null, host: null, ui: null,
  book: null, kind: "paper", chapters: [], scope: null, scopes: [], picked: null,
  state: "idle", // idle | no-book | loading | no-scope | empty-toc | need-ocr | ready
  model: null, rev: 0, skelInfo: null, hasPrev: false, unsaved: false, deeper: [], tocInfo: null,
  sel: null, saveState: "saved", saveT: 0, saving: false, again: false, conflict: null,
  gen: null, hls: [], trace: new Map(), stuck: new Set(), stuckList: null, here: null,
  undoN: 0, redoN: 0, toast: null, toastT: 0, sheet: null, menu: null,
  silent: 0, needsDraw: false, queue: Promise.resolve(), regen: null, known: null,
};
const bookKey = () => S.book?.key || "";
const scopeId = () => S.scope?.id || "";
const visible = () => currentView() === "map";

// 后台还在跑的生成任务（书|范围）。切章、换书只是不再订阅它，任务在服务端照常跑，标签上的点要一直亮到它写完：
// 还在跑就保持 busy；写完而你不在导图里，亮静止的 done
const BG = new Map();
let bgTimer = 0;
function badge() { setBadge("map", BG.size ? "busy" : null); }
function bgAdd(file, scope) {
  BG.set(file + "|" + scope, { file, scope, title: S.book?.title || "", label: S.scope?.title || "" });
  badge();
  if (!bgTimer) bgTimer = setInterval(bgPoll, 4000);
}
function bgDrop(file, scope, finished = false) {
  const ent = BG.get(file + "|" + scope);
  if (!BG.delete(file + "|" + scope)) return;
  // 写完的就是你正看着的这一份，不用亮；你在别处（别的视图、别的书、别的章）才亮静止的 done
  const watching = visible() && file === bookKey() && scope === scopeId();
  if (BG.size) badge(); else setBadge("map", finished && !watching ? "done" : null);
  // 人就在导图视图里时外壳不显示 done 点（panel.js），换成一条提示
  if (finished && !watching && visible() && S.ui) tell(`「${ent?.title || "另一本书"}」的导图生成完了，换回去就能看。`);
  if (!BG.size && bgTimer) { clearInterval(bgTimer); bgTimer = 0; }
}
async function bgPoll() {
  for (const [key, { file, scope }] of [...BG]) {
    if (S.gen?.running && key === bookKey() + "|" + scopeId()) continue; // 正在订阅的这一个，结束时由 finishGen 收尾
    try {
      const r = await getJSON(`/api/mindmap?file=${encodeURIComponent(file)}&scope=${encodeURIComponent(scope)}`);
      if (r.job?.state !== "running") bgDrop(file, scope, true);
    } catch {}
  }
}

// ─────────────────────────── 模型 ⇄ Mind Elixir ───────────────────────────
const SRC_STYLE = {
  doc: { fontFamily: "var(--song)", color: "var(--ink)" },
  user: { fontFamily: "var(--song)", color: "var(--ink)" },
  claude: { fontFamily: "var(--kai)", color: "var(--dian-ink)", fontSize: "15px" },
};

function metaOf(n, parentId) {
  return {
    src: n.src, page: n.page ?? null, off: n.off ?? null, end: n.end ?? null, quote: n.quote || "", seg: n.seg || "", term: n.term || "", skel: !!n.skel,
    topic0: n.src === "user" || n.edited ? null : n.topic, parent0: n.src === "user" || n.moved ? null : parentId,
    edited: !!n.edited, moved: !!n.moved,
  };
}

function toME(n, depth, parentId, ctx) {
  const m = metaOf(n, parentId);
  const kids = (n.children || []).map((c) => toME(c, depth + 1, n.id, ctx));
  const edited = !!n.edited, moved = !!n.moved;
  // 占位行：生成中、没生成好的分支，不进模型，只画在图上
  const extra = [];
  if (depth === 1 && ctx.pending.has(n.id)) extra.push({ id: "pend-" + n.id, topic: ctx.pending.get(n.id), metadata: { pending: true, src: "doc" }, style: SRC_STYLE.doc });
  if (depth === 1 && ctx.failed.has(n.id)) extra.push({ id: "fail-" + n.id, topic: "这一节没生成好", metadata: { failed: true, src: "doc", of: n.id }, tags: [{ text: "重试", className: "wait" }], style: SRC_STYLE.doc });
  if (depth === 1 && ctx.undone.has(n.id)) extra.push({ id: "fail-" + n.id, topic: "这一节还没生成", metadata: { failed: true, undone: true, src: "doc", of: n.id }, tags: [{ text: "生成", className: "wait" }], style: SRC_STYLE.doc });
  const all = [...extra, ...kids];
  const tags = [];
  if (n.page && depth > 0) tags.push({ text: "p." + n.page, className: "pg" });
  if (depth === 1 && ctx.waiting.has(n.id)) tags.push({ text: "等待", className: "wait" });
  if (ctx.stuck.has(n.id)) tags.push({ text: "卡", className: "stamp ka" });
  if (n.src === "user" || edited || moved) tags.push({ text: "我", className: "stamp wo" });
  return {
    id: n.id, topic: n.topic,
    // 叶子节点不能带 expanded:false，否则之后给它加子节点时 Mind Elixir 会去展开一个不存在的展开圈而报错
    expanded: all.length ? n.open !== false : undefined,
    children: all.length ? all : undefined,
    tags: tags.length ? tags : undefined,
    style: depth === 0 ? undefined : SRC_STYLE[n.src] || SRC_STYLE.user,
    metadata: m,
  };
}

// 改名、拖动之后的「我」印是从数据里算出来的：改过名 = 现在的字不是当初的字，拖过 = 现在的父节点不是当初的父节点
function fromME(n, parentId) {
  const m = n.metadata || {};
  if (m.pending || m.failed) return null;
  const node = { id: n.id, topic: cut(n.topic, MAX_TOPIC), src: m.src || "user" };
  if (m.term) node.term = m.term;
  node.page = m.page ?? null;
  if (m.off != null) node.off = m.off;
  if (m.end != null) node.end = m.end;
  node.quote = m.quote || "";
  if (m.seg) node.seg = m.seg;
  if (m.skel) node.skel = true;
  if (node.src !== "user") {
    if (m.edited || (m.topic0 != null && n.topic !== m.topic0)) node.edited = true;
    if (m.moved || (m.parent0 && m.parent0 !== parentId)) node.moved = true;
  }
  const kids = (n.children || []).map((c) => fromME(c, n.id)).filter(Boolean);
  if (n.expanded === false && (n.children || []).length) node.open = false;
  node.children = kids;
  return node;
}

function eachNode(n, fn, depth = 0, parent = null) {
  fn(n, depth, parent);
  for (const c of n.children || []) eachNode(c, fn, depth + 1, n);
}
const findNode = (root, id) => { let r = null; eachNode(root, (n) => { if (n.id === id) r = n; }); return r; };
const subtreeSize = (n) => 1 + (n.children || []).reduce((s, c) => s + subtreeSize(c), 0);
const isLocked = (n) => n.src === "user" || n.edited || n.moved;
const hasLockedDesc = (n) => (n.children || []).some((c) => isLocked(c) || hasLockedDesc(c));
const posOf = (n) => [n.page ?? 1e9, n.off ?? 0];
const cmpPos = (a, b) => { const [pa, oa] = posOf(a), [pb, ob] = posOf(b); return pa - pb || oa - ob; };

// 模型比画布新（隐藏时合并了生成结果、还没画）时不能拿画布覆盖模型
function syncFromME() {
  if (!S.inst || !S.model || S.needsDraw) return;
  const root = fromME(S.inst.getData().nodeData, null);
  if (root) { root.id = S.model.root.id; S.model.root = root; }
}

// ─────────────────────────── 画布 ───────────────────────────
const THEME = {
  name: "评点本", type: "light", palette: ["#233A5E"],
  cssVar: {
    "--node-gap-x": "12px", "--node-gap-y": "4px", "--main-gap-x": "16px", "--main-gap-y": "4px",
    "--main-color": "#231E19", "--main-bgcolor": "transparent", "--main-bgcolor-transparent": "transparent",
    "--color": "#231E19", "--bgcolor": "transparent", "--selected": "#233A5E", "--accent-color": "#233A5E",
    "--root-color": "#F9F7F0", "--root-bgcolor": "#233A5E", "--root-border-color": "#233A5E", "--root-radius": "2px",
    "--main-radius": "0px", "--topic-padding": "1px", "--map-padding": "16px 16px 16px 14px",
    "--panel-color": "35, 30, 25", "--panel-bgcolor": "253, 252, 248", "--panel-border-color": "214, 208, 199",
  },
  // 线：字落在线上。每条分支从父节点底边右端弯到子节点底边左端，再沿子节点底边走到它的右端（＝子节点的下划线）
  generateMainBranch({ pT, pL, pW, pH, cT, cL, cH }) {
    const x0 = pL + pW, y0 = pT + pH / 2, x1 = cL, y1 = cT + cH - 0.75, dx = (x1 - x0) * 0.55;
    return `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1}`;
  },
  generateSubBranch({ pT, pL, pW, pH, cT, cL, cW, cH }) {
    const x0 = pL + pW - 2, y0 = pT + pH - 0.75, x1 = cL, y1 = cT + cH - 0.5, dx = Math.max(8, (x1 - x0) * 0.6);
    return `M ${x0} ${y0} C ${x0 + dx} ${y0}, ${x1 - dx} ${y1}, ${x1} ${y1} H ${cL + cW}`;
  },
};

function branchRange(id) {
  const kids = [...(S.model?.root.children || [])].sort(cmpPos); // 到下一节的起页，按页码排，和画布上兄弟的先后无关
  const i = kids.findIndex((c) => c.id === id);
  if (i < 0) return "";
  return `${kids[i].page}–${kids[i + 1] ? kids[i + 1].page : S.scope.pages[1]}`;
}

function marksCtx() {
  const pending = new Map(), waiting = new Set(), failed = new Set(), undone = new Set();
  const g = S.gen;
  // 只有真在跑的才画「正在读」「等待」：停止、中断之后 g.branches 里还留着 running，不能接着显示
  if (g?.running && g.branches) {
    for (const [id, st] of Object.entries(g.branches)) {
      if (st === "running") pending.set(id, `正在读第 ${branchRange(id)} 页…`);
      else if (st === "pending") waiting.add(id);
    }
  }
  const brs = S.model?.gen?.branches || {};
  for (const [id, b] of Object.entries(brs)) if (b.state === "failed" && !pending.has(id)) failed.add(id);
  if (!g?.running && !g?.collect) for (const id of unfinishedBranches()) undone.add(id);
  return { pending, waiting, failed, undone, stuck: S.stuck };
}

// 展开圈里写子孙数；节点上的圈点、书签带、占位态用 data 属性挂（不影响布局，每次布局后补一次）。
// 折叠起来的节点，把藏在里面的圈点和「读到这儿」收到它自己身上，免得看不见
function decorate() {
  const inst = S.inst;
  if (!inst) return;
  const tpcs = [...inst.container.querySelectorAll("me-tpc")];
  const visibleIds = new Set(tpcs.map((t) => t.nodeObj?.id));
  const parentOf = new Map();
  if (S.model) eachNode(S.model.root, (n, _d, p) => { if (p) parentOf.set(n.id, p.id); });
  const lift = (id) => { while (id && !visibleIds.has(id)) id = parentOf.get(id); return id; };
  const hereId = lift(S.here);
  const lifted = new Set();
  for (const id of S.trace.keys()) { const v = lift(id); if (v && v !== id) lifted.add(v); }
  for (const tpc of tpcs) {
    const id = tpc.nodeObj?.id, m = tpc.nodeObj?.metadata || {};
    const set = (k, v) => (v ? tpc.setAttribute("data-" + k, v === true ? "" : v) : tpc.removeAttribute("data-" + k));
    set("trace", S.trace.get(id));
    set("trace-in", lifted.has(id));
    set("here", hereId === id);
    set("pending", !!m.pending);
    set("failed", !!m.failed);
    set("undone", !!m.undone);
    if (tpc.parentElement?.tagName === "ME-ROOT") tpc.classList.toggle("cjk", CJK.test(tpc.nodeObj.topic) && !/[a-z]{4}/i.test(tpc.nodeObj.topic));
  }
  const count = (n) => (n.children || []).reduce((s, c) => s + 1 + count(c), 0);
  for (const epd of inst.container.querySelectorAll("me-epd")) {
    const node = epd.previousSibling?.nodeObj;
    epd.dataset.n = node ? String(count(node)) : "";
  }
}

// 取景：根贴左；目标节点纵向在 40% 高处，整张图放得进画布高度时整体纵向居中；
// 目标和它的子孙要能落在栏里，放不下就整体向左滑到刚好放下（根题签整个滑出去，不留半截）
function frame(id, { slide = true } = {}) {
  const inst = S.inst;
  if (!inst || !visible()) return;
  const c = inst.container.getBoundingClientRect();
  const rootEl = inst.map.querySelector("me-root");
  if (!rootEl || !c.width) return;
  const root = rootEl.getBoundingClientRect();
  let dx = 22 - (root.left - c.left), dy = 0;
  let tpc = null;
  try { tpc = id ? inst.findEle(id) : null; } catch {}
  const all = [...inst.container.querySelectorAll("me-tpc")].map((t) => t.getBoundingClientRect());
  const top = Math.min(...all.map((b) => b.top)), bottom = Math.max(...all.map((b) => b.bottom));
  if (bottom - top <= c.height - 36) dy = c.top + c.height / 2 - (top + bottom) / 2;
  else if (tpc) { const r = tpc.getBoundingClientRect(); dy = c.top + c.height * 0.4 - (r.top + r.height / 2); }
  else dy = c.top + 24 - top;
  if (slide && tpc) {
    const branch = tpc.closest("me-main > me-wrapper") || tpc.closest("me-wrapper");
    const right = Math.max(...[...branch.querySelectorAll("me-tpc")].map((t) => t.getBoundingClientRect().right));
    const fit = Math.max(0, right + dx - (c.right - 14));
    let shift = fit;
    if (fit > 0) {
      shift = Math.max(fit, root.right - root.left + 14 + 6);
      // 一级节点不能留半截：能完整留在左缘就留，不能就整个滑出去，并让二级那一列离左缘 18px（避开渐隐）
      const l1 = branch.querySelector("me-parent > me-tpc")?.getBoundingClientRect();
      if (l1 && l1.left + dx - shift < c.left + 16) {
        const l2 = branch.querySelector("me-children me-parent > me-tpc")?.getBoundingClientRect();
        shift = l2 ? Math.max(fit, l2.left + dx - c.left - 24) : Math.max(fit, l1.right + dx - c.left + 10);
      }
    }
    dx -= shift;
  }
  inst.move(dx, dy);
}

// Mind Elixir 5.15.1 里左键拖空白处是框选，平移要右键拖、按住空格拖或触控板双指滚动。
// 窄栏里最常用的就是平移，所以让左键拖空白处也能平移（右键仍可框选）
function enablePan(inst) {
  const c = inst.container;
  let st = null;
  c.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.pointerType !== "mouse" || e.target !== c) return;
    st = { x: e.clientX, y: e.clientY };
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener("pointermove", (e) => {
    if (!st) return;
    inst.move(e.clientX - st.x, e.clientY - st.y);
    st = { x: e.clientX, y: e.clientY };
  });
  const end = (e) => { if (st) { st = null; c.releasePointerCapture?.(e.pointerId); } };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
}

function depthOf(nodeObj) { let d = 0, n = nodeObj; while (n?.parent) { d++; n = n.parent; } return d; }
function heightOf(nodeObj) { return 1 + Math.max(-1, ...(nodeObj.children || []).map(heightOf)); }

function createInstance() {
  S.host.replaceChildren();
  const inst = new MindElixir({
    el: S.host, direction: MindElixir.RIGHT, toolBar: false, contextMenu: false, keypress: true, allowUndo: true,
    mouseSelectionButton: 2, scaleMin: 0.6, scaleMax: 1.4, theme: THEME, newTopicName: "新节点",
    before: {
      // 深度上限：栏窄，再深一层就要横着拖才看得到
      // Tab 走键盘路径，调用时不带节点（tpc 是 undefined）：要退回当前选中的节点，不能当作没有超层放行
      addChild: (tpc) => {
        const at = tpc || S.inst?.currentNode;
        if (at && depthOf(at.nodeObj) >= MAX_DEPTH) { tell("导图最多四层。可以把它加成上一层的同级节点。"); return false; }
        return true;
      },
      insertParent: () => false,
      moveNodeIn: (from, to) => allowMove(from, to, true),
      moveNodeBefore: (from, to) => allowMove(from, to, false),
      moveNodeAfter: (from, to) => allowMove(from, to, false),
    },
  });
  // 新节点：你写的，带「我」印，没有出处
  inst.generateNewObj = () => ({
    topic: "新节点", id: newId(), style: SRC_STYLE.user, tags: [{ text: "我", className: "stamp wo" }],
    metadata: { src: "user", page: null, off: null, quote: "", term: "", topic0: null, parent0: null },
  });
  inst.init({ nodeData: toME(S.model.root, 0, null, marksCtx()) });
  enablePan(inst);
  // 复制粘贴会带着节点的全部数据，冒出第二个「Claude 写的」且不带「我」印：捕获阶段拦掉；改方向、插父节点的组合键也拦掉
  const c = inst.container;
  for (const t of ["copy", "cut", "paste"]) c.addEventListener(t, (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  c.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && /^(Arrow|Enter$|[kxcv]$)/i.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  // Esc 取消选中（改名时 Esc 在输入框里就被拦下，不会走到这里）
  c.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.target.closest?.("#input-box")) S.inst?.clearSelection(); });
  // 节点名最多 200 字：在输入框里就截，输入法选词的过程中不截（会打断输入法），选完再截
  const limitBox = (box) => {
    const t = box.innerText;
    if (charLen(t) <= MAX_TOPIC) return;
    box.innerText = cut(t, MAX_TOPIC);
    const r = document.createRange(); r.selectNodeContents(box); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    tell(`节点名最多 ${MAX_TOPIC} 字，多出的部分没有保留。`);
  };
  c.addEventListener("input", (e) => { if (e.target?.id === "input-box" && !e.isComposing) limitBox(e.target); }, true);
  c.addEventListener("compositionend", (e) => { if (e.target?.id === "input-box") limitBox(e.target); }, true);
  const undo0 = inst.undo.bind(inst), redo0 = inst.redo.bind(inst);
  const dismissToast = () => { clearTimeout(S.toastT); S.toast = null; renderToast(); };
  inst.undo = () => { if (S.undoN > 0) { S.undoN--; S.redoN++; dismissToast(); } const view = viewState(); undo0(); afterHistory(view); };
  inst.redo = () => { if (S.redoN > 0) { S.redoN--; S.undoN++; dismissToast(); } const view = viewState(); redo0(); afterHistory(view); };
  inst.bus.addListener("operation", onOperation);
  inst.bus.addListener("selectNodes", onSelectNodes);
  inst.bus.addListener("unselectNodes", () => { if (!S.silent) { S.sel = null; renderCard(); } });
  inst.bus.addListener("expandNode", onExpand);
  inst.bus.addListener("linkDiv", decorate);
  S.inst = inst;
  S.undoN = S.redoN = 0;
  decorate();
}

function allowMove(from, to, into) {
  const targetDepth = depthOf(to.nodeObj) + (into ? 1 : 0);
  const worst = Math.max(...from.map((t) => heightOf(t.nodeObj)));
  if (targetDepth + worst > MAX_DEPTH) { tell("导图最多四层。可以把它加成上一层的同级节点。"); return false; }
  return true;
}

// 重画：模型 → Mind Elixir。refresh 不动平移和缩放，选中会清掉，画完按 id 选回来
function draw({ select = S.sel, clearHistory = false } = {}) {
  if (!S.model) return;
  if (!visible() || !S.host.isConnected || !S.host.clientWidth) { S.needsDraw = true; return; }
  S.needsDraw = false;
  S.silent++;
  try {
    if (!S.inst) createInstance();
    else {
      S.inst.refresh({ nodeData: toME(S.model.root, 0, null, marksCtx()) });
      if (clearHistory) { S.inst.clearHistory?.(); S.undoN = S.redoN = 0; }
    }
    decorate();
    if (select) { try { S.inst.selectNode(S.inst.findEle(select)); } catch { S.sel = null; } }
    S.known = snapTree(); // 模型里换掉的 Claude 要点（重新生成）、恢复快照、载入最新，都不是你删的，不留墓碑
  } finally { S.silent--; }
  renderChrome();
}

// ─────────────────────────── 操作事件 ───────────────────────────
// 双击改名：输入框建好之后，浏览器的「双击选词」还会再改一次选区，把默认的全选冲掉，直接打字就插在原名前面。
// 刚进入编辑的一小段时间里，选区不是全文就补一次全选；已经改过字的不动
function keepAllSelected() {
  const box = S.inst?.container.querySelector("#input-box");
  if (!box) return;
  const text = box.innerText;
  const again = () => {
    if (!box.isConnected || box.innerText !== text) return;
    const sel = getSelection();
    if (sel.toString() === text) return;
    const r = document.createRange(); r.selectNodeContents(box);
    sel.removeAllRanges(); sel.addRange(r);
  };
  for (const ms of [0, 30, 80]) setTimeout(again, ms);
}

function onOperation(op) {
  if (op.name === "beginEdit") { keepAllSelected(); return; }
  S.undoN++; S.redoN = 0;
  reconcileTombstones();
  if (op.name === "finishEdit" && charLen(String(op.obj?.topic || "")) > MAX_TOPIC) {
    op.obj.topic = cut(op.obj.topic, MAX_TOPIC);
    tell(`节点名最多 ${MAX_TOPIC} 字，多出的部分没有保留。`);
  }
  if (op.name === "finishEdit" || /^moveNode/.test(op.name)) {
    if (/^moveNode/.test(op.name)) {
      tell(`已把「${op.objs[0].topic}」${op.objs.length > 1 ? "等 " + op.objs.length + " 个节点" : ""}移到「${op.toObj.topic}」${op.name === "moveNodeIn" ? "下" : "旁"}`, { undo: true });
    }
    // 改名和拖动都要给节点补上「我」印：同步成模型再重画
    setTimeout(() => { syncFromME(); draw(); }, 0);
  } else if (op.name === "removeNodes") {
    const total = op.objs.reduce((s, o) => s + subtreeSize(o), 0);
    tell(total > 1 ? `已删除「${op.objs[0].topic}」等 ${total} 个节点` : `已删除「${op.objs[0].topic}」`, { undo: true });
    // 删完 Mind Elixir 会自动选中父节点；卡片却没有节点可写，再按一次 Delete 删掉的就是整支。一并取消画布上的选中
    S.inst.clearSelection();
    S.sel = null;
    renderCard();
  } else if (op.name === "addChild" || op.name === "insertSibling") {
    // 兜底：钩子之外的入口万一放进了第五层，立刻去掉，不让它存到服务端
    if (depthOf(op.obj) > MAX_DEPTH) {
      try { S.inst.removeNodes([S.inst.findEle(op.obj.id)]); } catch {}
      tell("导图最多四层。可以把它加成上一层的同级节点。");
      return;
    }
    S.sel = op.obj.id;
  }
  scheduleSave();
  renderChrome();
}

// 展开/收起是你现在看到的样子，不在撤销的范围里：历史快照里的旧值不能把它翻回去
function viewState() {
  const view = new Map();
  (function w(n) { if ((n.children || []).length) view.set(n.id, n.expanded !== false); (n.children || []).forEach(w); })(S.inst.nodeData);
  return view;
}
function afterHistory(view) {
  // 撤销、重做之后节点数据是历史快照里的样子：按数据重新算一遍「我」印等标记；展开状态沿用撤销之前的
  setTimeout(() => {
    syncFromME();
    eachNode(S.model.root, (n) => { if (n.children.length && view.has(n.id)) { if (view.get(n.id)) delete n.open; else n.open = false; } });
    reconcileTombstones(); draw(); scheduleSave();
  }, 0);
}

// 删除要留痕：重新生成时你删掉的不再出现。
// Claude 要点的 id 每次重新生成都换，所以墓碑不能按父节点 id 记；记最近的文档目录/骨架祖先（id 不变）加内容指纹：
// 规整后的节名加页码，或者引句在页内的位置。被删节点的子孙也一并留痕，新要点自己带的 children 同样按它比对。
// 墓碑由操作前后画布上节点集合的差异推出：删除、撤销、重做、批量删除走同一条路，不靠哪个入口的钩子（重做删除不经过钩子）
function snapTree() {
  const out = new Map();
  const walk = (n, anc, isRoot) => {
    const m = n.metadata || {};
    if (!isRoot && !m.pending && !m.failed) {
      const t = { parent: anc, key: norm(n.topic) };
      if (m.page) t.page = m.page;
      if (m.off != null) t.off = m.off;
      if (m.end != null) t.end = m.end;
      if (m.quote) t.quote = cut(norm(m.quote), 60);
      out.set(n.id, { src: m.src, tomb: t });
    }
    const next = m.src === "doc" || m.skel ? n.id : anc; // 最近的文档目录/骨架祖先
    for (const c of n.children || []) walk(c, next, false);
  };
  walk(S.inst.nodeData, "", true);
  return out;
}
function reconcileTombstones() {
  if (!S.inst || !S.model) return;
  const now = snapTree(), before = S.known;
  S.known = now;
  if (!before) return;
  const tombs = (S.model.tombstones ||= []);
  for (const [id, r] of before) {
    if (now.has(id) || r.src === "user") continue; // 你自己写的不用留痕
    const t = r.tomb;
    if (!tombs.some((x) => x.parent === t.parent && x.key === t.key && x.page === t.page && x.off === t.off)) tombs.push(t);
  }
}

// 新要点是不是你删过的：同一个分支、同一页上，节名相同，或者引的是同一处原文（模型摘的片段 [off, end) 有明显重叠）。
// 不比补到句界的上下文 quote：同一句里不同位置的要点，上下文往往一样，A 删了 B 也会被跳过。
// 重叠至少占较短那段的三成：换个说法、起点挪了几个字，还是同一处；同一句里挨着的两段不重叠，不算。
// 刷新前后用同一套比法：墓碑的每个字段服务端都保留。没有页码的老墓碑只比节名；没有 end 的老墓碑只比 off
function sameCited(t, p) {
  if (t.off == null || p.off == null) return false;
  if (t.end == null || p.end == null) return t.off === p.off;
  const overlap = Math.min(t.end, p.end) - Math.max(t.off, p.off);
  return overlap > 0 && overlap >= 0.3 * Math.min(t.end - t.off, p.end - p.off);
}
function isTombstoned(tombs, anc, p) {
  const key = norm(p.topic);
  return tombs.some((t) => t.parent === anc && (t.page != null ? t.page === p.page && (t.key === key || sameCited(t, p)) : t.key === key));
}

function onExpand(nodeObj) {
  if (S.silent) return;
  // 手风琴：展开一个一级节点时，其他一级节点折叠
  if (nodeObj.parent && !nodeObj.parent.parent && nodeObj.expanded !== false) {
    S.silent++;
    for (const c of S.inst.nodeData.children || []) {
      if (c !== nodeObj && c.expanded !== false && (c.children || []).length) {
        try { S.inst.expandNode(S.inst.findEle(c.id), false); } catch {}
      }
    }
    S.silent--;
    setTimeout(() => frame(nodeObj.id), 0);
  }
  scheduleSave();
  decorate();
}

function onSelectNodes(nodes) {
  const n = nodes[nodes.length - 1];
  if (!n) return;
  S.sel = n.id;
  renderCard();
  if (S.silent) return;
  const m = n.metadata || {};
  if (m.page) revealPassage(m.page, m.seg || m.quote || n.topic).catch(() => {});
}

// ─────────────────────────── 存盘 ───────────────────────────
function scheduleSave(delay = 400) {
  if (!S.model || S.conflict) return;
  S.unsaved = true;
  setSave("dirty");
  clearTimeout(S.saveT);
  S.saveT = setTimeout(() => { S.saveT = 0; save(); }, delay);
}

// 删掉的一级分支在 gen.branches 里留下的条目没用了，还会让章节下拉、状态行把已经跑完的章当成没跑完
function pruneBranchStates(model) {
  const bs = model.gen?.branches;
  if (!bs) return;
  const have = new Set(model.root.children.filter((c) => c.src === "doc" || c.skel).map((c) => c.id));
  for (const id of Object.keys(bs)) if (!have.has(id)) delete bs[id];
}
const tidyModel = (model) => { pruneTombstones(model); pruneBranchStates(model); };

function pruneTombstones(model) {
  const alive = [];
  const walk = (n, anc) => {
    for (const c of n.children || []) {
      alive.push({ parent: anc, topic: c.topic, page: c.page, off: c.off, quote: c.quote });
      walk(c, c.src === "doc" || c.skel ? c.id : anc);
    }
  };
  walk(model.root, model.root.id);
  // 墓碑作废只看「同一个要点又在了」（同分支、同节名、同页）：同一句里的别的要点在，不算
  model.tombstones = (model.tombstones || []).filter((t) => !alive.some((a) => a.parent === t.parent && t.key === norm(a.topic) && (t.page == null || t.page === a.page))).slice(-400);
}

// 发一次存盘。导图自带书、范围和版本号（file、scope.id、rev），换书换章之后也能发回它原来的地方
async function sendSave(model, keepPrev) {
  model.gen ||= { state: "none", branches: {} };
  let r;
  try { r = await postJSON("/api/mindmap/save", { file: model.file, scope: model.scope.id, rev: model.rev || 0, map: clone(model), keepPrev }); } catch { return { kind: "error" }; }
  if (r.data.conflict) return { kind: "conflict", map: r.data.map };
  if (!r.ok) return { kind: "error" };
  model.rev = r.data.rev;
  return { kind: "ok" };
}

// 同一时刻只有一个存盘在飞；要留快照的那一次不能被正在飞的那次吞掉（否则撤销会回到更早的快照）。
// 返回这一次是不是真的存上了：冲突、出错、被排到在飞的那次后面都返回 false，要确认结果的地方走 saveConfirmed
async function save({ keepPrev = false } = {}) {
  if (!S.model || S.conflict) return false;
  if (S.saving) {
    if (!keepPrev) { S.again = true; return false; }
    await S.saving;
    return save({ keepPrev });
  }
  const model = S.model;
  let ok = false;
  S.saving = (async () => {
    syncFromME();
    tidyModel(model);
    setSave("saving");
    const r = await sendSave(model, keepPrev);
    if (S.model !== model) return; // 等的时候换了书、换了章：结果不往新导图的状态里写
    if (r.kind === "conflict") { S.conflict = r.map || true; setSave("conflict"); }
    else if (r.kind === "error") setSave("error");
    else {
      S.rev = model.rev;
      S.unsaved = S.again || !!S.saveT; // 存的时候又有新改动在等定时器：还没存完
      if (keepPrev) S.hasPrev = true;
      setSave(S.again ? "dirty" : "saved");
      ok = true;
    }
  })();
  await S.saving;
  S.saving = null;
  if (S.again && !S.conflict) { S.again = false; save(); } else S.again = false;
  return ok;
}

// 并入生成结果、重新生成前留快照：存不上就不能往下走（确认服务端的暂存结果、开始生成），先等在飞的那次落地再发一次
async function saveConfirmed(opts) {
  while (S.saving) await S.saving;
  return save(opts);
}

// 换书、换章、重新定范围之前：定时器里还没发出去的、上次没存上的改动先发出去，再清状态。
// 请求体在 sendSave 的同步段里就组好了，之后清状态不影响它；发不出去要说一声，不能悄悄丢
function flushBeforeLeave() {
  const model = S.model;
  if (!model || S.conflict || !S.unsaved || (S.saveState === "saved" && !model.rev)) return; // 从没存过、也没人动过的骨架不用存
  clearTimeout(S.saveT);
  S.saveT = 0;
  syncFromME();
  tidyModel(model);
  const go = async () => {
    const r = await sendSave(model, false);
    if (r.kind !== "ok") tell(`「${model.scope?.title || "导图"}」有改动没存上，${r.kind === "conflict" ? "那张导图在别处改过了" : "本地服务没有回应"}。`);
  };
  if (S.saving) S.saving.then(go, go); else go();
}

function setSave(st) { S.saveState = st; renderStatus(); }

// ─────────────────────────── 提示条 ───────────────────────────
function tell(text, { undo = false, action = null, ms = 0 } = {}) {
  clearTimeout(S.toastT);
  S.toast = { text, undo, action };
  renderToast();
  S.toastT = setTimeout(() => { S.toast = null; renderToast(); }, ms || (undo || action ? 8000 : 4000));
}

// ─────────────────────────── 界面外壳 ───────────────────────────
function buildUI(root) {
  const u = {};
  u.scopeBtn = el("button", { className: "mm-scope-btn", type: "button" });
  u.undo = el("button", { className: "mm-tool", type: "button", textContent: "撤销", onclick: () => S.inst?.undo() });
  u.redo = el("button", { className: "mm-tool", type: "button", textContent: "重做", onclick: () => S.inst?.redo() });
  u.more = el("button", { className: "mm-tool more", type: "button", textContent: "⋯", title: "更多", onclick: (e) => openMenu(e.currentTarget) });
  // 「全貌」「读到处」放在范围条里，不浮在画布上：图一长，最底下的节点会钻到浮着的按钮下面
  u.all = el("button", { className: "mm-tool", type: "button", textContent: "全貌", title: "收成只剩一级", onclick: overview });
  u.here = el("button", { className: "mm-tool", type: "button", textContent: "读到处", title: "展开到你现在读到的位置", onclick: gotoHere });
  u.row = el("div", { className: "row" }, u.scopeBtn, el("i", { className: "sp" }), u.all, u.here, u.undo, u.redo, u.more);
  u.subL = el("span"); u.subR = el("span");
  u.sub = el("div", { className: "mm-sub" }, u.subL, u.subR);
  u.scope = el("div", { className: "mm-scope" }, u.row, u.sub);
  u.host = el("div", { className: "mm-host" });
  u.hostWrap = el("div", { className: "mm-hostwrap" }, u.host);
  u.edge = el("div", { className: "mm-edge" });
  u.toast = el("div", { className: "mm-toast", hidden: true });
  u.canvas = el("div", { className: "mm-canvas" }, u.hostWrap, u.edge, u.toast);
  u.empty = el("div", { className: "mm-empty", hidden: true });
  u.card = el("div", { className: "mm-card" });
  u.over = el("div", { hidden: true });
  root.classList.add("mm-view");
  root.append(u.scope, u.canvas, u.empty, u.card, u.over);
  S.ui = u; S.host = u.host;
}

function renderChrome() { renderScope(); renderStatus(); renderCard(); renderToast(); }

function renderScope() {
  const u = S.ui, sc = S.scope;
  u.scopeBtn.replaceChildren();
  const can = S.kind === "book" && S.chapters.length > 0;
  u.scopeBtn.className = "mm-scope-btn" + (can ? " can" : "");
  u.scopeBtn.onclick = can ? (e) => openChapters(e.currentTarget) : null;
  if (!S.book) u.scopeBtn.append(el("span", { textContent: "导图" }));
  else if (!sc) { u.scopeBtn.append(el("span", { textContent: S.kind === "book" ? "选一章" : "指定页" })); if (can) u.scopeBtn.append(chev()); }
  else {
    const name = S.kind === "paper" ? "全文" : sc.kind === "chapter" ? (sc.no != null ? `第 ${sc.no} 章` : "这一章") : "指定页";
    u.scopeBtn.append(el("span", { textContent: name }));
    if (can) u.scopeBtn.append(chev());
  }
  u.undo.disabled = !S.undoN || S.state !== "ready";
  u.redo.disabled = !S.redoN || S.state !== "ready";
  u.more.disabled = S.state !== "ready";
  u.all.disabled = S.state !== "ready";
  u.here.disabled = S.state !== "ready" || !S.here;
}
function chev() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 10 6");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M1 1l4 4 4-4");
  s.append(p);
  return s;
}

function stat() {
  let doc = 0, claude = 0, mine = 0, total = 0;
  eachNode(S.model.root, (n, d) => {
    total++;
    if (d === 0) return;
    if (n.src === "doc" || n.skel) doc++; else if (n.src === "claude") claude++;
    if (n.src === "user" || n.edited || n.moved) mine++;
  });
  return { total, doc, claude, mine };
}
const branchNodes = () => S.model.root.children.filter((c) => c.src === "doc" || c.skel);
// 上次生成没跑完的支（停止、中断、刷新前）：生成开始时记成 pending，写完才改成 done / failed，存在导图文件里
const unfinishedBranches = () => (S.model ? branchNodes().filter((b) => S.model.gen?.branches?.[b.id]?.state === "pending").map((b) => b.id) : []);
// 生成中这一支的中文节名要等 Claude 回来才有：骨架里已经有中文名就用它；英文论文的标准章节名按通行译法；
// 其余写「第 N 节」，不在状态行里显示一长串英文标题
const ZH_SECTION = { abstract: "摘要", summary: "摘要", introduction: "引言", background: "背景", methods: "方法", method: "方法", "materials and methods": "材料与方法", "patients and methods": "患者与方法", results: "结果", discussion: "讨论", conclusion: "结论", conclusions: "结论", limitations: "局限", references: "参考文献" };
function branchLabel(n) {
  if (CJK.test(n.topic)) return n.topic;
  const z = ZH_SECTION[String(n.topic).trim().toLowerCase()];
  if (z) return z;
  const i = branchNodes().findIndex((b) => b.id === n.id);
  return i >= 0 ? `第 ${i + 1} 节` : "这一节";
}

// 「新建空导图」「我自己搭」把状态记成 manual；它和 none 一样都是「还没让 Claude 生成过」
const genState = () => S.model.gen?.state || "none";
const hasClaudePoints = () => { let r = false; eachNode(S.model.root, (n, d) => { if (d > 0 && n.src === "claude" && !n.skel) r = true; }); return r; };

// 页范围放在状态行左端：范围条里已经有五个按钮，再放页范围，「第 22 章」这样的名字会被挤成「第…」
function renderStatus() {
  renderStatusText();
  const L = S.ui.subL;
  if (S.scope && !L.className) {
    const pre = [el("small", { className: "pg", textContent: `p.${S.scope.pages[0]}–${S.scope.pages[1]}` })];
    if (S.scope.clipped) pre.push(`（这一章 ${S.scope.fullPages} 页，先出前 ${MAX_PAGES} 页）`); // 右侧留给存盘状态
    L.prepend(...pre, " · ");
  }
}

function renderStatusText() {
  const u = S.ui, L = u.subL, R = u.subR;
  L.className = ""; R.replaceChildren(); L.replaceChildren();
  const set = (t) => L.append(t);
  const g = S.gen;
  const btn = (text, fn) => el("button", { type: "button", textContent: text, onclick: fn });
  if (S.state === "ready" && S.model) {
    const have = new Set(branchNodes().map((b) => b.id));
    const failed = Object.entries(S.model.gen?.branches || {}).filter(([id, b]) => b.state === "failed" && have.has(id)).length;
    const branches = branchNodes().length;
    if (g?.collect) { L.className = "live"; set(g.collect.status); R.append(btn("停止", stopGenerate)); return; }
    if (g?.running) {
      L.className = "live";
      if (!Object.keys(g.branches).length) { set(g.propose ? "Claude 正在按内容提议分支…" : "Claude 正在开始生成…"); R.append(btn("停止", stopGenerate)); return; }
      const run = Object.entries(g.branches).find(([, s]) => s === "running");
      const n = run && findNode(S.model.root, run[0]);
      const fin = Object.values(g.branches).filter((s) => s === "done" || s === "failed").length;
      set(`Claude 正在读「${n ? branchLabel(n) : "…"}」· 已完成 ${fin} / ${Object.keys(g.branches).length} 节`);
      R.append(btn("停止", stopGenerate));
      return;
    }
    if (g?.error) { L.className = "bad"; set(g.error); R.append(btn("重试", () => { S.gen = null; generate({ only: g.only || null }); })); return; }
    if (g?.stopped) {
      const ids = Object.keys(g.branches).filter((id) => have.has(id)); // 停下之后删掉的分支不算
      set(`${g.interrupted || "已停止"} · 完成 ${ids.filter((id) => g.branches[id] === "done" || g.branches[id] === "failed").length} / ${ids.length} 节`);
      R.append(btn("继续", () => { const rest = g.rest; S.gen = null; generate({ only: rest }); }));
      return;
    }
    if (S.conflict) { L.className = "bad"; set("导图在别处改过了 · 载入最新"); R.append(btn("载入", reloadFromConflict)); return; }
    const left = g ? [] : unfinishedBranches();
    if (left.length) {
      const all = Object.keys(S.model.gen.branches).filter((id) => have.has(id)).length; // 删掉的分支不算
      set(`已停止 · 完成 ${all - left.length} / ${all} 节`);
      R.append(btn("继续", () => generate({ only: left })));
      return;
    }
    let idle = "已保存";
    if (failed) { L.className = "bad"; set(`${branches - failed} / ${branches} 节完成 · ${failed} 节没生成好`); }
    else if (!hasClaudePoints() && (genState() === "none" || (genState() === "manual" && (S.model.skeleton || {}).source === "manual"))) {
      const sk = S.model.skeleton || {};
      set(sk.source === "manual" ? "自己搭的骨架" : sk.source === "layout" ? `骨架按版式识别（可能不全） · ${branches} 节` : sk.source === "propose" ? `骨架由 Claude 按内容提议 · ${branches} 节` : `骨架取自书签 · ${branches} 节`);
      idle = "尚未生成要点";
    } else {
      const s = stat();
      set(s.mine ? `${s.total} 个节点 · 你的改动 ${s.mine} 处` : `${s.total} 个节点 · ${{ outline: "书签", propose: "提议分支" }[S.model.skeleton?.source] || "标题"} ${s.doc} 个 · Claude 要点 ${s.claude} 个`);
    }
    const st = S.saveState;
    if (st === "error") { R.append(el("span", { className: "bad", textContent: "没存上 · " }), btn("重试", () => save())); }
    else if (st === "saving" || st === "dirty") R.append(el("span", { textContent: "保存中…" }));
    else R.append(el("span", { textContent: idle }));
  } else if (S.state === "loading") {
    if (g?.collect) { L.className = "live"; set(g.collect.status); } else set("正在取这本书的导图…");
  } else if (S.state === "no-book") set("还没打开书");
  else if (S.state === "no-scope") set("这本书按章出图，选一章开始");
}

function renderToast() {
  const u = S.ui, t = S.toast;
  u.toast.hidden = !t;
  u.toast.replaceChildren();
  if (!t) return;
  u.toast.append(el("span", { textContent: t.text }));
  if (t.undo) u.toast.append(el("button", { type: "button", textContent: "撤销", onclick: () => { S.toast = null; renderToast(); S.inst?.undo(); } }));
  else if (t.action) u.toast.append(el("button", { type: "button", textContent: "撤销", onclick: () => { S.toast = null; renderToast(); t.action(); } }));
}

// ─────────────────────────── 节点卡 ───────────────────────────
const SRC_LABEL = { doc: "文档目录", claude: "Claude 写的", user: "你写的" };

function renderCard() {
  const u = S.ui, c = u.card;
  c.replaceChildren();
  u.card.hidden = S.state !== "ready" || !S.model;
  if (u.card.hidden) return;
  const btn = (text, fn, cls = "") => el("button", { className: "mm-btn " + cls, type: "button", textContent: text, onclick: fn });
  const text = (h, p, tiny, btns) => {
    c.append(el("h3", { textContent: h }));
    if (p) c.append(el("p", { textContent: p }));
    if (btns) c.append(el("div", { className: "btns" }, ...btns));
    if (tiny) c.append(el("p", { className: "tiny", textContent: tiny }));
  };
  const g = S.gen;
  let nodeObj = null;
  if (S.sel && S.inst) { try { nodeObj = S.inst.findEle(S.sel).nodeObj; } catch {} }
  if (nodeObj) return nodeCard(c, nodeObj, btn);
  if (g?.running || g?.collect) return text("先出来的几节已经能用", "点任意节点，原文会跳到那一页。生成期间你改过、加过的节点不会被后面的结果覆盖。");
  const branches = branchNodes().length;
  if (!hasClaudePoints() && (genState() === "none" || genState() === "manual")) {
    if (!S.model.root.children.length) {
      return text("空导图", "选中根节点，点「＋ 子节点」加一级节点。在阅读区划一段再加，新节点会带上这段的页码和引句。", null,
        [btn("＋ 一级节点", addToRoot, "solid"), btn("让 Claude 提议", () => startPropose())]);
    }
    if (genState() === "manual") return text("点一个节点", "原文会跳到那一页。双击改名，拖动换位置，Tab 加子节点。");
    const sk = S.model.skeleton || {}, info = S.skelInfo || {};
    let first;
    if (sk.source === "layout") first = "这份文件没有书签，标题是按版式认出来的，可能不全；缺的节可以自己加。";
    else if (sk.source === "propose") first = "这是 Claude 按内容提议的一级分支。";
    else if (S.kind === "book") first = `这一章在书签里有 ${branches} 节。`;
    else first = `这篇文章自带 ${info.count ?? "若干"} 条书签，用了其中 ${branches} 节${info.sub ? `、${info.sub} 个小节` : ""}；参考文献和图表页不入图。`;
    return text("先有骨架，再填要点", `${first}让 Claude 往每一节里填要点：每个要点都挂原文页码，找不到出处的会被删掉。`, `约 ${Math.max(1, Math.ceil(branches / 3))} 分钟。生成时可以继续读，也可以改节点。`,
      [btn("让 Claude 填要点", () => generate({}), "solid"), btn("我自己搭", () => { S.model.gen = { state: "manual", branches: {} }; scheduleSave(0); renderChrome(); })]);
  }
  return text("点一个节点", "原文会跳到那一页。双击改名，拖动换位置，Tab 加子节点。");
}

// 「先不管」一支：导图里的待生成标记和停下那一次在内存里的分支表都去掉，不刷新直接点「继续」也不会重跑它
function skipBranch(id) {
  delete S.model.gen.branches[id];
  if (S.gen) {
    delete S.gen.branches[id];
    if (S.gen.rest) S.gen.rest = S.gen.rest.filter((x) => x !== id);
  }
  S.sel = null; scheduleSave(0); draw({ select: null });
}

function nodeCard(c, nodeObj, btn) {
  const m = nodeObj.metadata || {};
  if (m.pending) { c.append(el("h3", { textContent: "正在读这一节" }), el("p", { textContent: "要点会一次整支出现。" })); return; }
  if (m.failed && m.undone) {
    const owner = S.model.root.children.find((x) => x.id === m.of);
    const kept = (owner?.children || []).some((x) => x.src === "claude"); // 重新生成被停下：这一支还留着原来的要点
    c.append(el("h3", { textContent: `「${owner?.term || owner?.topic || ""}」这一节${kept ? "没有重新生成" : "还没生成"}` }),
      el("p", { textContent: kept ? "上次重新生成没有跑完，这一节还是原来的要点，其他节不受影响。" : "上次生成没有跑完，这一节还空着，其他节不受影响。" }),
      el("div", { className: "btns" }, btn("生成这一节", () => generate({ only: [m.of] }), "solid"),
        btn("先不管", () => skipBranch(m.of))));
    return;
  }
  if (m.failed) {
    const owner = S.model.root.children.find((x) => x.id === m.of);
    const hasOld = (owner?.children || []).some((c) => c.src === "claude");
    const why = S.model.gen.branches[m.of]?.reason || "Claude 没有回应";
    c.append(el("h3", { textContent: `「${owner?.term || owner?.topic || ""}」这一节没生成好` }),
      el("p", { textContent: hasOld ? `${why}，原来的要点还在，其他节不受影响。` : `${why}，这一节先空着，其他节不受影响。` }),
      el("div", { className: "btns" }, btn("重试这一节", () => generate({ only: [m.of] }), "solid"),
        btn("先不管", () => skipBranch(m.of))));
    return;
  }
  const depth = depthOf(nodeObj);
  const src = m.src === "claude" ? "claude" : m.src === "doc" ? "doc" : "user";
  const edited = !!(m.edited || (m.topic0 != null && nodeObj.topic !== m.topic0));
  const moved = !!(m.moved || (m.parent0 && m.parent0 !== nodeObj.parent?.id));
  const head = el("div", { className: "nd-head" }, el("span", { className: "t" + (src === "claude" && !edited ? " claude" : ""), textContent: nodeObj.topic }));
  if (m.page && depth > 0) head.append(el("span", { className: "pg", textContent: "p." + m.page }));
  c.append(head);
  const meta = el("div", { className: "nd-meta" });
  if (m.term) meta.append(el("i", { textContent: m.term }), " · ");
  meta.append(SRC_LABEL[src] + (edited && src !== "user" ? "，你改过名" : "") + (moved && src !== "user" ? "，你挪过位置" : ""));
  c.append(meta);
  if (m.page && m.quote && src !== "doc") {
    // 存的是引句所在的整句（数字常在句子后半），卡片上默认露四行，点一下展开全句
    const q = el("p", { className: "nd-quote", title: "点一下展开或收起", onclick: (e) => e.currentTarget.classList.toggle("open") });
    q.append("“", el("mark", { textContent: m.quote }), /[.。!?！？;；)）]$/.test(m.quote) ? "”" : "…”");
    c.append(q);
  } else if (m.page && src === "doc") c.append(el("p", { className: "nd-quote none", textContent: `目录里这一节从第 ${m.page} 页开始。` }));
  else if (m.page) c.append(el("p", { className: "nd-quote none", textContent: `挂在第 ${m.page} 页。` }));
  else c.append(el("p", { className: "nd-quote none", textContent: "没有挂原文。" }));
  const tpc = () => S.inst.findEle(nodeObj.id);
  const btns = [];
  if (depth > 0 && !m.page) {
    const cur = getCurrentPage();
    const hl = [...S.hls].reverse().find((h) => h.page === cur);
    btns.push(btn(hl ? `挂到这句划线（第 ${cur} 页）` : `挂到第 ${cur} 页`, () => attachHere(nodeObj, hl)));
  }
  btns.push(btn("问 Claude", () => askAbout(nodeObj)));
  if (depth < MAX_DEPTH) btns.push(btn("＋ 子节点", () => S.inst.addChild(tpc())));
  if (depth > 0) btns.push(btn("改名", () => S.inst.beginEdit(tpc())));
  if (depth === 1 && (src === "doc" || m.skel)) btns.push(btn("重新生成这一支", () => regenerate(nodeObj.id)));
  if (depth > 0) btns.push(btn("删除", () => S.inst.removeNodes([tpc()]), "danger"));
  c.append(el("div", { className: "btns" }, ...btns));
}

async function attachHere(nodeObj, hl) {
  const page = getCurrentPage();
  const quote = cut((hl?.text || "").replace(/\s+/g, " "), 90);
  let off = null;
  if (quote) off = Math.max(0, norm(await extractText(page)).indexOf(norm(quote)));
  syncFromME();
  const n = findNode(S.model.root, nodeObj.id);
  if (n) { n.page = page; n.quote = quote; n.off = off; }
  commitModel("attachPage", nodeObj.id);
  scheduleSave(0);
}

// 导图自己改了模型再重画的地方，画布的撤销历史并不知道：它只认 Mind Elixir 的 operation 事件，
// 不发的话，下一次撤销别的操作会回到这次改动之前的快照，把它一并回滚（挂上的页码就是这样丢的）。
// 带数据的改动（挂页码）当成一步操作发出去，能单独撤销；展开、收起这类只动 open 的视图状态不带数据，不进历史
function commitModel(name, id) {
  draw();
  S.inst?.bus.fire("operation", { name, obj: { id } });
}

async function askAbout(nodeObj) {
  const m = nodeObj.metadata || {};
  if (m.page) await focusPassage(m.page, m.seg || m.quote || nodeObj.topic).catch(() => {});
  compose(`讲讲「${nodeObj.topic}」这部分`);
}

function addToRoot() {
  const r = S.inst?.findEle("root");
  if (r) { S.inst.selectNode(r); S.inst.addChild(r); }
}

// ─────────────────────────── 菜单、章节下拉、确认层 ───────────────────────────
function closeOverlays() { S.menu = null; S.sheet = null; renderOver(); }
function renderOver() {
  const u = S.ui;
  u.over.replaceChildren();
  u.over.hidden = !S.menu && !S.sheet;
  if (S.sheet) u.over.append(el("div", { className: "mm-scrim", onclick: closeOverlays }), S.sheet);
  else if (S.menu) u.over.append(el("div", { className: "mm-scrim", style: "background:transparent", onclick: closeOverlays }), S.menu);
}

function openMenu(anchor) {
  if (S.menu) return closeOverlays();
  const item = (text, fn, disabled = false) => el("button", { type: "button", textContent: text, disabled, onclick: () => { closeOverlays(); fn(); } });
  const hasBranches = branchNodes().length > 0;
  const busy = !!(S.gen?.running || S.gen?.collect);
  const menu = el("div", { className: "mm-menu" },
    item("重新生成全部", () => regenerate(null), !hasBranches || busy),
    item("展开全部", () => { syncFromME(); eachNode(S.model.root, (n) => { if (n.children.length) n.open = true; }); draw(); frame(S.sel); scheduleSave(); }),
    item("收起为一级", overview),
    item("恢复到上次重新生成之前", restorePrev, !S.hasPrev));
  const b = anchor.getBoundingClientRect(), p = S.ui.over.parentElement.getBoundingClientRect();
  menu.style.top = b.bottom - p.top + 4 + "px";
  menu.style.right = p.right - b.right + "px";
  S.menu = menu;
  renderOver();
}

async function openChapters(anchor) {
  if (S.menu) return closeOverlays();
  await refreshScopeList();
  const cur = getCurrentPage();
  const list = el("ul", { className: "mm-chap" });
  for (const ch of S.chapters) {
    const id = "ch-" + ch.from;
    const have = S.scopes.find((s) => s.id === id);
    const ok = have && (have.state === "done" || have.state === "partial");
    const some = have && have.claude > 0 && (!ok || have.left > 0); // 停止过、中断过：已经有要点，但还有没跑的支
    const here = cur >= ch.from && cur <= ch.to;
    const li = el("li", { className: (S.scope?.id === id ? "cur " : "") + (here ? "here" : "") },
      here ? el("span", { className: "rib" }) : "",
      el("span", { className: "n", textContent: ch.no != null ? `第 ${ch.no} 章` : ch.kind === "appendix" ? "附录" : "" }),
      el("span", { className: "nm", textContent: ch.title, title: ch.title }), el("span", { className: "ld" }),
      el("span", { className: "st" + (ok && !some ? " ok" : ""), textContent: (here ? "当前 · " : "") + (some ? "生成了一部分" : ok ? "已生成" : "未生成") }));
    li.onclick = () => { closeOverlays(); pickChapter(ch); };
    list.append(li);
  }
  const menu = el("div", { className: "mm-menu", style: "left:0;right:0;padding:0" }, list, el("div", { className: "foot", textContent: "一次只出一章。默认停在你正在读的那一章。" }));
  const p = S.ui.over.parentElement.getBoundingClientRect(), b = anchor.getBoundingClientRect();
  menu.style.top = b.bottom - p.top + 6 + "px";
  S.menu = menu;
  renderOver();
  menu.querySelector(".here")?.scrollIntoView({ block: "center" });
}

function sheet(title, rows, note, okText, ok) {
  const s = el("div", { className: "mm-sheet" }, el("h3", { textContent: title }),
    el("ul", {}, ...rows.map(([k, v, cls]) => el("li", { className: cls || "" }, el("b", { textContent: k }), el("span", { textContent: v })))));
  if (note) s.append(el("p", { textContent: note }));
  s.append(el("div", { className: "btns" }, el("button", { className: "mm-btn solid", type: "button", textContent: okText, onclick: () => { closeOverlays(); ok(); } }),
    el("button", { className: "mm-btn", type: "button", textContent: "取消", onclick: closeOverlays })));
  S.sheet = s;
  renderOver();
}

function overview() {
  if (!S.model) return;
  syncFromME();
  for (const c of S.model.root.children) c.open = false;
  S.sel = null;
  draw({ select: null });
  frame(null, { slide: false });
}

function gotoHere() {
  if (!S.model) return;
  collapseToHere();
}

// 手风琴：只展开你读到的位置所在的那一支（没有读到位置就展开第一支），其余一级折叠，再取景
function collapseToHere() {
  syncFromME();
  const target = S.here || branchNodes()[0]?.id || S.model.root.children[0]?.id;
  if (!target) return;
  openPathTo(target);
  draw({ select: null });
  frame(target);
}

// 展开到某个节点：它的祖先全部展开，其余一级折叠
function openPathTo(id) {
  const path = [];
  const walk = (n, trail) => { if (n.id === id) { path.push(...trail, n.id); return true; } return (n.children || []).some((c) => walk(c, [...trail, n.id])); };
  walk(S.model.root, []);
  const keep = new Set(path);
  for (const c of S.model.root.children) c.open = keep.has(c.id);
  eachNode(S.model.root, (n, d) => { if (d >= 2 && keep.has(n.id) && n.id !== id) n.open = true; });
}

// ─────────────────────────── 阅读位置、圈点、「卡」 ───────────────────────────
function orderedNodes() {
  const out = [];
  eachNode(S.model.root, (n, d) => { if (d > 0 && n.page) out.push(n); });
  return out.map((n, i) => ({ n, i })).sort((a, b) => cmpPos(a.n, b.n) || a.i - b.i).map((x) => x.n);
}

function updateHere() {
  if (!S.model || !S.scope) { S.here = null; return; }
  const cur = getCurrentPage();
  let best = null;
  for (const n of orderedNodes()) if (n.page <= cur) best = n;
  const id = cur >= S.scope.pages[0] && cur <= S.scope.pages[1] ? best?.id || null : null;
  if (id !== S.here) { S.here = id; decorate(); }
  S.ui.here.disabled = !S.here;
}

async function updateTrace() {
  if (!S.model) return;
  syncFromME();
  const order = orderedNodes();
  const trace = new Map();
  for (const h of S.hls) {
    if (!h.page || !S.scope || h.page < S.scope.pages[0] || h.page > S.scope.pages[1]) continue;
    let off = 0;
    try { off = Math.max(0, norm(await extractText(h.page)).indexOf(norm(h.text))); } catch {}
    let owner = null;
    for (const n of order) { if (n.page < h.page || (n.page === h.page && (n.off ?? 0) <= off)) owner = n; else break; }
    if (owner) trace.set(owner.id, Math.max(trace.get(owner.id) || 0, h.asked ? 2 : 1));
  }
  S.trace = trace;
  decorate();
}

async function loadStuck() {
  try { if (!S.stuckList) S.stuckList = (await getJSON("/api/mindmap/stuck")).concepts || []; } catch { S.stuckList = []; }
  if (!S.model) return;
  syncFromME();
  const order = orderedNodes();
  const ids = new Set();
  const title = norm(S.book?.title || "");
  for (const c of S.stuckList) {
    // 先按名字找（节点文字或英文原词里含这个概念）；一个都没找到，才按「第一次遇到」的页码挂到那一页的最后一个节点上
    const byName = order.filter((n) => {
      const hay = norm(n.topic) + "|" + norm(n.term || "");
      return c.aliases.some((a) => { const k = norm(a); return k.length >= 2 && hay.includes(k); });
    }).slice(0, 3);
    let hit = byName;
    if (!hit.length && c.book && c.page && title.includes(norm(c.book))) {
      const onPage = order.filter((n) => n.page <= c.page);
      const last = onPage[onPage.length - 1];
      if (last && c.page >= last.page && c.page <= (S.scope?.pages[1] ?? c.page)) hit = [last];
    }
    for (const n of hit) ids.add(n.id);
  }
  const same = ids.size === S.stuck.size && [...ids].every((i) => S.stuck.has(i));
  if (!same) { S.stuck = ids; draw(); }
}

// ─────────────────────────── 书、范围、骨架 ───────────────────────────
// 章节表以导读为准：书签推出来的和目录页建出来的都走 guide.js 的 getChapters()，导图不自己从书签推章。
// 导读还没导出它时，退回读已存的那一份；两处都拿不到就按「没有章节表」处理
// 不超过 60 页的文件一次能出完，按全文出图：导读会给论文也返回章节表（每条顶层书签算一章，连图表页都在内），导图不用
async function fetchChapters() {
  if ((getPdf()?.numPages || 0) <= MAX_PAGES) return [];
  let list = null;
  try {
    const g = await import("./guide.js");
    if (typeof g.getChapters === "function") list = (await g.getChapters()) || [];
  } catch {}
  if (list === null) {
    try { list = (await getJSON("/api/guide/chapters?file=" + encodeURIComponent(bookKey()))).chapters || []; } catch { list = []; }
  }
  return list.filter((c) => Number.isInteger(c.from) && Number.isInteger(c.to) && c.from <= c.to).sort((a, b) => a.from - b.from);
}

async function refreshScopeList() {
  try { S.scopes = (await getJSON("/api/mindmap?file=" + encodeURIComponent(bookKey()))).scopes || []; } catch { S.scopes = []; }
}

function chapterScope(ch) {
  const full = ch.to - ch.from + 1;
  const to = full > MAX_PAGES ? ch.from + MAX_PAGES - 1 : ch.to;
  return { id: "ch-" + ch.from, kind: "chapter", title: ch.title, no: ch.no ?? null, pages: [ch.from, to], ...(full > MAX_PAGES ? { clipped: true, fullPages: full } : {}) };
}

function pickChapter(ch) {
  S.picked = "ch-" + ch.from;
  S.scope = chapterScope(ch);
  loadScope();
}

async function reload() {
  const book = currentBook();
  resetBookState();
  if (!book) { S.state = "no-book"; renderAll(); return; }
  S.book = { key: book.key, title: book.title, numPages: getPdf()?.numPages || 0 };
  S.state = "loading";
  renderAll();
  const chapters = await fetchChapters();
  if (S.book?.key !== book.key) return;
  S.chapters = chapters;
  const cur = getCurrentPage();
  if (S.chapters.length) {
    S.kind = "book";
    const ch = S.chapters.find((c) => "ch-" + c.from === S.picked) || S.chapters.find((c) => cur >= c.from && cur <= c.to);
    if (ch) S.scope = chapterScope(ch);
    else { S.scope = null; S.state = "no-scope"; renderAll(); openChapters(S.ui.scopeBtn); return; }
  } else if (S.book.numPages <= MAX_PAGES) {
    S.kind = "paper";
    S.scope = { id: "all", kind: "whole", title: S.book.title, pages: [1, S.book.numPages] };
  } else {
    S.kind = "long";
    S.scope = null;
    S.state = "empty-toc";
    S.tocInfo = { reasons: ["没有章节表"], long: true };
    renderAll();
    return;
  }
  await loadScope();
}

function resetBookState() {
  flushBeforeLeave();
  clearTimeout(S.saveT);
  S.saveT = 0;
  try { S.gen?.abort?.abort(); } catch {}
  S.gen = null; S.model = null; S.rev = 0; S.scope = null; S.sel = null; S.conflict = null; S.saveState = "saved"; S.unsaved = false;
  S.trace = new Map(); S.stuck = new Set(); S.here = null; S.toast = null; S.sheet = null; S.menu = null; S.skelInfo = null; S.deeper = [];
  S.undoN = S.redoN = 0; S.tocInfo = null; S.needsDraw = false; S.known = null; S.picked = S.picked && S.book ? S.picked : null;
  if (S.inst) { try { S.inst.destroy?.(); } catch {} S.inst = null; S.host?.replaceChildren(); }
  badge();
}

async function loadScope({ discard = false } = {}) {
  const sc = S.scope;
  if (!discard) flushBeforeLeave();
  clearTimeout(S.saveT);
  try { S.gen?.abort?.abort(); } catch {}
  S.model = null; S.rev = 0; S.skelInfo = null; S.sel = null; S.gen = null; S.conflict = null; S.hasPrev = false; S.deeper = []; S.tocInfo = null;
  S.trace = new Map(); S.stuck = new Set(); S.here = null; S.saveState = "saved"; S.unsaved = false; S.known = null;
  if (S.inst) { try { S.inst.destroy?.(); } catch {} S.inst = null; S.host.replaceChildren(); }
  badge();
  S.state = "loading";
  renderAll();
  let r = {};
  try { r = await getJSON(`/api/mindmap?file=${encodeURIComponent(bookKey())}&scope=${encodeURIComponent(sc.id)}`); } catch {}
  if (S.scope !== sc) return; // 等的时候你换了章
  S.scopes = r.scopes || S.scopes;
  S.hasPrev = !!r.hasPrev;
  if (r.map) {
    S.model = r.map;
    S.rev = r.map.rev || 0;
    S.scope = { ...sc, ...(r.map.scope.pages ? { pages: r.map.scope.pages } : {}) };
    S.state = "ready";
  } else {
    await prepareSkeleton();
    if (S.scope !== sc && S.state !== "ready") return;
  }
  await loadHighlights();
  if (S.state === "ready") {
    // 暂存的生成结果（页面关着时跑完的分支）先并入
    if (r.results && Object.keys(r.results).length) await enqueue(() => mergeStoredResults(r.results));
    renderAll();
    draw({ select: null });
    updateHere();
    await updateTrace();
    await loadStuck();
    if (r.job?.state === "running") attachJob(r.job); else gotoHere();
  } else renderAll();
}

async function loadHighlights() {
  try {
    const r = await getJSON("/api/book?file=" + encodeURIComponent(bookKey()));
    S.hls = (r.highlights || []).filter((h) => h.page && h.text);
  } catch { S.hls = []; }
}

// 取骨架：书签 → 版式 → 都没有。扫描页要先识别文字才能认标题，由用户点按钮再做
async function prepareSkeleton() {
  const sc = S.scope;
  const pdf = getPdf();
  const flat = flatOutline(await getOutline());
  const j = judgeOutline(flat, pdf.numPages);
  let nodes = [], deeper = [], source = "", pages = sc.pages.slice();
  if (j.usable) {
    if (S.kind === "book") {
      const r = skeletonFromRange(flat, sc.pages[0], sc.pages[1]);
      if (r && (r.nodes.length >= 2 || r.nodes[0]?.children.length >= 2)) { nodes = r.nodes; deeper = r.deeper; source = "outline"; }
    } else {
      const refs = flat.find((x) => x.depth === 0 && SKIP_TITLE.test(x.title) && x.page != null);
      const r = skeletonFromOutline(flat, [1, pdf.numPages]);
      if (r.nodes.length >= 2 || r.nodes[0]?.children.length >= 2) {
        nodes = r.nodes; deeper = r.deeper; source = "outline";
        pages = [r.nodes[0].page, refs && refs.page > r.nodes[0].page ? refs.page - 1 : pdf.numPages];
        if (pages[1] - pages[0] + 1 > MAX_PAGES) pages[1] = pages[0] + MAX_PAGES - 1;
      }
    }
  }
  let sub = nodes.reduce((s, n) => s + n.children.length, 0);
  if (!nodes.length) {
    // 扫描页：前几页都没有文字层，要先识别
    let textual = false;
    for (let n = pages[0]; n <= Math.min(pages[1], pages[0] + 4); n++) {
      try { if ((await (await pdf.getPage(n)).getTextContent()).items.some((i) => i.str.trim())) { textual = true; break; } } catch {}
    }
    if (!textual) for (let n = pages[0]; n <= pages[1]; n++) if (isScanned(n)) { textual = true; break; } // 识别过的页有文字了
    if (!textual) {
      S.state = "need-ocr";
      S.tocInfo = { reasons: j.reasons, examples: j.examples, count: j.count };
      return;
    }
    const lines = [];
    for (let n = pages[0]; n <= pages[1]; n++) lines.push(...(await pageLinesOf(n, pdf)));
    if (getPdf() !== pdf || S.scope !== sc) return; // 取页文字的时候换了书或换了章
    nodes = numberedSkeleton(lines);
    deeper = nodes.deeper || [];
    if (nodes.length < 2) nodes = styledSkeleton(lines);
    if (nodes.length >= 2) {
      source = "layout";
      const refPage = lines.find((l) => l.page > nodes[0].page && /^(参考文献|references)$/i.test(l.text.replace(/\s/g, "")))?.page;
      if (S.kind === "paper") pages = [1, Math.min(refPage ?? pdf.numPages, MAX_PAGES)];
      sub = nodes.reduce((s, n) => s + n.children.length, 0);
    } else nodes = [];
  }
  S.skelInfo = { count: j.count, sub };
  if (!nodes.length) {
    S.state = "empty-toc";
    S.tocInfo = { reasons: j.reasons, examples: j.examples, count: j.count, long: false };
    return;
  }
  await locateTitles(nodes);
  if (getPdf() !== pdf || S.scope !== sc) return; // 等的时候换了书或换了章：别把旧书的骨架写进新书的状态
  S.scope = { ...sc, pages };
  S.model = buildModel({ nodes, source, deeper, pages, note: source === "outline" ? `书签 ${j.count} 条` : "没有书签；按版式识别" });
  S.state = "ready";
  S.unsaved = true;
}

// 标题在页文字里的位置，用来给节点排兄弟顺序、算「读到哪」
async function locateTitles(nodes) {
  for (const n of nodes) {
    try { n.off = Math.max(0, norm(await extractText(n.page)).indexOf(norm(n.title))); } catch { n.off = 0; }
    await locateTitles(n.children);
  }
}

const cleanRoot = (t) => String(t || "").replace(/^chapter\s*\d+\s*[:：.]?\s*/i, "").trim();
function buildModel({ nodes, source, deeper, pages, note }) {
  const toDoc = (n) => ({ id: n.id, topic: n.title, src: "doc", page: n.page, off: n.off || 0, quote: n.title, open: true, children: n.children.map(toDoc) });
  const rootTitle = S.scope.kind === "chapter" ? cleanRoot(S.scope.title) : S.book.title;
  S.deeper = deeper || [];
  return {
    schema: 1, file: bookKey(), scope: { id: S.scope.id, kind: S.scope.kind, title: S.scope.title, pages, ...(S.scope.no != null ? { no: S.scope.no } : {}) },
    skeleton: { source, note }, rev: 0, gen: { state: "none", branches: {} }, tombstones: [],
    root: { id: "root", topic: rootTitle, src: "doc", page: pages[0], quote: "", children: nodes.map(toDoc) },
  };
}

// ─────────────────────────── 没有目录、需要识别 ───────────────────────────
function renderEmpty() {
  const e = S.ui.empty;
  e.replaceChildren();
  const t = S.tocInfo || {};
  const btn = (text, fn, cls = "") => el("button", { className: "mm-btn " + cls, type: "button", textContent: text, onclick: fn });
  if (S.state === "need-ocr") {
    const n = S.scope.pages[1] - S.scope.pages[0] + 1;
    e.append(el("h3", { textContent: "先识别这一章的文字" }),
      el("p", { textContent: `这一章是扫描页，要先识别文字才能认出标题。共 ${n} 页，约 ${Math.ceil(n * 1.3)} 秒；识别过的页以后不用再等。` }),
      el("div", { className: "btns", style: "display:flex;gap:8px;margin-top:14px" }, btn("识别并出图", ocrThenSkeleton, "solid")));
    return;
  }
  const long = !!t.long;
  const cur = getCurrentPage();
  const a = S.scope ? S.scope.pages[0] : cur, b = S.scope ? S.scope.pages[1] : Math.min(S.book.numPages, cur + 19);
  e.append(el("h3", { textContent: long ? "这本书还没有章节表" : "这份文件没有可用的目录" }),
    el("p", { textContent: "没有章节标题，导图就没有可靠的骨架。下面的路任选一条。" }));
  const why = el("ul", { className: "why" });
  if (long) why.append(el("li", {}, el("span", { textContent: "章节表" }), el("span", { textContent: `这本书有 ${S.book.numPages} 页，一次最多出 ${MAX_PAGES} 页，需要先按章分开` })));
  else {
    if (t.count) why.append(el("li", {}, el("span", { textContent: "书签" }), el("span", { textContent: `${t.count} 条${(t.reasons || []).some((r) => r.includes("每页")) ? "，每页一条" : ""}${t.examples?.length ? `（${t.examples.join("、")}……）` : ""}，不是章节` })));
    else why.append(el("li", {}, el("span", { textContent: "书签" }), el("span", { textContent: "没有" })));
    why.append(el("li", {}, el("span", { textContent: "文字层" }), el("span", { textContent: "没有认出编号标题或章节名" })));
  }
  e.append(why);
  let from, to;
  if (long) {
    const mk = (v) => el("input", { value: String(v), inputMode: "numeric" });
    from = mk(a); to = mk(b);
  }
  if (long) {
    e.append(el("div", { className: "mm-opt" }, el("h4", { textContent: "先建章节表" }),
      el("p", { textContent: "在导读里从目录页建，约 40 秒，只做一次。建好以后回到这里，按章出图。" }),
      el("div", { className: "btns" }, btn("去导读建章节表", () => showView("guide"), "solid"))));
  }
  const rangeOf = () => {
    if (!from) return null;
    const x = Math.max(1, Math.min(S.book.numPages, parseInt(from.value) || 1)), y = Math.max(x, Math.min(S.book.numPages, parseInt(to.value) || x));
    return [x, Math.min(y, x + MAX_PAGES - 1)];
  };
  const rangeRow = long ? el("div", { className: "range" }, "第", from, "到", to, "页", el("span", { className: "eta", textContent: `一次最多 ${MAX_PAGES} 页` })) : null;
  e.append(el("div", { className: "mm-opt" }, el("h4", { textContent: "自己搭骨架" }),
    el("p", { textContent: "从一个空导图开始：加一级节点，挂上页码，再让 Claude 往里填要点。" }),
    ...(rangeRow ? [rangeRow] : []),
    el("div", { className: "btns" }, btn("新建空导图", () => startManual(rangeOf())))));
  e.append(el("div", { className: "mm-opt" }, el("h4", { textContent: "让 Claude 按内容提议一级分支" }),
    el("p", { textContent: "只看你指定的页。先识别这些页的文字，再提议分支；提议的分支每个都要对得上页码，你可以随意改。" }),
    long ? el("div", { className: "range" }, "范围同上", el("span", { className: "eta", textContent: "约 1 分钟" })) : el("div", { className: "range" }, `第 ${a} 到 ${b} 页`, el("span", { className: "eta", textContent: "约 1 分钟" })),
    el("div", { className: "btns" }, btn("开始提议", () => startPropose(rangeOf())))));
}

async function ocrThenSkeleton() {
  const sc = S.scope;
  const total = sc.pages[1] - sc.pages[0] + 1;
  S.state = "loading";
  S.gen = { collect: { status: `正在识别第 ${sc.pages[0]}–${sc.pages[1]} 页的文字（0 / ${total}）…` }, branches: {} };
  renderAll();
  const lines = [], pdf = getPdf();
  for (let n = sc.pages[0]; n <= sc.pages[1]; n++) {
    lines.push(...(await pageLinesOf(n, pdf)));
    if (S.scope !== sc || getPdf() !== pdf) return;
    S.gen.collect.status = `正在识别第 ${sc.pages[0]}–${sc.pages[1]} 页的文字（${n - sc.pages[0] + 1} / ${total}）…`;
    renderStatus();
  }
  S.gen = null;
  const nodes = numberedSkeleton(lines);
  if (nodes.length < 2) {
    S.state = "empty-toc";
    S.tocInfo = { reasons: ["没有认出编号标题"], long: false };
    renderAll();
    return;
  }
  await locateTitles(nodes);
  S.model = buildModel({ nodes, source: "layout", deeper: nodes.deeper || [], pages: sc.pages, note: "没有书签；按编号标题识别（扫描页已识别）" });
  S.skelInfo = { sub: nodes.reduce((s, n) => s + n.children.length, 0) };
  S.state = "ready";
  S.unsaved = true;
  await save();
  renderAll();
  draw({ select: null });
  updateHere();
}

function startManual(range) {
  if (range) S.scope = { id: `r-${range[0]}-${range[1]}`, kind: "range", title: S.book.title, pages: range };
  S.model = buildModel({ nodes: [], source: "manual", deeper: [], pages: S.scope.pages, note: "自己搭的骨架" });
  S.model.gen.state = "manual";
  S.state = "ready";
  S.unsaved = true;
  save();
  renderAll();
  draw({ select: null });
  frame(null, { slide: false });
}

async function startPropose(range) {
  if (range) S.scope = { id: `r-${range[0]}-${range[1]}`, kind: "range", title: S.book.title, pages: range };
  if (!S.model) {
    S.model = buildModel({ nodes: [], source: "propose", deeper: [], pages: S.scope.pages, note: "由 Claude 按内容提议" });
    S.state = "ready";
    S.unsaved = true;
    renderAll();
    draw({ select: null });
  }
  await generate({ propose: true });
}

// ─────────────────────────── 生成 ───────────────────────────
// 标题在这一页文字里的位置（原文下标）：整行就是标题（或标题的头几个字）的那一行的行首。
// 服务端按它把相邻两节的页窗口切开：本节之前的字属于上一节，下一节标题之后的字属于下一节
function rawOffsetOfTitle(text, title) {
  const nt = norm(title);
  if (nt.length < 2) return null;
  let pos = 0;
  for (const line of String(text).split("\n")) {
    const nl = norm(line);
    if (nl && ((nl.startsWith(nt) && nl.length <= nt.length + 15) || (nt.startsWith(nl) && nl.length >= 6))) return pos;
    pos += line.length + 1;
  }
  return null;
}

function skeletonForServer(pages = []) {
  const texts = new Map(pages);
  const orig = (n) => (n.term && n.src === "doc" ? n.term : n.topic);
  const f = (n, top) => {
    const title = orig(n);
    return { id: n.id, title, page: n.page, ...(top && texts.has(n.page) ? { raw: rawOffsetOfTitle(texts.get(n.page), title) } : {}), children: (n.children || []).filter((x) => x.src === "doc").sort(cmpPos).map((c) => f(c, false)) };
  };
  // 按原文先后（页码，同一页再按标题在页内的位置）发，和画布上兄弟的先后无关：页窗口是「到下一节的起点为止」
  return branchNodes().sort(cmpPos).map((n) => f(n, true));
}

async function collectPages(pages, g) {
  const out = [];
  const total = pages[1] - pages[0] + 1;
  for (let n = pages[0]; n <= pages[1]; n++) {
    g.collect.status = `正在取第 ${pages[0]}–${pages[1]} 页的文字（${n - pages[0] + 1} / ${total}）…`;
    renderStatus();
    out.push([n, await extractText(n)]);
    if (g.cancelled) return null;
  }
  if (out.every(([, t]) => !t.trim())) throw new Error("这几页取不到文字");
  return out;
}

async function generate({ only = null, propose = false, label = "" } = {}) {
  if (!S.model || S.gen?.running || S.gen?.collect) return;
  if (only) { // 「继续」「重试」带的分支 id 里，停下之后被删掉的不再跑，也不再记成 pending
    const have = new Set(branchNodes().map((b) => b.id));
    only = only.filter((id) => have.has(id));
    if (!only.length) return;
  }
  const sc = S.scope, regen = S.regen;
  S.regen = null;
  const ctl = new AbortController();
  const g = (S.gen = { abort: ctl, branches: {}, running: false, collect: { status: "正在取文字…" }, only, cancelled: false, label, propose });
  bgAdd(bookKey(), sc.id);
  renderChrome();
  let pages;
  try {
    pages = await collectPages(sc.pages, g);
    if (!pages) return;
  } catch {
    if (S.gen === g) { S.gen = { error: `第 ${sc.pages[0]}–${sc.pages[1]} 页取不到文字`, only }; bgDrop(bookKey(), sc.id); renderChrome(); }
    return;
  }
  if (S.gen !== g) return;
  syncFromME();
  S.model.gen ||= { state: "none", branches: {} };
  // 要跑的支先记成 pending 并存盘：停止、中断、刷新之后，靠它知道哪几支还空着、给「继续」
  for (const id of only || (propose ? [] : branchNodes().map((b) => b.id))) S.model.gen.branches[id] = { state: "pending" };
  collapseToHere();
  if (!(await saveConfirmed({ keepPrev: !!regen?.keepPrev }))) {
    // 版本落后（别处改过了）或服务没回应：先不生成，跑完的结果存不进这张导图就白跑了
    if (S.gen === g) { S.gen = null; bgDrop(bookKey(), sc.id); renderChrome(); }
    tell(S.conflict ? "导图在别处改过了，先载入最新再生成。" : "导图没存上，先不生成。");
    return;
  }
  // 存盘那几十毫秒里点了「停止」（或换了书、换了章）：不再发生成请求，否则后台照样跑完、下次打开时被并进来
  if (S.gen !== g || g.cancelled) return;
  const body ={ file: bookKey(), title: S.book.title, scope: { id: sc.id, pages: sc.pages }, nodes: propose ? [] : skeletonForServer(pages), deeper: S.deeper || [], pages, only: only || [], propose };
  g.collect = null;
  g.running = true;
  renderChrome();
  await runStream(body, g);
}

async function attachJob(info) {
  if (S.gen?.running) return;
  // 服务端任务里每一支现在的状态先带过来：已经跑完的不再显示成「等待」
  const g = (S.gen = { abort: new AbortController(), branches: { ...(info?.branches || {}) }, running: true, collect: null, cancelled: false });
  bgAdd(bookKey(), scopeId());
  renderChrome();
  await runStream({ file: bookKey(), scope: { id: scopeId() }, attach: true }, g);
}

const enqueue = (fn) => (S.queue = S.queue.then(fn, fn));

async function runStream(body, g) {
  const key = bookKey() + "|" + scopeId();
  try {
    const res = await fetch("/api/mindmap/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: g.abort.signal });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (res.status === 404 && body.attach) { if (S.gen === g) { S.gen = null; bgDrop(bookKey(), scopeId()); renderChrome(); } return; }
      throw new Error(d.error || "服务出错 " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          let ev;
          try { ev = JSON.parse(line); } catch { throw Object.assign(new Error("生成结果读不出来"), { bad: true }); }
          await enqueue(() => onGenEvent(ev, g, key));
        }
      }
    }
  } catch (err) {
    if (g.abort.signal.aborted) return;
    if (S.gen !== g) return;
    const why = err.bad ? err.message : /fetch|network|Failed|terminated|reset|closed/i.test(String(err.message)) ? "和服务的连接断了" : "";
    // 已经开跑（有分支表）：跑完的留着，没跑完的给「继续」；还没开跑：整个重试
    if (Object.keys(g.branches).length && g.running) await enqueue(() => haltGen(g, why || "生成出错了"));
    else { S.gen = { error: why || (err.message || "Claude 没有回应"), only: body.only }; bgDrop(bookKey(), scopeId()); renderChrome(); }
    return;
  }
  // 流结束了却没收到 done / cancelled / error：服务断了，或连接被切断。不能当成生成完了
  if (S.gen === g && g.running && !g.ended) await enqueue(() => haltGen(g, "生成中断了"));
}

async function onGenEvent(ev, g, key) {
  if (S.gen !== g || key !== bookKey() + "|" + scopeId()) return;
  if (ev.type === "start") {
    let added = false;
    for (const id of ev.branches) { g.branches[id] ??= "pending"; if (!S.model.gen.branches[id]) { S.model.gen.branches[id] = { state: "pending" }; added = true; } }
    g.total = ev.total;
    if (added) scheduleSave(0); // 提议分支这条路：分支是这时才有的
    draw(); renderChrome();
    return;
  }
  if (ev.type === "skeleton") {
    syncFromME();
    S.model.root.children = ev.nodes.map((n) => ({ id: n.id, topic: n.topic, src: "claude", skel: true, page: n.page, off: n.off, end: n.end, quote: n.quote, seg: n.seg, open: true, children: [] }));
    S.model.skeleton = { source: "propose", note: "由 Claude 按内容提议" };
    draw({ select: null });
    scheduleSave(0);
    return;
  }
  if (ev.type === "branch") {
    if (ev.state === "start") {
      // 刷新后接上任务时，服务端会补发已经写完那几支的 start：它们在 attachJob 里已经是 done / failed，别改回「正在读」
      if (g.branches[ev.id] !== "done" && g.branches[ev.id] !== "failed") g.branches[ev.id] = "running";
      draw(); renderChrome(); return;
    }
    await whenIdle();
    applyBranch(ev);
    g.branches[ev.id] = ev.state;
    g.doneN = Object.values(g.branches).filter((s) => s === "done" || s === "failed").length;
    // 历史栈里是生成前的整棵树；留着的话 ⌘Z 会把其它分支新生成的内容一并回滚。回到生成前走提示条里的「撤销」
    draw({ clearHistory: true });
    // 存上了才确认：确认之后服务端就把这一支的暂存结果删了，存不上（别处改过了）时它是这次生成唯一的底
    if (await saveConfirmed()) postJSON("/api/mindmap/ack", { file: bookKey(), scope: scopeId(), ids: [ev.id] });
    renderChrome();
    return;
  }
  if (ev.type === "done") { g.ended = true; g.running = false; await finishGen(g); return; }
  if (ev.type === "cancelled") { g.ended = true; haltGen(g); return; }
  if (ev.type === "error") {
    g.ended = true;
    if (Object.keys(g.branches).length) haltGen(g, ev.message || "生成出错了"); // 已经开跑：跑完的留着，没跑完的给「继续」
    else { S.gen = { error: ev.message || "Claude 没有回应", only: null }; bgDrop(bookKey(), scopeId()); renderChrome(); }
  }
}

// 生成停下来了（你点了停止、流中途断了、服务报错）：没跑完的支在导图里还是 pending，状态行给「继续」
function haltGen(g, why = "") {
  if (S.gen !== g) return; // 排队等的时候已经换了书、换了章
  g.running = false; g.stopped = true; g.interrupted = why;
  g.doneN = Object.values(g.branches).filter((s) => s === "done" || s === "failed").length;
  g.total = Object.keys(g.branches).length;
  g.rest = Object.entries(g.branches).filter(([, s]) => s === "pending" || s === "running").map(([id]) => id);
  bgDrop(bookKey(), scopeId()); draw(); renderChrome();
}

async function finishGen(g) {
  if (S.gen !== g) return;
  const failed = Object.values(g.branches).filter((s) => s === "failed").length;
  S.model.gen.state = failed ? "partial" : "done";
  S.gen = null;
  collapseToHere();
  const saved = await saveConfirmed();
  bgDrop(bookKey(), scopeId(), true);
  renderChrome();
  updateTrace();
  loadStuck();
  if (g.label && saved) {
    const n = Object.keys(g.branches).length;
    if (failed && failed >= n) tell(`${failed} 节没生成好，原来的内容没动。`);
    else tell(failed ? `已重新生成「${g.label}」，有 ${failed} 节没生成好` : `已重新生成「${g.label}」`, { action: restorePrev, ms: 15000 });
  }
}

// 你正在改名时先不动图
async function whenIdle() {
  for (let i = 0; i < 100 && S.inst?.container.querySelector("#input-box"); i++) await sleep(200);
}

async function stopGenerate() {
  const g = S.gen;
  if (!g) return;
  if (g.collect) { g.cancelled = true; S.gen = null; bgDrop(bookKey(), scopeId()); renderChrome(); return; }
  await postJSON("/api/mindmap/cancel", { file: bookKey(), scope: scopeId() });
}

// ─────────────────────────── 合并生成结果（锁定模型） ───────────────────────────
function pointNode(p) {
  // id 由服务端发：存盘时服务端只认自己发出去的 id 才是「Claude 写的」
  const n = { id: p.id || newId(), topic: p.topic, src: "claude", page: p.page, off: p.off, end: p.end, quote: p.quote, seg: p.seg };
  if (p.term) n.term = p.term;
  n.children = (p.children || []).map(pointNode);
  if (n.children.length) n.open = false; // 三级默认折叠：窄栏里同时只看相邻两三列
  return n;
}

async function mergeStoredResults(results) {
  const ids = [];
  syncFromME();
  for (const [id, r] of Object.entries(results)) {
    if (r.state === "done" || r.state === "failed") { applyBranch({ ...r, id }); ids.push(id); }
  }
  if (ids.length) {
    S.model.gen.state = Object.values(S.model.gen.branches).some((b) => b.state === "failed") ? "partial" : "done";
    if (await saveConfirmed()) await postJSON("/api/mindmap/ack", { file: bookKey(), scope: scopeId(), ids });
  }
}

// 你动过的（你写的、改过名的、拖过位置的，以及里面有这类节点的）原地保留；你没动过的 Claude 要点换成新的；
// 你删掉的（墓碑）新结果里碰到同样的跳过；文档目录里的节点不会变
function applyBranch(ev) {
  syncFromME();
  const X = findNode(S.model.root, ev.id);
  if (!X) return;
  S.model.gen ||= { state: "none", branches: {} };
  if (ev.state === "failed") { S.model.gen.branches[ev.id] = { state: "failed", reason: ev.reason || "" }; return; }
  S.model.gen.branches[ev.id] = { state: "done" };
  // 骨架节点的中文节名：文档目录节点没被你改过、原标题不是中文时，原标题挪进 term
  const titles = ev.titles || {};
  eachNode(X, (n) => {
    const zh = titles[n.id];
    if (zh && n.src === "doc" && !n.edited && !CJK.test(n.topic) && !n.term) { n.term = n.topic; n.topic = zh; }
  });
  const byUnder = new Map();
  for (const p of ev.points || []) {
    if (!byUnder.has(p.under)) byUnder.set(p.under, []);
    byUnder.get(p.under).push(p);
  }
  const tomb = S.model.tombstones || [];
  // 别的分支里已经有的要点不再收：窗口按页切、两支看到同一段文字时会各自写出同一个要点（页和引句位置相同，或页和节名相同，或引句整句相同）
  const mine = new Set();
  eachNode(X, (n) => mine.add(n.id));
  const elsewhere = [];
  eachNode(S.model.root, (n) => { if (!mine.has(n.id) && n.src === "claude" && !n.skel && n.page != null) elsewhere.push(n); });
  const sameSpot = (a, b) => a.page != null && a.page === b.page && ((a.off != null && a.off === b.off) || norm(a.topic) === norm(b.topic));
  eachNode(X, (U) => {
    if (U.src !== "doc" && !U.skel) return;
    const keep = U.children.filter((c) => c.src === "doc" || c.skel || isLocked(c) || hasLockedDesc(c));
    // 新要点连同它自己带的子要点一起过：你删过的、别的分支已有的、和你留下的重复的，都不收
    const clean = (list) => list.filter((p) => !isTombstoned(tomb, U.id, p) && !elsewhere.some((e) => sameSpot(e, p) || ((e.seg || e.quote) && (e.seg || e.quote) === (p.seg || p.quote))) && !keep.some((c) => c.src !== "doc" && !c.skel && sameSpot(c, p)))
      .map((p) => ({ ...p, children: clean(p.children || []) }));
    const fresh = clean((byUnder.get(U.id) || []).map(pointNode));
    U.children = [...[...keep.filter((c) => c.page), ...fresh].sort(cmpPos), ...keep.filter((c) => !c.page)];
  });
}

// 重新生成：有改动先说清会动哪些
function regenerate(branchId) {
  syncFromME();
  const branches = branchNodes().filter((c) => !branchId || c.id === branchId);
  let replace = 0, added = 0, renamed = 0, moved = 0;
  const ids = new Set();
  for (const b of branches) {
    eachNode(b, (n) => {
      ids.add(n.id);
      if (n === b || n.src === "doc" || n.skel) return;
      if (n.src === "user") added++;
      else if (n.edited) renamed++;
      else if (n.moved) moved++;
      else if (!hasLockedDesc(n)) replace++;
    });
  }
  const deleted = (S.model.tombstones || []).filter((t) => ids.has(t.parent)).length;
  const name = branchId ? branches[0]?.topic : "整张导图";
  const go = () => { S.regen = { keepPrev: true }; generate({ only: branches.map((b) => b.id), label: name }); };
  if (!added && !renamed && !moved && !deleted) return go();
  const keep = [added && `你加的 ${added} 个`, renamed && `改过名的 ${renamed} 个`, moved && `拖过位置的 ${moved} 个`].filter(Boolean).join("、");
  const rows = [["替换", `Claude 写的 ${replace} 个要点（你没动过的）`]];
  if (keep) rows.push(["保留", `${keep}，原地不动`]);
  if (deleted) rows.push(["不再出现", `你删掉的 ${deleted} 个，新结果里碰到同样的也会跳过`, "del"]);
  sheet(branchId ? `重新生成「${name}」这一支` : "重新生成整张导图", rows, "文档目录里的节点不会变。完成后可以撤销，回到现在的样子。", "重新生成", go);
}

async function restorePrev() {
  const r = await postJSON("/api/mindmap/restore", { file: bookKey(), scope: scopeId() });
  if (!r.ok) return tell("没有可恢复的快照");
  S.model = r.data.map;
  S.rev = r.data.map.rev;
  S.hasPrev = false;
  S.sel = null;
  draw({ select: null, clearHistory: true });
  renderChrome();
  tell("已恢复到重新生成之前");
}

async function reloadFromConflict() {
  // 不直接用冲突里带回来的那份：整个重新取一遍，服务端暂存的生成结果也一并并进来
  S.conflict = null;
  S.unsaved = false;
  await loadScope({ discard: true });
}

// ─────────────────────────── 总渲染、视图生命周期 ───────────────────────────
function renderAll() {
  const u = S.ui;
  const canvasOn = S.state === "ready";
  u.canvas.hidden = !canvasOn;
  u.empty.hidden = canvasOn;
  if (!canvasOn) {
    if (S.state === "empty-toc" || S.state === "need-ocr") renderEmpty();
    else u.empty.replaceChildren(el("div", { className: "mm-blank", textContent: S.state === "no-book" ? "打开一本书之后，这里会出现它的导图。" : S.state === "no-scope" ? "这本书按章出图。从上面选一章。" : "" }));
  }
  renderChrome();
  if (canvasOn && S.needsDraw) draw();
}

async function onShow() {
  const book = currentBook();
  badge();
  if (!book || S.book?.key !== book.key || S.state === "idle" || S.state === "no-book") { await reload(); return; }
  // 导读那边可能刚建好章节表：每次回到这个视图都取一次，变了就重新定范围
  const ch = await fetchChapters();
  if (JSON.stringify(ch.map((c) => [c.from, c.to])) !== JSON.stringify(S.chapters.map((c) => [c.from, c.to])) && !S.gen) { await reload(); return; }
  if (S.state === "ready") {
    renderAll();
    if (S.needsDraw || !S.inst) draw({ select: null });
    await loadHighlights();
    updateHere();
    updateTrace();
    loadStuck();
    if (!S.gen) {
      try {
        const r = await getJSON(`/api/mindmap?file=${encodeURIComponent(bookKey())}&scope=${encodeURIComponent(scopeId())}`);
        if (r.job?.state === "running") attachJob(r.job);
        else if (r.results && Object.keys(r.results).length) { await enqueue(() => mergeStoredResults(r.results)); draw({ clearHistory: true }); }
      } catch {}
    }
    gotoHere();
  } else renderAll();
}
function onHide() { closeOverlays(); }

const root = registerView("map", { label: "导图", order: 20, composer: false, onShow, onHide });
buildUI(root);
renderAll();
registerAction({ name: "导图", desc: "这一章 / 这篇的思维导图", run: () => showView("map") });

window.addEventListener("book-opened", () => { S.state = "idle"; S.book = null; S.picked = null; resetBookState(); if (visible()) reload(); else renderAll(); });
let hereT = 0;
window.addEventListener("page-changed", () => {
  if (!visible()) return;
  clearTimeout(hereT);
  hereT = setTimeout(() => {
    updateHere();
    // 读到别的章了：状态行右侧提示切章，点了才切
    if (S.kind === "book" && S.scope && S.model) {
      const p = getCurrentPage();
      const ch = S.chapters.find((c) => p >= c.from && p <= c.to);
      if (ch && "ch-" + ch.from !== S.scope.id && !S.gen) S.ui.subR.replaceChildren(el("button", { type: "button", textContent: `你读到第 ${ch.no ?? "·"} 章了 · 切过去`, onclick: () => pickChapter(ch) }));
    }
  }, 500);
});
window.addEventListener("highlight", (e) => {
  const h = e.detail;
  if (h?.page && h.text) { S.hls.push({ page: h.page, text: h.text }); if (visible() && S.model) updateTrace(); }
});
window.addEventListener("highlight-removed", (e) => {
  const h = e.detail;
  S.hls = S.hls.filter((x) => !(x.page === h?.page && x.text === h?.text));
  if (visible() && S.model) updateTrace();
});
// 页面要走了（刷新、关掉、跳走）：还没存的改动马上补存。刷新时 sendBeacon 的请求发不出去（实测），
// fetch 加 keepalive 在页面卸载后也会发完；带着 rev，被别处改过会被服务端拒绝，不会覆盖
function flushOnLeave() {
  if (!S.model || S.conflict || !S.unsaved) return;
  try {
    clearTimeout(S.saveT);
    S.saveT = 0;
    syncFromME();
    tidyModel(S.model);
    const body = JSON.stringify({ file: bookKey(), scope: scopeId(), rev: S.rev, map: S.model });
    // keepalive 请求体上限 64KB；导图比这大时只能退回普通保存，尽力而为
    if (body.length > 60000) { save(); return; }
    fetch("/api/mindmap/save", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  } catch {}
}
window.addEventListener("pagehide", flushOnLeave);
// 切到别的标签页、最小化：页面还在，就地存一次，不等下一次编辑
document.addEventListener("visibilitychange", () => { if (document.hidden && S.model && !S.conflict && S.unsaved) { clearTimeout(S.saveT); S.saveT = 0; save(); } });
window.__mindmap = S; // 调试和脚本验证用
void isScanned;
