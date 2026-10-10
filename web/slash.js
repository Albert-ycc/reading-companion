// 输入框的「/」菜单：在输入框开头敲「/」，从伴读自己的功能（registry.js 登记）和精选的 Claude skill 里选。
// 选中功能：清掉「/xxx」直接执行；选中 skill / 项目命令：输入框变成「/名字 」，光标停在后面接着打字，回车照常发送，
// 由 Claude 按这个 skill 回答（后台 claude -p 认「/名字 参数」）。
import { listActions } from "./registry.js";
import { $, el, toast } from "./ui.js";

const input = $("#q");
const form = $("#ask");
const TOKEN = /^[/／、]\S*/; // 输入框开头的「/xxx」；中文输入法下「/」可能变成全角「／」或「、」
const GROUPS = [["action", "伴读功能"], ["method", "Claude 方法"]];

// ---------- 服务端给的 skill / 项目命令 ----------
let remote = [];
let fetchedAt = 0;
// 服务端给的条目只收结构对的：一条坏数据不能让整个菜单（连同「/导读」「/导图」）打不开
function cleanRemote(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((c) => c && typeof c.name === "string" && c.name).map((c) => ({
    kind: c.kind === "command" ? "command" : "skill", name: c.name,
    label: typeof c.label === "string" && c.label ? c.label : c.name,
    desc: typeof c.desc === "string" ? c.desc : "",
    keys: Array.isArray(c.keys) ? c.keys.filter((k) => typeof k === "string") : [],
  }));
}
async function loadRemote() {
  if (Date.now() - fetchedAt < 3000) return false;
  fetchedAt = Date.now();
  try {
    const res = await fetch("/api/commands");
    if (res.ok) remote = cleanRemote((await res.json())?.items);
  } catch { /* 取不到时菜单里只剩伴读功能 */ }
  return true;
}

// ---------- 搜索：英文名、中文名、拼音首字母 ----------
// 汉字 → 拼音首字母：按拼音排序规则在 23 个声母边界字里比大小，不引入拼音库
const BOUND = "阿八嚓哒妸发旮哈讥咔垃痳拏噢妑七呥扨它穵夕丫帀";
const LETTERS = "abcdefghjklmnopqrstwxyz";
const collator = new Intl.Collator("zh-Hans-CN");
const initials = (s) => [...s].map((ch) => {
  if (!/[一-鿿]/.test(ch)) return ch.toLowerCase();
  let r = "";
  for (let i = 0; i < BOUND.length && collator.compare(BOUND[i], ch) <= 0; i++) r = LETTERS[i];
  return r;
}).join("");

function entries() {
  const acts = listActions().map((a) => ({ kind: "action", name: a.name, label: a.label || a.name, desc: a.desc || "", keys: [], run: a.run }));
  const taken = new Set(acts.map((a) => a.name)); // 同名的以功能为准
  return [...acts, ...remote.filter((c) => !taken.has(c.name))].map((e) => ({
    ...e, group: e.kind === "action" ? "action" : "method",
    py: [initials(e.label), initials(e.name)],
  }));
}

// 越小越靠前，-1 表示不匹配
function score(e, q) {
  if (!q) return 0;
  const name = e.name.toLowerCase(), label = e.label.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (label.startsWith(q)) return 1;
  if (e.py.some((p) => p.startsWith(q))) return 2;
  if (name.includes(q) || label.includes(q)) return 3;
  if (e.keys.some((k) => k.toLowerCase().includes(q))) return 4;
  if (e.py.some((p) => p.includes(q))) return 5;
  return -1;
}

function filter(q) {
  const scored = entries().map((e, i) => ({ e, s: score(e, q), i })).filter((x) => x.s >= 0);
  const out = [];
  for (const [g] of GROUPS) {
    const part = scored.filter((x) => x.e.group === g);
    if (q) part.sort((a, b) => a.s - b.s || a.i - b.i);
    out.push(...part.map((x) => x.e));
  }
  return out;
}

