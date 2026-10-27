// 书架：书库文件夹（Chrome 授权一次，记住访问权）→ 扫出 PDF 清单 → 搜索 / 最近在读 → 交给阅读器
import { idb } from "./db.js";
import { openBook, renderCover } from "./reader.js";
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
    const record = { key, title, handle, at: Date.now(), cover: old?.cover };
    await idb.put("books", key, record);
    // 书架上的封面：第一次打开时把第 1 页渲染成小图存下来
    if (!record.cover) {
      record.cover = await renderCover().catch(() => null);
      if (record.cover) await idb.put("books", key, record);
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
  $("#recent").replaceChildren(...books.map((b) => {
    const p = progress[b.key];
    const pct = p?.numPages ? Math.min(100, (p.page / p.numPages) * 100) : 0;
    // 书口厚度＝真实页数（0.6×√页数，3–20px），藤黄细线＝读到的位置
    const edge = p?.numPages ? Math.min(20, Math.max(3, 0.6 * Math.sqrt(p.numPages))) : 4;
    const open = (e) => { e.preventDefault(); openHandle(b.handle, b.key, b.title); };
    const face = b.cover
      ? el("img", { src: b.cover, alt: "" })
      : el("span", { className: "plain", textContent: b.title });
    const book = el("a", { className: "book", href: "#", title: b.title + (p ? `　${p.page} / ${p.numPages} 页` : ""), onclick: open },
      el("div", { className: "obj" }, face, el("span", { className: "edge" }, el("i"))),
      el("p", { className: "t", textContent: b.title }),
      el("div", { className: "bar" }, el("i")),
      el("p", { className: "n" }, p ? `${p.page} / ${p.numPages ?? "?"}` : down ? "—" : "未读", el("small", { textContent: p ? "页" : "" })),
      el("button", {
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
      }));
    book.style.setProperty("--e", edge + "px");
    book.style.setProperty("--p", pct + "%");
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
