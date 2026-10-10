// 阅读器：pdf.js 渲染 PDF，选中即划线，把「读到哪 + 划了什么 + 前后文」同步给本地服务，
// Claude Code 的 UserPromptSubmit hook 再把它带进每一次提问。
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { $, el, toast, api, apiOk, whyFailed, setSpineTitle } from "./ui.js";
import { planPage, restructure, resetTranslations, enqueue, pump } from "./bilingual.js";

// 绝对路径：真 worker 起不来时 pdf.js 改走主线程里的假 worker，相对路径会按 pdf.min.mjs 所在目录再拼一层 vendor/pdfjs
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

const viewer = $("#viewer");
const CONTEXT_CHARS = 500; // 划线前后各带多少字
const PAGE_TEXT_CHARS = 3000; // 没划线时，当前页最多带多少字
const WHOLE_FILE_LIMIT = 40 * 1024 * 1024; // 超过这个体积就按需分段读，不整本读进内存
const OCR_WIDTH = 2000; // 扫描页送去识别的图宽，和屏幕缩放无关
const FONT = '"PingFang SC", -apple-system, sans-serif';

let pdf = null;
let shownTask = null; // 当前显示的这本书的 pdf.js 加载任务
let pendingTask = null; // 正在加载、还没换上来的那本；加载成功之前旧书原样留着，失败了也不动它
let shownRange = null;
let fileKey = "";
let bookTitle = "";
let scale = 1;
let spread = false; // 双页：左右两页一排
let layoutSeq = 0; // 第几次重排：重排前开始的渲染，await 回来发现变了就放弃，不往清空后的页里再塞一层画布
let base = null; // 第 1 页在 scale=1 时的尺寸，用来定整本的缩放
let pageDivs = [];
let currentPage = 1;
let currentTo = 1; // 眼前这一排的最后一页：双页时是右页，单页时等于 currentPage
let highlights = [];
let currentHl = null;
const pageText = new Map(); // 页码 -> 该页纯文本（扫描页为识别出的文字）
const rendering = new Map(); // 页码 -> 渲染 Promise
const scanned = new Set(); // 没有文字层、靠识别的页
const ocrLines = new Map(); // 页码 -> 识别结果（按阅读顺序排好），重排时不用再请求
const ocrFailed = new Map(); // 页码 -> 重新识别的函数：识别失败的扫描页，翻回来时自动再试一次
const bookKeyOf = new WeakMap(); // pdf 文档 -> 它属于哪本书：识别结果要记到这本书名下，不能看翻页时 fileKey 是什么
let openSeq = 0; // 第几次打开：连着打开两本时，被顶掉的那次发现序号变了就静默退出
let openedAt = 0; // 书刚换上来的时刻
let cancelOpen = null; // 让还在等待的上一次打开立刻放弃：大文件（分段读）加载到一半销毁任务，pdf.js 的 promise 实测一直不结束

let bilingual = false; // 中英对照开关，记在本机浏览器里
try { bilingual = localStorage.getItem("banDu.bilingual") === "1"; } catch {}
$("#bi-toggle").classList.toggle("on", bilingual);

export const currentBook = () => (pdf ? { key: fileKey, title: bookTitle } : null);

$("#bi-toggle").addEventListener("click", () => {
  bilingual = !bilingual;
  try { localStorage.setItem("banDu.bilingual", bilingual ? "1" : "0"); } catch {}
  $("#bi-toggle").classList.toggle("on", bilingual);
  if (!pdf) return;
  newTranslationRun();
  const keep = currentPage;
  layout();
  gotoPage(keep);
  updatePage(); // 对照只出单页：双页改单页时页码没变，滚动位置也可能没变，要自己补一次
});

function newTranslationRun() {
  resetTranslations({ file: () => fileKey, title: () => bookTitle, currentPage: () => currentPage });
}

// ---------- 阅读状态：交给本地服务，hook 带进每次提问 ----------
let stateSnap = null; // 本页面最近一次交给 /api/state 的内容。提问时 readingContext() 原样带上，Claude 拿到的就是界面上这一刻写的那本书、那一页、那条划线，不再读服务端全局的那一份

// 本页面所有 /api/state 都从这里发。服务端对同一本书是合并（没带的字段保持原样），内存里的快照照同样的规则合并。
// 服务端收下了才改快照（被拒收或没连上就抛出错误，快照不动），提问时带的上下文才不会比服务端存的多；
// 请求排队一个一个发，快照的更新顺序和服务端收到的顺序一样
const SELECTION_MAX_CHARS = 60000; // 服务端 selection 文字字段的字数上限（server.py 的 MAX_SELECTED，按码点数），改了要一起改
// 截到上限；别把一个字（代理对）劈成两半
const clip = (t) => {
  const k = t.slice(0, SELECTION_MAX_CHARS);
  return k.length < t.length && /[\ud800-\udbff]$/.test(k) ? k.slice(0, -1) : k;
};
let stateChain = Promise.resolve();
export function syncState(patch = {}) {
  if (!pdf) return Promise.resolve();
  const doc = pdf;
  const body = { file: fileKey, title: bookTitle, numPages: pdf.numPages, page: currentPage || 1, pageTo: currentTo || currentPage || 1, ...patch };
  const run = stateChain.catch(() => {}).then(async () => {
    await apiOk("/api/state", body);
    if (doc === pdf) stateSnap = { ...stateSnap, ...body };
  });
  stateChain = run;
  return run;
}

// 提问时附带的阅读上下文：没打开书是 null，否则是 { file, title, numPages, page, pageTo, pageText, ocr, selection }。
// pageTo 是眼前这一排的最后一页：双页时比 page 大 1，pageText 是两页的文字按页分段
export function readingContext() {
  if (!pdf || !stateSnap) return null;
  const { file, title, numPages, page, pageTo = page, pageText = "", ocr = false, selection = null } = stateSnap;
  return { file, title, numPages, page, pageTo, pageText, ocr, selection };
}

const textOf = (n) => (pageText.get(n) || "").trim().slice(0, PAGE_TEXT_CHARS);
// 眼前这几页的文字：单页原样；双页每页前标【第 N 页】，Claude 讲解时能按页引用
const viewText = (n, to) => (to > n
  ? [n, to].map((p) => `【第 ${p} 页】\n${textOf(p) || "（这一页没有提取到文字）"}`).join("\n\n")
  : textOf(n));
const viewOcr = (n, to) => scanned.has(n) || (to > n && scanned.has(to));

// 批注栏顶上的「Claude 看到」：划了线就整句写出来；没划线时说明它看的是当前这一页
let seenSel = null; // { page, text, image? }
let revealMark = null; // 跳到原文后留下的旁线：{ page, rect:[x,y,w,h] }，页内比例坐标
let revealSeq = 0; // 连点几处出处时，只让最后一次的旁线留下
let pinStop = null; // 停掉「引句钉在 35% 处」的函数，见 pinLine
let back = null; // 跳走之前的位置：{ page, scroll }，书页底部「回到第 N 页」用
function renderSees() {
  $("#sees").hidden = !pdf;
  if (!pdf) return;
  if (seenSel) {
    $("#sees-label").textContent = `Claude 看到 · 第 ${seenSel.page} 页` + (seenSel.image ? " · 框选" : "");
    if (seenSel.image) { // 框选的区域：显示缩略图
      $("#sees-quote").replaceChildren(Object.assign(document.createElement("img"), { src: seenSel.image, className: "sees-img", alt: "框选的区域" }));
      $("#sees-quote").title = seenSel.text || "";
      return;
    }
    const mark = document.createElement("mark");
    // PDF 换行在中文之间留下的空白去掉，西文之间留一个空格
    mark.textContent = seenSel.text.replace(/([\u3400-\u9fff，。、；：！？）」])\s+(?=[\u3400-\u9fff（「])/g, "$1").replace(/\s+/g, " ");
    $("#sees-quote").replaceChildren(mark);
    $("#sees-quote").title = mark.textContent;
  } else {
    $("#sees-label").textContent = currentTo > currentPage
      ? `Claude 看到 · 第 ${currentPage}、${currentTo} 两页`
      : `Claude 看到 · 第 ${currentPage || 1} 页整页`;
    $("#sees-quote").replaceChildren();
  }
}

