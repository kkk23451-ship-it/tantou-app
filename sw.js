// アプリの枠を端末に保存し、通信なしでも開けるようにする。
// 枠は保存したものをすぐ返し、裏で新しい版を取りに行く（次に開いたときに反映）。
// GitHub への問い合わせ（問題と記録）はここでは扱わない。問題を保存した "data" の入れ物は消さない。
const CACHE = "shell-v8";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.json", "icon-180.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/dev/")) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || new Response("offline", { status: 503 });
    })
  );
});
