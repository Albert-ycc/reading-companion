// 参考文献角标弹窗：点正文里的引用角标（上标 1,2 / ［3］ / [7–9]），在旁边直接出题录，不用翻到文末。
// 只用文字规则解析，不调 Claude。书里找不到参考文献区就什么都不做。
import { currentBook, getPdf, pageDiv, isScanned, revealPassage } from "./reader.js";
import { el } from "./ui.js";

// ===PURE-BEGIN=== 以下是纯函数，不碰 DOM，design/refs/tools/unit.mjs 把这一段切出来离线测

const norm = (s) => s.replace(/\s+/g, "").toLowerCase();
const HEADINGS = new Set(["references", "reference", "referenceslist", "bibliography", "literaturecited", "referencesandnotes", "参考文献", "文献", "参考资料", "主要参考文献"]);
// 标题行：整行就是「References」「参 考 文 献」「7. References」「VII. REFERENCES」，可带冒号
export function isRefHeading(line) {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  const k = norm(t.replace(/^(?:\d{1,2}|[ivx]{1,5})\s*[.、）)]\s*/i, "")).replace(/[:：]$/, "");
  return HEADINGS.has(k);
}

const DASH = "\\-–—‑‐‒−~～﹣";
const NUM = "\\d{1,4}";
const SEP = `[,，、;；${DASH}]`;
const OPEN = "[\\[［【]", CLOSE = "[\\]］】]";
const BRACKET_FULL = new RegExp(`^${OPEN}\\s*${NUM}(?:\\s*${SEP}\\s*${NUM})*\\s*${CLOSE}$`);
const BRACKET_ANY = new RegExp(`${OPEN}\\s*${NUM}(?:\\s*${SEP}\\s*${NUM})*\\s*${CLOSE}`, "g");
const CITE_CHARS = new RegExp(`^[\\s\\d,，、;；.${DASH}\\[\\]［］【】]+$`);

// 「[3,5]」「7–9」「［8‑9］」「1, 2」→ [3,5] / [7,8,9] / [8,9] / [1,2]；不是一串编号返回 null
export function parseNums(text) {
  let t = text.replace(/\s+/g, "");
  const m = t.match(/^([\[［【])?(.+?)([\]］】])?$/);
  if (!m || !!m[1] !== !!m[3]) return null;
  t = m[2];
  const out = new Set();
  for (const part of t.split(/[,，、;；]/)) {
    const r = part.match(new RegExp(`^(${NUM})(?:[${DASH}](${NUM}))?$`));
    if (!r) return null;
    const a = +r[1], b = r[2] ? +r[2] : a;
    if (a < 1 || b < a || b - a > 30) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out];
}

// 标题行之后一行行认编号条目。样式靠第一条（编号 1）定下来，之后只认同一种样式、编号只许往后走：
// 这样续行开头的「2005;20:」「1681-8.」「34 mg」不会被当成新条目
const LABELS = {
  bracket: (l) => l.match(/^[\[［【(（]\s*(\d{1,4})\s*[\]］】)）]\s*(.*)$/),
  dot: (l) => l.match(/^(\d{1,4})\s*[.．、](?!\d)\s*(.*)$/),
  paren: (l) => l.match(/^(\d{1,4})\)\s*(.*)$/),
  space: (l) => l.match(/^(\d{1,4})\s+([A-Z一-鿿].*)$/),
  // 老版《新英格兰》：编号是上标，排在条目第一行的行尾（「…Friend PJ. Liver1.」），后面几行是条目的其余部分
  trail: (l) => { const m = l.match(/^(.*?[A-Za-z,.\-)])(\d{1,3})\.$/); return m && [m[0], m[2], m[1]]; },
};
const STYLE_ORDER = ["bracket", "dot", "paren", "space", "trail"];
const STRICT = new Set(["space", "trail"]); // 这两种样式容易撞上续行，编号必须正好是下一个
const STOP = /^(figures?\s*\d*[.:]|fig\.\s*\d|tables?\s*\d+[.:]|appendix|appendices|supplement|附录|附表|附图|图\s*\d|表\s*\d|acknowledg|致谢)/i;
const JUNK = /©|copyright|downloaded from|all rights reserved|版权所有|本刊编辑部|读者·作者·编者/i;
const MIN_ENTRIES = 3;

