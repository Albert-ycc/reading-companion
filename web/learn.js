// 学习视图的三节：小问题 · 复习 · 概念；徽标；书架书桌上的提示。
// 数据全在服务端（features/learning.py）：quiz.json、review.json、learner.md 的概念掌握表。页面只读、只点。
import { el, toast, api, whyFailed } from "./ui.js";
import { registerSection, setBadge, currentView } from "./panel.js";
import { currentBook, revealPassage, gotoPage } from "./reader.js";
import { compose } from "./chat.js";

// ───────────────────────── 小工具 ─────────────────────────
const E = (tag, cls, ...kids) => el(tag, cls ? { className: cls } : {}, ...kids.flat(Infinity).filter((k) => k != null && k !== false));
const btn = (cls, text, onclick, props = {}) => el("button", { type: "button", className: cls, textContent: text, onclick, ...props });
const enc = encodeURIComponent;
// 书名：「书名 -- 作者 -- 出版社」只留书名；和服务端写进概念表的 label_of 一致（30 个字，按码点）
const tidy = (t) => (t || "").split(" -- ")[0].replace(/_+/g, " ").replace(/\s+/g, " ").trim();
const labelOf = (t) => [...(t || "").split(" -- ")[0].replace(/[\s|]+/g, " ").trim()].slice(0, 30).join("");
const day = (iso) => {
  const m = /^\d{4}-(\d\d)-(\d\d)/.exec(iso || "");
  return m ? `${+m[1]} 月 ${+m[2]} 日` : "";
};
// 下次复习：按本地日期差说「明天」「3 天后」
const nextText = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const n = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / 86400000);
  return n <= 0 ? "今天" : n === 1 ? "明天" : `${n} 天后`;
};
const RESULT = { right: "对", half: "半对", wrong: "错" };
const STATUS_NEXT = { 卡住: "半懂", 半懂: "已掌握", 已掌握: "卡住" };
const STATUS_CLS = { 卡住: "stuck", 半懂: "half", 已掌握: "done" };
const STATUS_ORDER = { 卡住: 0, 半懂: 1, 已掌握: 2 };
const KIND = { highlight: "划线", concept: "概念", quiz: "小问题" };
const CONCEPT_FOLD = 12, REVIEW_FOLD = 8;

// ───────────────────────── 状态 ─────────────────────────
const S = {
  key: "", title: "",
  quiz: null,      // 所有书的小问题（服务端按提问时间新到旧）
  review: null,    // 所有到期的复习条目（带 mine：是不是这本书的）
  concepts: null,  // 概念表
  down: null,      // 取不到数据的原因（服务没开等）
};
const UI = {
  openAnswer: new Set(),        // 展开了「直接答」的小问题 id
  drafts: new Map(),            // id -> 没交的回答草稿（重画后还在）
  busy: new Set(),              // 正在判卷 / 出题 / 写入的 id
  answeredHere: new Map(),      // 小问题 id -> { result, feedback }：这个页面里「直接答」判过的，留着让人看完反馈
  rev: new Map(),               // 复习条目 id -> { phase: idle|asked|done, question, result, feedback, next, err }
  otherQuiz: false, otherReview: false, allConcepts: false, allReview: false,
};
let seq = 0;

// ───────────────────────── 三节 ─────────────────────────
let lastKick = 0;
const kick = () => { if (Date.now() - lastKick > 250) { lastKick = Date.now(); refresh(); } }; // 三节各自 onShow，只取一次数据

const secQuiz = registerSection("learn", { label: "小问题", order: 10, onShow: kick });
const secReview = registerSection("learn", { label: "复习", order: 20, onShow: kick });
const secConcept = registerSection("learn", { label: "概念", order: 30, onShow: kick });
const quizBody = E("div", "ln"), reviewBody = E("div", "ln"), conceptBody = E("div", "ln");
secQuiz.append(quizBody);
secReview.append(reviewBody);
secConcept.append(conceptBody);
const counts = { quiz: E("small"), review: E("small"), concept: E("small") };
secQuiz.querySelector(".sec-h").append(counts.quiz);
secReview.querySelector(".sec-h").append(counts.review);
secConcept.querySelector(".sec-h").append(counts.concept);