// ---------- 菜单 ----------
const withAttrs = (node, attrs) => { for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
const kbd = (...k) => el("span", {}, ...k.map((t) => el("kbd", { textContent: t })));
const menu = withAttrs(el("div", { id: "slash-menu", hidden: true }), { role: "listbox", "aria-label": "命令" });
const list = el("div", { className: "sl-list" });
menu.append(list, el("div", { className: "sl-foot" },
  el("span", {}, kbd("↑", "↓"), " 选择"), el("span", {}, kbd("↵"), " 选定"), el("span", {}, kbd("Esc"), " 关闭")));
form.append(menu);
withAttrs(input, { "aria-controls": "slash-menu", "aria-autocomplete": "list", "aria-expanded": "false" });
input.placeholder = "回车发送，Shift+回车换行，/ 调出命令"; // 菜单模块加载成功才有这句提示

let open = false;
let items = [];
let active = 0;
let lastQuery = null;
let dismissed = false; // Esc 关掉后，到用户下一次敲字前不再弹出
let composing = false; // 输入法组字中

// 命中的那几个字用荧光笔标出来，和划线同一个手法
function marked(text, q) {
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return [text];
  return [text.slice(0, at), el("mark", { textContent: text.slice(at, at + q.length) }), text.slice(at + q.length)];
}

function render(q) {
  const nodes = [];
  let idx = 0;
  for (const [g, title] of GROUPS) {
    const part = items.filter((e) => e.group === g);
    if (!part.length) continue;
    nodes.push(el("div", { className: "sl-group", textContent: title }));
    for (const e of part) {
      const i = idx++;
      const top = el("div", { className: "sl-top" },
        el("span", { className: "sl-name" }, el("i", { textContent: "/" }), ...marked(e.name, q)));
      if (e.label !== e.name) top.append(el("span", { className: "sl-label" }, ...marked(e.label, q)));
      const row = withAttrs(el("div", { className: "sl-item", id: "sl-opt-" + i },
        top, el("div", { className: "sl-desc", textContent: e.desc })), { role: "option", "aria-selected": "false" });
      row.addEventListener("click", () => choose(items[i]));
      row.addEventListener("mousemove", () => { if (active !== i) setActive(i, false); }); // 用 mousemove：滚动时指针下换了行不算
      nodes.push(row);
    }
  }
  list.replaceChildren(...nodes);
}

function setActive(i, scroll = true) {
  active = i;
  const rows = list.querySelectorAll(".sl-item");
  rows.forEach((row, k) => row.setAttribute("aria-selected", String(k === i)));
  input.setAttribute("aria-activedescendant", "sl-opt-" + i);
  const row = rows[i];
  if (!scroll || !row) return;
  // 滚到可见；上面紧挨着分组标题时一并露出来
  const prev = row.previousElementSibling;
  const top = prev?.classList.contains("sl-group") ? prev.offsetTop : row.offsetTop;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
}

function close() {
  if (!open) return;
  open = false;
  lastQuery = null;
  menu.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

// 光标在输入框开头的「/xxx」里时，返回光标之前的那部分（不含「/」）；否则 null
function slashQuery() {
  const m = TOKEN.exec(input.value);
  const caret = input.selectionStart;
  if (!m || caret < 1 || caret > m[0].length) return null;
  return input.value.slice(1, caret).toLowerCase();
}

function sync() {
  if (composing) return;
  const q = slashQuery();
  if (q === null || dismissed) return close();
  items = filter(q);
  if (!items.length) return close(); // 没有匹配就收起来，回车照常发送
  const opening = !open;
  render(q);
  if (opening || q !== lastQuery) active = 0;
  active = Math.min(active, items.length - 1);
  lastQuery = q;
  open = true;
  menu.hidden = false;
  input.setAttribute("aria-expanded", "true");
  setActive(active);
  if (opening) loadRemote().then((changed) => { if (changed && open) sync(); }); // 顺手刷新清单，新加的命令不用重启
}

function choose(e) {
  const rest = input.value.slice(TOKEN.exec(input.value)[0].length).trimStart();
  close();
  if (e.kind === "action") {
    input.value = rest;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    runAction(e, rest);
  } else {
    const head = `/${e.name} `;
    input.value = head + rest;
    input.setSelectionRange(head.length, head.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.focus();
}

async function runAction(e, args) {
  try { await e.run(args); } catch (err) {
    console.error("命令执行失败：", e.name, err);
    toast("「" + e.name + "」没能执行，详情见控制台");
  }
}

// ---------- 键盘 ----------
// 捕获阶段先于 chat.js 处理：菜单开着时回车是选菜单项，preventDefault 后 chat.js 不会发送
input.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 输入法选词的回车、方向键不归菜单管
  const plain = !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey);
  if (open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && plain) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismissed = true;
      close();
    }
    return;
  }
  // 菜单没开（比如整条「/导图 参数」都敲完了）：敲的是伴读功能的名字就直接执行，不当成提问发出去
  if (e.key === "Enter" && plain) {
    const m = /^[/／、](\S+)(?:\s+([\s\S]*))?$/.exec(input.value.trim());
    const act = m && listActions().find((a) => a.name === m[1]);
    if (act) {
      e.preventDefault();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      runAction(act, (m[2] || "").trim());
    }
  }
}, true);

input.addEventListener("input", (e) => {
  dismissed = false;
  if (!(composing || e.isComposing)) sync();
});
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", () => { composing = false; sync(); });
input.addEventListener("keyup", (e) => { if (e.key !== "Escape" && !e.isComposing) sync(); }); // 光标左右移动也可能进出「/xxx」
input.addEventListener("click", sync);
input.addEventListener("focus", sync);
input.addEventListener("blur", close);
// 点在菜单和输入框之外就收起。点书页文字层时阅读器会 preventDefault 掉 mousedown，输入框不失焦，光靠 blur 关不掉
document.addEventListener("pointerdown", (e) => {
  if (open && e.target !== input && !menu.contains(e.target)) close();
}, true);
menu.addEventListener("mousedown", (e) => e.preventDefault()); // 点菜单不让输入框失焦
window.addEventListener("view-changed", close);

loadRemote();