function showCtx(hl) {
  seenSel = { page: hl.page, text: hl.text, image: hl.image };
  renderSees();
}

// 版心里的页码
function renderFolio() {
  $("#folio").hidden = !pdf;
  if (!pdf) return;
  $("#folio-n").textContent = currentPage || 1;
  $("#folio-total").textContent = pdf.numPages;
}

// 书架用的封面：第 1 页渲染成小图
export async function renderCover(width = 240) {
  if (!pdf) return null;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const c = Object.assign(document.createElement("canvas"), { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c.toDataURL("image/jpeg", 0.82);
}

// 小文件整本读；大文件（几百 MB 的参考书）按 pdf.js 要的区间从磁盘切片读
async function sourceOf(file) {
  if (file.size <= WHOLE_FILE_LIMIT) return { data: new Uint8Array(await file.arrayBuffer()) };
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const range = new pdfjsLib.PDFDataRangeTransport(file.size, head);
  range.requestDataRange = (begin, end) => {
    // 读到一半文档销毁了（换了书、打开被顶掉）：切片读回来就丢掉
    file.slice(begin, end).arrayBuffer().then((buf) => {
      if (!range.retired) range.onDataRange(begin, new Uint8Array(buf));
    }).catch(() => {});
  };
  return { range, length: file.size };
}
const retire = (range) => { if (range) range.retired = true; };

// ---------- 打开与渲染 ----------
// 要密码的 PDF：弹一个输入框，返回输入的密码；取消（含 Esc）返回 null
function askPassword(wrong) {
  return new Promise((resolve) => {
    const input = el("input", { type: "password", autocomplete: "off", placeholder: "输入密码" });
    const cancel = el("button", { type: "button", className: "btn", textContent: "取消" });
    const form = el("form", {},
      el("p", { className: "pw-note" + (wrong ? " wrong" : ""), textContent: wrong ? "密码不对，再输一次" : "这份 PDF 设了打开密码" }),
      input,
      el("div", { className: "pw-btns" }, cancel, el("button", { type: "submit", className: "btn solid", textContent: "打开" })));
    const dlg = el("dialog", { id: "pw-dialog" }, form);
    let value = null;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value) return input.focus();
      value = input.value;
      dlg.close();
    });
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { dlg.remove(); resolve(value); });
    document.body.append(dlg);
    dlg.showModal();
    input.focus();
  });
}

// 被后一次打开顶掉时返回 false（不是错误），成功返回 true。
// 新文档加载成功（连第 1 页都取到了）之前，正在看的这本书原样不动：打不开（坏文件、没密码、服务不在）时，
// 阅读器和批注栏仍然是同一本旧书，不会出现「阅读器空了、批注栏还写着上一本」。
// 每个 await 之后都核对序号：被顶掉的这次不能再往 #viewer 里加页
export async function openBook(file, key, title) {
  const seq = ++openSeq;
  const stale = () => seq !== openSeq;
  document.querySelector("#pw-dialog")?.close(); // 上一次打开还停在输密码，这次顶掉它
  // 加载期间旧书还摆在阅读区里：看得见，点不动、选不了字。书架上双击封面时，第二下会落在这些旧书页上，记成旧书的一条划线
  viewer.inert = true;
  cancelOpen?.();
  const gone = new Promise((resolve) => { cancelOpen = resolve; });
  const until = (promise) => Promise.race([promise, gone]); // 被顶掉后 gone 先结束，后面的 stale() 核对会退出
  if (pendingTask) pendingTask.destroy().catch(() => {});
  pendingTask = null;

  let src = null, task = null;
  let swapped = false;
  let passwordCancelled = false;
  try {
    // 先确认服务在：它不在时 pdf.js 的 worker 加载失败，之后一直走加载不起来的假 worker，服务回来了也要刷新页面才好
    const book = await until(api("/api/book?file=" + encodeURIComponent(key)));
    if (stale()) return false;
    src = await until(sourceOf(file));
    if (stale()) return false;
    task = pdfjsLib.getDocument({
      ...src,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: "/vendor/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
      isEvalSupported: false, // 页面的内容安全策略不许 eval
    });
    task.onPassword = async (update, reason) => {
      const pw = await askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
      if (pw === null) passwordCancelled = true;
      update(pw ?? new Error("没有输入密码"));
    };
    pendingTask = task;
    const doc = await until(task.promise);
    if (stale()) return false;
    const first = (await until(doc.getPage(1))).getViewport({ scale: 1 });
    if (stale()) return false;

    // ---- 到这里没有 await 了：换书 ----
    swapped = true;
    openedAt = performance.now();
    retire(shownRange);
    if (shownTask) shownTask.destroy().catch(() => {});
    shownTask = task;
    shownRange = src.range ?? null;
    pendingTask = null;
    pinStop?.();
    pdf = doc;
    bookKeyOf.set(doc, key);
    base = first;
    stateSnap = null;
    viewer.replaceChildren();
    pageText.clear();
    rendering.clear();
    scanned.clear();
    ocrLines.clear();
    ocrFailed.clear();
    pageDivs = [];
    currentHl = null;
    seenSel = null;
    revealMark = null;
    setBack(null);
    fileKey = key;
    bookTitle = title;
    newTranslationRun();
    document.title = bookTitle + " · 伴读";
    setSpineTitle(bookTitle);
    for (let i = 1; i <= doc.numPages; i++) {
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.page = i;
      viewer.appendChild(div);
      pageDivs.push(div);
    }
    layout();

    highlights = book.highlights || [];
    const startPage = Math.min(Math.max(book.page || 1, 1), doc.numPages);
    // 重开一本书，服务端上次留下的划线和框选不再算「Claude 看到」的：界面写的是整页，Claude 拿到的也得是整页
    syncState({ page: startPage, pageTo: startPage, pageText: "", ocr: false, selection: null }).catch(() => {});
    gotoPage(startPage);
    currentPage = currentTo = 0; // 强制触发一次进度同步
    updatePage();
    if (startPage > 1) toast("回到上次读到的第 " + startPage + " 页");
    window.dispatchEvent(new CustomEvent("book-opened", { detail: { key, title } }));
    return true;
  } catch (err) {
    if (stale()) return false;
    if (passwordCancelled) throw new Error("这份 PDF 有打开密码，没有输入，没打开");
    if (/Setting up fake worker failed/.test(err?.message || "")) throw new Error("本地服务刚断过，刷新一下页面再打开");
    throw err;
  } finally {
    if (!stale()) { // 被顶掉的那次不放开，后一次还在加载
      viewer.inert = false;
      // 书架上双击封面：第二下落在加载期间点不动的阅读区上，浏览器把最近的一个词（版心里的「书架」）选中了，选中的黄底会一直留着
      getSelection()?.removeAllRanges();
    }
    if (!swapped) { // 没换上来的这次：它的切片读取和加载任务都收掉
      retire(src?.range);
      if (task && pendingTask === task) { pendingTask = null; task.destroy().catch(() => {}); }
    }
  }
}

// 只滚阅读区；scrollIntoView 会连带滚动外层隐藏了滚动条的容器，把顶栏顶出窗口
export function gotoPage(n) {
  pinStop?.();
  const div = pageDivs[n - 1];
  if (div) viewer.scrollTop = div.offsetTop - 8;
}

