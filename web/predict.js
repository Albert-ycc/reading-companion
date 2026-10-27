// 划线后的输入预测：猜你接下来最可能问的三句，Tab 填进输入框接着改，不用就照常自己打字。
// 交互参照 Claude Code 的 prompt suggestion：输入框空着时，当前那条以灰字显示在输入框里，Tab 采纳，一打字就隐去。
// 它一次只给一条，这里三条列在输入框上方，↑↓ 换一条、点一下也能采纳，Esc 收起。
// 前两条猜你最可能打的；第三条固定是「深一层」的问题（你未必想得到、但读懂这句要过的那一关），带标签和前两条区分开。
// 三条占用快捷按钮那一行：划线后到收起之前不显示快捷按钮；没划线、没猜出来、发出提问后，快捷按钮照旧
import { readingContext } from "./reader.js";
import { $, el } from "./ui.js";
import { currentView } from "./panel.js";
import { answering } from "./chat.js";

const input = $("#q");
const composer = $(".composer");
const box = el("div", { id: "predict", hidden: true });
box.setAttribute("role", "listbox");
box.setAttribute("aria-label", "你可能想问");
$("#chips").before(box);

const PREDICT_DELAY = 1000; // 划线后停这么久没再划才去猜：连划几句时只为最后一句起进程（每次猜都是一个 claude 进程）
let state = "idle"; // idle 没有预测（快捷按钮照旧）/ loading 正在猜 / ready 三条已出
let preds = [];
let deep = -1; // 深一层那条在 preds 里的下标，没有时 -1
let active = 0;
let forText = ""; // 这组预测对应的划线文字：Claude 看到的换了（点了别的旧划线），这组就作废
let timer = null; // 等着去猜的那一下
let ctrl = null; // 在途的预测请求；换一句划线时中止，服务端随即杀掉 claude
let skipped = ""; // 不在问答视图、或 Claude 正在答题时划的那句：切回来 / 答完再猜
let savedPlaceholder = null; // 输入框原来的提示语，灰字预测收起时放回去
const kbd = (t) => el("kbd", { textContent: t });

function cancel() {
  clearTimeout(timer);
  timer = null;
  ctrl?.abort();
  ctrl = null;
}

function reset() {
  cancel();
  state = "idle";
  preds = [];
  forText = "";
  skipped = "";
  render();
}

// 「Claude 看到」的已经不是这一句：预测作废
const stale = () => state !== "idle" && readingContext()?.selection?.text !== forText;

function render() {
  if (stale()) { cancel(); state = "idle"; preds = []; forText = ""; }
  const own = state !== "idle" && currentView() === "chat";
  composer.classList.toggle("predicting", own); // 占住快捷按钮那一行
  const show = own && !input.value; // 自己打字时收起，删空了再出来
  box.hidden = !show;
  const ghost = show && state === "ready";
  if (ghost) {
    savedPlaceholder ??= input.placeholder;
    input.placeholder = preds[active];
  } else if (savedPlaceholder !== null) {
    input.placeholder = savedPlaceholder;
    savedPlaceholder = null;
  }
  input.classList.toggle("predict-ghost", ghost);
  if (!show) return;
  if (state === "loading") {
    box.replaceChildren(el("div", { className: "pd-status", textContent: "正在猜你可能想问的…" }));
    return;
  }
  box.replaceChildren(
    el("div", { className: "pd-head" }, el("span", { textContent: "你可能想问" }),
      el("span", { className: "pd-keys" }, kbd("↑↓"), " 换一条　", kbd("Tab"), " 填进输入框　", kbd("Esc"), " 不用")),
    ...preds.map((p, i) => {
      const row = el("div", { className: "pd-item" + (i === deep ? " deep" : ""), id: "pd-opt-" + i },
        ...(i === deep ? [el("span", { className: "pd-deep", textContent: "深一层" })] : []), p);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === active));
      if (i === active) row.append(el("kbd", { className: "pd-tab", textContent: "Tab" }));
      row.addEventListener("mousedown", (e) => e.preventDefault()); // 点选不让输入框失焦
      row.addEventListener("click", () => adopt(i));
      return row;
    }));
}
// 采纳：整句填进输入框，光标停在末尾，接着改；不发送
function adopt(i) {
  if (state !== "ready" || !preds[i]) return;
  active = i;
  input.value = preds[i];
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function start() {
  const ctx = readingContext();
  const sel = ctx?.selection;
  if (!sel?.text || sel.kind) return reset(); // 只为文字划线猜；框选的是图表，另说
  reset();
  // 不在问答视图（猜出来也看不见）、Claude 正在答题：先不猜，切回来 / 答完再猜这一句
  if (currentView() !== "chat" || answering()) { skipped = sel.text; return; }
  state = "loading";
  active = 0;
  forText = sel.text;
  render();
  timer = setTimeout(() => { timer = null; predict(ctx, sel); }, PREDICT_DELAY);
}

// 先前没猜的那句还是「Claude 看到」的：现在猜
function resume() {
  if (skipped && readingContext()?.selection?.text === skipped) start();
}

async function predict(ctx, sel) {
  const mine = ctrl = new AbortController();
  let res = null;
  try {
    const r = await fetch("/api/predict", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: mine.signal,
      body: JSON.stringify({ file: ctx.file, title: ctx.title, page: sel.page, selection: { text: sel.text, before: sel.before, after: sel.after, ocr: sel.ocr } }),
    });
    res = await r.json();
  } catch { /* 中止、服务没在运行：快捷按钮照旧 */ }
  if (ctrl !== mine) return; // 已经换了一句划线
  ctrl = null;
  const raw = Array.isArray(res?.predictions) ? res.predictions.slice(0, 3) : [];
  const list = raw.filter((p) => typeof p === "string" && p.trim());
  if (!list.length) return reset();
  state = "ready";
  preds = list;
  deep = list.length === raw.length && Number.isInteger(res.deep) && res.deep < list.length ? res.deep : -1; // 有被筛掉的就不认下标，免得标错条
  render();
}

// 捕获阶段：输入框空着、三条已出时，Tab / ↑↓ / Esc 归预测；输入框里有字时一概不管（「/」菜单只在有字时工作，两边不重叠）
input.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || input.value || box.hidden || state !== "ready") return;
  if (stale()) return render();
  const plain = !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey);
  if (e.key === "Tab" && plain) {
    e.preventDefault();
    adopt(active);
  } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && plain) {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : preds.length - 1)) % preds.length;
    render();
  } else if (e.key === "Escape") {
    e.preventDefault();
    reset();
  }
}, true);
input.addEventListener("input", render);
input.addEventListener("focus", render);
window.addEventListener("question-sent", reset); // 一问发出去了（输入框、快捷按钮、「/」菜单都算）就收起；没发出去（Claude 还在答）预测留着

window.addEventListener("highlight", (e) => { if (!e.detail?.kind) start(); });
window.addEventListener("highlight-removed", (e) => { if (e.detail?.text === forText || e.detail?.text === skipped) reset(); });
window.addEventListener("focus-passage", reset); // Claude 看到的换成了一段译文或导读里的原文
window.addEventListener("book-opened", reset);
window.addEventListener("answer-done", resume);
window.addEventListener("view-changed", () => { render(); resume(); });
