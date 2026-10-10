// 各模块共用的小工具
export const $ = (s) => document.querySelector(s);

let toastTimer;
// action = { label, run }：提示条里带一个按钮（比如「撤销」），停留久一点；ms 给较长的失败说明留够读的时间
export function toast(msg, action, ms) {
  const el = $("#toast");
  el.replaceChildren(msg);
  if (action) {
    el.append(Object.assign(document.createElement("button"), {
      type: "button", textContent: action.label,
      onclick: () => { el.classList.remove("show"); action.run(); },
    }));
  }
  el.classList.toggle("has-action", !!action);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms || (action ? 6000 : 2500));
}

// 发请求，返回 { status, data }。连不上本地服务抛 ServiceDown，响应不是 JSON 抛 BadResponse，message 都是能直接给用户看的中文
async function request(path, body) {
  const down = () => Object.assign(new Error("伴读的本地服务没在运行"), { name: "ServiceDown" });
  let res;
  try {
    res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (err) {
    throw err instanceof TypeError ? down() : err;
  }
  try {
    return { status: res.status, data: await res.json() };
  } catch (err) {
    if (err instanceof TypeError) throw down(); // 响应读到一半连接断了
    if (err instanceof SyntaxError) throw Object.assign(new Error("本地服务回的内容读不懂"), { name: "BadResponse" });
    throw err;
  }
}

// 有响应就原样返回解析后的 JSON，不论状态码（调用方靠 4xx 里的 { error } 判断）
export async function api(path, body) {
  return (await request(path, body)).data;
}

// 写入类请求：状态码 4xx/5xx 或回了 { error } 都当失败抛出，调用方只处理一种失败。
// 4xx 是服务端拒收（err.name 为 Rejected，message 是服务端给的原因），5xx 是服务端自己出了错（ServerError）
export async function apiOk(path, body) {
  const { status, data } = await request(path, body);
  if (status >= 400 || data?.error) {
    throw Object.assign(new Error(data?.error || `服务端回了 ${status}`), { name: status >= 500 ? "ServerError" : "Rejected", status });
  }
  return data;
}

// 给用户看的失败原因：服务没在运行和回包读不懂有现成中文；服务端拒收（4xx）说它给的原因，重试也不会成功，所以不劝人重试；
// 其余（5xx、没有原因）用调用方给的兜底句
export function whyFailed(err, fallback) {
  if (err?.name === "ServiceDown" || err?.name === "BadResponse") return err.message;
  if (err?.name === "Rejected") return /太(长|大)/.test(err.message) ? "这段太长，选短一点" : err.message;
  return fallback;
}

// 版心里的书名：中文竖排正立，西文按书脊惯例侧转
export function setSpineTitle(text) {
  const span = $("#spine-title span");
  span.textContent = text;
  span.title = text;
  const cjk = (text.match(/[㐀-鿿]/g) || []).length;
  span.classList.toggle("cjk", cjk > text.length / 3);
}

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
