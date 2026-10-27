// 中英对照：把一页按段落切成原图块，每块下面插这一段的中文译文。
// 表格、公式、图都保留原样；双栏先左栏后右栏；英文照样能选中划线。
import { el, toast } from "./ui.js";

// ---------- 1. 从文字层量出每一行（坐标是相对整页的比例）----------
function measureLines(div) {
  const box = div.getBoundingClientRect();
  const items = [];
  for (const s of div.querySelectorAll(".textLayer span:not(.markedContent)")) {
    if (!s.textContent.trim()) continue;
    const r = s.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.height > r.width * 1.5 && s.textContent.trim().length > 1) continue; // 竖排的页边水印不算正文
    items.push({
      span: s, x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height,
      w: r.width / box.width, h: r.height / box.height,
    });
  }
  if (!items.length) return { lines: [], gutter: null };
  const gutter = findGutter(items);
  const rows = groupRows(items);
  // 双栏页在栏间距处把每排拆成左右两行；跨过栏间距的（通栏标题）整排算一行
  const lines = [];
  const toLine = (group) => {
    const x = Math.min(...group.map((i) => i.x)), y = Math.min(...group.map((i) => i.y));
    lines.push({
      x, y, items: group.sort((a, b) => a.x - b.x),
      w: Math.max(...group.map((i) => i.x + i.w)) - x, h: Math.max(...group.map((i) => i.y + i.h)) - y,
    });
  };
  for (const row of rows) {
    const crosses = gutter !== null && row.items.some((i) => i.x < gutter - 0.005 && i.x + i.w > gutter + 0.005);
    if (gutter === null || crosses) { toLine(row.items); continue; }
    const left = row.items.filter((i) => i.x + i.w / 2 < gutter);
    const right = row.items.filter((i) => i.x + i.w / 2 >= gutter);
    if (left.length) toLine(left);
    if (right.length) toLine(right);
  }
  for (const l of lines) {
    l.text = l.items.reduce((t, it, i) => {
      const prev = l.items[i - 1];
      const gap = prev && it.x - (prev.x + prev.w) > l.h * 0.2 && !/\s$/.test(t) && !/^\s/.test(it.span.textContent);
      return t + (gap ? " " : "") + it.span.textContent;
    }, "").trim();
  }
  return { lines: lines.sort((a, b) => a.y - b.y || a.x - b.x), gutter };
}

// 归排：先只用正常字号的字按纵向中心分排，上标、下标这类小字最后挂到和它重叠最多的那一排。
// 上标的框常常同时压着上下两行（实测按中心距离会单独成行、按重叠合并又会把两行连成一排），所以不让它参与分排。
// 脚注那种整片都是小字的，挂不上任何一排，就在小字之间再分一次
function groupRows(items) {
  const cy = (it) => it.y + it.h / 2;
  const byCenter = (list) => {
    const h = [...list].sort((a, b) => a.h - b.h)[list.length >> 1].h;
    const rows = [];
    for (const it of [...list].sort((a, b) => cy(a) - cy(b))) {
      const row = rows.at(-1);
      if (row && cy(it) - row.cy < h * 0.5) row.items.push(it);
      else rows.push({ cy: cy(it), items: [it] });
    }
    for (const r of rows) {
      r.y0 = Math.min(...r.items.map((i) => i.y));
      r.y1 = Math.max(...r.items.map((i) => i.y + i.h));
      r.x0 = Math.min(...r.items.map((i) => i.x));
      r.x1 = Math.max(...r.items.map((i) => i.x + i.w));
    }
    return rows;
  };
  const medH = [...items].sort((a, b) => a.h - b.h)[items.length >> 1].h;
  const main = items.filter((i) => i.h >= medH * 0.75);
  const rows = byCenter(main);
  const leftover = [];
  for (const it of items.filter((i) => i.h < medH * 0.75)) {
    let best = null;
    let bestOverlap = it.h * 0.25;
    for (const r of rows) {
      const overlap = Math.min(r.y1, it.y + it.h) - Math.max(r.y0, it.y);
      if (overlap > bestOverlap && it.x > r.x0 - 0.05 && it.x < r.x1 + 0.05) { best = r; bestOverlap = overlap; }
    }
    if (best) best.items.push(it); else leftover.push(it);
  }
  if (leftover.length) rows.push(...byCenter(leftover));
  return rows.sort((a, b) => a.y0 - b.y0);
}

