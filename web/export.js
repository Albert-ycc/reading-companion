// 批注视图里的「导出」：把这本书的划线、眉批、问答、导图、概念整理成一份 Markdown（GET /api/export），存到读者选的文件夹。
// 服务是 launchd 起的，写外置盘会被 TCC 拦，所以文件由页面用 File System Access API 写：Chrome 记得上次选的文件夹（id: "banDu-export"）。
import { el, toast, apiOk, whyFailed } from "./ui.js";
import { registerSection } from "./panel.js";
import { currentBook } from "./reader.js";

const section = registerSection("notes", { label: "导出", order: 90 });
const saveBtn = el("button", { type: "button", className: "ex-main", textContent: "导出成读书笔记", onclick: () => run(saveMarkdown) });
const copyBtn = el("button", { type: "button", className: "ex-sub", textContent: "复制到剪贴板", onclick: () => run(copyMarkdown) });
const last = el("p", { className: "ex-last", hidden: true });
section.append(
  el("p", { className: "ex-hint", textContent: "划线、眉批、问答、导图、概念整理成一份 Markdown，每一条带页码。" }),
  el("div", { className: "ex-acts" }, saveBtn, copyBtn),
  last,
);

let working = false;
async function run(job) {
  if (working) return;
  working = true;
  saveBtn.disabled = copyBtn.disabled = true;
  try {
    await job();
  } finally {
    working = false;
    saveBtn.disabled = copyBtn.disabled = false;
  }
}

// 向服务端要这本书的读书笔记；没有书、没东西可导、服务端出错都在这里说清楚，返回 null
async function fetchNotes() {
  const book = currentBook();
  if (!book) { toast("先打开一本书"); return null; }
  let out;
  try {
    out = await apiOk(`/api/export?file=${encodeURIComponent(book.key)}&title=${encodeURIComponent(book.title || "")}`);
  } catch (err) {
    toast("没能整理出读书笔记：" + whyFailed(err, "再试一次"), undefined, 5000);
    return null;
  }
  if (out.empty) {
    toast(out.warnings?.length ? `这本书的${out.warnings.join("、")}没读出来，没有别的可导出` : "这本书还没有划线、问答或导图，没什么可导出的", undefined, 4000);
    return null;
  }
  return out;
}

const warned = (out) => (out.warnings?.length ? `（${out.warnings.join("、")}没读出来，没写进去）` : "");

async function saveMarkdown() {
  const out = await fetchNotes();
  if (!out) return;
  const blob = new Blob([out.markdown], { type: "text/markdown;charset=utf-8" });
  if (typeof window.showSaveFilePicker === "function") {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: out.filename, id: "banDu-export",
        types: [{ description: "Markdown", accept: { "text/markdown": [".md"] } }],
      });
    } catch (err) {
      if (err?.name === "AbortError") return; // 读者取消，不报错
      console.warn("文件选择框没能打开，改成下载：", err);
      return download(blob, out);
    }
    try {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } catch (err) {
      return toast(`没能写进「${handle.name}」：${err?.message || "再试一次"}`, undefined, 5000);
    }
    last.textContent = `已存到 ${handle.name}`;
    last.hidden = false;
    return toast(`已存到 ${handle.name}${warned(out)}`, undefined, out.warnings?.length ? 5000 : 3500);
  }
  download(blob, out);
}

// 浏览器没有文件选择框，或它打不开：退回成下载，文件在浏览器的下载文件夹里
function download(blob, out) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: out.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  last.textContent = `已下载 ${out.filename}`;
  last.hidden = false;
  toast(`已下载 ${out.filename}（在浏览器的下载文件夹里）${warned(out)}`, undefined, 4500);
}

async function copyMarkdown() {
  const out = await fetchNotes();
  if (!out) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(out.markdown);
    ok = true;
  } catch {
    // 页面没拿到焦点时 clipboard API 会拒绝：退回成选中一个看不见的输入框再复制
    const box = el("textarea", { value: out.markdown });
    Object.assign(box.style, { position: "fixed", left: "-9999px", top: "0", opacity: "0" });
    document.body.append(box);
    box.select();
    try { ok = document.execCommand("copy"); } catch {}
    box.remove();
  }
  toast(ok ? `已复制 ${out.markdown.length} 字${warned(out)}` : "没能复制，改点「导出成读书笔记」存成文件", undefined, ok ? 3000 : 4500);
}

window.addEventListener("book-opened", () => { last.hidden = true; });
