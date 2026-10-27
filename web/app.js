// 入口：书架 / 阅读器 / 对话栏的串联，外加拖入文件、Finder「打开方式」和安装到桌面
import { showLibrary, openHandle } from "./library.js";
import { loadChat } from "./chat.js";
import { $, toast, api } from "./ui.js";

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
const loads = ["./region.js", "./slash.js", "./predict.js", "./guide.js", "./mindmap.js",
  "./notes.js", "./export.js", "./learn.js", "./retell.js", "./errata.js", "./terms.js", "./recap.js", "./refs.js",
  "./compare.js", "./askall.js", "./socratic.js"].map((m) =>
  // 新 Chrome 档案第一次打开时偶尔有一个模块请求被 service worker 接管页面的那一刻掐断（实测 12 次里 1 次 mindmap.js），
  // 也防服务刚好忙不过来：失败了过 1 秒再请求一次（Chrome 不会把失败的模块请求记住，同一个地址能重新取），还不行才报
  import(m).catch(() => new Promise((r) => setTimeout(r, 1000)).then(() => import(m)))
    .catch((err) => console.error("功能模块加载失败：", m, err)));

// 数据文件读坏了，服务把它改名留底、功能按空的接着跑：读者看不出发生过什么，这里弹一次说明（/api/ping 的 quarantined 是这次服务运行里
// 留底的文件名）。每个留底文件只说一次，刷新页面也不重复（记在 sessionStorage）；启动、模块都加载完、窗口回到前台、切视图、答完一问时各查一次
const announced = new Set();
try { for (const n of JSON.parse(sessionStorage.getItem("banDu.quarantine") || "[]")) announced.add(n); } catch {}
let lastCheck = 0;
export async function checkQuarantine() {
  if (Date.now() - lastCheck < 2000) return;
  lastCheck = Date.now();
  let r;
  try { r = await api("/api/ping"); } catch { return; }
  const fresh = (Array.isArray(r?.quarantined) ? r.quarantined : []).filter((n) => typeof n === "string" && !announced.has(n));
  if (!fresh.length) return;
  fresh.forEach((n) => announced.add(n));
  try { sessionStorage.setItem("banDu.quarantine", JSON.stringify([...announced])); } catch {}
  toast(`有 ${fresh.length} 个数据文件读坏了，已改名留底在 data/ 里：${fresh.slice(0, 3).join("、")}${fresh.length > 3 ? " 等" : ""}`, undefined, 10000);
}
Promise.allSettled(loads).then(() => setTimeout(checkQuarantine, 1200));
window.addEventListener("focus", checkQuarantine);
window.addEventListener("view-changed", checkQuarantine);
window.addEventListener("answer-done", checkQuarantine);