// 找栏间距：页面中间 30%~70% 范围里，几乎没有文字压着的那条竖向空白带。
// 只认整页一致的空白带：某行里的偶然空隙（比如连字丢失留下的空位）不会被当成换栏
function findGutter(items) {
  const N = 200;
  const cover = new Array(N).fill(0);
  for (const it of items) {
    for (let i = Math.max(0, Math.floor(it.x * N)); i <= Math.min(N - 1, Math.floor((it.x + it.w) * N)); i++) cover[i]++;
  }
  let best = Math.floor(0.3 * N);
  for (let i = best; i <= Math.floor(0.7 * N); i++) if (cover[i] < cover[best]) best = i;
  if (cover[best] > items.length * 0.03) return null; // 不少字压在中线上：单栏
  const g = best / N;
  const left = items.filter((it) => it.x + it.w <= g).length;
  const right = items.filter((it) => it.x >= g).length;
  if (left < items.length * 0.2 || right < items.length * 0.2) return null; // 一边几乎没字：不是双栏
  let a = best, b = best;
  while (a > 0 && cover[a - 1] === cover[best]) a--;
  while (b < N - 1 && cover[b + 1] === cover[best]) b++;
  return (a + b + 1) / 2 / N;
}

// ---------- 2. 分区：通栏段和双栏段 ----------
function bands(lines, mid) {
  if (mid === null) return [{ y0: 0, y1: 1, cols: [{ x0: 0, x1: 1, lines }] }];
  const isFull = (l) => l.x < mid - 0.005 && l.x + l.w > mid + 0.005; // 跨过栏间距的是通栏行
  const out = [];
  for (const l of lines) {
    const full = isFull(l);
    let band = out.at(-1);
    if (!band || band.full !== full) out.push(band = { full, lines: [] });
    band.lines.push(l);
  }
  // 相邻两段的分界放在空隙中间；第一段从页顶开始，最后一段到页底
  out.forEach((b, i) => {
    b.top = Math.min(...b.lines.map((l) => l.y));
    b.bottom = Math.max(...b.lines.map((l) => l.y + l.h));
  });
  return out.map((b, i) => ({
    y0: i === 0 ? 0 : (out[i - 1].bottom + b.top) / 2,
    y1: i === out.length - 1 ? 1 : (b.bottom + out[i + 1].top) / 2,
    cols: b.full
      ? [{ x0: 0, x1: 1, lines: b.lines }]
      : [{ x0: 0, x1: mid, lines: b.lines.filter((l) => l.x + l.w / 2 < mid) },
        { x0: mid, x1: 1, lines: b.lines.filter((l) => l.x + l.w / 2 >= mid) }],
  }));
}

// ---------- 3. 分段 ----------
function joinLines(lines) {
  return lines.reduce((t, l) => {
    if (!t) return l.text;
    if (/[a-z]-$/i.test(t) && /^[a-z]/.test(l.text)) return t.slice(0, -1) + l.text; // 行尾连字符
    if (/[㐀-鿿，。、；：）]$/.test(t)) return t + l.text;
    return t + " " + l.text;
  }, "");
}

function paragraphs(lines, medH) {
  if (!lines.length) return [];
  const big = (l) => l.h > medH * 1.3;
  const out = [];
  for (const l of [...lines].sort((a, b) => a.y - b.y)) {
    const cur = out.at(-1);
    const prev = cur?.lines.at(-1);
    let start = !prev;
    if (prev) {
      // 「写满没有」按这一段自己的宽度比：缩进的摘要、引文比正文窄，拿整栏比会每行都判成段尾
      const left = Math.min(cur.left, l.x), right = Math.max(cur.right, l.x + l.w);
      const width = right - left;
      const prevFull = prev.x + prev.w > right - width * 0.15;
      start = l.y - (prev.y + prev.h) > medH * 0.8 // 段间距大
        || big(l) !== big(prev) // 标题和正文分开
        || !prevFull // 上一行明显没写满，段落已结束
        || (l.x - left > 0.015 && prev.x - left <= 0.015 && cur.lines.length > 1); // 首行缩进
    }
    if (start) out.push({ lines: [], left: l.x, right: l.x + l.w });
    const p = out.at(-1);
    p.lines.push(l);
    p.left = Math.min(p.left, l.x);
    p.right = Math.max(p.right, l.x + l.w);
  }
  for (const p of out) {
    p.x = Math.min(...p.lines.map((l) => l.x));
    p.y = Math.min(...p.lines.map((l) => l.y));
    p.w = Math.max(...p.lines.map((l) => l.x + l.w)) - p.x;
    p.h = Math.max(...p.lines.map((l) => l.y + l.h)) - p.y;
    p.text = joinLines(p.lines);
  }
  return out;
}

// 值得翻译：英文字母够多、不以中文为主；又窄又短的多半是图里的标注，插译文会把图切开
function translatable(p) {
  const latin = (p.text.match(/[A-Za-z]/g) || []).length;
  const cjk = (p.text.match(/[㐀-鿿]/g) || []).length;
  const words = p.text.split(/\s+/).filter(Boolean).length;
  return latin >= 20 && latin > cjk * 2 && !(words < 8 && p.w < 0.2);
}

