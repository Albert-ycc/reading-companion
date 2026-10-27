// 对话栏：问题发给本地服务，服务调本机 Claude Code（带伴读 hook 和你的记忆），回答逐字流回来。
// 每本书一个对话，换书自动切换；「新对话」清掉这本书的上下文。
import { marked } from "./vendor/marked.esm.js";
import { currentBook, removeHighlight, readingContext, revealHighlight, tidyText } from "./reader.js";
import { $, toast, api, el } from "./ui.js";
import { showView, currentView } from "./panel.js";

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// 回答由 Claude 写，Claude 读的是 PDF 原文：原文里夹带的指令要是被照做，回答就可能带着外链。
// 原始 HTML 一律按文字显示；图片不渲染（打开对话就会自动请求外部地址），只留说明文字；
// 链接只认 http(s)，在新窗口打开，javascript:、data: 这类按文字显示
marked.use({ renderer: {
  html: ({ text }) => esc(text),
  image: ({ text, href }) => esc(text || href || ""),
  link({ href, tokens }) {
    const inner = this.parser.parseInline(tokens);
    return /^https?:\/\//i.test(href || "") ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
  },
} });
// 中文里 **粗体** 紧挨着标点时 CommonMark 不认（实测「**「显著」的门槛这句话没写。**单因素」原样露出星号）：
// 在标点和 ** 之间插一个零宽空格，粗体就能闭合，界面上看不出来
const cjkSafe = (md) => md
  .replace(/([^\s*\w])\*\*/gu, (m, p) => (/\p{P}/u.test(p) ? p + "\u200b**" : m))
  .replace(/\*\*([^\s*\w])/gu, (m, p) => (/\p{P}/u.test(p) ? "**\u200b" + p : m));
const render = (md) => marked.parse(cjkSafe(md));

const box = $("#messages");
const input = $("#q");
let scopeKey = "";
let loadSeq = 0; // 每次 loadChat 加一；慢响应回来时发现自己过期了就丢掉，免得上一本书的对话铺进这一本

const scope = () => currentBook() || { key: "", title: "" };

// 本地服务没在运行时给的办法，和离线页（sw.js）是同一行
const RESTART = "launchctl kickstart -k gui/$(id -u)/com.albert.reading-companion";
const isDown = (err) => err?.name === "ServiceDown";
function restartHelp(then) {
  const cmd = el("code", { textContent: RESTART });
  cmd.style.userSelect = "all"; // 点一下选中整行，直接复制
  return [`打开「终端」，粘贴下面这行回车，再${then}：`, el("br"), cmd];
}
// 在对话栏里留一条说明，不用提示条：提示条几秒就没了，而重启命令得有时间复制
function downNote(what) {
  box.querySelector(".msg.note.down")?.remove();
  box.append(el("div", { className: "msg note down" }, `伴读的本地服务没在运行，${what}。`, ...restartHelp("试一次")));
  box.scrollTop = box.scrollHeight;
}

// 回答不完整时注在回答下面；服务端存的是原因字符串
const incompleteNote = (reason) => el("div", { className: "error", textContent: "回答不完整" + (typeof reason === "string" && reason ? "：" + reason : "") });

function bubble(role, text, attachments = [], interrupted = null, into = box) {
  const node = el("div", { className: "msg " + role });
  if (role === "user") {
    node.textContent = text;
    if (attachments.length) node.prepend(el("div", { className: "msg-att" },
      ...attachments.map((a) => el("img", { src: a.url, alt: "附图" }))));
  } else {
    node.innerHTML = render(text || "");
    if (interrupted) node.append(incompleteNote(interrupted));
  }
  into.append(node);
  return node;
}

// ---------- 划线、问题、回答排成一组 ----------
// 每一问记着提问时 Claude 看到的那段（quote：划线、框选，或导读里「接着问」的那段），没划线直接问的没有。
// 对着同一句接着问的几轮归在同一组：组头写一次划线原文，左边一道藤黄竖线把这几轮问答串起来。点组头跳回书页上那个位置
const quoteKey = (q) => q.hl || `${q.page}\n${q.text}`;

