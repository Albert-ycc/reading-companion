// 多文献对比表：书架上勾几份文献、定几个维度，Claude 逐份读完抽成一张表，每格带页码，点页码回到原文。
// 别的书的文字在这里用 pdf.js 另开文档取（只取文字层，不调识别，不碰阅读器）；服务端是 features/compare.py。
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { idb } from "./db.js";
import { openHandle, tidyTitle } from "./library.js";
import { currentBook, gotoPage, revealPassage } from "./reader.js";
import { $, el, toast, api, whyFailed } from "./ui.js";

const LIST_N = 12;            // 书架最近在读列几本
const MAX_BOOKS = 5, MAX_DIMS = 8, MAX_DIM_CHARS = 30;
const SAVED_SHOWN = 5;        // 已生成的表默认列几张，其余折起来（不然书架上「最近在读」被推到老远）
const MAX_PAGES = 80;         // 每本最多读前几页
const DOC_CHARS = 120000;     // 一本最多送多少字（一本一次调用，各读各的；超过的每页截短）
const MAX_PAGE_CHARS = 20000;
const WHOLE_FILE_LIMIT = 40 * 1024 * 1024; // 超过的文件按区间从磁盘切片读，不整本读进内存
const DEFAULT_DIMS = "研究问题；人群；方法；主要结论；推荐与证据级别";

const st = {
  books: [],        // 最近在读 [{ key, title, handle, at }]
  sel: new Set(),   // 勾了的书
  saved: [],        // 已生成的表的清单
  shown: null,      // 正显示的那张表
  allSaved: false,  // 已生成的表是否全部展开
  job: null,        // 正在生成：{ ctl, t0 }
};

class Skip extends Error {} // 这一本读不了，原因直接给用户看

// 书架上同名的书靠文件夹分得清：key 是「书库名/路径/文件名」或「文件/文件名」（单个打开的）
const folderOf = (key) => {
  const parts = String(key).split("/");
  return parts[0] === "文件" ? "单个文件" : parts.length > 1 ? parts.at(-2) : "";
};

const fmtAt = (iso) => {
  const d = new Date(iso), now = new Date();
  if (isNaN(d)) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getFullYear() === now.getFullYear() ? "" : d.getFullYear() + "年"}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

// ---------- 取文字 ----------
async function ensureRead(handle) {
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

// 小文件整本读；大文件按 pdf.js 要的区间切片读（和阅读器同一个办法，阅读器那个没导出）
async function sourceOf(file) {
  if (file.size <= WHOLE_FILE_LIMIT) return { data: new Uint8Array(await file.arrayBuffer()) };
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const range = new pdfjsLib.PDFDataRangeTransport(file.size, head);
  range.requestDataRange = (begin, end) => {
    file.slice(begin, end).arrayBuffer().then((buf) => {
      if (!range.retired) range.onDataRange(begin, new Uint8Array(buf));
    }).catch(() => {});
  };
  return { range, length: file.size };
}

// 读一本书的文字层：前 MAX_PAGES 页，每页 { n, text }。读不了的抛 Skip；扫描版（几乎没有文字层）也跳过，这里不做识别
async function readBook(book, signal) {
  let file;
  try {
    file = await book.handle.getFile();
  } catch (err) {
    throw new Skip(err.name === "NotFoundError" ? "文件被移动或删除了" : "读不了这个文件");
  }
  if (!file.size) throw new Skip("文件是空的");
  const src = await sourceOf(file);
  let needPw = false;
  const task = pdfjsLib.getDocument({
    ...src, disableAutoFetch: true, disableStream: true,
    cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", isEvalSupported: false,
  });
  task.onPassword = (update) => { needPw = true; update(new Error("没有密码")); };
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (/fake worker/i.test(err.message || "")) // 服务断过，pdf.js 的 worker 没加载上；之后一直走不起来，要刷新页面
        throw Object.assign(new Error("本地服务刚断过，刷新一下页面再试"), { name: "ServiceDown" });
      if (needPw || err.name === "PasswordException") throw new Skip("设了打开密码");
      if (err.name === "InvalidPDFException") throw new Skip("不是有效的 PDF，或者文件已经损坏");
      throw new Skip("打不开：" + (err.message || err.name));
    }
    const total = doc.numPages, limit = Math.min(total, MAX_PAGES);
    const pages = [];
    let withText = 0;
    for (let n = 1; n <= limit; n++) {
      if (signal.aborted) throw new DOMException("已取消", "AbortError");
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("").replace(/\u0000/g, "").trim();
      page.cleanup();
      if (text.length >= 30) withText++;
      if (text) pages.push({ n, text: text.slice(0, MAX_PAGE_CHARS) });
    }
    if (!withText || withText < limit * 0.1) throw new Skip("扫描版，没有文字层，这里不做识别");
    return { book, name: file.name, size: file.size, pages, total, read: limit, blank: limit - pages.length };
  } finally {
    if (src.range) src.range.retired = true;
    task.destroy().catch(() => {});
  }
}