async function refresh() {
  const my = ++seq;
  const b = currentBook();
  S.key = b?.key || "";
  S.title = b?.title || "";
  try {
    const rq = b ? `&file=${enc(b.key)}&title=${enc(b.title || "")}` : "";
    const [quiz, review, concepts] = await Promise.all([api("/api/learn/quiz"), api("/api/learn/review?all=1" + rq), api("/api/learn/concepts")]);
    if (my !== seq) return;
    const bad = [quiz, review, concepts].find((r) => !r || r.error || !Array.isArray(r.items));
    if (bad) throw Object.assign(new Error(bad?.error || "学习记录读不出来"), { name: "Rejected" });
    S.quiz = quiz.items;
    S.review = review.items;
    // 概念按状态排一次：卡住的在前。点状态后这一行不跳位置，下次取数据才重排
    S.concepts = concepts.items.map((c, i) => ({ ...c, i })).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.i - b.i);
    S.down = null;
    // 本页里交过卷的条目，过了半分钟服务端还说它到期：是又轮到它了（页面开了很久），去掉「已交卷」的旧状态
    for (const [id, v] of [...UI.rev]) if (v.phase === "done" && Date.now() - (v.at || 0) > 30000 && S.review.some((i) => i.id === id)) UI.rev.delete(id);
  } catch (err) {
    if (my !== seq) return;
    S.down = whyFailed(err, "学习记录读不出来，过一会儿再点一下这一页");
  }
  renderAll();
}

// 重画前后保住输入框里的字和光标：后台刷新、徽标轮询都可能触发重画
function keepTyping(draw) {
  const a = document.activeElement;
  const id = a instanceof HTMLTextAreaElement ? a.dataset.draft : null;
  const sel = id ? [a.selectionStart, a.selectionEnd] : null;
  draw();
  if (!id) return;
  const t = document.querySelector(`#view-learn textarea[data-draft="${CSS.escape(id)}"]`);
  if (t) { t.focus(); t.setSelectionRange(...sel); }
}

// 输入法正在组字时不重画（重画会把输入框换掉，组到一半的字就没了），组完再补画
let composing = false, deferred = false;
document.addEventListener("compositionstart", (e) => { if (e.target.closest?.("#view-learn")) composing = true; });
document.addEventListener("compositionend", () => { composing = false; if (deferred) { deferred = false; renderAll(); } });
function renderAll() {
  if (composing) { deferred = true; return; }
  keepTyping(() => { renderQuiz(); renderReview(); renderConcepts(); });
}

const downNote = () => E("p", "ln-note err", S.down, " ", btn("ln-link", "重试", refresh));
const note = (text) => E("p", "ln-note", text);
const where = (title, page) => `${labelOf(tidy(title))}${page ? ` · 第 ${page} 页` : ""}`;
const snip = (t, n = 160) => { const s = (t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };

// 到原文：小问题用出题那轮的划线，复习用条目的文字
const jump = (page, quote) => {
  if (!page) return;
  revealPassage(page, quote || "").catch(() => toast("没跳过去，这本书可能还没开好"));
};

function answerBox(id, { placeholder, submitText, onSubmit, onCancel }) {
  const ta = el("textarea", { className: "ln-ta", placeholder, value: UI.drafts.get(id) || "", rows: 3 });
  ta.dataset.draft = id;
  ta.addEventListener("input", () => UI.drafts.set(id, ta.value));
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(ta.value); } });
  const busy = UI.busy.has(id);
  ta.disabled = busy;
  return [ta, E("div", "ln-acts",
    btn("ln-btn solid", busy ? "判卷中…" : submitText, () => onSubmit(ta.value), { disabled: busy }),
    onCancel ? btn("ln-text", "取消", onCancel, { disabled: busy }) : null)];
}