// 反复出现在页首页尾的行（页眉页脚、页码）：同一行（数字当成同一个）在两页以上的头 2 行或尾 3 行出现
function runningLines(pages) {
  const seen = new Map();
  for (const p of pages) {
    const L = p.lines;
    const edge = [...new Set([...L.slice(0, 2), ...L.slice(-3)])];
    for (const l of edge) {
      const t = l.trim();
      if (!t || LABELS.bracket(t) || LABELS.dot(t)) continue;
      const k = t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  return (l) => (seen.get(l.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ")) || 0) >= 2;
}

// 条目的行拼成一句：英文行尾断字接回去，中文之间不留空格，DOI / 网址被换行拆开的接上
export function joinEntry(lines) {
  let s = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (!s) { s = l; continue; }
    if (/[A-Za-z]-$/.test(s) && /^[a-z]/.test(l)) s = s.slice(0, -1) + l;
    else if (/[㐀-鿿]$/.test(s) && /^[㐀-鿿]/.test(l)) s += l;
    else s += " " + l;
  }
  return mend(s.replace(/([㐀-鿿])\s+(?=[㐀-鿿])/g, "$1").replace(/\s{2,}/g, " ").trim());
}
// 被换行拆开的 DOI / 网址：「10.1016/j. healun. 2020.03.020」「https://www. site.org/a/ b.pdf」
function mend(s) {
  const toks = s.split(" ");
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    let acc = toks[i];
    if (/^(https?:\/\/|10\.\d{4,9}\/)/i.test(acc)) {
      while (i + 1 < toks.length && (acc.endsWith("/") || (/[.\-‑]$/.test(acc) && /^[a-z0-9/]/.test(toks[i + 1])))) acc += toks[++i];
    }
    out.push(acc);
  }
  return out.join(" ");
}

// pages: [{ n, lines }]，按页码连续。返回 [{ hp, lp, entries:[{ n, page, text, quote }], map, max }]
export function parseRefLists(pages) {
  const isRunning = runningLines(pages);
  const clean = pages.map((p) => ({ n: p.n, lines: p.lines.map((l) => l.trim()).filter((l) => l && !isRunning(l)) }));
  const lists = [];
  let skipTo = 0; // 已经解析过的列表占到哪一页
  for (let pi = 0; pi < clean.length; pi++) {
    const p = clean[pi];
    if (p.n <= skipTo) continue;
    for (let li = 0; li < p.lines.length; li++) {
      if (!isRefHeading(p.lines[li])) continue;
      const list = parseFrom(clean, pi, li + 1);
      if (list) { list.hp = p.n; list.head = p.lines[li]; lists.push(list); skipTo = list.lp; break; }
    }
  }
  return lists;
}

function parseFrom(pages, pi, li) {
  // 先定样式：标题后 12 行里找编号 1
  let style = null;
  const head = [];
  for (let p = pi, l = li; p < pages.length && head.length < 12; p++, l = 0) head.push(...pages[p].lines.slice(l, l + 12 - head.length));
  for (const s of STYLE_ORDER) {
    if (head.some((x) => { const m = LABELS[s](x); return m && +m[1] === 1; })) { style = s; break; }
  }
  if (!style) return null;
  const entries = [];
  let cur = null, next = 1, lp = pages[pi].n, stopped = false;
  const close = () => {
    if (!cur) return;
    const text = joinEntry(cur.lines);
    if (text.length >= 8) entries.push({ n: cur.n, page: cur.page, text, quote: cur.raw.join(" ").slice(0, 160) });
    cur = null;
  };
  for (let p = pi; p < pages.length && !stopped; p++) {
    const lines = p === pi ? pages[p].lines.slice(li) : pages[p].lines;
    const keepLines = cur ? cur.lines.length : 0, keepRaw = cur ? cur.raw.length : 0;
    let labels = 0;
    for (const l of lines) {
      const m = LABELS[style](l);
      const n = m ? +m[1] : 0;
      if (m && (STRICT.has(style) ? n === next : n >= next && n <= next + 2)) {
        close();
        labels++;
        next = n + 1;
        lp = pages[p].n;
        cur = { n, page: pages[p].n, lines: [m[2]], raw: [l] };
      } else if (cur) {
        if (STOP.test(l) && l.length <= 80) { stopped = true; break; }
        // 最后一条后面常拖着版权行、广告：条目最多 8 行，遇到版权字样后不再接
        if (cur.lines.length >= 8 || JUNK.test(l)) cur.done = true;
        if (!cur.done) { cur.lines.push(l); cur.raw.push(l); }
      }
    }
    // 标题之后的页没有一条新编号：列表在上一页就结束了，这一页的行不算条目的续行
    if (labels === 0 && cur && p > pi) { cur.lines.length = keepLines; cur.raw.length = keepRaw; break; }
    if (!cur && p > pi + 1) break; // 标题后两页都没认出编号 1
  }
  close();
  if (entries.length < MIN_ENTRIES) return null;
  const max = entries[entries.length - 1].n;
  if (max >= 10 && entries.length < max * 0.7) return null;
  return { entries, map: new Map(entries.map((e) => [e.n, e])), lp, max };
}

// 一页里找引用角标。items = [{ s, x, y, fs, w }]（pdf.js getTextContent 的条目，与文字层的 span 一一对应），
// o：{ from, to }（只看这个下标区间）、{ yMin, yMax }（基线在区间外的不算，页眉页脚带）。返回 [{ idx: [条目下标], nums, kind }]。fs 为 0 / 缺失（扫描页识别出的文字）时只认整个 span 是方括号的那种。
// 上标的判据：整串由数字、逗号、短横、方括号组成；字号比前一个正文片段小得明显（≤ 0.86）；基线抬高 0.15–0.85 个正文字号；
// 紧贴在它后面（排除脚注序号、页脚的年卷期、下标 CO2）。一个角标常被拆成好几个相邻小片段（「［」「1」「］」或「8」「–」「13」），连成一串当一个。
const UNIT_TAIL = /(?:^|[\s/(])(?:m|cm|mm|km|nm|um|μm|µm|kg|mg|ml|dl|mol|mmol|ca|na|k|cl|po|pao|fio|co|hco|o|h|log|e|x)$/i;
export function detectCites(items, o = {}) {
  const out = [];
  const used = new Set();
  const n = items.length;
  const blank = (i) => !items[i].s.trim();
  const from = Math.max(0, o.from || 0), to = o.to == null ? n : Math.min(n, o.to);
  const yMin = o.yMin ?? -Infinity, yMax = o.yMax ?? Infinity; // 页眉页脚带里的不算（页码、期刊名旁的年卷期）
  const band = (i) => items[i].y < yMin || items[i].y > yMax;
  for (let i = from; i < to; i++) {
    if (used.has(i) || blank(i) || band(i)) continue;
    const it = items[i];
    const t = it.s.trim();
    if (BRACKET_FULL.test(t)) {
      const nums = parseNums(t);
      if (nums) { out.push({ idx: [i], nums, kind: "span" }); used.add(i); }
      continue;
    }
    if (!it.fs || !CITE_CHARS.test(it.s)) continue;
    let h = i - 1;
    while (h >= from && blank(h)) h--;
    if (h < from) continue;
    const H = items[h];
    if (!H.fs || CITE_CHARS.test(H.s) || band(h)) continue;
    const ratio = it.fs / H.fs, rise = (it.y - H.y) / H.fs, gap = (it.x - (H.x + (H.w || 0))) / H.fs;
    if (ratio > 0.86 || ratio < 0.35 || rise < 0.15 || rise > 0.85 || gap < -0.6 || gap > 1.3) continue;
    const tail = H.s.replace(/\s+$/, "");
    if (/\d$/.test(tail) || UNIT_TAIL.test(tail)) continue; // 10⁶、m²、mm²：指数不是引用
    // 连成一串
    const idx = [i];
    let text = it.s, end = it.x + (it.w || 0), last = i;
    for (let k = i + 1; k < to; k++) {
      const K = items[k];
      if (!CITE_CHARS.test(K.s)) break;
      const blankK = !K.s.trim();
      if (K.fs && (Math.abs(K.fs - it.fs) > 0.2 * it.fs || Math.abs(K.y - it.y) > 0.25 * it.fs)) break;
      if (K.x - end > 1.2 * it.fs) break;
      text += K.s;
      end = K.x + (K.w || 0);
      if (!blankK) { idx.push(k); last = k; }
    }
    const nums = parseNums(text);
    if (!nums) continue;
    for (let k = i; k <= last; k++) used.add(k);
    out.push({ idx, nums, kind: "sup" });
  }
  return out;
}

// 一个 span 的文字里的方括号引用（不是整个 span）：Elsevier 一类期刊把「[124]」排在正文行里，没有单独的片段
export function inlineCites(s) {
  const out = [];
  for (const m of s.matchAll(BRACKET_ANY)) {
    const nums = parseNums(m[0]);
    if (nums) out.push({ start: m.index, end: m.index + m[0].length, nums });
  }
  return out;
}

// 题录文字切成 [文字 | { text, href }]：http(s) 链接、DOI、PubMed 号；href 只会是 http(s)
export function linkParts(text) {
  const out = [];
  const re = /(https?:\/\/[^\s<>"，。；、）】]+)|(\b10\.\d{4,9}\/[^\s<>"，。；、）】]+)|(PubMed:\s*(\d{5,9})|PMID:?\s*(\d{5,9}))/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    let str = m[0], href;
    if (m[1] || m[2]) {
      str = str.replace(/[.,;:)\]}]+$/, "");
      const ascii = str.replace(/[\u00ad\u2010-\u2013\u2212]/g, "-"); // 排版用的不换行连字符、软连字符，链接里要还原成普通短横
      href = m[1] ? ascii : "https://doi.org/" + encodeURI(ascii);
    } else {
      href = "https://pubmed.ncbi.nlm.nih.gov/" + (m[4] || m[5]) + "/";
    }
    if (!/^https?:\/\//i.test(href)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ text: str, href });
    last = m.index + str.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
// ===PURE-END===

// ---------- 状态 ----------
// book：{ doc, status: "loading" | "ready" | "none", lists, scopes:[{ from, to, list }] }。换书就整个丢掉
let book = null;
const marks = new Map(); // 页码 -> { div, cites: [{ els, boxes, nums, list }] }；page-cleared 时去掉
const citeOf = new WeakMap(); // 角标的 span -> cite
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewer = document.querySelector("#viewer");
const MAX_SHOWN = 5; // 气泡里一次最多列几条
const TAIL_PAGES = 40; // 参考文献区从末尾往前找这么多页
const MAX_INLINE = 400; // 一页最多画这么多行内标记
const BEFORE_SCAN = 300; // 往窗口之前探有没有别的参考文献标题，最多探这么多页

// 一页的文字（和 reader.js 的 extractText 同一个拼法）。扫描页没有文字层，直接给空串：
// 这里不触发识别，不然一打开扫描书，后台就要为末尾 40 页排队跑 OCR，挤占读者正在看的那一页
async function rawText(doc, n) {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("");
}

async function startBook() {
  const doc = getPdf();
  if (!doc || !currentBook()) return;
  if (book?.doc === doc) return;
  resetAll();
  const b = (book = { doc, status: "loading", lists: [], scopes: [] });
  try {
    await sleep(600); // 先让眼前的页画出来
    await loadRefs(b);
  } catch {
    if (book === b) b.status = "none"; // 换书后旧文档销毁、读页失败：静默
  }
}

const alive = (b) => book === b && getPdf() === b.doc;

async function loadRefs(b) {
  const N = b.doc.numPages;
  const W = Math.min(N, TAIL_PAGES);
  const ws = N - W + 1;
  const pages = [];
  for (let n = ws; n <= N; n++) {
    const text = await rawText(b.doc, n);
    if (!alive(b)) return;
    pages.push({ n, lines: text.split("\n") });
    if (n % 5 === 0) await sleep(0);
  }
  const lists = parseRefLists(pages);
  if (!lists.length) return void (b.status = "none");
  // 窗口之前的页有没有别的参考文献标题（教材每章一份）：有，第一份列表的辖区只从窗口开头算起，不把后面一章的文献套到前面章节上
  let from = 1;
  if (ws > 1) {
    from = Math.max(1, ws - BEFORE_SCAN);
    for (let n = ws - 1; n >= from; n--) {
      const hit = (await rawText(b.doc, n)).split("\n").some(isRefHeading);
      if (!alive(b)) return;
      if (hit) { from = ws; break; }
      if (n % 5 === 0) await sleep(30);
    }
  }
  b.lists = lists;
  lists.forEach((list, k) => b.scopes.push({ from: k === 0 ? from : lists[k - 1].lp + 1, to: list.hp, list }));
  b.status = "ready";
  for (let n = 1; n <= N; n++) {
    const div = pageDiv(n);
    if (div?.querySelector(".textLayer span")) markPage(n, div);
  }
}

const scopeOf = (page) => book?.scopes.find((s) => page >= s.from && page <= s.to);

// ---------- 在页上标角标 ----------
function textSpans(div) {
  const byI = new Map();
  for (const sp of div.querySelectorAll(".textLayer span:not(.markedContent)")) byI.set(+sp.dataset.i, sp);
  return byI;
}

function clearMarks(page) {
  const rec = marks.get(page);
  if (!rec) return;
  for (const c of rec.cites) for (const sp of c.els || []) sp.classList.remove("ref-cite", "ref-open");
  rec.div.querySelectorAll(".ref-layer").forEach((n) => n.remove());
  marks.delete(page);
}

const valid = (nums, list) => nums.every((n) => n >= 1 && n <= list.max + 2);

async function markPage(page, div) {
  try { await markPageInner(page, div); } catch (err) { console.debug("参考文献角标：第", page, "页标注失败", err); }
}

async function markPageInner(page, div) {
  const b = book;
  if (!b || b.status !== "ready") return;
  clearMarks(page);
  const scope = scopeOf(page);
  if (!scope) return;
  const rec = { div, cites: [] };
  marks.set(page, rec);
  let items = null, band = {};
  if (!isScanned(page)) {
    try {
      const pg = await b.doc.getPage(page);
      const [x0, y0, x1, y1] = pg.view;
      band = { yMin: y0 + (y1 - y0) * 0.05, yMax: y1 - (y1 - y0) * 0.05 }; // 上下各 5% 是页眉页脚
      const tc = await pg.getTextContent();
      items = tc.items.filter((it) => it.str).map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], fs: Math.hypot(it.transform[2], it.transform[3]), w: it.width }));
    } catch {}
  }
  if (!alive(b) || marks.get(page) !== rec || !div.isConnected) return;
  const spans = textSpans(div);
  if (!spans.size) return;
  // 条目和文字层的 span 要一一对上（pdf.js 对空串条目不生成 span，上面已滤掉；按 reader.js 给的 data-i 对），对不上就不用字号判断，只认方括号
  if (items) {
    let seen = 0, same = 0;
    for (const [i, sp] of spans) { seen++; if (items[i] && items[i].s === sp.textContent) same++; }
    if (!seen || same < seen * 0.95) items = null;
  }
  const taken = new Set();
  const add = (cite) => { rec.cites.push(cite); };
  if (items) {
    let from = 0, to = items.length;
    if (page <= 2) {
      const k = items.findIndex((it) => /^(abstract|summary|摘要|introduction|引言|前言)$/.test(norm(it.s))); // 作者单位的上标序号不是引用
      if (k >= 0) from = k;
    }
    if (page === scope.list.hp) {
      const k = items.findIndex((it) => isRefHeading(it.s));
      to = k >= 0 ? k : 0;
    }
    for (const c of detectCites(items, { from, to, ...band })) {
      if (!valid(c.nums, scope.list)) continue;
      const els = c.idx.map((i) => spans.get(i));
      if (els.some((e) => !e)) continue;
      const cite = { els, boxes: [], nums: c.nums, list: scope.list, page };
      els.forEach((e) => { e.classList.add("ref-cite"); citeOf.set(e, cite); taken.add(e); });
      add(cite);
    }
  }
  // 正文行里排着的 [124]（没有单独的片段）：量出它的位置，放一个不收鼠标事件的标记层，点击时按坐标判断
  let inline = 0;
  if (page !== scope.list.hp || items) {
    for (const [i, sp] of spans) {
      if (taken.has(sp)) continue;
      const text = sp.textContent;
      if (!/[\[［【]/.test(text) || (page === scope.list.hp && items && i >= items.findIndex((it) => isRefHeading(it.s)))) continue;
      const tn = sp.firstChild;
      if (tn?.nodeType !== 3) continue;
      for (const m of inlineCites(text)) {
        if (!valid(m.nums, scope.list)) continue;
        if (m.start === 0 && m.end === text.length) { // 整个 span 就是它（扫描页识别出的、对不上条目的）
          const cite = { els: [sp], boxes: [], nums: m.nums, list: scope.list, page };
          sp.classList.add("ref-cite");
          citeOf.set(sp, cite);
          add(cite);
          continue;
        }
        const r = document.createRange();
        r.setStart(tn, m.start);
        r.setEnd(tn, m.end);
        const rect = [...r.getClientRects()].find((q) => q.width > 1 && q.height > 1);
        if (!rect) continue;
        if (++inline > MAX_INLINE) return; // 一页上成千个括号（乱码、表格）不画
        const box = drawBox(sp.closest(".crop") || div, rect);
        add({ els: [], boxes: [box], nums: m.nums, list: scope.list, page });
      }
    }
  }
}