// 每页只留开头 ratio 的字（每页都留一点，不是砍掉后面的页：结论常在文末）；尽量断在换行、空格或句号上
function clipText(text, ratio) {
  if (ratio >= 1 || text.length < 200) return text;
  const k = Math.floor(text.length * ratio);
  const cut = text.slice(0, k);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "), cut.lastIndexOf("。"), cut.lastIndexOf(". "));
  return at > k - 120 ? cut.slice(0, at + 1) : cut;
}

// 读好的几本 → 要发给服务端的 docs：每页前加页码标记；一本超过 DOC_CHARS 就每页截短到那个字数
function packDocs(read) {
  return read.map((r) => {
    const size = r.pages.reduce((n, p) => n + p.text.length + 12, 0);
    const ratio = size > DOC_CHARS * 1.1 ? DOC_CHARS / size : 1; // 只超一点点不截，截了表头还要注明，不值
    const text = r.pages.map((p) => `【第 ${p.n} 页】\n${clipText(p.text, ratio)}`).join("\n\n");
    const doc = { file: r.book.key, title: r.book.title, text, pages_total: r.total, pages_read: r.read };
    if (r.blank >= Math.max(2, r.read * 0.2)) doc.pages_blank = r.blank;
    if (ratio < 1) doc.kept_pct = Math.max(1, Math.round(ratio * 100));
    return doc;
  });
}

// ---------- 维度 ----------
// 分号（中英文）或换行隔开；去空、去重、每个最多 30 字。返回 { dims } 或 { error }
function parseDims(text) {
  const dims = [];
  for (const part of text.split(/[;；\n]/)) {
    const d = part.replace(/\s+/g, " ").trim().slice(0, MAX_DIM_CHARS).trim();
    if (d && !dims.includes(d)) dims.push(d);
  }
  if (!dims.length) return { error: "至少写一个要比的维度" };
  if (dims.length > MAX_DIMS) return { error: `最多 ${MAX_DIMS} 个维度，现在写了 ${dims.length} 个` };
  return { dims };
}

// ---------- 网络 ----------
async function postJson(path, body, signal) {
  let res;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw Object.assign(new Error("伴读的本地服务没在运行"), { name: "ServiceDown" });
  }
  try {
    return await res.json();
  } catch {
    throw Object.assign(new Error("本地服务回的内容读不懂"), { name: "BadResponse" });
  }
}