// 按阅读区大小定单页还是双页、缩放多少；阅读区尺寸变化（窗口缩放、拖版心）时重画。
// 双页的每一页至少按原尺寸的 MIN_SPREAD_SCALE 倍画（正文 10 磅约 12.5px），达不到就是左边放不下两页，改单页。
// 中英对照下每段原文下插译文，一页拉得很长，左右并排就得读完左页再滚回上面读右页，所以只出单页
const MIN_SPREAD_SCALE = 1.25;
const SPREAD_GAP = 40; // 两页之间的空，和 index.html 里 #viewer.spread 的列间距一致
function fit() {
  const w = viewer.clientWidth || window.innerWidth;
  const h = viewer.clientHeight || window.innerHeight;
  // 留出左边「译」字标和页边的位置；版面再宽也不超过 900px，一行太长眼睛来回扫累
  const single = Math.min(Math.max((Math.min(w - 96, 900)) / base.width, 0.6), 2);
  if (bilingual || pdf.numPages < 2) return { scale: single, spread: false };
  // 双页还要整页高放得下（连同页脚页码），不然读完左页下半要滚回上面读右页
  const two = Math.min(Math.min((w - 96 - SPREAD_GAP) / 2, 900) / base.width, (h - 60) / base.height, 2);
  return two >= MIN_SPREAD_SCALE ? { scale: two, spread: true } : { scale: single, spread: false };
}

function layout() {
  ({ scale, spread } = fit());
  layoutSeq++;
  viewer.classList.toggle("spread", spread);
  rendering.clear();
  ocrFailed.clear(); // 页上的内容整个重建，失败角标也跟着没了，重新渲染时会重新识别
  for (const div of pageDivs) {
    lazy.unobserve(div);
    div.replaceChildren();
    div.classList.remove("bilingual");
    div.style.width = base.width * scale + "px";
    div.style.height = base.height * scale + "px";
    div.style.setProperty("--scale-factor", scale);
    lazy.observe(div);
  }
}

// 重排前后，阅读线（35% 高处，和判定当前页的线一致）停在同一页的同一个高度比例上：
// 双页改单页、单页改回双页之后，读到的那几行还在眼前
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!pdf || !viewer.clientWidth) return;
    const next = fit();
    if (next.spread === spread && Math.abs(next.scale - scale) / scale < 0.05) return;
    const n = currentPage || 1;
    const line = viewer.scrollTop + viewer.clientHeight * 0.35;
    const at = (line - pageDivs[n - 1].offsetTop) / pageDivs[n - 1].offsetHeight;
    pinStop?.();
    layout();
    const div = pageDivs[n - 1];
    viewer.scrollTop = div.offsetTop + at * div.offsetHeight - viewer.clientHeight * 0.35;
    updatePage(); // 双页和单页互换时页码可能没变、也不一定触发滚动，眼前是一页还是两页要自己补
  }, 250);
}).observe(viewer);

const lazy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const n = +e.target.dataset.page;
    renderPage(n);
    ocrFailed.get(n)?.(); // 上次识别失败的扫描页翻回来了：自动再试一次
  }
}, { root: viewer, rootMargin: "800px 0px" });

function renderPage(n) {
  if (!rendering.has(n)) rendering.set(n, doRender(n));
  return rendering.get(n);
}

// 渲染途中换了书：旧文档销毁后 pdf.js 会抛「渲染已取消」「传输已销毁」，这些都静默放掉
async function doRender(n) {
  const doc = pdf;
  if (!doc) return;
  try {
    await renderInto(n, doc, layoutSeq);
  } catch (e) {
    if (doc !== pdf || e?.name === "RenderingCancelledException" || /destroyed|aborted/i.test(e?.message || "")) return;
    throw e;
  }
}

