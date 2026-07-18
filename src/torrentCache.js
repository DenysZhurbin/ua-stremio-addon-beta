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
const MAX_BYTES = 10 * 1024 * 1024
let totalBytes = 0

function remove(infoHash) {
  const entry = cache.get(infoHash)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  totalBytes -= entry.buffer.length
  cache.delete(infoHash)
}

function evictOldest() {
  const oldest = cache.keys().next().value
  if (oldest !== undefined) remove(oldest)
}

function set(infoHash, buffer) {
  remove(infoHash)
  if (buffer.length > MAX_BYTES) return false

  while (
    cache.size > 0 &&
    (cache.size >= MAX_ENTRIES || totalBytes + buffer.length > MAX_BYTES)
  ) {
    evictOldest()
  }

  const timer = setTimeout(() => remove(infoHash), TTL)
  timer.unref?.()
  cache.set(infoHash, { buffer, timer })
  totalBytes += buffer.length
  return true
}

function get(infoHash) {
  const entry = cache.get(infoHash)
  if (!entry) return undefined

  // Refresh insertion order so the byte/entry cap evicts least-recently-used
  // metadata, while the original TTL still bounds credential-bearing buffers.
  cache.delete(infoHash)
  cache.set(infoHash, entry)
  return entry.buffer
}

module.exports = { set, get }
