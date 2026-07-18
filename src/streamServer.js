// src/streamServer.js
// WebTorrent-проксі: завантажує торрент з приватного трекера на нашому
// сервері (де є правильні announce URL з токеном) і віддає відео як
// звичайний HTTP-стрім з підтримкою Range-заголовків.
//
// Це вирішує проблему: вбудований BitTorrent-клієнт Stremio не вміє
// коректно працювати з приватними трекерами навіть коли infoHash +
// sources передані правильно (відома проблема, підтверджена в
// офіційному репозиторії Stremio: issues #676, #687).
//
// Memory constraints (≈512MB hosts): WebTorrent defaults download the
// entire torrent, keep ~55 peers, and cache many pieces in RAM. We
// write pieces to disk, deselect unused files, clamp Range windows,
// limit peers/cache, keep few active torrents, and destroy aggressively.

const WebTorrent = require('webtorrent')
const { pipeline } = require('stream')
const os = require('os')
const path = require('path')
const fs = require('fs')

// КРИТИЧНО: без опції `path` WebTorrent зберігає всі завантажені шматки
// файлу В ОПЕРАТИВНІЙ ПАМ'ЯТІ (MemoryChunkStore) і ніколи їх не звільняє
// по мірі перегляду. Для великого відео (кілька GB) це неминуче з'їдає
// всю доступну RAM за кілька хвилин перегляду — саме це й спричиняло
// краш процесу на Render (512MB ліміту) з незрозумілою причиною
// ("Cause of failure could not be determined" = SIGKILL від OOM,
// його неможливо перехопити на рівні коду).
// Рішення: писати шматки на диск (ephemeral storage є навіть на
// безкоштовному Render) і чистити файли при видаленні торренту.
const DOWNLOAD_PATH = path.join(os.tmpdir(), 'ua-stremio-torrents')
try {
  fs.mkdirSync(DOWNLOAD_PATH, { recursive: true })
} catch (err) {
  console.error('Не вдалось створити папку для torrent-даних:', err.message)
}

const MAX_CONNS = 8
const STORE_CACHE_SLOTS = 3
const MAX_WEB_CONNS = 4
const DOWNLOAD_LIMIT = 3 * 1024 * 1024 // 3 MB/s — fewer in-flight pieces
const MAX_RANGE_BYTES = 4 * 1024 * 1024 // 4 MB per HTTP response
// Render free tier ≈512MB: one active torrent is safest; idle cleanup is short
const MAX_CONCURRENT_TORRENTS = 1
const IDLE_TIMEOUT = 3 * 60 * 1000

// DHT/LSD/NAT-traversal вимкнені навмисно:
//   - Toloka — приватний трекер, піри доступні ТІЛЬКИ через
//     announce URL з персональним токеном, DHT там нічого не знайде
//   - WebTorrent з увімкненим DHT відкриває десятки UDP-портів
//     через що Render.com попереджав про ліміт портів і, судячи
//     з логів, перезапускав контейнер
// downloadLimit обмежує швидкість завантаження на рівні КЛІЄНТА (всі
// торренти разом). Без цього WebTorrent тягне дані з мережі настільки
// швидко, наскільки дозволяють сіди — якщо роздача швидка, а диск/HTTP-
// стрім до Stremio встигають повільніше, непрочитані шматки чекають
// своєї черги і накопичуються в пам'яті (внутрішні буфери мережевих
// сокетів і черга запису на диск).
const client = new WebTorrent({
  dht: false,
  lsd: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
  maxConns: MAX_CONNS,
  downloadLimit: DOWNLOAD_LIMIT,
  uploadLimit: 0, // proxy only — do not seed
})

client.on('error', err => {
  console.error('WebTorrent client error:', err.message)
})

// Періодичний лог пам'яті процесу — для діагностики чи справді витік
// іде під час активного перегляду (допомагає підтвердити/спростувати
// гіпотезу про накопичення буферів у RAM попри запис на диск)
setInterval(() => {
  const mem = process.memoryUsage()
  console.log(
    `📊 RAM: rss=${Math.round(mem.rss / 1024 / 1024)}MB ` +
    `heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB ` +
    `external=${Math.round(mem.external / 1024 / 1024)}MB ` +
    `активних торрентів=${activeTorrents.size}`
  )
}, 30 * 1000)

