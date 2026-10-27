// 勘误本：Claude 在回答里指出书里译错、识别认错、原文印错的地方，答完由服务端（features/errata.py）记下。
// 这里做三件事：批注视图里的「勘误」一节、有勘误的书页右上角的小标、答完后在「批注」标签上点一个靛点。
import { registerSection, showView, setBadge } from "./panel.js";
import { currentBook, revealPassage, gotoPage, pageDiv, renderPage } from "./reader.js";
import { api, apiOk, el, toast, whyFailed } from "./ui.js";

const POLL_MS = 5000;
const POLL_MAX_MS = 120000; // 问出去后最多查两分钟；回答还没答完时，答完（answer-done）再续 45 秒，抽取在回答存盘之后才开始
const POLL_AFTER_ANSWER_MS = 45000;

let key = ""; // items 属于哪本书
let items = []; // 这本书的勘误，按页排
let seq = 0; // 请求序号：慢的旧请求回来时发现已经不是最新的，丢掉
const pages = new Map(); // 页码 -> 文字层就绪的 .page：页角小标挂在这上面

const sec = registerSection("notes", { label: "勘误", order: 50, onShow: () => load() });
sec.classList.add("errata-sec");
const body = el("div", { className: "er-body" });
sec.append(body);

// ---------- 取数 ----------
const sane = (it) => it && typeof it.id === "string" && Number.isInteger(it.page) && it.page >= 1
  && typeof it.original === "string" && typeof it.correction === "string";

// 返回这本书当前的条数；没取到（服务没开、换书了、被新请求顶掉）返回 undefined，原样留着
async function load() {
  const book = currentBook();
  if (!book) {
    ++seq;
    if (key || items.length) { key = ""; items = []; sync(); }
    else render();
    return 0;
  }
  const mine = ++seq;
  let data;
  try {
    data = await api("/api/errata?file=" + encodeURIComponent(book.key));
  } catch {
    return undefined;
  }
  if (mine !== seq || currentBook()?.key !== book.key || !Array.isArray(data?.items)) return undefined;
  const list = data.items.filter(sane).sort((a, b) => a.page - b.page);
  const changed = key !== book.key || JSON.stringify(list) !== JSON.stringify(items);
  key = book.key;
  items = list;
  if (changed) sync();
  return list.length;
}

// 列表和页角小标一起重画
function sync() {
  render();
  for (const [page, div] of pages) {
    if (!div.isConnected) pages.delete(page);
    else mark(page, div);
  }
}

// ---------- 批注视图里的「勘误」一节 ----------
function render() {
  const mine = key && key === currentBook()?.key ? items : [];
  if (!mine.length) {
    body.replaceChildren(el("p", { className: "er-empty", textContent: "Claude 指出书里的错时会记在这里" }));
    return;
  }
  body.replaceChildren(el("ol", { className: "er-list" }, ...mine.map(row)));
}

function row(it) {
  const li = el("li", { className: "er-item" });
  li.dataset.id = it.id;
  li.dataset.page = String(it.page);
  const pg = el("button", { className: "er-pg", type: "button", textContent: `第 ${it.page} 页`, title: "回到书里这一处", onclick: () => jump(it) });
  const del = el("button", { className: "er-del", type: "button", textContent: "删掉", title: "这条勘误记错了，删掉", onclick: () => remove(it, del) });
  li.append(
    el("div", { className: "er-head" }, pg, el("span", { className: "er-kind", textContent: it.kind || "勘误" }), del),
    el("p", { className: "er-fix" },
      el("span", { className: "er-from", textContent: it.original }),
      el("span", { className: "er-arrow", textContent: "→", ariaLabel: "应为" }),
      el("span", { className: "er-to", textContent: it.correction })),
  );
  if (it.why) li.append(el("p", { className: "er-why", textContent: it.why }));
  return li;
}

async function remove(it, btn) {
  btn.disabled = true;
  try {
    await apiOk("/api/errata/delete", { id: it.id });
  } catch (err) {
    btn.disabled = false;
    return toast(whyFailed(err, "没删掉，再点一次试试"));
  }
  if (key !== currentBook()?.key) return;
  items = items.filter((x) => x.id !== it.id);
  sync();
}

// 点「第 N 页」：跳到书里那一处。译文的错字在对照的译文块里，先找译文块；其余走 revealPassage（按原文定位、闪一下），
// 找不到退回页顶
async function jump(it) {
  if (!currentBook() || !pageDiv(it.page)) return toast(`这本书里没有第 ${it.page} 页`);
  const k = key;
  if (it.kind === "译文") {
    gotoPage(it.page);
    try { await renderPage(it.page); } catch { /* 页画不出来就走下面的退路 */ }
    if (k !== currentBook()?.key) return;
    const tr = findTranslation(it);
    if (tr) return landOn(tr);
  }
  let ok = false;
  try { ok = await revealPassage(it.page, it.original); } catch { /* 当成没找到 */ }
  if (!ok && k === currentBook()?.key) gotoPage(it.page);
}