function quoteNode(q) {
  const node = el("button", { type: "button", className: "quote", title: "点一下跳回书页上的这一处" });
  const words = () => el("span", { className: "quote-text" }, el("mark", { textContent: tidyText(q.text) }));
  if (q.image) {
    // 缩略图跟着框选划线走：划线删掉后图就取不到了，改写框里的文字
    const img = el("img", { src: q.image, alt: "框选的区域" });
    img.addEventListener("error", () => img.replaceWith(words()), { once: true });
    node.append(img);
  } else node.append(words());
  node.append(el("span", { className: "quote-at", textContent: `第 ${q.page} 页 · 跳到原文` }));
  node.addEventListener("click", () => jumpTo(q));
  return node;
}

async function jumpTo(q) {
  if (!currentBook()) return toast("这本书没打开，跳不过去");
  if ($("#viewer").hidden) return toast("书架开着：先打开这本书，再点这句划线");
  if (!(await revealHighlight(q))) toast(`第 ${q.page} 页上没找到这句，停在了这一页`);
}

// 一问该放在哪：有 quote 就放进它那一组（对话栏最后一组正是这句就接着放，否则新开一组），没有就直接放在对话栏里
function holder(quote) {
  if (!quote) return box;
  const last = box.lastElementChild;
  if (last?.classList.contains("qa") && last.dataset.qk === quoteKey(quote)) return last;
  const g = el("div", { className: "qa" }, quoteNode(quote));
  g.dataset.qk = quoteKey(quote);
  box.append(g);
  return g;
}

// 页面先画出了问题、服务端随后才说这一问对着哪段：把问、答挪进那一组
function regroup(t) {
  if (!t.quote || !t.user?.isConnected || t.user.parentElement !== box) return;
  const stick = nearBottom(); // 组头插在问题上面，把回答往下推；原来贴着底就接着贴底，回答才会一直跟着滚
  const prev = t.user.previousElementSibling;
  let g = prev?.classList.contains("qa") && prev.dataset.qk === quoteKey(t.quote) ? prev : null;
  if (!g) {
    g = el("div", { className: "qa" }, quoteNode(t.quote));
    g.dataset.qk = quoteKey(t.quote);
    t.user.before(g);
  }
  g.append(t.user, t.out);
  if (stick) box.scrollTop = box.scrollHeight;
}

// 撤下一问的问、答；它所在的组里没有别的问题了，组头也一起撤掉
function unmount(t) {
  const g = t.user?.parentElement;
  t.user?.remove();
  t.out?.remove();
  if (g?.classList.contains("qa") && !g.querySelector(".msg.user")) g.remove();
}

// 一段对话（当前的或历史里的）的全部消息按组画进对话栏：回答跟着它前面那一问走
function paintMessages(messages) {
  let into = box;
  for (const m of messages) {
    if (m.role === "user") into = holder(m.quote && typeof m.quote === "object" ? m.quote : null);
    bubble(m.role, m.text, m.attachments || [], m.interrupted, into);
  }
}