const activeTorrents = new Map() // infoHash -> { torrent, cleanupTimer, lastUsed }
const pendingAdds = new Map()    // infoHash -> Promise (захист від подвійного client.add при паралельних Range-запитах)

function destroyTorrent(infoHash, reason) {
  const entry = activeTorrents.get(infoHash)
  if (!entry) return
  console.log(`StreamServer: прибираємо торрент ${infoHash} (${reason})`)
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
  const torrent = client.get(infoHash)
  if (torrent) {
    // destroyStore: true — видаляє завантажені файли з диску, інакше
    // ephemeral storage на Render поступово заповниться сміттям від
    // переглянутих раніше фільмів
    torrent.destroy({ destroyStore: true }, err => {
      if (err) console.error(`Помилка видалення файлів торренту ${infoHash}:`, err.message)
    })
  }
  activeTorrents.delete(infoHash)
}

function scheduleCleanup(infoHash) {
  const entry = activeTorrents.get(infoHash)
  if (!entry) return
  entry.lastUsed = Date.now()
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
  entry.cleanupTimer = setTimeout(
    () => destroyTorrent(infoHash, `неактивний ${IDLE_TIMEOUT / 60000} хв`),
    IDLE_TIMEOUT
  )
}

// Якщо перевищено ліміт одночасних торрентів — прибираємо найдавніше
// використаний, щоб звільнити пам'ять під новий
function evictOldestIfNeeded() {
  if (activeTorrents.size < MAX_CONCURRENT_TORRENTS) return
  let oldestHash = null
  let oldestTime = Infinity
  for (const [hash, entry] of activeTorrents) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed
      oldestHash = hash
    }
  }
  if (oldestHash) destroyTorrent(oldestHash, 'ліміт одночасних торрентів')
}

function addTorrent(torrentBuffer, infoHash) {
  if (activeTorrents.has(infoHash)) {
    scheduleCleanup(infoHash)
    return Promise.resolve(activeTorrents.get(infoHash).torrent)
  }

  // Захист від race condition: два паралельних Range-запити на той самий
  // фільм (браузер/Stremio так роблять під час буферизації) можуть обидва
  // потрапити сюди до того як перший встигне записати в activeTorrents
  if (pendingAdds.has(infoHash)) {
    return pendingAdds.get(infoHash)
  }

  const promise = new Promise((resolve, reject) => {
    const existing = client.get(infoHash)
    if (existing) {
      activeTorrents.set(infoHash, { torrent: existing, lastUsed: Date.now() })
      scheduleCleanup(infoHash)
      pendingAdds.delete(infoHash)
      return resolve(existing)
    }

    evictOldestIfNeeded()

    let torrent
    try {
      // private: true — КЛЮЧОВЕ виправлення. Файли .torrent з Toloka не
      // мають прапору "private" у метаданих (перевірено окремо), тому
      // WebTorrent вважає торрент публічним і сам додає купу публічних
      // UDP-трекерів (global.WEBTORRENT_ANNOUNCE) у спробах знайти пірів,
      // яких там фізично немає — саме це відкривало 75+ портів і викликало
      // попередження/рестарти від Render. Toloka — приватний трекер:
      // піри існують ТІЛЬКИ через наш announce URL з токеном.
      torrent = client.add(torrentBuffer, {
        path: DOWNLOAD_PATH,
        maxWebConns: MAX_WEB_CONNS,
        private: true,
        uploads: false,
        storeCacheSlots: STORE_CACHE_SLOTS,
        destroyStoreOnDestroy: true,
      }, t => {
        // Stop default whole-torrent selection until restrictToSingleFile runs
        if (t.pieces.length > 0) {
          try { t.deselect(0, t.pieces.length - 1, false) } catch (_) {}
        }
        console.log(`StreamServer: торрент додано, файлів: ${t.files.length} (активних торрентів: ${activeTorrents.size + 1})`)
        activeTorrents.set(infoHash, { torrent: t, lastUsed: Date.now() })
        scheduleCleanup(infoHash)
        pendingAdds.delete(infoHash)
        resolve(t)
      })
    } catch (err) {
      pendingAdds.delete(infoHash)
      return reject(err)
    }

    torrent.on('error', err => {
      console.error('StreamServer torrent error:', err.message)
      pendingAdds.delete(infoHash)
      reject(err)
    })
  })

  pendingAdds.set(infoHash, promise)
  return promise
}

