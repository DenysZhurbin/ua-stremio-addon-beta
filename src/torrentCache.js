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

function set(infoHash, buffer) {
  cache.set(infoHash, buffer)
  setTimeout(() => cache.delete(infoHash), TTL)
}

function get(infoHash) {
  return cache.get(infoHash)
}

module.exports = { set, get }
