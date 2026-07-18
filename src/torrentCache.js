// src/torrentCache.js
// Тимчасовий кеш .torrent буферів за infoHash.
// Потрібен тому що Stremio робить ДВА окремих HTTP-запити:
//   1) GET /stream/movie/tt123.json  — де ми віддаємо список стрімів з URL
//   2) GET /watch/<infoHash>.mp4     — де Stremio відкриває цей URL для перегляду
// Буфер .torrent файлу (з правильними announce URL і токеном) отримується
// на кроці 1, але фактично потрібен тільки на кроці 2 — тому зберігаємо
// його тут на короткий час.

const cache = new Map()
const TTL = 15 * 60 * 1000 // 15 хвилин вистачає щоб встигнути натиснути play
const MAX_ENTRIES = 20

function set(infoHash, buffer) {
  if (cache.has(infoHash)) {
    const prev = cache.get(infoHash)
    if (prev?.timer) clearTimeout(prev.timer)
  }

  // Evict oldest entries when over cap (Map iterates in insertion order)
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    const entry = cache.get(oldest)
    if (entry?.timer) clearTimeout(entry.timer)
    cache.delete(oldest)
  }

  const timer = setTimeout(() => cache.delete(infoHash), TTL)
  cache.set(infoHash, { buffer, timer })
}

function get(infoHash) {
  const entry = cache.get(infoHash)
  return entry ? entry.buffer : undefined
}

module.exports = { set, get }