function nearBottom() {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

// 对话栏被下面的输入区挤矮（答到一半又划了一句、预测冒出来，输入框打成多行，附了图）时，离底距离一下子变大，
// 回答就不再跟着往下滚。记下最后一次滚动时贴没贴底，栏高一变按它补滚。栏收起（切到导读、导图）时高度是 0，不算
let atBottom = true;
box.addEventListener("scroll", () => { if (box.clientHeight) atBottom = nearBottom(); }, { passive: true });
new ResizeObserver(() => { if (box.clientHeight && atBottom) box.scrollTop = box.scrollHeight; }).observe(box);

// 当前对话取不到：不能画成空对话的提示笺，那会让人以为这本书没聊过
function loadFailedNote(err) {
  const down = isDown(err);
  return el("div", { className: "msg note down" },
    down ? "伴读的本地服务没在运行，对话暂时取不到。" : "对话没取到：" + err.message,
    ...(down ? [el("br"), ...restartHelp("点「重新载入」")] : []),
    el("br"), el("button", { type: "button", className: "ghost", textContent: "重新载入", onclick: () => loadChat() }));
}

export async function loadChat() {
  const seq = ++loadSeq;
  viewing = null;
  $("#chat-history").classList.remove("on");
  const { key, title } = scope();
  if (ghost?.key === key) stopGhost(); // 回到那本书时按服务端的最新记录重新接；别的书里接回来的那一问继续等，换书不丢
  stopElsewhere();
  if (turn?.phase === "error" && turn.restored && turn.key !== key) unrestore(turn);
  scopeKey = key;
  $("#pi-book").textContent = title || "";
  box.replaceChildren();
  const started = Date.now();
  let chat, failed = null;
  try {
    chat = await api("/api/chat?file=" + encodeURIComponent(key));
    if (chat?.error) failed = new Error(chat.error);
  } catch (err) { failed = err; }
  if (seq !== loadSeq) return;
  const { messages = [], inflight = null } = (!failed && chat) || {};
  // 等响应的这段时间里这一问恰好答完存盘：这份响应可能是存盘前取的，再取一次
  if (turn?.key === key && turn.phase === "done" && turn.doneAt >= started) return loadChat();
  paintMessages(messages);
  rounds = messages.filter((m) => m.role === "user").length;
  if (rounds >= LONG_ROUNDS) box.append(longNote());
  // 这一页自己发出的提问（进行中或出错）还没存进服务端，得从内存里接回来
  const live = turn?.key === key && turn.phase !== "done";
  if (live) { mountTurn(turn); if (turn.phase === "error") restore(turn); }
  // 刷新前发出的提问，Claude 还在答：服务端记着，这里接上并等它答完
  else if (inflight && !busy()) startGhost({ key, title, question: inflight.question || "", quote: inflight.quote || null, at: inflight.at, note: "这本书有一问正在回答，答完会自动显示" });
  const other = !failed && chat?.busyElsewhere;
  if (other && typeof other === "object" && !busy()) startElsewhere({ key: other.file, title: typeof other.title === "string" ? other.title : "" });
  if (failed) box.append(loadFailedNote(failed));
  else if (!messages.length && !live && ghost?.key !== key) {
    box.append(el("div", { className: "msg hint" },
      title ? "在左边选中一段就是划线，然后在这里问。按住 ⌥ 拖一个框，能把图、表、公式发给 Claude；⌘V 能贴截图。没划线时，问的是当前这一页。" : "还没打开书时也能直接问 Claude。"));
  }
  box.scrollTop = box.scrollHeight;
  syncBusy();
}

// ---------- 附图：粘贴截图等功能模块调 addAttachment 加进来，下一次提问一起带走 ----------
const pending = []; // [{ path, url }]，path 是服务端存图的位置，url 用来显示缩略图
function renderAttachments() {
  $("#attach").hidden = !pending.length;
  $("#attach").replaceChildren(...pending.map((a, i) => el("span", { className: "att" },
    el("img", { src: a.url, alt: "附图" }),
    el("button", { type: "button", textContent: "×", title: "移除这张图", onclick: () => {
      pending.splice(i, 1);
      a.removed = true; // 出错后放回来的图，重试时不再带上它
      renderAttachments();
      api("/api/attachment/delete", { path: a.path }).catch(() => {}); // 图不会再有人用，顺手删掉；删不掉不影响移除
    } }))));
}
const MAX_ATTACHMENTS = 6; // 和服务端 valid_attachments 的上限一致
// 还能不能再附一张：贴图模块在上传之前先问，满了就不传，免得数据目录里留下没人用的图
export const canAttach = () => pending.length < MAX_ATTACHMENTS;
// 附上一张图；已经满 6 张时不收，提示一下并返回 false
export function addAttachment(a) {
  if (pending.length >= MAX_ATTACHMENTS) {
    toast(`最多附 ${MAX_ATTACHMENTS} 张图，这张没附上`);
    return false;
  }
  pending.push(a);
  renderAttachments();
  input.focus();
  return true;
}

// ---------- 提问 ----------
// 这一页自己发出的那一问。服务端同一时间只答一个，页面这边也只留一个；带 key 是为了换书回来能接上，
// 答完时人不在这本书，就不去碰对话栏。phase：run 进行中 / error 失败（没存） / done 已答完（已存盘）
let turn = null; // { key, title, typed, question, attachments, ctx, quote, t0, acc, status, phase, error, interrupted, user, out }
// 页面刷新后发现服务端还在答刷新前发出的提问：{ key, question, at, note, user, out, timer }
let ghost = null;

// 刷新后直接打开另一本书：服务端在答的是别的书里的提问，这个页面没见过它，靠 /api/chat 的 busyElsewhere 得知：{ key, title, poll }
let elsewhere = null;

// 此刻服务端在答的那一问：自己发的，或刷新、断线后从服务端记录里接回来的，或别的书里的
const running = () => (turn?.phase === "run" ? turn : ghost || elsewhere);
const busy = () => !!running();
export const answering = busy; // 划线预测用：Claude 正在答题时不猜
const busyHere = () => running()?.key === scopeKey;
const shortTitle = (t) => (t.length > 18 ? t.slice(0, 18) + "…" : t);
const nameOf = (r) => (r.title ? `《${shortTitle(r.title)}》` : "另一本书");
const busyHint = () => {
  const r = running();
  return !r || r.key === scopeKey ? "Claude 还在回答，答完再发" : `Claude 还在回答${nameOf(r)}里的提问，答完再发`;
};

let foreign = null; // 别的书的提问还没答完时，在这本书的对话栏末尾说明为什么发不出去
let wasBusy = false;
function syncBusy() {
  const b = busy();
  $("#send").disabled = b;
  $("#send").title = b ? busyHint() : "";
  if (wasBusy && !b) window.dispatchEvent(new Event("answer-done")); // 答完了：划线预测补猜答题期间划的那句
  wasBusy = b;
  const r = running();
  const need = r && r.key !== scopeKey && viewing === null;
  if (!need) { foreign?.remove(); foreign = null; return; }
  if (foreign?.isConnected) return;
  foreign = el("div", { className: "msg note", textContent: `Claude 还在回答${nameOf(r)}里的提问，答完才能在这里发问。` });
  const hint = box.querySelector(".msg.hint"); // 空对话的提示笺下面垫着一大块留白，说明放它上面
  if (hint) hint.before(foreign); else box.append(foreign);
  box.scrollTop = hint ? 0 : box.scrollHeight;
}

const MAX_QUESTION = 50000; // 和服务端 _ask 的上限一致，按字（码点）算，不是 UTF-16 单位
// 返回 false＝这一问没发出去（还在回答别的、问题太长、或什么都没写），调用方据此保留输入框里的字
export function ask(question) {
  question = question.trim();
  if (!question && !pending.length) return false;
  if (busy()) { toast(busyHint()); return false; }
  const chars = question.length > MAX_QUESTION ? [...question].length : 0;
  if (chars > MAX_QUESTION) {
    toast(`问题太长：一次最多 ${MAX_QUESTION} 字，这次 ${chars} 字，删减后再发`, undefined, 5000);
    return false;
  }
  launch(question, pending.splice(0));
  renderAttachments();
  return true;
}

function launch(typed, attachments) {
  // 发出去了：划线预测收起。快捷按钮、「/」菜单、导读的「接着问」都直接调 ask()，不经过输入框的提交
  window.dispatchEvent(new Event("question-sent"));
  // 上一次失败的那一问不再留着：重新发的是它就等于重试，发的是别的就是不要了
  if (turn?.phase === "error") unmount(turn);
  // 按下发送这一刻的书、页、划线，不让 Claude 启动时再去读全局状态；
  // 刚换书、阅读状态还停在上一本时书对不上，宁可不给也不给错
  const ctx = readingContext();
  const t = turn = {
    key: scopeKey, title: scope().title, typed, question: typed || "看看这张图", attachments, t0: Date.now(),
    ctx: ctx?.file === scopeKey ? ctx : null,
    acc: "", status: "Claude 在看你读的这一段…", phase: "run",
  };
  showView("chat");
  syncBusy();
  (async () => {
    if (viewing) await loadChat(); // 在翻历史时发问：先回到当前对话
    mountTurn(t);
    await run(t);
  })().catch((err) => { if (t.phase === "run") fail(t, "出错了：" + err.message); }); // 没兜住的意外也得收场，否则发送键永远灰着
}

// 把这一问画进对话栏；已经画着就不重复（换书回来、翻完历史回来都会再进来）
function mountTurn(t) {
  if (t.key !== scopeKey || viewing !== null || t.user?.isConnected) return;
  box.querySelector(".msg.hint")?.remove();
  const into = holder(t.quote);
  t.user = bubble("user", t.question, t.attachments, null, into);
  t.out = bubble("assistant", "", [], null, into);
  paintTurn(t);
  box.scrollTop = box.scrollHeight;
}

function errorBlock(t) {
  const { text, down, retryable } = t.error;
  const node = el("div", { className: "error" }, text);
  if (down) node.append(el("br"), ...restartHelp("点「重试」"));
  if (retryable) node.append(el("br"), el("button", { type: "button", className: "ghost", textContent: "重试", onclick: () => retry(t) }));
  return node;
}

function paintTurn(t) {
  if (!t.out?.isConnected) return;
  const stick = nearBottom();
  t.out.innerHTML = t.acc ? render(t.acc) : "";
  if (t.interrupted) t.out.append(incompleteNote(t.interrupted));
  if (t.phase === "error") t.out.append(errorBlock(t));
  else if (t.phase === "run" && !t.acc) t.out.append(el("div", { className: "status", textContent: t.status }));
  else if (!t.acc) t.out.textContent = "（没有回答）";
  if (stick) box.scrollTop = box.scrollHeight;
}
const schedulePaint = (t) => { t.frame ||= requestAnimationFrame(() => { t.frame = 0; paintTurn(t); }); };
function cancelPaint(t) {
  if (t.frame) cancelAnimationFrame(t.frame);
  t.frame = 0;
}
function paintNow(t) {
  cancelPaint(t);
  paintTurn(t);
}

// 失败的一问：问题放回输入框、附图放回附图栏（输入框里已有别的字就不覆盖），回答气泡里给「重试」
function restore(t) {
  if (t.restored || t.key !== scopeKey || viewing !== null) return;
  t.restored = true;
  if (!input.value.trim()) input.value = t.typed;
  for (const a of t.attachments) if (!a.removed && canAttach()) pending.push(a);
  renderAttachments();
}

// 换书了：放回去的字和图是上一本书那一问的，不留在这本书里；回到那本书时再放回来
function unrestore(t) {
  t.restored = false;
  if (input.value === t.typed) input.value = "";
  for (const a of t.attachments) { const i = pending.indexOf(a); if (i >= 0) pending.splice(i, 1); }
  renderAttachments();
}

// retryable：再发一次有可能成功（服务忙、临时出错）；请求本身有问题的 4xx 再发多少次也一样，不挂「重试」，问题照样放回输入框供修改
function fail(t, text, { down = false, retryable = true } = {}) {
  t.phase = "error";
  t.error = { text, down, retryable };
  paintNow(t);
  restore(t);
  syncBusy();
  input.focus();
}

function retry(t) {
  if (busy()) return void toast(busyHint());
  // 放回去的那份撤掉，这次就是把它发出去
  if (input.value === t.typed) input.value = "";
  const atts = t.attachments.filter((a) => !a.removed);
  for (const a of atts) { const i = pending.indexOf(a); if (i >= 0) pending.splice(i, 1); }
  renderAttachments();
  unmount(t);
  if (t.typed || atts.length) launch(t.typed, atts); // 图都被移除了、又没有字，就没什么可重发的
}

async function run(t) {
  let res;
  try {
    res = await fetch("/api/ask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: t.key, question: t.question, attachments: t.attachments.map(({ path, url }) => ({ path, url })), context: t.ctx }),
    });
  } catch {
    return fail(t, "出错了：伴读的本地服务没在运行，这一问没发出去。", { down: true });
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))).error || "服务出错 " + res.status;
    return fail(t, "出错了：" + msg, { retryable: res.status >= 500 || [408, 409, 429].includes(res.status) });
  }

  let gotDone = false;
  let errMsg = "";
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    read: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "quote") {
          t.quote = ev.quote && typeof ev.quote === "object" ? ev.quote : null;
          regroup(t);
        } else if (ev.type === "delta") {
          t.acc += ev.text;
          schedulePaint(t);
        } else if (ev.type === "tool") {
          t.status = ev.name === "Read" ? "Claude 在看这一页的原图…" : `Claude 在用 ${ev.name} 查资料…`;
          if (!t.acc) schedulePaint(t);
        } else if (ev.type === "interrupted") {
          t.interrupted = ev.message || true;
        } else if (ev.type === "error") {
          errMsg = ev.message;
          reader.cancel().catch(() => {});
          break read;
        } else if (ev.type === "done") {
          gotDone = true;
        }
      }
    }
  } catch { /* 读到一半连接断了：和「流结束却没等到 done」同样处理 */ }

  if (errMsg) return fail(t, "出错了：" + errMsg);
  if (!gotDone) return recover(t);
  finish(t);
}