// ───────────────────────── 小问题 ─────────────────────────
function renderQuiz() {
  const all = S.quiz;
  if (S.down && !all) { counts.quiz.textContent = ""; return quizBody.replaceChildren(downNote()); }
  if (!all) return quizBody.replaceChildren(note("读取中…"));
  const mine = all.filter((q) => q.file === S.key && (q.status === "open" || UI.answeredHere.has(q.id)));
  const others = all.filter((q) => q.file !== S.key && q.status === "open");
  const open = mine.filter((q) => q.status === "open" && !UI.answeredHere.has(q.id)).length;
  counts.quiz.textContent = open ? String(open) : "";
  const kids = [];
  if (S.down) kids.push(downNote());
  if (!S.key) kids.push(note("打开一本书后，这里记着 Claude 留给你的小问题。"));
  else if (!mine.length) kids.push(note("这本书还没有小问题。Claude 答完留的小问题会记在这里。"));
  else kids.push(...mine.map((q) => quizCard(q, true)));
  if (others.length) {
    kids.push(E("div", "ln-fold", btn("ln-link", `其他书还有 ${others.length} 道${UI.otherQuiz ? "　收起" : ""}`, () => { UI.otherQuiz = !UI.otherQuiz; renderAll(); })));
    if (UI.otherQuiz) kids.push(...others.map((q) => quizCard(q, false)));
  }
  quizBody.replaceChildren(...kids);
}

function quizCard(q, here) {
  const local = UI.answeredHere.get(q.id);
  const status = local?.result || q.status;
  const feedback = local?.feedback ?? q.feedback;
  const open = status === "open";
  const busy = UI.busy.has(q.id);
  const meta = E("p", "ln-meta",
    here && q.page
      ? btn("ln-link", where(q.title, q.page), () => jump(q.page, q.quote), { title: "回到出题时看的那一页" })
      : E("span", "", where(q.title, q.page)),
    q.asked_at ? E("span", "", day(q.asked_at)) : null);
  meta.title = tidy(q.title);
  const card = E("div", "ln-card ln-quiz" + (open ? "" : " answered"), E("p", "ln-qtext", q.question), meta);
  if (!open) {
    card.append(E("div", "ln-res", E("span", "ln-tag " + status, RESULT[status] || "已答"), feedback ? E("span", "", feedback) : null));
    return card;
  }
  if (UI.openAnswer.has(q.id)) {
    card.append(...answerBox(q.id, {
      placeholder: "写下你的回答（⌘ + 回车交卷）", submitText: "交卷",
      onSubmit: (text) => submitQuiz(q, text),
      onCancel: () => { UI.openAnswer.delete(q.id); renderAll(); },
    }));
  } else {
    card.append(E("div", "ln-acts",
      here ? btn("ln-btn", "在问答里答", () => compose(`你留的小问题「${q.question}」，我的回答是：`)) : null,
      btn("ln-btn", "直接答", () => { UI.openAnswer.add(q.id); renderAll(); document.querySelector(`#view-learn textarea[data-draft="${CSS.escape(q.id)}"]`)?.focus(); }),
      btn("ln-text", "不答了", () => dismissQuiz(q), { disabled: busy })));
  }
  return card;
}

async function submitQuiz(q, text) {
  text = text.trim();
  if (!text) return toast("先写下你的回答");
  if (UI.busy.has(q.id)) return;
  UI.busy.add(q.id);
  renderAll();
  try {
    const d = await api("/api/learn/quiz/answer", { id: q.id, answer: text });
    if (d.error) {
      toast(d.error, undefined, 4000);
      if (/已经答过|收起/.test(d.error)) refresh();
    } else {
      UI.answeredHere.set(q.id, { result: d.result, feedback: d.feedback });
      UI.openAnswer.delete(q.id);
      UI.drafts.delete(q.id);
      refresh();
    }
  } catch (err) {
    toast(whyFailed(err, "判卷没成功，再交一次"), undefined, 4000);
  } finally {
    UI.busy.delete(q.id);
    renderAll();
  }
}

async function dismissQuiz(q) {
  UI.busy.add(q.id);
  renderAll();
  try {
    const d = await api("/api/learn/quiz/dismiss", { id: q.id });
    if (d.error) toast(d.error);
    else { q.status = "dismissed"; S.quiz = S.quiz.filter((x) => x.id !== q.id); UI.drafts.delete(q.id); UI.openAnswer.delete(q.id); }
  } catch (err) {
    toast(whyFailed(err, "没收起来，再试一次"));
  } finally {
    UI.busy.delete(q.id);
    renderAll();
  }
}

