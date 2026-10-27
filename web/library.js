// 书架：书库文件夹（Chrome 授权一次，记住访问权）→ 扫出 PDF 清单 → 搜索 / 最近在读 → 交给阅读器
import { idb } from "./db.js";
import { openBook, renderCover, tidyText } from "./reader.js";
import { $, toast, api, el, setSpineTitle } from "./ui.js";

let indexCache = []; // [{rootId, rootName, name, path}]

export function showLibrary() {
  $("#viewer").hidden = true;
  $("#library").hidden = false;
  document.title = "伴读";
  setSpineTitle("伴读");
  $("#folio").hidden = true;
  $("#zoom").hidden = true;
  $("#home").classList.add("on");
  renderRecent();
  renderRoots();
}

function showViewer() {
  $("#library").hidden = true;
  $("#viewer").hidden = false;
  $("#home").classList.remove("on");
}

async function ensurePermission(handle) {
  if ((await handle.queryPermission({ mode: "read" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "read" })) === "granted";
}

const titleOf = (name) => name.replace(/\.pdf$/i, "");
const COVER_V = 2; // 封面算法的版本号：存下来的封面带这个号才算有效，改了算法就加一
// 书架上显示的书名：Anna's Archive 那种「书名 -- 作者 -- 出版社」的文件名只留书名，下划线当空格
export const tidyTitle = (t) => t.split(" -- ")[0].replace(/_+/g, " ").replace(/\s+/g, " ").trim();
const cjkRatio = (t) => (t.match(/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/g) || []).length / Math.max(1, t.replace(/\s/g, "").length);
// 题签封面：第一页是白纸的报告、文献，或封面还没渲染出来的书——靛布面、纸色题签写书名，中文竖排、西文横排
function genCover(title, numPages) {
  const t = tidyTitle(title);
  return el("span", { className: "gen" },
    el("span", { className: "tag " + (cjkRatio(t) >= 0.6 ? "v" : "h"), textContent: t }),
    numPages ? el("span", { className: "n", textContent: `${numPages} 页` }) : "");
}

// ---------- 打开一本书 ----------
const RESTART = "launchctl kickstart -k gui/$(id -u)/com.albert.reading-companion";

// 服务没在运行时给办法：提示条上的按钮把重启命令复制走
function serviceDownToast() {
  toast(`伴读的本地服务没在运行。终端里运行：${RESTART}`, {
    label: "复制命令", run: () => navigator.clipboard?.writeText(RESTART).catch(() => {}),
  });
}

// pdf.js 和文件系统的异常按类型翻成中文，原文不给用户看
function openError(err) {
  if (err.name === "NotFoundError") return "文件被移动或删除了";
  if (err.name === "PasswordException") return "这份 PDF 设了打开密码，暂时打不开";
  if (err.name === "InvalidPDFException") return "不是有效的 PDF，或者文件已经损坏";
  return err.message;
}

export async function openHandle(handle, key, title) {
  try {
    if (!(await ensurePermission(handle))) return toast("没拿到读取权限");
    const file = await handle.getFile();
    if (!file.size) return toast("打不开：这个文件是空的（0 字节）");
    showViewer();
    // 被后一次打开顶掉时 openBook 回 false：那次的结果归后一次，这里静默退出
    if ((await openBook(file, key, title)) === false) return;
    // 打开成功才记进「最近在读」：坏文件进去会把真书挤出只放 12 本的书架
    const old = await idb.get("books", key);
    const record = { key, title, handle, at: Date.now(), cover: old?.cover, blank: old?.blank, coverV: old?.coverV };
    await idb.put("books", key, record);
    // 书架上的封面：把第 1 页渲染成小图存下来。没打过 COVER_V 的重渲一次：早期版本存过整页空白的坏封面
    if (record.coverV !== COVER_V) {
      const r = await renderCover().catch(() => null);
      // 一片白是没画出来（比如 JPEG 2000 还没解出来），这次不记，下次打开再试；中途被从书架移除了就不再写回
      if (r && r.ink > 0 && (await idb.get("books", key))) {
        record.blank = r.ink < 0.06; // 第一页只有一两行字的报告：书架上用题签封面
        record.cover = record.blank ? null : r.cover;
        record.coverV = COVER_V;
        await idb.put("books", key, record);
      }
    }
  } catch (err) {
    showLibrary();
    if (err.name === "ServiceDown") serviceDownToast();
    else toast("打不开：" + openError(err));
  }
}

async function openFromIndex(item) {
  const root = await idb.get("roots", item.rootId);
  if (!root || !(await ensurePermission(root.handle))) return toast("没拿到书库文件夹的读取权限");
  const parts = item.path.split("/");
  let dir = root.handle;
  try {
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    const handle = await dir.getFileHandle(parts.at(-1));
    await openHandle(handle, `${root.name}/${item.path}`, titleOf(item.name));
  } catch {
    toast("文件不在原处了，点书库旁的「重新扫描」");
  }
}

export async function openSingleFile() {
  const [handle] = await window.showOpenFilePicker({
    id: "banDu-file", types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
  }).catch(() => []);
  if (handle) openHandle(handle, "文件/" + handle.name, titleOf(handle.name));
}

// ---------- 书库文件夹 ----------
async function addRoot() {
  const handle = await window.showDirectoryPicker({ id: "banDu-root", mode: "read" }).catch(() => null);
  if (!handle) return;
  for (const r of await idb.all("roots")) {
    if (await r.handle.isSameEntry(handle)) return toast("这个文件夹已经在书库里了");
  }
  const root = { id: crypto.randomUUID(), name: handle.name, handle };
  await idb.put("roots", root.id, root);
  await scan(root);
}

async function scan(root) {
  const status = $("#scan-status");
  try {
    if (!(await ensurePermission(root.handle))) return toast("没拿到读取权限");
    const files = [];
    async function walk(dir, prefix) {
      for await (const [name, h] of dir.entries()) {
        if (name.startsWith(".")) continue; // 含 macOS 的 ._ 资源文件
        if (h.kind === "directory") await walk(h, prefix + name + "/");
        else if (/\.pdf$/i.test(name)) {
          files.push({ name, path: prefix + name });
          if (files.length % 100 === 0) status.textContent = `正在扫描「${root.name}」：已找到 ${files.length} 个 PDF…`;
        }
      }
    }
    status.textContent = `正在扫描「${root.name}」…`;
    await walk(root.handle, "");
    await idb.put("index", root.id, { id: root.id, files, at: Date.now() });
    toast(`「${root.name}」里有 ${files.length} 个 PDF`);
    await loadIndex();
    renderRoots();
  } catch (err) {
    // 外置盘没接上时文件夹句柄还在、目录已经找不到；旧清单原样留着
    toast(err.name === "NotFoundError" ? `找不到「${root.name}」这个文件夹，外置盘没接上？` : `扫描「${root.name}」没成功：${err.message}`);
  } finally {
    status.textContent = "";
  }
}

async function loadIndex() {
  const roots = new Map((await idb.all("roots")).map((r) => [r.id, r]));
  indexCache = [];
  for (const idx of await idb.all("index")) {
    const root = roots.get(idx.id);
    if (root) for (const f of idx.files) indexCache.push({ rootId: root.id, rootName: root.name, ...f });
  }
}

async function renderRoots() {
  const box = $("#roots");
  const roots = await idb.all("roots");
  const counts = new Map((await idb.all("index")).map((i) => [i.id, i.files.length]));
  box.replaceChildren(...await Promise.all(roots.map(async (r) => {
    const granted = (await r.handle.queryPermission({ mode: "read" })) === "granted";
    return el("li", {},
      el("span", { className: "name", textContent: r.name }),
      el("span", { className: "leader" }),
      el("span", { className: "count" }, String(counts.get(r.id) ?? 0), el("small", { textContent: "个 PDF" })),
      el("span", { className: "acts" },
        granted ? "" : el("button", { textContent: "恢复访问", onclick: () => ensurePermission(r.handle).then(renderRoots) }),
        el("button", { textContent: "重新扫描", onclick: () => scan(r) }),
        el("button", {
          textContent: "移除",
          onclick: async () => {
            const index = await idb.get("index", r.id);
            await idb.del("roots", r.id);
            await idb.del("index", r.id);
            await loadIndex();
            renderRoots();
            toast(`已移除书库「${r.name}」`, {
              label: "撤销",
              run: async () => {
                await idb.put("roots", r.id, r);
                if (index) await idb.put("index", r.id, index);
                await loadIndex();
                renderRoots();
              },
            });
          },
        })));
  })));
  if (!roots.length) box.append(el("li", {}, el("span", { className: "muted", textContent: "还没有书库。点「添加书库文件夹」选一个放 PDF 的文件夹，比如外置盘里的「医学部」。" })));
}

// ---------- 最近在读 ----------
const fmtDate = (iso) => {
  const d = new Date(iso), now = new Date();
  if (isNaN(d)) return "";
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 864e5);
  if (days === 0) return `今天 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return "昨天";
  return (d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}年`) + `${d.getMonth() + 1}月${d.getDate()}日`;
};
// 书口厚度＝真实页数（0.6×√页数，3–20px），藤黄细线＝读到的位置
const edgeOf = (p) => p?.numPages ? Math.min(20, Math.max(3, 0.6 * Math.sqrt(p.numPages))) : 4;
const pctOf = (p) => p?.numPages ? Math.min(100, (p.page / p.numPages) * 100) : 0;