function finish(t) {
  t.phase = "done";
  t.doneAt = Date.now();
  paintNow(t);
  // 答完时人在别的书里：轮数是那本书的，不能记到这里
  if (t.key === scopeKey && viewing === null) {
    rounds++;
    if (rounds === LONG_ROUNDS) { box.append(longNote()); box.scrollTop = box.scrollHeight; }
  }
  syncBusy();
  input.focus();
}

const savedAfter = (messages, question, since) => {
  const last = [...messages].reverse().find((m) => m?.role === "user");
  return !!last && last.text === question && !(Date.parse(last.at) < since - 5000);
};
const messagesOf = (chat) => (Array.isArray(chat?.messages) ? chat.messages : []);

// 流结束了却没收到 done：服务端页面断开后不杀 Claude，可能还在答、可能已经存好、也可能确实没了
async function recover(t) {
  let chat;
  try { chat = await api("/api/chat?file=" + encodeURIComponent(t.key)); } catch (err) {
    return fail(t, "回答中断了，这一问没保存。" + (isDown(err) ? "伴读的本地服务也没在运行了。" : ""), { down: isDown(err) });
  }
  if (chat?.inflight) {
    if (turn === t) turn = null; // 往后由服务端的记录接着管
    cancelPaint(t); // 排着队的重画会把等待说明刷掉
    return startGhost({ key: t.key, title: t.title, question: t.question, quote: t.quote, at: chat.inflight.at, note: "连接断了，Claude 还在回答这一问，答完会自动显示", user: t.user, out: t.out, acc: t.acc });
  }
  if (savedAfter(messagesOf(chat), t.question, t.t0)) {
    t.phase = "done";
    t.doneAt = Date.now();
    syncBusy();
    if (t.key === scopeKey && viewing === null) loadChat();
    return;
  }
  fail(t, "回答中断了，这一问没保存。");
}