// ---------- 4. 切块：原图块切到段尾就停，译文紧跟其后；段后的空白、插图、页脚单独成块，排在译文后面 ----------
export function planPage(div) {
  const { lines, gutter } = measureLines(div);
  if (!lines.length) return null;
  const hs = lines.map((l) => l.h).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1];
  const crops = [];
  for (const band of bands(lines, gutter)) {
    for (const col of band.cols) {
      const paras = paragraphs(col.lines, medH);
      if (!paras.length) {
        crops.push({ x0: col.x0, x1: col.x1, y0: band.y0, y1: band.y1, lines: [], para: null });
        continue;
      }
      let start = band.y0;
      paras.forEach((p, i) => {
        const next = paras[i + 1];
        const nextTop = next ? Math.max(start, next.y - medH * 0.15) : band.y1;
        const end = Math.max(start, Math.min(p.y + p.h + medH * 0.4, nextTop)); // 多留半行，别切到字母下沿
        crops.push({ x0: col.x0, x1: col.x1, y0: start, y1: end, lines: p.lines, para: p });
        if (nextTop - end > 0.002) crops.push({ x0: col.x0, x1: col.x1, y0: end, y1: nextTop, lines: [], para: null });
        start = nextTop;
      });
    }
  }
  if (!crops.some((c) => c.para && translatable(c.para))) return null; // 整页没有要译的英文：保持原样
  return { crops, medH };
}

// ---------- 5. 重排这一页：原图块 + 译文块 ----------
// 返回要翻译的段落和对应的译文块，交给翻译队列
export function restructure(div, plan, onTextLayer) {
  const W = div.clientWidth, H = div.clientHeight;
  const src = div.querySelector(":scope > canvas");
  const oldTl = div.querySelector(":scope > .textLayer");
  const k = src.width / W;
  const fontSize = Math.min(Math.max(plan.medH * H * 1.05, 14), 17); // 宋体比英文原文略大一点才等观感
  const nodes = [];
  const jobs = [];
  for (const c of plan.crops) {
    const cx = c.x0 * W, cy = c.y0 * H, cw = (c.x1 - c.x0) * W, ch = (c.y1 - c.y0) * H;
    if (ch < 1) continue;
    const canvas = el("canvas", { width: Math.max(1, Math.round(cw * k)), height: Math.max(1, Math.round(ch * k)) });
    Object.assign(canvas.style, { left: cx + "px", top: cy + "px", width: cw + "px", height: ch + "px" });
    canvas.getContext("2d").drawImage(src, cx * k, cy * k, cw * k, ch * k, 0, 0, canvas.width, canvas.height);
    const tl = el("div", { className: "textLayer" });
    tl.style.width = oldTl.style.width;
    tl.style.height = oldTl.style.height;
    // 这一块里的行搬进来；文字层和整页一样大，位置不用改
    for (const line of c.lines) {
      for (const { span } of line.items) {
        const br = span.nextSibling?.nodeName === "BR" ? span.nextSibling : null;
        tl.append(span);
        if (br) tl.append(br);
      }
    }
    const inner = el("div", { className: "crop-inner" }, canvas, tl);
    Object.assign(inner.style, { left: -cx + "px", top: -cy + "px", width: W + "px", height: H + "px" });
    const crop = el("div", { className: "crop" }, inner);
    Object.assign(crop.style, { width: cw + "px", height: ch + "px" });
    nodes.push(crop);
    onTextLayer(tl);
    if (c.para && translatable(c.para)) {
      const tr = el("div", { className: "tr pending", textContent: "翻译中…" });
      tr.style.setProperty("--indent", Math.max(0, (c.para.x - c.x0) * W) + "px"); // 「译」字标挂在译文左缘外
      Object.assign(tr.style, {
        width: cw + "px", fontSize: fontSize + "px",
        paddingLeft: Math.max(0, (c.para.x - c.x0) * W) + "px",
        paddingRight: Math.max(0, (c.x1 - c.para.x - c.para.w) * W) + "px",
      });
      tr.dataset.source = c.para.text;
      nodes.push(tr);
      jobs.push({ text: c.para.text, block: tr });
    }
  }
  div.replaceChildren(...nodes);
  div.classList.add("bilingual");
  div.style.height = "auto";
  return jobs;
}