// ---------- 页面骨架 ----------
const ui = {};
function build() {
  const desk = $("#desk");
  if (!desk) return;
  ui.count = el("small", { textContent: "已选 0 / " + MAX_BOOKS });
  ui.list = el("div", { className: "cmp-books" });
  ui.dims = el("input", { type: "text", id: "cmp-dims", value: DEFAULT_DIMS, placeholder: DEFAULT_DIMS, autocomplete: "off", spellcheck: false });
  ui.go = el("button", { type: "button", className: "btn solid", textContent: "生成对比表", onclick: generate });
  ui.stop = el("button", { type: "button", className: "btn", textContent: "取消", hidden: true, onclick: () => st.job?.ctl.abort() });
  ui.hint = el("p", { className: "cmp-hint" });
  ui.status = el("p", { className: "cmp-status", hidden: true, role: "status" });
  ui.result = el("div", { className: "cmp-result", hidden: true });
  ui.saved = el("div", { className: "cmp-saved", hidden: true });
  ui.dims.addEventListener("input", syncControls);
  ui.dims.addEventListener("keydown", (e) => { if (e.key === "Enter" && !ui.go.disabled) generate(); });
  ui.root = el("section", { id: "compare", hidden: true },
    el("div", { className: "sec-row" }, el("h3", { className: "sec" }, "对比几份文献", ui.count)),
    el("p", { className: "muted cmp-intro", textContent: "读几份指南、论文对同一个问题的口径时用：勾几本，定好要比的维度，Claude 逐本读完摆成一张表，每格标出处页码，点页码回到原文。" }),
    ui.list,
    el("div", { className: "cmp-form" }, el("label", { htmlFor: "cmp-dims", textContent: "要比的维度" }), ui.dims, ui.go, ui.stop),
    ui.hint, ui.status, ui.result, ui.saved);
  desk.after(ui.root);
}

function syncControls() {
  if (!ui.root) return;
  const busy = !!st.job;
  const p = parseDims(ui.dims.value);
  ui.count.textContent = `已选 ${st.sel.size} / ${MAX_BOOKS}`;
  ui.hint.textContent = p.error || `用分号隔开，最多 ${MAX_DIMS} 个；每本最多读前 ${MAX_PAGES} 页，扫描版读不了。`;
  ui.hint.classList.toggle("err", !!p.error);
  ui.go.disabled = busy || !st.sel.size || !!p.error;
  ui.go.hidden = busy;
  ui.stop.hidden = !busy;
  ui.dims.disabled = busy;
  for (const box of ui.list.querySelectorAll("input")) {
    box.disabled = busy || (!box.checked && st.sel.size >= MAX_BOOKS);
    box.closest("label").classList.toggle("off", box.disabled);
    box.closest("label").title = box.disabled && !busy ? `最多选 ${MAX_BOOKS} 本` : box.dataset.title;
  }
}

function renderBooks() {
  ui.list.replaceChildren(...st.books.map((b) => {
    const box = el("input", { type: "checkbox", checked: st.sel.has(b.key) });
    box.dataset.title = b.title;
    box.addEventListener("change", () => {
      if (box.checked) st.sel.add(b.key); else st.sel.delete(b.key);
      syncControls();
    });
    return el("label", { className: "cmp-book", title: b.title }, box, el("span", { className: "t", textContent: tidyTitle(b.title) }),
      el("span", { className: "d", textContent: folderOf(b.key) }));
  }));
  if (!st.books.length) ui.list.append(el("p", { className: "muted", textContent: "还没有最近在读的书。打开几本书，它们就出现在这里。" }));
  syncControls();
  ui.root.hidden = !st.books.length && !st.saved.length;
}

async function refreshBooks() {
  try {
    st.books = (await idb.all("books")).sort((a, b) => b.at - a.at).slice(0, LIST_N);
  } catch {
    st.books = [];
  }
  const keys = new Set(st.books.map((b) => b.key));
  for (const k of [...st.sel]) if (!keys.has(k)) st.sel.delete(k);
  renderBooks();
}

async function refreshSaved() {
  try {
    const r = await api("/api/compare");
    st.saved = Array.isArray(r?.items) ? r.items : [];
  } catch {
    return; // 服务没开：书架那边已经给了提示，这里留着上次的清单
  }
  renderSaved();
  ui.root.hidden = !st.books.length && !st.saved.length;
}