// ---------- 刷新前发出的提问：显示它，每 2 秒问一次服务端，答完重载对话 ----------
function startGhost(g) {
  ghost = g;
  if (!g.user) {
    const into = holder(g.quote);
    g.user = bubble("user", g.question, [], null, into);
    g.out = bubble("assistant", "", [], null, into);
  }
  paintGhost(g);
  syncBusy();
  box.scrollTop = box.scrollHeight;
  watchGhost(g);
}
function paintGhost(g) {
  g.out.innerHTML = g.acc ? render(g.acc) : "";
  g.out.append(el("div", { className: "status", textContent: g.note }));
}
function stopGhost() {
  if (!ghost) return;
  clearTimeout(ghost.timer);
  ghost = null;
}
function watchGhost(g) {
  g.timer = setTimeout(async () => {
    let chat;
    try { chat = await api("/api/chat?file=" + encodeURIComponent(g.key)); } catch (err) {
      if (ghost !== g) return;
      return endGhost(g, [], isDown(err));
    }
    if (ghost !== g) return;
    if (chat?.inflight) return watchGhost(g);
    endGhost(g, messagesOf(chat), false);
  }, 2000);
}
function endGhost(g, messages, down) {
  ghost = null;
  const here = g.key === scopeKey && viewing === null;
  // 存下来了：人在这本书里就重载；人在别处，回来时 loadChat 自然会取到
  if (!down && savedAfter(messages, g.question, Date.parse(g.at) || 0)) {
    if (here) loadChat();
    syncBusy();
    return;
  }
  // 没存下来：把它变成一条失败的提问，问题放回输入框，可以重试
  const t = turn = { key: g.key, title: g.title, typed: g.question, question: g.question, quote: g.quote, attachments: [], t0: Date.now(), acc: g.acc || "", phase: "error", user: g.user, out: g.out };
  t.error = { text: "回答中断了，这一问没保存。" + (down ? "伴读的本地服务也没在运行了。" : ""), down, retryable: true };
  if (here) { paintNow(t); restore(t); }
  syncBusy();
}

