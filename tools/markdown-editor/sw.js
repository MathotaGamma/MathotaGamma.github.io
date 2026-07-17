/* ==================================================
   Markdown Editor — Service Worker
   オフライン表示対応用キャッシュ管理
   ================================================== */

// 【Ver管理】キャッシュ内容を更新したい場合は、このバージョン文字列を
// インクリメントしてください（例: v1 -> v2）。古いキャッシュは自動で破棄されます。
const CACHE_VERSION = 'v1';
const CACHE_NAME = `md-editor-cache-${CACHE_VERSION}`;

// 起動時に必ず先読みしておく、同一オリジンの必須ファイル
// ※ このファイルの配置場所や index.html のファイル名を変えた場合はここも修正すること
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  '/statics/drive-api/6-2/manager.js',
];

// キャッシュ対象とみなすホスト（CDN・Googleフォント・自オリジン）
const CACHEABLE_HOSTS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  self.location.hostname,
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 1つずつ追加し、どれかが失敗しても他のプリキャッシュは継続する
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] プリキャッシュに失敗:', url, err);
          })
        )
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('md-editor-cache-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET以外（Drive保存・OAuthなど）はキャッシュ対象外。素通りさせてネットワークに任せる
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // Google Drive APIなど、動的な通信はキャッシュ対象外（素通し）
  if (!CACHEABLE_HOSTS.includes(url.hostname)) return;

  // ページ本体（HTMLナビゲーション）は「ネットワーク優先、失敗時キャッシュ」
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(req);
          return cached || cache.match('./index.html');
        }
      })()
    );
    return;
  }

  // それ以外の静的リソース（CSS/JS/フォント）は「キャッシュ優先、裏で更新」
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await networkFetch) || Response.error();
    })()
  );
});
