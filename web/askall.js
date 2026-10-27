// 全库提问：没开书时，问答栏问的就是读过的全部书。书架上把输入框的提示语换成能问什么的例子，打开书后换回去。
// 注入给 Claude 的内容在 .claude/hooks/inject_reading.py 的 library_block（页面没给书的上下文时服务把 READER_CONTEXT 设为 none）。
import { $ } from "./ui.js";

const input = $("#q");
const ALL = "没开书时问的是你读过的全部书：我在哪本书里问过 X？两本书对 Y 的说法有什么不同？";
let saved = null; // 换之前输入框的提示语（「/」菜单模块加载成功会把它改成带「/ 调出命令」的那句，这里不写死）

function enter() {
  // 书架可见就是全库提问，书还开在后台也一样（chat.js 在书架可见时按全库发问）
  if (input.placeholder === ALL) return;
  saved = input.placeholder;
  input.placeholder = ALL;
}

function leave() {
  if (input.placeholder === ALL && saved !== null) input.placeholder = saved;
  saved = null;
}

window.addEventListener("library-shown", enter);
window.addEventListener("book-opened", leave);
// 模块比首次 showLibrary 加载得晚，错过了那次事件：书架已经在眼前就补上。稍等一下，让「/」菜单先把它的提示语写好
setTimeout(() => { if (!$("#library").hidden) enter(); }, 300);