async function renderInto(n, doc, seq) {
  const div = pageDivs[n - 1];
  const page = await doc.getPage(n);
  if (seq !== layoutSeq) return; // 等页的时候重排了：新一轮渲染会接手
  const viewport = page.getViewport({ scale });
  div.style.width = viewport.width + "px";
  div.style.height = viewport.height + "px";

  const textContent = await page.getTextContent();
  if (doc !== pdf || seq !== layoutSeq) return; // 渲染途中换了书或重排了
  pageText.set(n, textContent.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  div.appendChild(canvas);

  const tl = document.createElement("div");
  tl.className = "textLayer";
  div.appendChild(tl);
  await new pdfjsLib.TextLayer({ textContentSource: textContent, container: tl, viewport }).render();
  numberSpans(tl);
  registerLayer(tl);

  drawHighlights(n);
  await page.render({
    canvasContext: canvas.getContext("2d"), viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;
  if (!pageText.get(n).trim()) {
    scanned.add(n);
    await ocrPage(n, page, div, tl, doc);
  }
  // 中英对照：按段落切成原图块，块下插译文。渲染途中换了书或重排过就不动
  if (bilingual && doc === pdf && canvas.isConnected) {
    const plan = planPage(div);
    if (plan) {
      enqueue(n, restructure(div, plan, registerLayer));
      drawHighlights(n);
    }
  }
}

function registerLayer(tl) {
  attachEnd(tl);
  tl.addEventListener("mousedown", () => tl.classList.add("selecting"));
}

// ---------- 扫描页：识别文字，铺一层透明文字，和文字版一样能选中划线 ----------
// 识别一页：先问服务端缓存，没有再送高清图去识别。渲染页面和导读、导图取页文字都走这里。
// 换了书返回 null（结果丢掉）；服务端回了错误抛 OcrFailed；连不上服务抛 ServiceDown
const ocrRuns = new Map(); // 页码 -> { doc, run }：同一页同时有几处要识别（渲染、导读取文字）时只发一次
function recognize(n, page, doc) {
  const cached = ocrLines.get(n);
  if (cached) return Promise.resolve(cached);
  let cur = ocrRuns.get(n);
  if (cur?.doc !== doc) {
    cur = { doc, run: runOcr(n, page, doc).finally(() => { if (ocrRuns.get(n) === cur) ocrRuns.delete(n); }) };
    ocrRuns.set(n, cur);
  }
  return cur.run;
}

async function runOcr(n, page, doc) {
  const key = bookKeyOf.get(doc); // 翻页时 fileKey 可能已经是下一本书
  let res = await api(`/api/ocr?file=${encodeURIComponent(key)}&page=${n}`);
  if (!res.lines) res = await api("/api/ocr", { file: key, page: n, dataUrl: await hiresJpeg(page) });
  if (doc !== pdf) return null;
  if (!res.lines) throw Object.assign(new Error(res.error || "未知原因"), { name: "OcrFailed" });
  const lines = readingOrder(res.lines);
  ocrLines.set(n, lines);
  scanned.add(n);
  return lines;
}

// 识别失败：页角出「识别失败 · 重试」，点它或者翻走再翻回来都会重新识别。quiet 是自动重试，不再弹提示
function ocrFailure(n, page, div, tl, doc, err, quiet) {
  const reason = err.name === "OcrFailed" ? err.message : whyFailed(err, "没识别成功");
  const chip = el("button", { type: "button", className: "ocr-badge failed", textContent: "识别失败 · 重试", title: reason });
  const retry = (auto) => {
    if (!chip.isConnected) return;
    chip.remove();
    ocrFailed.delete(n);
    ocrPage(n, page, div, tl, doc, auto === true);
  };
  chip.addEventListener("click", retry);
  div.appendChild(chip);
  ocrFailed.set(n, () => retry(true));
  if (!quiet) toast(`第 ${n} 页识别失败：${reason}`);
}

async function ocrPage(n, page, div, tl, doc, quiet = false) {
  let lines = ocrLines.get(n);
  if (!lines) {
    const badge = div.appendChild(el("div", { className: "ocr-badge", textContent: "识别文字中…" }));
    try {
      lines = await recognize(n, page, doc);
    } catch (err) {
      if (doc === pdf) ocrFailure(n, page, div, tl, doc, err, quiet);
      return;
    } finally {
      badge.remove();
    }
    if (!lines) return; // 换了书
  }
  pageText.set(n, lines.map((l) => l.text).join("\n"));

  const W = div.clientWidth, H = div.clientHeight;
  const ctx = document.createElement("canvas").getContext("2d");
  tl.replaceChildren();
  for (const l of lines) {
    // 字号取行高的八五折，再横向拉伸到识别框的宽度，选区边界才和图上的字对得上
    const size = l.h * H * 0.85;
    ctx.font = `${size}px ${FONT}`;
    const natural = ctx.measureText(l.text).width || 1;
    const span = document.createElement("span");
    span.textContent = l.text;
    Object.assign(span.style, {
      left: l.x * W + "px", top: l.y * H + "px", font: `${size}px ${FONT}`,
      transform: `scaleX(${(l.w * W) / natural})`,
    });
    tl.append(span, document.createElement("br"));
  }
  numberSpans(tl);
  attachEnd(tl);
}

// 给文字层的每个片段记下原始顺序：中英对照会把片段按行带搬进各个原图块，
// 双栏页上左右两栏的片段就交错了；跳原文时按这个序号排回原文顺序再找引句
function numberSpans(tl) {
  tl.querySelectorAll("span:not(.markedContent)").forEach((sp, i) => { sp.dataset.i = i; });
}

// 扫描页单独渲染一张固定宽度的高清图：送去识别，也给 Claude 看原图。屏幕上的画布随窗口缩放，窄窗口时数字糊得分不清
async function hiresJpeg(page) {
  const vp = page.getViewport({ scale: OCR_WIDTH / page.getViewport({ scale: 1 }).width });
  const c = Object.assign(document.createElement("canvas"), { width: Math.floor(vp.width), height: Math.floor(vp.height) });
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c.toDataURL("image/jpeg", 0.9);
}

// Vision 按从上到下给行，双栏排版会左右栏交错：按通栏行切段，段内先左栏再右栏
function readingOrder(lines) {
  const byY = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  // 只看 8 个字以上的正文行判断双栏：表格单元格又短又分左右，会误判
  const prose = lines.filter((l) => l.text.length >= 8);
  const left = prose.filter((l) => l.x + l.w <= 0.55).length;
  const right = prose.filter((l) => l.x >= 0.45).length;
  if (left < 5 || right < 5 || (left + right) / prose.length < 0.6) return byY;
  const out = [];
  let band = [];
  const flush = () => {
    out.push(...band.filter((l) => l.x + l.w / 2 < 0.5), ...band.filter((l) => l.x + l.w / 2 >= 0.5));
    band = [];
  };
  for (const l of byY) {
    if (l.w > 0.6) { flush(); out.push(l); } else band.push(l);
  }
  flush();
  return out;
}

// ---------- 拖选：照搬 pdf.js 官方查看器 web/text_layer_builder.js 的做法 ----------
// 每页文字层末尾有个不可选的 endOfContent。鼠标拖到行尾空白处时，落点就在它上面，
// Chrome 不再延伸选区（实测会选空或只选半句）。选区每次变化都把它挪到选区端点旁边，选区就停在最后一个字上。
const textLayers = new Map(); // 文字层 -> 它的 endOfContent

function attachEnd(tl) {
  const end = Object.assign(document.createElement("div"), { className: "endOfContent" });
  tl.appendChild(end);
  textLayers.set(tl, end);
}

function resetEnd(end, tl) {
  tl.append(end);
  end.style.width = "";
  end.style.height = "";
  tl.classList.remove("selecting");
}

let pointerDown = false;
let prevRange = null;
const resetAll = () => {
  for (const [tl, end] of textLayers) {
    if (tl.isConnected) resetEnd(end, tl); else textLayers.delete(tl);
  }
};
document.addEventListener("pointerdown", () => { pointerDown = true; });
document.addEventListener("pointerup", () => { pointerDown = false; resetAll(); });
window.addEventListener("blur", () => { pointerDown = false; resetAll(); });
document.addEventListener("keyup", () => { if (!pointerDown) resetAll(); });
document.addEventListener("selectionchange", () => {
  const selection = document.getSelection();
  if (selection.rangeCount === 0) return resetAll();
  const range = selection.getRangeAt(0);
  for (const [tl, end] of textLayers) {
    if (!tl.isConnected) textLayers.delete(tl);
    else if (range.intersectsNode(tl)) tl.classList.add("selecting");
    else resetEnd(end, tl);
  }
  const modifyStart = prevRange && (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0
    || range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
  let anchor = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
  const tl = anchor.parentElement?.closest(".textLayer");
  const end = textLayers.get(tl);
  if (end) {
    end.style.width = tl.style.width;
    end.style.height = tl.style.height;
    anchor.parentElement.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
  }
  prevRange = range.cloneRange();
});

// 从空白处起拖（行首左边、行与行之间）：浏览器在这里找不到起点，拖动只会移动光标、选不上字。
// 把起点吸到最近一行文字上，这次拖选由我们接管；从字上起拖仍交给浏览器原生处理。
function nearestCaret(tl, x, y) {
  let best = null;
  let bestD = Infinity;
  for (const s of tl.querySelectorAll("span")) {
    if (!s.textContent.trim()) continue;
    const r = s.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * 4 + dx; // 优先同一行
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best) return null;
  const pos = document.caretRangeFromPoint(
    Math.min(Math.max(x, best.left + 1), best.right - 1), (best.top + best.bottom) / 2);
  return pos && { node: pos.startContainer, offset: pos.startOffset };
}

function layerAt(x, y) {
  const stack = document.elementsFromPoint(x, y);
  // 中英对照时一页拆成好几块，各有自己的文字层：先找鼠标下面那一块的
  return stack.find((e) => e.classList?.contains("textLayer"))
    || stack.find((e) => e.classList?.contains("page"))?.querySelector(".textLayer");
}

// 书架上双击封面：第一下打开了书，第二下落在刚换上来的书页上，会选中一个词记成划线。刚打开的半秒内，双击的第二下不当选字
document.addEventListener("mousedown", (e) => {
  if (e.detail >= 2 && performance.now() - openedAt < 500) e.preventDefault();
}, true);

document.addEventListener("mousedown", (e) => {
  const tl = e.target.closest?.(".textLayer");
  if (e.button !== 0 || !tl || (e.target !== tl && !e.target.classList.contains("endOfContent"))) return;
  const start = nearestCaret(tl, e.clientX, e.clientY);
  if (!start) return;
  e.preventDefault();
  tl.classList.add("selecting");
  const sel = document.getSelection();
  sel.collapse(start.node, start.offset);
  const move = (ev) => {
    const p = nearestCaret(layerAt(ev.clientX, ev.clientY) || tl, ev.clientX, ev.clientY);
    if (p) sel.setBaseAndExtent(start.node, start.offset, p.node, p.offset);
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up, true);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up, true);
}, true);

// ---------- 阅读进度 ----------
let pageTimer;
function updatePage() {
  // 阅读区隐藏（回了书架）时所有页的 offsetTop 都是 0，二分会落到最后一页，进度被冲成末页
  if (!pdf || viewer.hidden) return;
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  let lo = 0, hi = pageDivs.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (pageDivs[m].offsetTop <= mid) lo = m; else hi = m - 1;
  }
  while (lo > 0 && pageDivs[lo - 1].offsetTop === pageDivs[lo].offsetTop) lo--; // 双页时同一排算左页
  const n = lo + 1;
  const to = lo + 1 < pageDivs.length && pageDivs[lo + 1].offsetTop === pageDivs[lo].offsetTop ? n + 1 : n; // 双页时右页
  if (n === currentPage && to === currentTo) return;
  const turned = n !== currentPage;
  currentPage = n;
  currentTo = to;
  // 快照里的页跟着界面走：这一页的文字还没取到就先空着，不拿上一页的顶替
  if (stateSnap) stateSnap = { ...stateSnap, page: n, pageTo: to, pageText: viewText(n, to), ocr: viewOcr(n, to) };
  if (!seenSel) renderSees();
  if (turned) {
    if (back && n === back.page) setBack(null);
    renderFolio();
    window.dispatchEvent(new CustomEvent("page-changed", { detail: { page: n } }));
    pump(); // 翻到附近的页先译
  }
  clearTimeout(pageTimer);
  pageTimer = setTimeout(() => syncPage(n, to).catch(() => {}), 600); // 进度同步尽力而为：服务不在或换书了就算了
}

// 把眼前这一排（单页一页、双页两页）的文字交给服务端；扫描页再附高清原图
async function syncPage(n, to) {
  const doc = pdf;
  const pages = to > n ? [n, to] : [n];
  const still = () => n === currentPage && to === currentTo && doc === pdf;
  await Promise.all(pages.map((p) => renderPage(p).catch(() => {}))); // 渲染完（扫描页连识别）才有文字
  // 这一轮渲染被重排打断、文字没取到：单独取一次（扫描页走识别）
  await Promise.all(pages.map((p) => (pageText.has(p) ? null : extractText(p).catch(() => ""))));
  if (!still()) return;
  await syncState({ page: n, pageTo: to, pageText: viewText(n, to), ocr: viewOcr(n, to) });
  // 扫描页：识别可能认错字，公式和表格也认不全，把这一页的高清图一并发过去，Claude 拿不准时看原图
  for (const p of pages) {
    if (!scanned.has(p) || !still()) continue;
    const dataUrl = await hiresJpeg(await doc.getPage(p));
    if (still()) await api("/api/page-image", { file: bookKeyOf.get(doc), page: p, dataUrl });
  }
}
viewer.addEventListener("scroll", updatePage, { passive: true });

// ---------- 划线 ----------
function pageOf(node) {
  const e = node.nodeType === 1 ? node : node.parentElement;
  return e?.closest(".page");
}

// 在该页纯文本里定位选中文字（忽略空白差异），取前后文
function contextOf(n, text) {
  const raw = pageText.get(n) || "";
  const idxMap = [];
  let norm = "";
  for (let i = 0; i < raw.length; i++) {
    if (!/\s/.test(raw[i])) { idxMap.push(i); norm += raw[i]; }
  }
  const key = text.replace(/\s+/g, "");
  let at = norm.indexOf(key);
  let len = key.length;
  if (at < 0) { at = norm.indexOf(key.slice(0, 20)); len = Math.min(len, norm.length - at); } // 跨页选区按开头定位
  if (at < 0 || !len) return { before: "", after: "" };
  const start = idxMap[at];
  const end = idxMap[Math.min(at + len, idxMap.length) - 1] + 1;
  let before = raw.slice(Math.max(0, start - CONTEXT_CHARS), start);
  if (start < 150 && pageText.has(n - 1)) before = pageText.get(n - 1).slice(-300) + "\n" + before;
  return { before, after: raw.slice(end, end + CONTEXT_CHARS) };
}

// 划线画在「整页大小的面」上：普通模式是页本身；中英对照时是每一块里整页大小的内层，
// 各块只露出自己那一截，划线落在哪块就在哪块显示
function surfacesOf(div) {
  return div.classList.contains("bilingual") ? [...div.querySelectorAll(".crop-inner")] : [div];
}

function drawHighlights(n) {
  const div = pageDivs[n - 1];
  if (!div) return;
  div.querySelectorAll(".hl, .pangxian").forEach((e) => e.remove());
  for (const surface of surfacesOf(div)) {
    for (const hl of highlights) {
      for (const part of hl.parts || []) {
        if (part.page !== n) continue;
        for (const [x, y, w, h] of part.rects) {
          const r = document.createElement("div");
          r.className = "hl" + (hl.kind ? " " + hl.kind : "") + (hl === currentHl ? " current" : "");
          Object.assign(r.style, { left: x * 100 + "%", top: y * 100 + "%", width: w * 100 + "%", height: h * 100 + "%" });
          surface.appendChild(r);
        }
        // 旁线：当前这条划线右侧一道靛色竖线，标出老师正在讲的那句
        if (hl === currentHl && part.rects.length) {
          const right = Math.max(...part.rects.map(([x, , w]) => x + w));
          const top = Math.min(...part.rects.map(([, y]) => y));
          const bottom = Math.max(...part.rects.map(([, y, , h]) => y + h));
          const line = document.createElement("div");
          line.className = "pangxian";
          Object.assign(line.style, { left: Math.min(right + 0.012, 0.985) * 100 + "%", top: top * 100 + "%", height: (bottom - top) * 100 + "%" });
          surface.appendChild(line);
        }
      }
    }
    if (revealMark?.page === n) {
      const [x, y, w, h] = revealMark.rect;
      const line = document.createElement("div");
      line.className = "pangxian";
      Object.assign(line.style, { left: Math.min(x + w + 0.012, 0.985) * 100 + "%", top: y * 100 + "%", height: h * 100 + "%" });
      surface.appendChild(line);
    }
  }
}

// 屏幕上一点落在哪一页、那一页「整页大小的面」在哪：用来把选区换算成页内比例坐标
function surfaceAt(x, y) {
  const inside = (b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  for (const div of pageDivs) {
    if (!inside(div.getBoundingClientRect())) continue;
    if (!div.classList.contains("bilingual")) return { page: +div.dataset.page, box: div.getBoundingClientRect() };
    const crop = [...div.querySelectorAll(".crop")].find((c) => inside(c.getBoundingClientRect()));
    return crop && { page: +div.dataset.page, box: crop.firstElementChild.getBoundingClientRect() };
  }
  return null;
}

// getClientRects 会同时返回 span 盒子和文字盒子，叠在一起颜色深浅不一；按行合并成一条
function mergeRects(rects) {
  const out = [];
  const sorted = [...rects].filter((r) => r.width >= 1 && r.height >= 1)
    .sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom) || a.left - b.left);
  for (const r of sorted) {
    const cy = (r.top + r.bottom) / 2;
    const m = out.find((o) => Math.abs((o.top + o.bottom) / 2 - cy) < Math.min(o.bottom - o.top, r.height) / 2
      && r.left <= o.right + 8 && r.right >= o.left - 8);
    if (m) {
      m.left = Math.min(m.left, r.left); m.right = Math.max(m.right, r.right);
      m.top = Math.min(m.top, r.top); m.bottom = Math.max(m.bottom, r.bottom);
    } else {
      out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return out.map((o) => ({ ...o, width: o.right - o.left, height: o.bottom - o.top }));
}

function onSelectionDone() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!pdf || !text || text.length < 2 || sel.rangeCount === 0) return;
  if (clampFocus(sel)) return onSelectionDone();
  const range = sel.getRangeAt(0);
  const startDiv = pageOf(range.startContainer);
  if (!startDiv || !viewer.contains(startDiv)) return;
  const page = +startDiv.dataset.page;

  // 选的是中文译文：不画划线，把这段的英文原文一起交给 Claude
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const tr = startEl?.closest(".tr");
  if (tr) {
    sel.removeAllRanges();
    // 选得太长就截到服务端的上限：整段发过去会被拒收，Claude 什么都拿不到。英文原文同样处理
    const kept = clip(text);
    syncState({
      page: currentPage,
      selection: { text: kept, page, before: clip("（用户选中的是中文译文，对应的英文原文如下）\n" + (tr.dataset.source || "")), after: "", ocr: false },
    }).then(() => {
      showCtx({ page, text: kept });
      window.dispatchEvent(new CustomEvent("focus-passage", { detail: { page, text: kept } }));
      if (kept.length < text.length) toast(`这段译文太长，Claude 只看到了前 ${kept.length} 字`, undefined, 5000);
    }, (err) => toast("没能让 Claude 看到这段译文：" + whyFailed(err, "再选一次试试"), undefined, 5000));
    return;
  }

  // 选区矩形换算成页内比例坐标，缩放后也能画回原位
  const byPage = new Map();
  for (const r of mergeRects(textRects(range))) {
    const hit = surfaceAt(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit) continue;
    const b = hit.box;
    if (!byPage.has(hit.page)) byPage.set(hit.page, []);
    byPage.get(hit.page).push([(r.left - b.left) / b.width, (r.top - b.top) / b.height, r.width / b.width, r.height / b.height]);
  }
  const hl = { page, text, parts: [...byPage].map(([p, rects]) => ({ page: p, rects })) };
  sel.removeAllRanges();
  if (byPage.size > MAX_HL_PAGES) {
    return toast(`这次选到了 ${byPage.size} 页，像是拖过头了，没有记成划线。重新选一次`);
  }
  const { before, after } = contextOf(page, text);
  const selection = { text, page, before, after, ocr: scanned.has(page) };
  // 同一处已经划过：让 Claude 看这一条，不再记一条重复的
  const same = highlights.find((h) => sameSpot(h, hl));
  if (same) return lookAt(same);
  addHighlight(hl, selection).catch((err) => toast("划线没存上：" + whyFailed(err, "再划一次试试"), undefined, 5000));
}

// 同一处的划线：页、文字、各块位置都对得上。位置允许 0.6% 的出入（窗口宽度不同，比例坐标会有一点浮动）
function sameSpot(a, b) {
  if (a.page !== b.page || a.text !== b.text || !!a.kind !== !!b.kind) return false;
  const pa = a.parts || [], pb = b.parts || [];
  return pa.length === pb.length && pa.every((p, i) => p.page === pb[i].page && p.rects.length === pb[i].rects.length
    && p.rects.every((r, j) => r.every((v, k) => Math.abs(v - pb[i].rects[j][k]) < 0.006)));
}

const MAX_HL_PAGES = 3; // 一条划线最多跨几页；再多就是拖过头了
let lastUp = null; // 最近一次松开鼠标的位置

// 在书页外（书页右边的空白、版心上）松手时，Chrome 会把选区终点一路延到阅读区末尾
// （实测从第 17 页拖到书页右边松手，选区到了全书最后一页）。把终点拉回离松手处最近的那一页。
// 拉回了返回 true
function clampFocus(sel) {
  const up = lastUp;
  lastUp = null;
  if (!up || sel.isCollapsed) return false;
  // 选区是从书页的文字上起的才拉：起点在批注栏、输入框里（比如批注栏里双击按钮留下的选区），
  // 终点拉进书页就会把中间一大段拼成划线
  const from = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!from?.closest("#viewer .textLayer, #viewer .tr")) return false;
  if (document.elementsFromPoint(up.x, up.y).some((e) => e.classList?.contains("page"))) return false;
  let target = null;
  let best = Infinity;
  for (const div of pageDivs) {
    const r = div.getBoundingClientRect();
    const dy = up.y < r.top ? r.top - up.y : up.y > r.bottom ? up.y - r.bottom : 0;
    const dx = up.x < r.left ? r.left - up.x : up.x > r.right ? up.x - r.right : 0; // 双页时同一排的两页高度一样，靠左右分
    const d = dy + dx;
    if (d < best) { best = d; target = r; }
    if (r.top > up.y + 2000) break;
  }
  if (!target) return false;
  const x = Math.min(Math.max(up.x, target.left + 2), target.right - 2);
  const y = Math.min(Math.max(up.y, target.top + 2), target.bottom - 2);
  const tl = layerAt(x, y);
  const caret = tl && nearestCaret(tl, x, y);
  if (!caret) return false;
  sel.extend(caret.node, caret.offset);
  return true;
}