// 收掉像素的对照页翻回来了：按每块记在样式里的位置和大小，从整页重画的 src 再切一次（和上面切块的算法一样）
export function refill(div, src) {
  const k = src.width / div.clientWidth;
  for (const canvas of div.querySelectorAll(".crop-inner > canvas")) {
    const [cx, cy, cw, ch] = ["left", "top", "width", "height"].map((p) => parseFloat(canvas.style[p]));
    canvas.width = Math.max(1, Math.round(cw * k));
    canvas.height = Math.max(1, Math.round(ch * k));
    canvas.getContext("2d").drawImage(src, cx * k, cy * k, cw * k, ch * k, 0, 0, canvas.width, canvas.height);
  }
}

// ---------- 6. 翻译队列：离当前页近的先译，最多同时两页 ----------
const pending = new Map(); // 页码 -> 段落任务
let running = 0;
let generation = 0;
let abort = new AbortController(); // 换书、开关对照时中止在途请求，不然旧流占着两个名额，新书要等它吐出下一段才轮到
let ctx = null; // { file, title, currentPage }
let downToastGen = -1; // 服务没在运行的提示条每一代只弹一次

export function resetTranslations(context) {
  pending.clear();
  generation++;
  abort.abort();
  abort = new AbortController();
  ctx = context;
}

export function enqueue(page, jobs) {
  if (jobs.length) pending.set(page, jobs);
  pump();
}

export function pump() {
  while (running < 2 && pending.size) {
    const here = ctx.currentPage();
    const [page] = [...pending.keys()].sort((a, b) => Math.abs(a - here) - Math.abs(b - here));
    if (Math.abs(page - here) > 2) return; // 离得远的先放着，翻到附近再译
    const jobs = pending.get(page);
    pending.delete(page);
    running++;
    translatePage(page, jobs, generation, abort.signal).finally(() => { running--; pump(); });
  }
}

const RESTART = "launchctl kickstart -k gui/$(id -u)/com.albert.reading-companion";

// 失败块：写明原因，旁边给「重试」。点一下把这一页所有失败的段落一起重新入队。
// retryable 为 false 时不给（服务端拒收的请求，重发结果一样）
function markFailed(block, msg, page, jobs, retryable = true) {
  block.className = "tr error";
  block.replaceChildren("翻译失败：" + msg);
  if (!retryable) return;
  const retry = el("button", { type: "button", textContent: "重试", onclick: () => retryFailed(page, jobs) });
  Object.assign(retry.style, { marginLeft: "12px", color: "var(--dian)", textDecoration: "underline", textUnderlineOffset: "3px" });
  block.append(retry);
}

function retryFailed(page, jobs) {
  const again = jobs.filter((j) => j.block.isConnected && j.block.classList.contains("error"));
  for (const j of again) {
    j.block.className = "tr pending";
    j.block.textContent = "翻译中…";
  }
  enqueue(page, again);
}

async function translatePage(page, jobs, gen, signal) {
  const fail = (msg, retryable) => jobs.forEach((j) => {
    if (j.block.classList.contains("pending")) markFailed(j.block, msg, page, jobs, retryable);
  });
  let done = false;
  try {
    const res = await fetch("/api/translate", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ file: ctx.file(), title: ctx.title(), page, paragraphs: jobs.map((j) => j.text) }),
    });
    if (!res.ok) {
      if (res.status >= 500) return fail(`本地服务出错了（${res.status}）`);
      // 4xx：服务端拒收了这次请求（比如一页文字超过翻译上限），原因在回包的 error 里，重发也不会成功
      const why = await res.json().then((j) => j?.error, () => null);
      return fail(typeof why === "string" && why ? why : `本地服务没接受这次请求（${res.status}）`, false);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (gen !== generation) return;
        const ev = JSON.parse(line);
        if (ev.type === "para" && jobs[ev.i]) {
          const b = jobs[ev.i].block;
          if (ev.text) { b.className = "tr"; b.textContent = ev.text; } else b.remove();
        } else if (ev.type === "error") {
          fail(ev.message);
        } else if (ev.type === "done") {
          done = true;
        }
      }
    }
    // 流收尾了还停在「翻译中…」的块：没有结果就是失败，不能一直转圈
    if (gen === generation) fail(done ? "有段落没译出来" : "连接中断了，这一段没译完");
  } catch (err) {
    if (err.name === "AbortError" || gen !== generation) return;
    // fetch 打不通或流读到一半断掉都是 TypeError；api() 的网络错误约定是 ServiceDown
    if (err instanceof TypeError || err.name === "ServiceDown") {
      fail("伴读的本地服务没在运行");
      if (downToastGen !== gen) {
        downToastGen = gen;
        toast(`伴读的本地服务没在运行。终端里运行：${RESTART}`, { label: "复制命令", run: () => navigator.clipboard?.writeText(RESTART).catch(() => {}) });
      }
    } else if (err instanceof SyntaxError) {
      fail("服务返回的内容读不懂");
    } else {
      fail(err.message);
    }
  }
}