// ---------- 别的书里的提问：说明发不出去的原因，每 2 秒问一次，答完恢复 ----------
function startElsewhere(e) {
  elsewhere = e;
  syncBusy();
  watchElsewhere(e, scopeKey);
}
function stopElsewhere() {
  if (!elsewhere) return;
  clearTimeout(elsewhere.poll);
  elsewhere = null;
}
function watchElsewhere(e, forKey) {
  e.poll = setTimeout(async () => {
    let chat = null;
    try { chat = await api("/api/chat?file=" + encodeURIComponent(forKey)); } catch { /* 取不到就当它不在了，真发不出去时发送会给出原因 */ }
    if (elsewhere !== e) return;
    const other = chat?.busyElsewhere;
    if (other && typeof other === "object") {
      e.key = other.file;
      e.title = typeof other.title === "string" ? other.title : "";
      return watchElsewhere(e, forKey);
    }
    elsewhere = null;
    // 这一会儿别的窗口在这本书里发了问：重载一次把它接上
    if (chat?.inflight && forKey === scopeKey && viewing === null) loadChat();
    else syncBusy();
  }, 2000);
}

$("#ask").addEventListener("submit", (e) => {
  e.preventDefault();
  if (ask(input.value)) input.value = "";
});
input.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return; // 「/」菜单开着时回车是选菜单项，菜单已经处理过了
  // 输入法选词时的回车不算发送
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $("#ask").requestSubmit();
  }
});
$("#chips").addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") ask(e.target.textContent);
});
$("#chat-reset").addEventListener("click", async () => {
  if (busyHere()) return void toast("Claude 还在回答，答完再开新对话");
  let archived;
  try { ({ archived } = await api("/api/chat/reset", { file: scopeKey })); } catch (err) {
    if (isDown(err)) return downNote("没能开新对话");
    return void toast("没能开新对话：" + err.message);
  }
  if (turn?.phase === "error" && turn.key === scopeKey) turn = null; // 失败的那一问属于刚收起的对话，新对话里不留
  await loadChat();
  toast(archived ? "已开始新对话，刚才那段收进了「历史」" : "已开始新对话");
});