// ---------- 已生成的表 ----------
function renderSaved() {
  ui.saved.hidden = !st.saved.length;
  if (!st.saved.length) return ui.saved.replaceChildren();
  // 正显示的那张排在折叠线以外也要看得见：折起时只列最新几张，正显示的若不在其中也列上
  const rows = st.allSaved ? st.saved : st.saved.filter((it, i) => i < SAVED_SHOWN || it.id === st.shown?.id);
  ui.saved.replaceChildren(
    el("p", { className: "cmp-sub" }, "已生成的表",
      st.saved.length > SAVED_SHOWN
        ? el("button", { type: "button", className: "more", textContent: st.allSaved ? "只看最新几张" : `展开全部 ${st.saved.length} 张`,
          onclick: () => { st.allSaved = !st.allSaved; renderSaved(); } })
        : ""),
    el("ul", { className: "toc" }, ...rows.map((it) => {
      const short = (t) => (t.length > 20 ? t.slice(0, 20) + "…" : t);
      const names = (it.docs || []).map((d) => short(tidyTitle(d.title || ""))).join("、");
      const dims = (it.dims || []).join(" · ");
      const open = el("div", { className: "what" },
        el("a", { className: "name", href: "#", textContent: names || "（没有书名）",
          title: (it.docs || []).map((d) => tidyTitle(d.title || "")).join("\n") + "\n维度：" + dims,
          onclick: (e) => { e.preventDefault(); openSaved(it.id); } }),
        el("span", { className: "dm", textContent: "维度：" + dims }));
      const del = el("button", { type: "button", textContent: "删除" });
      let armed = 0;
      del.onclick = () => {
        if (!armed) {
          del.textContent = "确定删除";
          del.classList.add("arm");
          armed = setTimeout(() => { armed = 0; del.textContent = "删除"; del.classList.remove("arm"); }, 3000);
          return;
        }
        clearTimeout(armed);
        removeSaved(it.id);
      };
      return el("li", { className: st.shown?.id === it.id ? "on" : "" }, open, el("span", { className: "leader" }),
        el("span", { className: "meta", textContent: `${it.docs?.length ?? 0} 份 · ${fmtAt(it.at)}` }),
        el("span", { className: "acts" }, el("button", { type: "button", textContent: "打开", onclick: () => openSaved(it.id) }), del));
    })));
}

async function openSaved(id) {
  try {
    const t = await api("/api/compare?id=" + encodeURIComponent(id));
    if (!t || t.error || !Array.isArray(t.rows)) return toast(t?.error || "这张表读不出来");
    show(t, true);
  } catch (err) {
    toast(whyFailed(err, "没打开这张表"));
  }
}

async function removeSaved(id) {
  try {
    const r = await api("/api/compare/delete", { id });
    if (r?.error) toast(r.error);
  } catch (err) {
    return toast(whyFailed(err, "没删掉"));
  }
  if (st.shown?.id === id) show(null);
  await refreshSaved();
}

// ---------- 表 ----------
const rowNote = (r) => {
  const bits = [];
  if (r.pages_total) bits.push(`共 ${r.pages_total} 页`);
  if (r.pages_read && r.pages_total && r.pages_read < r.pages_total) bits.push(`只读了前 ${r.pages_read} 页`);
  if (r.pages_blank) bits.push(`${r.pages_blank} 页没有文字层，没读到`);
  if (r.kept_pct && r.kept_pct < 100) bits.push(`每页只取了开头约 ${r.kept_pct}%`);
  return bits;
};

// 没放进表的书和原因（表下面列出来）
const skippedNotes = (t) => (t.skipped || []).map((s) => `《${tidyTitle(s.title)}》没放进表：${s.reason}`);

// 复制成 Markdown 时附的说明：表头那些「只读了前几页」之类带不出去，文字版里补在表后面
function footnotes(t) {
  const notes = [];
  for (const r of t.rows) {
    const bits = rowNote(r).filter((b) => !/^共/.test(b));
    if (r.error) bits.unshift(`没读出来：${r.error}`);
    if (bits.length) notes.push(`《${tidyTitle(r.title)}》${bits.join("，")}`);
  }
  return [...notes, ...skippedNotes(t)];
}