function drawBox(container, rect) {
  const cr = container.getBoundingClientRect();
  let layer = container.querySelector(":scope > .ref-layer");
  if (!layer) layer = container.appendChild(el("div", { className: "ref-layer" }));
  const pct = (v, total) => (v / total * 100).toFixed(3) + "%";
  const box = el("i", { className: "ref-hit" });
  Object.assign(box.style, {
    left: pct(rect.left - cr.left - 1, cr.width), top: pct(rect.top - cr.top, cr.height),
    width: pct(rect.width + 2, cr.width), height: pct(rect.height, cr.height),
  });
  layer.append(box);
  return box;
}

window.addEventListener("page-rendered", (e) => {
  const { page, div } = e.detail;
  if (book?.status === "ready" && book.doc === getPdf()) markPage(page, div);
});
window.addEventListener("page-cleared", (e) => {
  const page = e.detail.page;
  if (popCite?.page === page) closePop();
  clearMarks(page);
});
window.addEventListener("book-opened", () => { closePop(); startBook(); });
window.addEventListener("view-changed", closePop);

function resetAll() {
  closePop();
  for (const page of [...marks.keys()]) clearMarks(page);
  book = null;
}

// ---------- 点击 → 气泡 ----------
let down = null; // 按下鼠标的位置：位移 ≥ 4px 是拖选，不当点击
document.addEventListener("mousedown", (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
document.addEventListener("pointerdown", (e) => { if (pop && !pop.contains(e.target)) closePop(); }, true);

const inside = (r, x, y, slop = 2) => x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop;
function citeAt(target, x, y) {
  const sp = target?.closest?.("span.ref-cite");
  if (sp && citeOf.has(sp)) return citeOf.get(sp);
  if (!target?.closest?.(".page")) return null;
  for (const rec of marks.values()) {
    for (const c of rec.cites) if (c.boxes.some((b) => inside(b.getBoundingClientRect(), x, y))) return c;
  }
  return null;
}

document.addEventListener("click", (e) => {
  if (!book || book.status !== "ready" || e.button !== 0 || e.detail > 1 || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (e.target.closest?.("#ref-pop, #hl-menu")) return;
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) >= 4) return; // 拖选
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  const cite = citeAt(e.target, e.clientX, e.clientY);
  if (!cite) return;
  const menu = document.querySelector("#hl-menu"); // 角标压在旧划线上：阅读器的划线菜单也会弹，角标优先
  if (menu) menu.hidden = true;
  openPop(cite);
});

// 鼠标在正文行里的 [124] 上：光标变手、标记变深（这类标记不收鼠标事件，不能靠 :hover）
let hoverRaf = 0, hoverBox = null;
document.addEventListener("mousemove", (e) => {
  if (hoverRaf || !book || book.status !== "ready") return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    let hit = null;
    if (e.target.closest?.(".page")) {
      for (const rec of marks.values()) {
        for (const c of rec.cites) for (const b of c.boxes) if (inside(b.getBoundingClientRect(), e.clientX, e.clientY)) hit = b;
      }
    }
    if (hit === hoverBox) return;
    hoverBox?.classList.remove("ref-hover");
    hoverBox = hit;
    hit?.classList.add("ref-hover");
    viewer.classList.toggle("ref-over", !!hit);
  });
}, { passive: true });