// 选区里每段文字的矩形。range.getClientRects() 会把整个落在选区里的元素（还没画出来的页、画布）
// 当成一整块算进来，划线就成了整页发黄；这里只量文字
function textRects(range) {
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (range.intersectsNode(n) && n.parentElement?.closest(".textLayer") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const out = [];
  const r = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    r.selectNodeContents(n);
    if (n === range.startContainer) r.setStart(n, range.startOffset);
    if (n === range.endContainer) r.setEnd(n, range.endOffset);
    out.push(...r.getClientRects());
  }
  return out;
}

// 划线写入服务端：同一条划线的新增、删除、恢复排着队一个一个发，撤销不会抢在新增前面到服务端、让划线又长回来
const hlOps = new WeakMap(); // 划线 -> 它最近一次写入
function queueHl(hl, path, body) {
  const prev = hlOps.get(hl) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => apiOk(path, body));
  hlOps.set(hl, run);
  return run;
}
const saveHl = (hl) => queueHl(hl, "/api/highlight", { file: fileKey, highlight: hl });
const dropHl = (hl) => queueHl(hl, "/api/highlight/delete", { file: fileKey, id: hl.id, at: hl.at, text: hl.text });

const redraw = (...hls) => new Set(hls.flatMap((h) => (h?.parts || []).map((p) => p.page))).forEach(drawHighlights);