// 书的实体：封面 + 书口
function bookObj(b, p) {
  const face = b.cover ? el("img", { src: b.cover, alt: "" }) : genCover(b.title, p?.numPages);
  return el("div", { className: "obj" }, face, el("span", { className: "edge" }, el("i")));
}

// 「从最近在读移除」：书架上的书和书桌上那本共用
function removeBtn(b) {
  return el("button", {
    className: "rm", textContent: "×", title: "从最近在读移除",
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await idb.del("books", b.key);
      renderRecent();
      toast("已从最近在读移除", {
        label: "撤销",
        // 撤销前又打开过这本书，就是已经有更新的记录了，不覆盖
        run: async () => { if (!(await idb.get("books", b.key))) await idb.put("books", b.key, b); renderRecent(); },
      });
    },
  });
}

// 书桌：最近打开的那本摊在书架上面——大封面、读到哪、最近划的一句（没划过线就是正读的那段）、「接着读」
async function renderDesk(b, p, down) {
  const desk = $("#desk");
  desk.hidden = !b;
  if (!b) return;
  const info = down ? null : await api("/api/desk?file=" + encodeURIComponent(b.key)).catch(() => null);
  const open = (e) => { e.preventDefault(); openHandle(b.handle, b.key, b.title); };
  const quote = info?.last
    ? [el("p", { className: "ql", textContent: info.last.page ? `最近划的一句 · 第 ${info.last.page} 页` : "最近划的一句" }),
       el("p", { className: "q marked" }, el("mark", { textContent: tidyText(info.last.text) }))]
    : info?.excerpt
      ? [el("p", { className: "ql", textContent: `读到这里 · 第 ${info.excerpt.page} 页` }), el("p", { className: "q page", textContent: info.excerpt.text + "…" })]
      : [];
  const meta = p ? [`读到第 ${p.page} 页`, `共 ${p.numPages ?? "?"} 页`, fmtDate(p.at)].filter(Boolean).join(" · ") : down ? "—" : "还没开始读";
  const book = el("a", { className: "book", href: "#", title: b.title, onclick: open }, bookObj(b, p));
  book.style.setProperty("--e", edgeOf(p) + "px");
  desk.replaceChildren(book,
    el("div", { className: "info" },
      el("p", { className: "k", textContent: "正在读" }),
      el("h2", {}, el("a", { href: "#", textContent: tidyTitle(b.title), onclick: open })),
      el("p", { className: "m", textContent: meta }),
      el("div", { className: "bar" }, el("i")),
      ...quote,
      el("div", { className: "acts" },
        el("button", { className: "btn solid", textContent: p ? `接着读第 ${p.page} 页` : "打开", onclick: open }),
        info ? el("span", { className: "st", textContent: `划线 ${info.highlights} · 提问 ${info.questions}` }) : "")),
    removeBtn(b));
  desk.style.setProperty("--p", pctOf(p) + "%");
}