// 打开表里的那本书；带 cell 就等它换上来再跳到那一页（有引文就连引文一起亮一下）
async function openRow(row, cell) {
  const book = st.books.find((b) => b.key === row.file) || await idb.get("books", row.file).catch(() => null);
  if (!book) return toast("这本书已经不在最近在读里了，从书库里打开它再回来点");
  await openHandle(book.handle, book.key, book.title);
  if (currentBook()?.key !== book.key || !cell) return; // 没打开成功（权限、文件不在了）：openHandle 已经给过提示
  if (cell.quote) await revealPassage(cell.page, cell.quote);
  else gotoPage(cell.page);
}

function cellNode(row, cell) {
  const c = cell || { text: "", page: null };
  if (row.error || !c.text) return el("td", { className: "empty", textContent: "—" });
  if (c.none) return el("td", { className: "none", textContent: c.text });
  return el("td", {}, el("span", { className: "tx", textContent: c.text }),
    c.page == null
      ? el("span", { className: "nosrc", textContent: "未找到出处", title: "Claude 没给出能在原文里核对的页码" })
      : el("button", {
        type: "button", className: "pg", textContent: `第 ${c.page} 页`,
        title: c.quote ? `原文：${c.quote}` : "回到这一页", onclick: () => openRow(row, c),
      }));
}

function tableNode(t) {
  const n = t.rows.length;
  const head = el("tr", {}, el("th", { className: "dim", scope: "col" }),
    ...t.rows.map((r) => {
      const notes = rowNote(r);
      return el("th", { scope: "col" },
        el("button", { type: "button", className: "ttl", title: r.title, textContent: tidyTitle(r.title),
          onclick: () => openRow(r) }),
        r.error ? el("small", { className: "err", textContent: `没读出来：${r.error}` }) : "",
        notes.length ? el("small", { textContent: notes.join(" · ") }) : "");
    }));
  const body = t.dims.map((dim, i) => el("tr", {}, el("th", { scope: "row", className: "dim", textContent: dim }),
    ...t.rows.map((r) => cellNode(r, r.cells?.[i]))));
  const table = el("table", {}, el("thead", {}, head), el("tbody", {}, ...body));
  table.style.setProperty("--n", n);
  return el("div", { className: "cmp-wrap n" + n, tabIndex: 0 }, table);
}