// 删一条划线（连同同一处重复记下的几条）：划线库里先删成功，页上才擦掉；它正是 Claude 看到的那句时，Claude 改回看整页。
// 提示条带「撤销」，6 秒内可以原样写回
const removing = new Set();
export async function removeHighlight(hl) {
  if (!hl || removing.has(hl)) return;
  const noun = hl.kind === "region" ? "框选" : "划线";
  const file = fileKey;
  const gone = highlights.filter((h) => h === hl || sameSpot(h, hl));
  if (!gone.includes(hl)) gone.push(hl);
  removing.add(hl);
  try {
    await Promise.all(gone.filter((h) => h.parts).map(dropHl));
  } catch (err) {
    return toast(`没删掉：${whyFailed(err, "再试一次")}`, undefined, 5000);
  } finally {
    removing.delete(hl);
  }
  if (file !== fileKey) return; // 等服务端回话的时候换了书，页面上已经是另一本的划线
  const sel = stateSnap?.selection;
  const wasSeen = gone.includes(currentHl) || (seenSel && seenSel.page === hl.page && seenSel.text === hl.text)
    || (sel && sel.page === hl.page && sel.text === hl.text);
  for (const h of gone) { const i = highlights.indexOf(h); if (i >= 0) highlights.splice(i, 1); }
  if (gone.includes(currentHl)) currentHl = null;
  redraw(...gone);
  if (wasSeen && pdf) {
    seenSel = null;
    renderSees();
    // 服务端没清成功时，提问带的上下文也按界面来（不带这条已经删掉的划线）
    syncState({ selection: null }).catch(() => { if (stateSnap && file === fileKey) stateSnap = { ...stateSnap, selection: null }; });
  }
  window.dispatchEvent(new CustomEvent("highlight-removed", { detail: hl }));
  toast(`${noun}已删掉`, { label: "撤销", run: () => restoreHighlights(gone, file, noun) });
}