async function renderRecent() {
  const books = (await idb.all("books")).sort((a, b) => b.at - a.at).slice(0, 12);
  let progress = {};
  let down = false;
  try {
    progress = await api("/api/library");
  } catch (err) {
    // 读不到进度就不能写「未读」，那是在说谎
    down = err.name === "ServiceDown";
    if (down) serviceDownToast();
  }
  const [now, ...rest] = books;
  await renderDesk(now, now ? progress[now.key] : null, down);
  // 书桌上那本不再摆在架上；只有一本时整个「最近在读」收起
  $("#recent-head").hidden = $("#recent").hidden = books.length === 1;
  $("#recent").replaceChildren(...rest.map((b) => {
    const p = progress[b.key];
    const open = (e) => { e.preventDefault(); openHandle(b.handle, b.key, b.title); };
    const book = el("a", { className: "book", href: "#", title: b.title + (p ? `　${p.page} / ${p.numPages} 页` : ""), onclick: open },
      bookObj(b, p),
      el("p", { className: "t", textContent: tidyTitle(b.title) }),
      el("div", { className: "bar" }, el("i")),
      el("p", { className: "n" }, p ? `${p.page} / ${p.numPages ?? "?"}` : down ? "—" : "未读", el("small", { textContent: p ? "页" : "" })),
      removeBtn(b));
    book.style.setProperty("--e", edgeOf(p) + "px");
    book.style.setProperty("--p", pctOf(p) + "%");
    return book;
  }));
  if (!books.length) $("#recent").append(el("p", { className: "muted", textContent: "打开过的书会摆在这里。" }));
}

// ---------- 搜索 ----------
function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const box = $("#results");
  box.hidden = !terms.length;
  if (!terms.length) return box.replaceChildren();
  const hits = indexCache.filter((f) => terms.every((t) => f.path.toLowerCase().includes(t))).slice(0, 50);
  box.replaceChildren(...hits.map((f) => el("li", {},
    el("a", { className: "name", href: "#", textContent: titleOf(f.name), title: f.path, onclick: (e) => { e.preventDefault(); openFromIndex(f); } }),
    el("span", { className: "leader" }),
    el("span", { className: "path", textContent: f.rootName + "/" + f.path.split("/").slice(0, -1).join("/") }))));
  if (!hits.length) box.append(el("li", {}, el("span", { className: "muted", textContent: indexCache.length ? "没找到，换个关键词试试。" : "先添加书库文件夹，才能搜。" })));
}

$("#search").addEventListener("input", (e) => search(e.target.value));
$("#add-root").addEventListener("click", addRoot);
$("#open-file").addEventListener("click", openSingleFile);
loadIndex();