const squash = (s) => s.normalize("NFKC").replace(/[\s「」『』“”‘’"'`，。、；：！？,.;:!?（）()[\]【】]/g, "").toLowerCase();

function findTranslation(it) {
  const want = squash(it.original);
  if (!want) return null;
  return [...(pageDiv(it.page)?.querySelectorAll(".tr") || [])].find((t) => squash(t.textContent || "").includes(want)) || null;
}

function landOn(node) {
  const viewer = document.querySelector("#viewer");
  if (viewer) viewer.scrollTop += node.getBoundingClientRect().top - viewer.getBoundingClientRect().top - viewer.clientHeight * 0.35;
  node.classList.remove("er-flash");
  void node.offsetWidth; // 连点两次也重新闪
  node.classList.add("er-flash");
  setTimeout(() => node.classList.remove("er-flash"), 1900);
}

// ---------- 页角小标 ----------
// 同一页会收到多次 page-rendered（对照重排、重新识别之后都会再发），所以每次先清掉自己上次放的再放
function mark(page, div) {
  div.querySelector(":scope > .er-flag")?.remove();
  if (!key || key !== currentBook()?.key) return;
  const here = items.filter((it) => it.page === page);
  if (!here.length) return;
  const n = here.length;
  const flag = el("button", { className: "er-flag", type: "button", title: `本页有 ${n} 处勘误`, ariaLabel: `本页有 ${n} 处勘误，点开看` },
    el("span", { className: "er-mark", textContent: "勘" }), ...(n > 1 ? [el("span", { className: "er-n", textContent: String(n) })] : []));
  // 页上的选区、划线工具栏、点旧划线的菜单都挂在 document 上监听鼠标：小标上的鼠标事件到此为止，也不让按下去把页上的选区点散
  flag.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
  for (const t of ["mouseup", "pointerdown", "pointerup", "dblclick"]) flag.addEventListener(t, (e) => e.stopPropagation());
  flag.addEventListener("click", (e) => { e.stopPropagation(); showErrata(page); });
  div.append(flag);
}

// 点小标：切到批注视图，滚到这一页的第一条，让它闪一下
function showErrata(page) {
  showView("notes");
  const li = body.querySelector(`.er-item[data-page="${page}"]`);
  if (!li) return;
  const box = li.closest(".secs");
  if (box) box.scrollTop += li.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
  li.classList.remove("er-hit");
  void li.offsetWidth;
  li.classList.add("er-hit");
  setTimeout(() => li.classList.remove("er-hit"), 1900);
  load(); // 顺手取一次最新的
}

window.addEventListener("page-rendered", (e) => {
  const { page, div } = e.detail || {};
  if (!Number.isInteger(page) || !(div instanceof Element)) return;
  pages.set(page, div);
  const k = currentBook()?.key;
  if (k && k !== key) load(); // 刚换书，手上还是上一本的勘误：取回来后 sync 会给已画好的页补小标
  mark(page, div);
});

window.addEventListener("page-cleared", (e) => {
  const page = e.detail?.page;
  pages.get(page)?.querySelector(":scope > .er-flag")?.remove();
  pages.delete(page);
});

// 换书：清掉上一本的条目和所有小标，再取这一本的。新书最先画好的页可能在 book-opened 之前就发过 page-rendered，
// 所以只丢掉已经不是当前书的页，其余的留着，取回数据后补小标
window.addEventListener("book-opened", () => {
  for (const [page, div] of pages) {
    div.querySelector(":scope > .er-flag")?.remove();
    if (!div.isConnected || pageDiv(page) !== div) pages.delete(page);
  }
  stopPoll();
  key = "";
  items = [];
  render();
  load();
});

// ---------- 答完后的靛点 ----------
// 抽取在回答存盘之后才开始（粗筛 + 一次 Sonnet，几秒），页面没有「抽完了」的通知，只能问：
// 问出去后每 5 秒查一次，条数比问之前多了就在「批注」标签上点靛点
let poll = null;

function stopPoll() {
  if (poll) clearInterval(poll.timer);
  poll = null;
}

window.addEventListener("question-sent", async () => {
  const book = currentBook();
  stopPoll();
  if (!book) return;
  const base = await load();
  if (base === undefined || currentBook()?.key !== book.key) return;
  const p = poll = { k: book.key, base, until: Date.now() + POLL_MAX_MS, busy: false };
  p.timer = setInterval(async () => {
    if (poll !== p) return;
    if (currentBook()?.key !== p.k || Date.now() > p.until) return stopPoll(); // 先看到点没有：上一次请求挂住时也要能收场
    if (p.busy) return;
    p.busy = true;
    const n = await load();
    p.busy = false;
    if (poll === p && typeof n === "number" && n > p.base) {
      setBadge("notes", "done");
      stopPoll();
    }
  }, POLL_MS);
});

// 回答要是超过两分钟才答完，抽取还没开始：从答完起再查一阵
window.addEventListener("answer-done", () => {
  if (poll) poll.until = Math.max(poll.until, Date.now() + POLL_AFTER_ANSWER_MS);
});

render();
load();