// 撤销删除：用原来的 id 写回划线库，页上画回来；划线（不是框选）还让 Claude 重新看到它
async function restoreHighlights(list, file, noun) {
  if (file !== fileKey) return toast("已经换了一本书，撤销不了了");
  try {
    await Promise.all(list.map((h) => { h.id ||= crypto.randomUUID(); return saveHl(h); }));
  } catch (err) {
    return toast(`没能撤销：${whyFailed(err, "再试一次")}`, undefined, 5000);
  }
  if (file !== fileKey) return;
  highlights.push(...list);
  redraw(...list);
  const hl = list[0];
  if (hl.kind) return toast(`${noun}已恢复`);
  await pick(hl).catch(() => {});
  window.dispatchEvent(new CustomEvent("highlight", { detail: hl })); // 导图那边把它的圆点补回来
  toast(`${noun}已恢复`);
}

// 让 Claude 看一条已经记下的划线：设为当前这条，阅读状态换成它的文字和前后文
async function pick(hl) {
  const { before, after } = contextOf(hl.page, hl.text);
  clearReveal();
  setBack(null);
  const prev = currentHl;
  currentHl = hl;
  redraw(prev, hl);
  try {
    await syncState({ page: hl.page || currentPage, selection: { text: hl.text, page: hl.page, before, after, ocr: scanned.has(hl.page) } });
  } catch (err) {
    if (currentHl === hl) { currentHl = prev; redraw(prev, hl); } // 阅读状态没换成功，Claude 看的还是原来那条
    throw err;
  }
  showCtx(hl);
}

// 点旧划线「问这句」、或重新选中同一处：不重复记录，只让 Claude 回到这一句
function lookAt(hl) {
  return pick(hl).then(() => {
    $("#q").focus();
    toast("Claude 能看到这段了");
  }, (err) => toast("没能让 Claude 看到这段：" + whyFailed(err, "再试一次"), undefined, 5000));
}

// 点一下已有的划线（不是拖选）：旁边出「问这句」「删除这条划线」
const hlMenu = el("div", { id: "hl-menu", hidden: true });
let menuHl = null;
const askBtn = el("button", { type: "button", textContent: "问这句", onclick: () => { const h = menuHl; hideHlMenu(); lookAt(h); } });
hlMenu.append(askBtn, el("button", {
  type: "button", textContent: "删除这条划线",
  onclick: () => { const h = menuHl; hideHlMenu(); removeHighlight(h); },
}));
document.body.append(hlMenu);
function hideHlMenu() { hlMenu.hidden = true; menuHl = null; }
document.addEventListener("click", (e) => {
  if (e.target.closest?.("#hl-menu")) return;
  hideHlMenu();
  if (e.button !== 0 || e.altKey || !pdf || !getSelection().isCollapsed) return;
  const hit = surfaceAt(e.clientX, e.clientY);
  if (!hit) return;
  const fx = (e.clientX - hit.box.left) / hit.box.width;
  const fy = (e.clientY - hit.box.top) / hit.box.height;
  const pad = 0.004;
  const hl = [...highlights].reverse().find((h) => h.parts?.some((p) => p.page === hit.page
    && p.rects.some(([x, y, w, hh]) => fx >= x - pad && fx <= x + w + pad && fy >= y - pad && fy <= y + hh + pad)));
  if (!hl) return;
  menuHl = hl;
  askBtn.style.display = hl.kind ? "none" : ""; // 框选区域的上下文（区域图、框内文字）没存在划线里，没法重新交给 Claude
  hlMenu.hidden = false;
  hlMenu.style.left = Math.min(e.clientX, window.innerWidth - 150) + "px";
  hlMenu.style.top = Math.min(e.clientY + 14, window.innerHeight - 84) + "px";
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideHlMenu(); });
viewer.addEventListener("scroll", hideHlMenu, { passive: true });

// ---------- 给功能模块用的接口（框选、导读、导图） ----------

// 记一条划线：画到页上、存进划线库、设为 Claude 当前看到的内容。
// hl = { page, text, parts:[{page, rects:[[x,y,w,h]...]}], kind?, image? }，坐标是页内比例；
// selection 原样存进阅读状态，hook 据此告诉 Claude 用户划了什么。
// 划线库或阅读状态没写成功就撤掉页上的划线并抛出错误，界面上留着服务端没有的划线，刷新后就不见了
export function addHighlight(hl, selection) {
  hl.id ||= crypto.randomUUID();
  clearReveal();
  setBack(null);
  const prev = currentHl;
  highlights.push(hl);
  currentHl = hl;
  redraw(prev, hl);
  // 阅读位置记成划线所在的页：划在窗口下半截时，按视口算出来的「当前页」可能已经是下一页
  let written = false;
  return saveHl(hl).then(() => { written = true; return syncState({ page: hl.page || currentPage, selection }); }).then(() => {
    showCtx(hl);
    window.dispatchEvent(new CustomEvent("highlight", { detail: hl }));
  }, (err) => {
    const i = highlights.indexOf(hl);
    if (i >= 0) highlights.splice(i, 1);
    if (currentHl === hl) currentHl = prev;
    redraw(prev, hl);
    if (written) dropHl(hl).catch(() => {}); // 写进去了、只是阅读状态没发成：把它也从划线库里拿掉
    throw err;
  });
}

export const getPdf = () => pdf;
export const getCurrentPage = () => currentPage;
export const pageDiv = (n) => pageDivs[n - 1];
export const isScanned = (n) => scanned.has(n);
export { surfaceAt, contextOf, hiresJpeg, renderPage };

// 任意一页的纯文字：有文字层直接取；扫描页走识别（有缓存，没识别过的约 1.3 秒一页）。
// 识别失败时返回空串但不进缓存，下一次调用会重新识别（导读的「只重新识别这几页」靠这个）
export async function extractText(n) {
  if (pageText.has(n) && (pageText.get(n) || !scanned.has(n))) return pageText.get(n);
  const doc = pdf;
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  let text = tc.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join("");
  let failed = false;
  if (!text.trim()) {
    try {
      const lines = await recognize(n, page, doc);
      if (lines) text = lines.map((l) => l.text).join("\n");
    } catch (err) {
      if (err.name !== "OcrFailed") throw err;
      failed = true;
    }
  }
  if (doc === pdf && !failed) pageText.set(n, text);
  return text;
}

// PDF 书签目录，解析成 [{ title, page, depth, children }]；没有书签返回 []
export async function getOutline() {
  const doc = pdf;
  const raw = await doc.getOutline();
  if (!raw) return [];
  const pageOfDest = async (dest) => {
    try {
      const d = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!d) return null;
      return typeof d[0] === "number" ? d[0] + 1 : (await doc.getPageIndex(d[0])) + 1;
    } catch {
      return null;
    }
  };
  const walk = async (items, depth) => {
    const out = [];
    for (const it of items) {
      out.push({ title: it.title, page: await pageOfDest(it.dest), depth, children: it.items?.length ? await walk(it.items, depth + 1) : [] });
    }
    return out;
  };
  return walk(raw, 0);
}

// 引句和文字层比对前先抹平排版上的差异：全角半角、连字（ﬁ 在文字层里有时拆成「fi」、有时整个丢掉）、
// 断字符号（行尾的「anal-」）、零宽字符、空白、大小写。两边用同一套规则
const cleanText = (t) => t.normalize("NFKC").toLowerCase().replace(/[\s\u00ad\u200b-\u200d\u2060\ufeff\-\u2010-\u2015\u2212]/g, "");
// 连字拆出来的字母序列也去掉，这样「confirmed」和丢了连字的「conrmed」能对上。
// withMap 时同时返回去掉之后每个字符在原串里的位置，用来找回它属于哪个文字片段
function typeset(text, withMap = false) {
  const t = withMap ? text : cleanText(text);
  let out = "", last = 0;
  const map = [];
  const copy = (from, to) => { for (let i = from; i < to; i++) { out += t[i]; if (withMap) map.push(i); } };
  for (const m of t.matchAll(/ffi|ffl|ff|fi|fl/g)) { copy(last, m.index); last = m.index + m[0].length; }
  copy(last, t.length);
  return { text: out, map };
}