// 复制成 Markdown：竖线和换行会弄坏表格，转掉；页脚的说明一起带上，不然复制出去就看不出这份表读得不全
function toMarkdown(t) {
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>");
  const lines = [
    `| 维度 | ${t.rows.map((r) => esc(tidyTitle(r.title))).join(" | ")} |`,
    `| --- |${t.rows.map(() => " --- |").join("")}`,
    ...t.dims.map((d, i) => `| ${esc(d)} | ${t.rows.map((r) => {
      const c = r.cells?.[i];
      if (r.error || !c?.text) return "—";
      return esc(c.text + (c.page != null ? `（第 ${c.page} 页）` : ""));
    }).join(" | ")} |`),
  ];
  const notes = footnotes(t);
  return lines.join("\n") + (notes.length ? "\n\n" + notes.map((x) => `注：${x}。`).join("\n") : "") + "\n";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { value: text });
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function show(t, scroll) {
  st.shown = t;
  ui.result.hidden = !t;
  if (!t) {
    ui.result.replaceChildren();
    return renderSaved();
  }
  const copy = el("button", { type: "button", className: "btn", textContent: "复制成 Markdown",
    onclick: async () => toast((await copyText(toMarkdown(t))) ? "已复制，粘贴到笔记里就是一张表" : "没复制成功，再点一次") });
  const close = el("button", { type: "button", className: "btn", textContent: "收起", onclick: () => show(null) });
  const notes = skippedNotes(t);
  ui.result.replaceChildren(
    el("div", { className: "cmp-cap" },
      el("span", { className: "t", textContent: `${t.rows.length} 份文献 · ${t.dims.length} 个维度${t.at ? " · " + fmtAt(t.at) : ""}${t.rows.length >= 4 ? " · 列放不下，横向滚动看后面几列" : ""}` }),
      el("span", { className: "btns" }, copy, close)),
    tableNode(t),
    ...(notes.length ? [el("ul", { className: "cmp-notes" }, ...notes.map((x) => el("li", { textContent: x })))] : []));
  renderSaved();
  if (scroll) ui.result.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---------- 生成 ----------
function setStatus(text, kind) {
  ui.status.hidden = !text;
  ui.status.className = "cmp-status" + (kind ? " " + kind : "");
  ui.status.replaceChildren(...(text ? [el("i", { className: "dot" }), text] : []));
}

async function generate() {
  if (st.job) return;
  const p = parseDims(ui.dims.value);
  const picked = st.books.filter((b) => st.sel.has(b.key)).slice(0, MAX_BOOKS);
  if (p.error || !picked.length) return syncControls();
  const ctl = new AbortController();
  st.job = { ctl, t0: Date.now() };
  show(null);
  syncControls();
  let tick = 0;
  try {
    // 服务不在时 pdf.js 的 worker 加载不起来，之后一直是坏的、要刷新页面才好：先确认服务在，不在就别碰 pdf.js
    await api("/api/ping");
    // 先把授权要齐：之后读很久，点击带来的「用户操作」早过期了，到那时再弹授权会被浏览器拒掉
    setStatus("正在确认读取权限…", "run");
    // 一起发出去：都趁点击的「用户操作」还新鲜；被拒或浏览器不给弹窗都按没授权算
    const granted = new Map(await Promise.all(picked.map(async (b) => [b.key, await ensureRead(b.handle).catch(() => false)])));

    const read = [], skipped = [], seen = new Map();
    for (const [i, b] of picked.entries()) {
      if (ctl.signal.aborted) throw new DOMException("已取消", "AbortError");
      const name = tidyTitle(b.title);
      setStatus(`正在读第 ${i + 1} / ${picked.length} 本：《${name}》`, "run");
      try {
        if (!granted.get(b.key)) throw new Skip("没拿到读取权限（再点一次「生成对比表」会重新问）");
        const r = await readBook(b, ctl.signal);
        const sig = `${r.name}|${r.size}`;
        if (seen.has(sig)) throw new Skip(`和《${seen.get(sig)}》是同一个文件，只读了一次`);
        seen.set(sig, name);
        read.push(r);
      } catch (err) {
        if (err.name === "AbortError" || err.name === "ServiceDown") throw err;
        skipped.push({ title: b.title, reason: err instanceof Skip ? err.message : "读取出错：" + (err.message || err.name) });
      }
    }
    if (!read.length) {
      setStatus("没有一本能读：" + skipped.map((s) => `《${tidyTitle(s.title)}》${s.reason}`).join("；"), "err");
      return;
    }

    const t0 = Date.now();
    const wait = () => setStatus(`文字取好了，Claude 正在逐本读并填表（${read.length} 本一起读，通常半分钟左右）· 已等 ${Math.round((Date.now() - t0) / 1000)} 秒`, "run");
    wait();
    tick = setInterval(wait, 1000);
    const res = await postJson("/api/compare", { docs: packDocs(read), dims: p.dims, skipped }, ctl.signal);
    if (res.error || !Array.isArray(res.rows)) throw Object.assign(new Error(res.error || "没生成出来"), { name: "Rejected" });
    setStatus("");
    show(res, true);
    refreshSaved();
  } catch (err) {
    if (err.name === "AbortError") setStatus("已取消。");
    else setStatus(whyFailed(err, "没生成出来：" + (err.message || err.name)), "err");
  } finally {
    clearInterval(tick);
    st.job = null;
    syncControls();
  }
}

// ---------- 启动 ----------
build();
if (ui.root) {
  window.addEventListener("library-shown", () => { refreshBooks(); refreshSaved(); });
  refreshBooks();
  refreshSaved();
}