function pickVideoFile(torrent, fileIdx) {
  if (typeof fileIdx === 'number' && torrent.files[fileIdx]) {
    return torrent.files[fileIdx]
  }
  const videoExt = /\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i
  let best = null
  for (const file of torrent.files) {
    if (videoExt.test(file.name) && (!best || file.length > best.length)) {
      best = file
    }
  }
  return best || torrent.files[0]
}

// КРИТИЧНО: за замовчуванням WebTorrent вважає ВСІ файли торренту
// "selected" і намагається завантажити їх усі одночасно. Для season-паку
// з Toloka (напр. 36 файлів — цілий сезон) це означає паралельне
// стягування ВСІХ епізодів одночасно замість одного потрібного.
// Виправлення: явно прибираємо пріоритет з усіх файлів і залишаємо
// тільки потрібний.
function restrictToSingleFile(torrent, fileIdx) {
  if (torrent.files.length <= 1) return
  if (torrent._uaRestrictedTo === fileIdx) return
  if (!torrent.files[fileIdx]) return

  torrent.deselect(0, torrent.pieces.length - 1, false)
  torrent.files[fileIdx].select()

  torrent._uaRestrictedTo = fileIdx
  console.log(`StreamServer: обмежено завантаження до файлу [${fileIdx}] "${torrent.files[fileIdx].name}" (з ${torrent.files.length})`)
}

function clampRange(start, end, fileSize) {
  const safeStart = Math.max(0, Math.min(start, fileSize - 1))
  let safeEnd = Math.min(end, fileSize - 1)
  // Cap window so createReadStream only high-priority-selects a few pieces
  if (safeEnd - safeStart + 1 > MAX_RANGE_BYTES) {
    safeEnd = safeStart + MAX_RANGE_BYTES - 1
  }
  return { start: safeStart, end: safeEnd }
}

// Обробляє HTTP-запит на стрімінг з підтримкою Range.
// КРИТИЧНО: усі read-стріми повинні мати обробник 'error', інакше
// необроблена помилка (напр. клієнт розірвав з'єднання) валить
// увесь Node.js процес і перезапускає сервер (втрачаючи кеш).
async function handleStreamRequest(req, res, torrentBuffer, infoHash, fileIdx) {
  let fileStream = null

  const onClientClose = () => {
    if (fileStream && !fileStream.destroyed) {
      fileStream.destroy()
    }
  }
  req.on('close', onClientClose)

  try {
    const torrent = await addTorrent(torrentBuffer, infoHash)
    scheduleCleanup(infoHash)

    const file = pickVideoFile(torrent, fileIdx)
    if (!file) {
      res.writeHead(404)
      res.end('Video file not found in torrent')
      return
    }

    // Знаходимо реальний індекс обраного файлу (fileIdx міг бути undefined,
    // якщо pickVideoFile сама обирала найбільший файл)
    const actualFileIdx = torrent.files.indexOf(file)
    restrictToSingleFile(torrent, actualFileIdx)

    const range = req.headers.range
    const fileSize = file.length

    let start = 0
    let end = fileSize - 1
    let status = 200
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    }

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      start = parseInt(parts[0], 10) || 0
      // Open-ended Range (bytes=N-) would otherwise select nearly the whole file
      end = parts[1] ? parseInt(parts[1], 10) : start + MAX_RANGE_BYTES - 1
      ;({ start, end } = clampRange(start, end, fileSize))
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
      headers['Content-Length'] = end - start + 1
    } else {
      // No Range: still serve a bounded first chunk as 206 so we never
      // high-priority-select the entire multi-GB file into RAM.
      ;({ start, end } = clampRange(0, MAX_RANGE_BYTES - 1, fileSize))
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
      headers['Content-Length'] = end - start + 1
    }

    res.writeHead(status, headers)

    fileStream = file.createReadStream({ start, end })

    pipeline(fileStream, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'PREMATURE_CLOSE') {
        console.error('Stream pipeline error:', err.message)
      }
      req.removeListener('close', onClientClose)
    })

  } catch (err) {
    console.error('handleStreamRequest error:', err.message)
    req.removeListener('close', onClientClose)
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('Streaming error')
    }
  }
}

module.exports = { handleStreamRequest }