let pop = null, popCite = null;
const chip = (n) => el("span", { className: "rp-n", textContent: `[${n}]` });

function entryView(list, n) {
  const entry = list.map.get(n);
  if (!entry) {
    return el("div", { className: "rp-item" }, chip(n), el("div", { className: "rp-body" },
      el("p", { className: "rp-text miss", textContent: `文献 [${n}] 没解析出来` }),
      goBtn("跳到参考文献", list.hp, list.head + " " + (list.entries[0]?.quote || ""))));
  }
  const text = el("p", { className: "rp-text" });
  for (const part of linkParts(entry.text)) {
    if (typeof part === "string") { text.append(part); continue; }
    text.append(el("a", { href: part.href, target: "_blank", rel: "noopener noreferrer", textContent: part.text, title: part.href }));
  }
  return el("div", { className: "rp-item" }, chip(n), el("div", { className: "rp-body" }, text, goBtn(`跳到文献 · 第 ${entry.page} 页`, entry.page, entry.quote)));
}

function goBtn(label, page, quote) {
  return el("button", { type: "button", className: "rp-go", textContent: label, onclick: () => { closePop(); revealPassage(page, quote); } });
}

function openPop(cite) {
  closePop();
  popCite = cite;
  pop = el("div", { id: "ref-pop", role: "dialog" });
  for (const n of cite.nums.slice(0, MAX_SHOWN)) pop.append(entryView(cite.list, n));
  if (cite.nums.length > MAX_SHOWN) {
    pop.append(el("p", { className: "rp-more", textContent: `另有 ${cite.nums.length - MAX_SHOWN} 条没有列出：` + cite.nums.slice(MAX_SHOWN).map((n) => `[${n}]`).join(" ") }));
  }
  pop.style.visibility = "hidden";
  document.body.append(pop);
  [...cite.els, ...cite.boxes].forEach((n) => n.classList.add("ref-open"));
  placePop();
}

