// 反问模式：问答栏右上角的「反问」开关。开着时，Claude 每次回答前先用一两个问题摸清你懂了什么、卡在哪，等你答了再讲。
// 开关的状态存在服务端（DATA/mode.json），提问时 hook 读它，所以刷新页面、换窗口都不丢；这里只是它的遥控器。
import { $, el, toast, api, apiOk, whyFailed } from "./ui.js";
import { registerAction } from "./registry.js";

const btn = el("button", {
  id: "chat-socratic", className: "ghost", type: "button", textContent: "反问",
  title: "开着时，Claude 先问你懂了什么、卡在哪，你答了再讲；说「直接讲」就直接讲",
});
btn.setAttribute("role", "switch");
btn.setAttribute("aria-checked", "false");
$(".chat-tools").append(btn);

let on = false;
let busy = false; // 请求在路上时不接第二次点击：开关两次点下去，服务端最后落在哪一边要由这里说了算

function paint() {
  btn.setAttribute("aria-checked", String(on));
}

// 以服务端为准：启动时、窗口回到前台时各读一次（另一个窗口可能改过）。读不到就保持原样，不报错
async function sync() {
  if (busy) return;
  try {
    const r = await api("/api/mode");
    if (typeof r?.socratic === "boolean") { on = r.socratic; paint(); }
  } catch { /* 服务没开：点开关时再说原因 */ }
}

function why(err) {
  if (err?.status === 404) return "服务还没加载反问模式，重启一次伴读的本地服务";
  return whyFailed(err, "服务出错了，稍后再试");
}

async function set(next) {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  try {
    const r = await apiOk("/api/mode", { socratic: next });
    on = r.socratic === true;
    paint();
    toast(on ? "反问模式已开：Claude 先问你，再讲" : "反问模式已关");
  } catch (err) {
    toast(`没能${next ? "开" : "关"}反问模式：${why(err)}`);
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

btn.addEventListener("click", () => set(!on));
window.addEventListener("focus", sync);
sync();

// 「/反问」：不带参数是翻转；「/反问 开」「/反问 关」指定
registerAction({
  name: "反问", desc: "开 / 关反问模式", order: 60,
  run: (args) => {
    const a = String(args ?? "").trim().toLowerCase();
    return set(/^(开|on|1|true)$/.test(a) ? true : /^(关|off|0|false)$/.test(a) ? false : !on);
  },
});