const MID_CHARS = 32; // 用引句中段定位时，片段至少这么长
const MID_SLACK = 8; // 核对整句时，文字层那边多取几个字，容得下中间多出来的字

// 引句的字在文字层这一段里按顺序能对上多少（最长公共子序列占引句的比例）。只算对角线附近 ±6 个字，
// 两边都是去掉排版差异后的字符串；缺几个字、多几个字都不要紧，对不上的位置会让比例掉下去
function orderedMatch(key, seg) {
  const band = 6;
  let prev = new Array(seg.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= key.length; i++) {
    const cur = new Array(seg.length + 1).fill(0);
    for (let j = Math.max(1, i - band); j <= Math.min(seg.length, i + band); j++) {
      cur[j] = key[i - 1] === seg[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best / key.length;
}

// 跳到原文：引句所在的行停在阅读区约 35% 高处（和判定当前页的线一致），闪 1.8 秒，
// 闪完在页边留一道靛色旁线，留到下一次跳转、划线或换书。第一次跳走时书页底部出「回到第 N 页」。
// 返回 true 表示定位到了引句；找不到（识别文字变了、引句落在图里）只滚到那页页顶，返回 false
export async function revealPassage(page, quote) {
  if (!pdf || !pageDivs[page - 1]) return false;
  if (!back && page !== currentPage) setBack({ page: currentPage, scroll: viewer.scrollTop });
  gotoPage(page);
  await renderPage(page);
  const div = pageDivs[page - 1];
  const key = typeset(quote || "").text.slice(0, 80);
  const owners = [];
  let joined = "";
  const spans = [...div.querySelectorAll(".textLayer span:not(.markedContent)")].sort((a, b) => (a.dataset.i ?? 0) - (b.dataset.i ?? 0));
  for (const sp of spans) {
    const t = cleanText(sp.textContent || "");
    for (let i = 0; i < t.length; i++) owners.push(sp);
    joined += t;
  }
  const { text: hay, map } = typeset(joined, true);
  let at = key ? hay.indexOf(key) : -1;
  let len = key.length;
  if (at < 0 && key.length > 16) { at = hay.indexOf(key.slice(0, 16)); len = 16; } // 引句后半有出入时按开头定位
  // 开头也对不上（开头那一小段里有文字层丢了的字）：拿引句中段的一长段（32 字以上）找，按它在引句里的位置往回推到引句开头，
  // 再核对整句：从推回的起点往后，引句的字按顺序能对上六成以上才算。短片段在同主题的论文里常常重复，不核对会闪到一段无关的文字
  for (let off = 16; at < 0 && off + MID_CHARS <= key.length; off += 16) {
    const i = hay.indexOf(key.slice(off, off + MID_CHARS));
    if (i < 0) continue;
    const start = Math.max(0, i - off);
    if (orderedMatch(key, hay.slice(start, start + key.length + MID_SLACK)) >= 0.6) { at = start; len = Math.min(key.length, hay.length - at); }
  }
  clearReveal();
  if (at < 0) {
    div.classList.add("flash-page");
    setTimeout(() => div.classList.remove("flash-page"), 1600);
    return false;
  }
  // 命中的片段：从头一个到最后一个之间的都算（连字单独成片、被抹平成空的片段也跟着一起闪）
  const owned = map.slice(at, at + len).map((i) => owners[i]);
  const hit = spans.slice(spans.indexOf(owned[0]), spans.indexOf(owned.at(-1)) + 1);
  const first = hit[0].getBoundingClientRect();
  viewer.scrollTop += first.top - viewer.getBoundingClientRect().top - viewer.clientHeight * 0.35;
  pinLine(hit[0]);
  // 旁线位置按页内比例记下来，重排、开关对照之后还能画回去
  const surface = hit[0].closest(".crop-inner") || div;
  const box = surface.getBoundingClientRect();
  const rs = hit.map((sp) => sp.getBoundingClientRect());
  const x0 = Math.min(...rs.map((r) => r.left)), x1 = Math.max(...rs.map((r) => r.right));
  const y0 = Math.min(...rs.map((r) => r.top)), y1 = Math.max(...rs.map((r) => r.bottom));
  const mark = { page, rect: [(x0 - box.left) / box.width, (y0 - box.top) / box.height, (x1 - x0) / box.width, (y1 - y0) / box.height] };
  const seq = revealSeq;
  hit.forEach((sp) => sp.classList.add("flash"));
  setTimeout(() => {
    hit.forEach((sp) => sp.classList.remove("flash"));
    if (seq !== revealSeq) return;
    revealMark = mark;
    drawHighlights(page);
  }, 1800);
  return true;
}

// 中英对照下，上方的译文块陆续填进来会把引句往下推：10 秒内让它一直停在 35% 高处，
// 读者自己滚动、点击或按键就放手
function pinLine(span) {
  pinStop?.();
  if (!bilingual) return;
  const until = performance.now() + 10000;
  const events = ["wheel", "pointerdown", "touchstart"];
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    events.forEach((t) => viewer.removeEventListener(t, stop));
    window.removeEventListener("keydown", stop);
    pinStop = null;
  };
  const tick = () => {
    if (performance.now() > until || !span.isConnected) return stop();
    const off = span.getBoundingClientRect().top - viewer.getBoundingClientRect().top - viewer.clientHeight * 0.35;
    if (Math.abs(off) > 4) viewer.scrollTop += off;
    raf = requestAnimationFrame(tick);
  };
  events.forEach((t) => viewer.addEventListener(t, stop, { passive: true }));
  window.addEventListener("keydown", stop);
  raf = requestAnimationFrame(tick);
  pinStop = stop;
}

function clearReveal() {
  revealSeq++;
  const old = revealMark?.page;
  revealMark = null;
  if (old) drawHighlights(old);
}

// 书页底部「回到第 N 页」：连跳几处出处，始终指向第一次跳走前的位置
const backChip = $("#back-chip");
function setBack(b) {
  back = b;
  backChip.hidden = !b;
  if (b) backChip.textContent = `回到第 ${b.page} 页`;
}
backChip.addEventListener("click", () => {
  if (!back) return;
  pinStop?.();
  viewer.scrollTop = back.scroll;
  setBack(null);
});

// 让 Claude 看到某一段，但不记成划线（导读、导图里「接着问」用）：
// 「Claude 看到」换成这段，阅读状态的 selection 写成这段和前后文，hook 下一轮带给 Claude
export async function focusPassage(page, text) {
  const doc = pdf;
  if (!doc) return;
  const prev = currentHl;
  currentHl = null;
  if (prev) redraw(prev);
  await extractText(page);
  if (doc !== pdf) return; // 取文字的时候换了书
  const { before, after } = contextOf(page, text);
  try {
    await syncState({ page, selection: { text, page, before, after, ocr: scanned.has(page) } });
  } catch (err) {
    return toast("没能让 Claude 看到这段：" + whyFailed(err, "再试一次"), undefined, 5000);
  }
  if (doc !== pdf) return;
  seenSel = { page, text };
  renderSees();
}

// 挂在 document 上：拖选时鼠标松在阅读区外也算；选的是对话栏里的字则不处理（onSelectionDone 里判断）
document.addEventListener("mouseup", (e) => { lastUp = { x: e.clientX, y: e.clientY }; setTimeout(onSelectionDone, 0); });
document.addEventListener("keyup", (e) => { if (e.shiftKey) onSelectionDone(); });
