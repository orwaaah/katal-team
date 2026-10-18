// KATAL Team service worker: makes the app installable and lets it open without a connection.
// The page is always fetched fresh when online (so updates arrive at once); the saved copy is
// only used offline. Data never goes through here (sign-in and the api go straight to Supabase),
// except Drive videos for the app's own player, streamed in pieces (see driveVideo below).
const VERSION = 'bc09a02f331a';
const CACHE = 'katal-' + VERSION;
const FILES = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('katal-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The sign-in library (a fixed version, so it never changes) is kept too, so the app can start offline.
const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/';

/**
 * The app's video player asks for drive-video/<file id>?k=<Drive key>&n=<size>. Google only takes the key in a
 * header (not in a link), so this fetches the asked-for piece from Drive with it and answers like a server would.
 * The address never leaves the phone.
 */
const PIECE = 2 * 1024 * 1024;
function driveVideo(req, url) {
  const id = decodeURIComponent(url.pathname.split('/drive-video/')[1] || '');
  const key = url.searchParams.get('k') || '';
  const size = Number(url.searchParams.get('n')) || 0;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
  const start = m ? Number(m[1]) : 0;
  let end = start + PIECE - 1;
  if (m && m[2]) end = Math.min(end, Number(m[2]));
  if (size) end = Math.min(end, size - 1);
  if (size && start >= size) return Promise.resolve(new Response('', { status: 416, headers: { 'content-range': 'bytes */' + size } }));
  return fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    headers: { authorization: 'Bearer ' + key, range: 'bytes=' + start + '-' + end }
  }).then((res) => {
    if (res.status !== 206 && res.status !== 200) return new Response('', { status: res.status });
    return res.arrayBuffer().then((body) => {
      // A 200 is the whole file (the range was ignored): it starts at 0.
      const from = res.status === 206 ? start : 0;
      const total = size || (res.status === 200 ? body.byteLength : '*');
      return new Response(body, {
        status: 206,
        headers: {
          'content-type': res.headers.get('content-type') || 'video/mp4',
          'content-range': 'bytes ' + from + '-' + (from + body.byteLength - 1) + '/' + total,
          'content-length': String(body.byteLength),
          'accept-ranges': 'bytes'
        }
      });
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const here = new URL(req.url);
  if (here.origin === self.location.origin && here.pathname.includes('/drive-video/')) { e.respondWith(driveVideo(req, here)); return; }
  if (req.url.startsWith(LIB)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); }
      return res;
    }).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