// ---------- 历史对话：点「新对话」时收起的旧对话，只读翻看 ----------
// 列表只取标题和时间，点开哪段才取哪段的全文，历史再多也不拖慢
let viewing = null; // null＝当前对话；"list"＝历史列表；否则是正在看的那段的 id
let rounds = 0; // 当前对话问了几次
const LONG_ROUNDS = 20; // 超过这么多轮，提醒开新对话

const fmt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function longNote() {
  return el("div", { className: "msg note",
    textContent: `这段对话已经 ${LONG_ROUNDS} 轮了。Claude 每次回答都要把前面的对话从头读一遍，越往后越慢。点「新对话」开一段新的，这段会收进「历史」，随时能翻。` });
}

async function showHistoryList() {
  viewing = "list";
  $("#chat-history").classList.add("on");
  let items = [], failed = null;
  try { ({ items = [] } = await api("/api/chat/history?file=" + encodeURIComponent(scopeKey))); } catch (err) { failed = err; }
  if (viewing !== "list") return;
  const head = el("div", { className: "hist-head" },
    el("span", {}, el("b", { textContent: "历史对话" }), el("span", { className: "hist-sub", textContent: items.length ? `这本书共 ${items.length} 段，点开只读` : "" })),
    el("button", { type: "button", textContent: "回到当前对话", onclick: loadChat }));
  // 取不到不等于没有：服务没在运行时不能说「还没有历史对话」
  const list = failed
    ? [el("p", { className: "hist-empty" }, isDown(failed) ? "伴读的本地服务没在运行，历史对话暂时取不到。" : "历史对话没取到：" + failed.message, ...(isDown(failed) ? [el("br"), ...restartHelp("点一次「历史」")] : []))]
    : items.length
      ? items.map((c) => el("button", { type: "button", className: "hist-item", onclick: () => showArchived(c.id) },
          el("span", { className: "hist-title", textContent: c.title }),
          el("span", { className: "hist-meta", textContent: `${fmt(c.startedAt)} · 问了 ${c.count} 次` })))
      : [el("p", { className: "hist-empty", textContent: "还没有历史对话。点「新对话」时，当前这段会收到这里，不会删掉。" })];
  box.replaceChildren(head, ...list);
  box.scrollTop = 0;
}