// ───────────────────────── 复习 ─────────────────────────
function renderReview() {
  const all = S.review;
  if (S.down && !all) { counts.review.textContent = ""; return reviewBody.replaceChildren(downNote()); }
  if (!all) return reviewBody.replaceChildren(note("读取中…"));
  // 刚交过卷的条目服务端已经改了到期日、不在列表里了：留在原位让人看完反馈，点「收起」才去掉
  const judged = [...UI.rev.entries()].filter(([, v]) => v.phase === "done" && v.item && v.key === S.key).map(([id, v]) => ({ ...v.item, id, mine: !!S.key }));
  const seen = new Set(all.map((i) => i.id));
  const stale = (i) => { const v = UI.rev.get(i.id); return v?.hidden || (v?.phase === "done" && v.key !== S.key); }; // 收起了的、在别的书里交的卷
  const list = [...all, ...judged.filter((j) => !seen.has(j.id))].filter((i) => !stale(i));
  const due = all.filter((i) => UI.rev.get(i.id)?.phase !== "done" && !stale(i));
  const mine = S.key ? list.filter((i) => i.mine === true) : list;   // 没开书时全部列出来，只是不能跳页
  const others = S.key ? list.filter((i) => i.mine !== true) : [];
  counts.review.textContent = due.length ? String(due.length) : "";
  const kids = [];
  if (S.down) kids.push(downNote());
  const dueMine = due.filter((i) => i.mine === true).length;
  kids.push(E("p", "ln-sum", due.length ? `今天到期 ${due.length} 条${S.key ? `（本书 ${dueMine}）` : ""}` : "没有到期的，读到哪算哪"));
  const shown = UI.allReview ? mine : mine.slice(0, REVIEW_FOLD);
  kids.push(...shown.map((i) => reviewCard(i, !!S.key)));
  if (mine.length > shown.length) kids.push(E("div", "ln-fold", btn("ln-link", `${S.key ? "本书" : ""}还有 ${mine.length - shown.length} 条`, () => { UI.allReview = true; renderAll(); })));
  if (others.length) {
    kids.push(E("div", "ln-fold", btn("ln-link", `其他书还有 ${others.length} 条${UI.otherReview ? "　收起" : ""}`, () => { UI.otherReview = !UI.otherReview; renderAll(); })));
    if (UI.otherReview) kids.push(...others.slice(0, 30).map((i) => reviewCard(i, false)));
  }
  reviewBody.replaceChildren(...kids);
}

function reviewCard(it, here) {
  const st = UI.rev.get(it.id) || (it.question ? { phase: "asked", question: it.question } : { phase: "idle" });
  const busy = UI.busy.has(it.id);
  const meta = E("p", "ln-meta", E("span", "ln-kind", KIND[it.kind] || "条目"),
    here && it.page ? btn("ln-link", where(it.title, it.page), () => jump(it.page, it.kind === "highlight" ? it.text : ""), { title: "回到原文" }) : E("span", "", where(it.title, it.page)));
  const text = E("p", "ln-ex", it.kind === "highlight" ? el("mark", { textContent: snip(it.text) }) : snip(it.text));
  const card = E("div", "ln-card ln-rev", meta, text);
  if (st.err) card.append(E("p", "ln-note err", st.err));
  if (st.phase === "done") {
    if (st.question) card.append(E("p", "ln-qtext dim", st.question));
    card.append(E("div", "ln-res", E("span", "ln-tag " + st.result, RESULT[st.result] || "已答"), E("span", "", st.feedback || "")),
      E("p", "ln-meta", `下次复习：${nextText(st.next)}`, " ", btn("ln-link", "收起", () => { st.hidden = true; renderAll(); })));
    return card;
  }
  if (st.phase === "asked") {
    card.append(E("p", "ln-qtext", st.question));
    card.append(...answerBox(it.id, {
      placeholder: "写下你的回答（⌘ + 回车交卷）", submitText: "交卷",
      onSubmit: (v) => submitReview(it, v),
    }));
    card.append(E("div", "ln-acts", btn("ln-text", "跳过", () => skipReview(it), { disabled: busy })));
    return card;
  }
  card.append(E("div", "ln-acts",
    btn("ln-btn solid", busy ? "出题中…" : "出题", () => askReview(it), { disabled: busy }),
    btn("ln-text", "跳过", () => skipReview(it), { disabled: busy })));
  return card;
}

