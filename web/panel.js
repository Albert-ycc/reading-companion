// 批注栏的视图外壳：问答 · 导读 · 导图。
// 功能模块调 registerView 挂上自己的视图，拿到一个容器自己往里画；外壳只管标签和切换。
import { $, el } from "./ui.js";

const views = new Map(); // name -> { label, order, node, tab, onShow, onHide, composer }
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

registerView("chat", { label: "问答", order: 0 });