function closePop() {
  if (popCite) [...popCite.els, ...popCite.boxes].forEach((n) => n.classList.remove("ref-open"));
  pop?.remove();
  pop = popCite = null;
}

// 贴在角标下面；下面放不下放上面；横向不出阅读区。角标滚出阅读区就收起
function placePop() {
  if (!pop || !popCite) return;
  const rects = [...popCite.els, ...popCite.boxes].map((n) => n.getBoundingClientRect()).filter((r) => r.width || r.height);
  if (!rects.length) return closePop();
  const a = { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)), left: Math.min(...rects.map((r) => r.left)) };
  const vb = viewer.getBoundingClientRect();
  if (a.bottom < vb.top || a.top > vb.bottom) return closePop();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let y = a.bottom + 8;
  if (y + h > Math.min(vb.bottom, innerHeight) - 6) y = a.top - h - 8;
  if (y < vb.top + 4) y = Math.max(vb.top + 4, Math.min(innerHeight - h - 6, a.bottom + 8));
  pop.style.left = Math.min(Math.max(a.left - 14, vb.left + 8), Math.max(vb.left + 8, vb.right - w - 8)) + "px";
  pop.style.top = y + "px";
  pop.style.visibility = "";
}
viewer.addEventListener("scroll", () => placePop(), { passive: true });
window.addEventListener("resize", () => placePop());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop) closePop(); }, true);

// 测试脚本读状态用
export const refsBook = () => book;
export const refsState = () => ({ status: book?.status || null, lists: (book?.lists || []).map((l) => ({ hp: l.hp, lp: l.lp, max: l.max, n: l.entries.length })), scopes: (book?.scopes || []).map((s) => [s.from, s.to]), marked: [...marks].map(([p, r]) => [p, r.cites.length]) });

startBook(); // 模块加载时书已经打开了