async function showArchived(id) {
  viewing = id;
  let c;
  try { ({ conversation: c } = await api(`/api/chat/history?file=${encodeURIComponent(scopeKey)}&id=${encodeURIComponent(id)}`)); } catch (err) {
    if (viewing !== id) return;
    return void toast(isDown(err) ? "伴读的本地服务没在运行，这段对话取不到" : "这段对话没取到：" + err.message);
  }
  if (viewing !== id) return;
  if (!c) return toast("这段对话没找到");
  const head = el("div", { className: "hist-head" },
    el("span", {}, el("b", { textContent: "历史对话" }), el("span", { className: "hist-sub", textContent: `${fmt(c.startedAt)} · 问了 ${c.count} 次 · 只读` })),
    el("span", { className: "hist-tools" },
      el("button", { type: "button", textContent: "‹ 列表", onclick: showHistoryList }),
      el("button", { type: "button", textContent: "回到当前对话", onclick: loadChat })));
  box.replaceChildren(head);
  paintMessages(c.messages || []);
  box.scrollTop = 0;
}

$("#chat-history").addEventListener("click", () => (viewing ? loadChat() : showHistoryList()));

window.addEventListener("book-opened", loadChat);
// 快捷问题问的是「Claude 看到」的那一句，只在问答视图里有对象
window.addEventListener("view-changed", () => { $("#chips").hidden = currentView() !== "chat"; });

// 切到问答、输入框聚焦，可选预填一句（导读、导图里「接着问」用），不发送
export function compose(text) {
  showView("chat");
  if (text != null) input.value = text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
window.addEventListener("highlight", (e) => {
  input.focus();
  toast("已划线，Claude 能看到这段了", { label: "撤销", run: () => removeHighlight(e.detail) });
});
// 选的是中文译文：页上没画线，不能说「已划线」，也没有线可撤销
window.addEventListener("focus-passage", () => {
  input.focus();
  toast("Claude 能看到这段译文了");
});