async function askReview(it) {
  if (UI.busy.has(it.id)) return;
  UI.busy.add(it.id);
  UI.rev.set(it.id, { phase: "idle", item: it });
  renderAll();
  try {
    const d = await api("/api/learn/review/ask", { id: it.id });
    if (d.error) UI.rev.set(it.id, { phase: "idle", item: it, err: d.error });
    else UI.rev.set(it.id, { phase: "asked", item: it, question: d.question });
  } catch (err) {
    UI.rev.set(it.id, { phase: "idle", item: it, err: whyFailed(err, "没出成题，再点一次") });
  } finally {
    UI.busy.delete(it.id);
    renderAll();
  }
}

async function submitReview(it, text) {
  text = text.trim();
  if (!text) return toast("先写下你的回答");
  if (UI.busy.has(it.id)) return;
  UI.busy.add(it.id);
  const prev = UI.rev.get(it.id) || { phase: "asked", item: it };
  renderAll();
  try {
    const d = await api("/api/learn/review/answer", { id: it.id, answer: text });
    if (d.error) UI.rev.set(it.id, { ...prev, err: d.error });
    else {
      UI.rev.set(it.id, { phase: "done", item: it, question: prev.question, result: d.result, feedback: d.feedback, next: d.next_due, at: Date.now(), key: S.key });
      UI.drafts.delete(it.id);
      refreshConceptsQuietly(it);
    }
  } catch (err) {
    UI.rev.set(it.id, { ...prev, err: whyFailed(err, "判卷没成功，再交一次") });
  } finally {
    UI.busy.delete(it.id);
    renderAll();
  }
}

// 概念类复习答对两次会把概念写成已掌握：交卷后把概念表和小问题重新读一遍，但不动复习这一节（让人看完反馈）
async function refreshConceptsQuietly(it) {
  if (it.kind !== "concept") return;
  try {
    const d = await api("/api/learn/concepts");
    if (Array.isArray(d.items)) {
      const old = new Map((S.concepts || []).map((c) => [c.name, c.i]));
      S.concepts = d.items.map((c, i) => ({ ...c, i: old.get(c.name) ?? 1000 + i })).sort((a, b) => a.i - b.i);
      renderConcepts();
    }
  } catch { /* 下次打开这一页会重新读 */ }
}

async function skipReview(it) {
  UI.busy.add(it.id);
  renderAll();
  try {
    const d = await api("/api/learn/review/skip", { id: it.id });
    if (d.error) toast(d.error);
    else { S.review = S.review.filter((x) => x.id !== it.id); UI.rev.delete(it.id); UI.drafts.delete(it.id); }
  } catch (err) {
    toast(whyFailed(err, "没跳过去，再试一次"));
  } finally {
    UI.busy.delete(it.id);
    renderAll();
  }
}

