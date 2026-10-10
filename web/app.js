// 入口：书架 / 阅读器 / 对话栏的串联，外加拖入文件、Finder「打开方式」和安装到桌面
import { showLibrary, openHandle } from "./library.js";
import { loadChat } from "./chat.js";
import { $, toast } from "./ui.js";

const titleOf = (name) => name.replace(/\.pdf$/i, "");

$("#home").addEventListener("click", showLibrary);

// 把 PDF 从 Finder 拖进窗口
window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const item = [...e.dataTransfer.items].find((i) => i.kind === "file");
  const handle = await item?.getAsFileSystemHandle();
  if (!handle || handle.kind !== "file" || !/\.pdf$/i.test(handle.name)) return toast("只支持 PDF");
  openHandle(handle, "文件/" + handle.name, titleOf(handle.name));
});

// 安装成桌面应用后，在 Finder 里对 PDF 选「打开方式 → 伴读」会走这里
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(({ files }) => {
    if (files?.length) openHandle(files[0], "文件/" + files[0].name, titleOf(files[0].name));
  });
}

// 「安装到桌面」按钮：Chrome 判断可安装时才出现
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("#install").hidden = false;
});
$("#install").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  if ((await installEvent.userChoice).outcome === "accepted") $("#install").hidden = true;
});
window.addEventListener("appinstalled", () => { $("#install").hidden = true; toast("装好了，以后从启动台或程序坞打开「伴读」"); });

// 版心是书页和批注栏的分界：按住空白处左右拖，批注栏跟着变宽变窄，宽度记在本机浏览器里。
// 书页那边由阅读器按剩下的宽度重排，放得下两页就双页（reader.js 的 fit）
const PI_MIN = 340, LEFT_MIN = 420, SPINE_W = 56;
const piCol = (w) => `clamp(${PI_MIN}px, ${w}px, calc(100vw - ${SPINE_W + LEFT_MIN}px))`; // 窗口变窄时书页至少留 420px
try {
  const w = +localStorage.getItem("banDu.piWidth");
  if (w > 0) $(".frame").style.setProperty("--pi-col", piCol(w));
} catch {}
$(".spine").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  e.preventDefault();
  const spine = e.currentTarget;
  const x0 = e.clientX;
  const w0 = Math.round($("#chat").getBoundingClientRect().width);
  let w = w0;
  spine.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  const move = (ev) => {
    w = Math.round(Math.max(Math.min(w0 + x0 - ev.clientX, innerWidth - SPINE_W - LEFT_MIN), PI_MIN));
    $(".frame").style.setProperty("--pi-col", piCol(w));
  };
  const up = () => {
    spine.removeEventListener("pointermove", move);
    spine.removeEventListener("pointerup", up);
    spine.removeEventListener("pointercancel", up);
    document.body.classList.remove("resizing");
    if (w !== w0) try { localStorage.setItem("banDu.piWidth", String(w)); } catch {}
  };
  spine.addEventListener("pointermove", move);
  spine.addEventListener("pointerup", up);
  spine.addEventListener("pointercancel", up);
});

navigator.serviceWorker?.register("/sw.js");
showLibrary();
loadChat();

// 功能模块：各自独立加载，写坏一个只在控制台报错，不影响别的
for (const m of ["./region.js", "./slash.js", "./predict.js", "./guide.js", "./mindmap.js"]) {
  import(m).catch((err) => console.error("功能模块加载失败：", m, err));
}
