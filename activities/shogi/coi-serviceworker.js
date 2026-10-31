/* GitHub Pages 等でも SharedArrayBuffer(WASMスレッド)を使えるようにする Service Worker。
   HTML と同じフォルダに置く。初回アクセス時に自動登録され、ページが1回だけ再読込される。 */
if (typeof window === 'undefined') {
  self.addEventListener('install', function () { self.skipWaiting(); });
  self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
  self.addEventListener('fetch', function (e) {
    if (e.request.cache === 'only-if-cached' && e.request.mode !== 'same-origin') return;
    e.respondWith(
      fetch(e.request).then(function (r) {
        if (r.status === 0) return r;
        var h = new Headers(r.headers);
        h.set('Cross-Origin-Embedder-Policy', 'require-corp');
        h.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
      }).catch(function (err) { return Response.error(); })
    );
  });
} else if (!window.crossOriginIsolated && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(document.currentScript.src).then(function (reg) {
    reg.addEventListener('updatefound', function () { window.location.reload(); });
    if (reg.active && !navigator.serviceWorker.controller) window.location.reload();
  }).catch(function (e) { console.warn('coi-serviceworker 登録失敗', e); });
}
