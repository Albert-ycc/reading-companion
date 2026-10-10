// 只做一件事：本地服务没在运行时，打开应用给出提示页，而不是 Chrome 的断网恐龙
const OFFLINE = `<!doctype html><meta charset="utf-8"><title>伴读</title>
<body style="font:15px/1.7 -apple-system,'PingFang SC',sans-serif;max-width:520px;margin:18vh auto;padding:0 16px;color:#1f2329;background:#ecebe7">
<h2>伴读的本地服务没在运行</h2>
<p>打开「终端」，粘贴下面这行回车，再刷新本页：</p>
<pre style="background:#fff;padding:10px 12px;border-radius:6px;white-space:pre-wrap">launchctl kickstart -k gui/$(id -u)/com.albert.reading-companion</pre>
</body>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