// ───────────────────────── 概念 ─────────────────────────
function renderConcepts() {
  const all = S.concepts;
  if (S.down && !all) { counts.concept.textContent = ""; return conceptBody.replaceChildren(downNote()); }
  if (!all) return conceptBody.replaceChildren(note("读取中…"));
  counts.concept.textContent = all.length ? String(all.length) : "";
  if (!all.length) return conceptBody.replaceChildren(S.down ? downNote() : note("还没有记下的概念。你在问答里问到的概念，Claude 答完会按「卡住 / 半懂 / 已掌握」记在这里。"));
  const n = (s) => all.filter((c) => c.status === s).length;
  const here = labelOf(S.title);
  const shown = UI.allConcepts ? all : all.slice(0, CONCEPT_FOLD);
  const kids = [];
  if (S.down) kids.push(downNote());
  kids.push(E("p", "ln-sum", `卡住 ${n("卡住")} · 半懂 ${n("半懂")} · 已掌握 ${n("已掌握")}`),
    E("div", "ln-clist", ...shown.map((c) => {
      const busy = UI.busy.has("c:" + c.name);
      const jumpable = here && c.book === here && c.page;
      return E("div", "ln-c",
        E("div", "ln-cname", E("span", "", c.name), c.note ? E("small", "", c.note) : null),
        btn("ln-st " + STATUS_CLS[c.status], c.status, () => cycleConcept(c), { disabled: busy, title: "点一下换状态：卡住 → 半懂 → 已掌握" + (c.source === "auto" ? "" : "。这一行归你，自动回写不会改它的状态") }),
        jumpable
          ? el("button", { type: "button", className: "ln-cwhere ln-link", onclick: () => gotoPage(c.page), title: `${c.book} · 第 ${c.page} 页` },
            E("span", "bk", c.book), E("span", "pg", ` · ${c.page}`))
          : E("span", "ln-cwhere", c.book ? E("span", "bk", c.book) : null, c.book && c.page ? E("span", "pg", ` · ${c.page}`) : null));
    })));
  if (all.length > shown.length) kids.push(E("div", "ln-fold", btn("ln-link", `展开全部 ${all.length} 个`, () => { UI.allConcepts = true; renderAll(); })));
  else if (UI.allConcepts && all.length > CONCEPT_FOLD) kids.push(E("div", "ln-fold", btn("ln-link", "收起", () => { UI.allConcepts = false; renderAll(); })));
  conceptBody.replaceChildren(...kids);
}

async function cycleConcept(c) {
  const id = "c:" + c.name;
  if (UI.busy.has(id)) return;
  const next = STATUS_NEXT[c.status];
  UI.busy.add(id);
  renderAll();
  try {
    const d = await api("/api/learn/concepts", { source: "manual", items: [{ name: c.name, status: next, book: c.book, page: c.page }] });
    if (d.error) toast(d.error, undefined, 4000);
    else { c.status = next; c.source = "manual"; }
  } catch (err) {
    toast(whyFailed(err, "没改成，再点一次"), undefined, 4000);
  } finally {
    UI.busy.delete(id);
    renderAll();
  }
}

// ───────────────────────── 徽标：问答发出后，等小问题出现 ─────────────────────────
let pollId = 0;
window.addEventListener("question-sent", () => {
  const b = currentBook();
  const my = ++pollId;
  if (!b) return;
  const end = Date.now() + 120000;
  let base = null;
  const tick = async () => {
    if (my !== pollId) return;
    try {
      const s = await api("/api/learn/summary?file=" + enc(b.key));
      if (my !== pollId) return;
      if (!s.error && typeof s.quiz_open === "number") {
        if (base === null) base = s.quiz_open;
        else if (s.quiz_open > base) {
          setBadge("learn", "done");
          if (currentView() === "learn") refresh();
          return;
        }
      }
    } catch { /* 服务暂时没回：下一轮再查 */ }
    if (Date.now() < end) setTimeout(tick, 5000);
  };
  tick();
});

// ───────────────────────── 书架书桌 ─────────────────────────
window.addEventListener("desk-rendered", async (e) => {
  const { key, node } = e.detail || {};
  const ext = node?.querySelector?.(".desk-ext");
  if (!key || !ext) return;
  try {
    const s = await api("/api/learn/summary?file=" + enc(key));
    if (s.error || !ext.isConnected) return;
    const parts = [];
    if (s.quiz_open > 0) parts.push(`还有 ${s.quiz_open} 道小问题`);
    if (s.due > 0) parts.push(`今天 ${s.due} 条到期`);
    ext.replaceChildren(...(parts.length ? [el("span", { className: "learn-hint", textContent: parts.join(" · ") })] : []));
  } catch { /* 服务没开：书桌上本来就有「没在运行」的提示 */ }
});

// 换书：学习视图开着就刷新；没开着，下次打开时 onShow 会刷新
window.addEventListener("book-opened", () => { UI.allReview = false; UI.allConcepts = false; if (currentView() === "learn") refresh(); });
