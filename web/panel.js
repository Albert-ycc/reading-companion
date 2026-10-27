// 批注栏的视图外壳：问答 · 批注 · 导读 · 导图 · 学习。
// 功能模块调 registerView 挂上自己的视图，拿到一个容器自己往里画；外壳只管标签和切换。
// 「批注」「学习」是两个由小节拼成的容器视图：模块调 registerSection 往里加一节，不用自己管滚动和排序。
import { $, el } from "./ui.js";

const views = new Map(); // name -> { label, order, node, tab, onShow, onHide, composer, secs?, sections? }
let current = "chat";

function renderTabs() {
  const list = [...views.values()].sort((a, b) => a.order - b.order);
  $("#tabs").replaceChildren(...list.map((v) => v.tab));
  $("#tabs").hidden = list.length < 2; // 只有问答一个视图时不显示标签
}

// opts.composer=false：这个视图里收起底下的输入框（比如导图要竖向空间）
export function registerView(name, { label, order = 50, onShow, onHide, composer = true } = {}) {
  const node = name === "chat" ? $("#view-chat") : el("div", { className: "view", id: "view-" + name, hidden: true });
  if (name !== "chat") $("#view-chat").after(node);
  const tab = el("button", { className: "tab", type: "button", textContent: label, onclick: () => showView(name) });
  views.set(name, { label, order, node, tab, onShow, onHide, composer });
  renderTabs();
  if (name === current) tab.classList.add("on");
  return node;
}

export function showView(name) {
  const next = views.get(name);
  if (!next || name === current) return;
  const prev = views.get(current);
  prev.node.hidden = true;
  prev.tab.classList.remove("on");
  prev.onHide?.();
  next.node.hidden = false;
  next.tab.classList.add("on");
  current = name;
  if (next.badge === "done") setBadge(name, null); // 看过了，靛点消失
  $(".chat-tools").hidden = name !== "chat"; // 「历史」「新对话」只属于问答
  $(".composer").hidden = !next.composer;
  next.onShow?.();
  for (const s of next.sections || []) {
    try { s.onShow?.(); } catch (err) { console.error("小节 onShow 出错：", s.label, err); } // 一节写坏不影响别的节
  }
  window.dispatchEvent(new CustomEvent("view-changed", { detail: { view: name } }));
}

export const currentView = () => current;

// 标签旁的小点：busy＝在后台生成（脉动藤黄），done＝生成完还没看（静止靛点），null＝去掉。
// 人就在这个标签里时 done 不显示
export function setBadge(name, state) {
  const v = views.get(name);
  if (!v) return;
  if (state === "done" && name === current) state = null;
  v.badge = state;
  v.tab.querySelector(".dot")?.remove();
  if (state) v.tab.append(el("span", { className: "dot " + state }));
}

// 往一个容器视图（批注、学习）里加一节：返回 <section class="sec">，里面已有 <h3 class="sec-h">label</h3>，模块往 h3 后面画。
// 各节按 order 从小到大排在视图的 .secs 滚动容器里（同序按登记先后），该视图每次显示时依次调各节的 onShow()。
// 视图不存在（或是问答视图，它不是由小节拼的）时抛错
export function registerSection(view, { label, order = 50, onShow } = {}) {
  const v = views.get(view);
  if (!v || view === "chat") throw new Error(`registerSection：没有「${view}」这个可以加小节的视图`);
  if (!v.secs) {
    v.secs = el("div", { className: "secs" });
    v.node.append(v.secs);
    v.sections = [];
  }
  const node = el("section", { className: "sec" }, el("h3", { className: "sec-h", textContent: label }));
  node.dataset.sec = label;
  v.sections.push({ label, order, onShow, node });
  v.sections.sort((a, b) => a.order - b.order); // 稳定排序：同序的保持登记先后
  v.secs.replaceChildren(...v.sections.map((s) => s.node));
  return node;
}

registerView("chat", { label: "问答", order: 0 });
// 两个由小节拼成的容器视图：批注（划线与眉批、勘误、导出……）、学习（小问题、复习、概念、术语、复述……）。
// 标签位置夹在问答、导读之间 / 排在导图之后；里面没有任何一节时显示一句空状态（模块都没加载上时）
for (const [name, label, order] of [["notes", "批注", 5], ["learn", "学习", 40]]) {
  const node = registerView(name, { label, order, composer: false });
  const secs = el("div", { className: "secs" });
  node.append(secs);
  Object.assign(views.get(name), { secs, sections: [] });
}
