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
// deliberately deselect the full torrent, clamp Range windows, limit
// peers/cache, keep one active torrent, and destroy aggressively.

const WebTorrent = require('webtorrent')
const { pipeline } = require('stream')

const MAX_CONNS = 8
const STORE_CACHE_SLOTS = 3
const MAX_WEB_CONNS = 4
const DOWNLOAD_LIMIT = 3 * 1024 * 1024 // 3 MB/s — fewer in-flight pieces
const IDLE_TIMEOUT = 3 * 60 * 1000 // 3 min (was 30) — reclaim RAM sooner
const MAX_RANGE_BYTES = 4 * 1024 * 1024 // 4 MB per HTTP response
const MAX_ACTIVE_TORRENTS = 1

// DHT/LSD/NAT-traversal вимкнені навмисно:
//   - Toloka — приватний трекер, піри доступні ТІЛЬКИ через
//     announce URL з персональним токеном, DHT там нічого не знайде
//   - WebTorrent з увімкненим DHT відкриває десятки UDP-портів
//     (пошук по всій мережі), через що Render.com попереджав
//     "Detected more than the maximum number (75) of ports" і,
//     судячи з періодичних рестартів контейнера в логах, це й
//     було причиною нестабільної/повільної роботи
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

const activeTorrents = new Map()

function logMemory(label) {
  const m = process.memoryUsage()
  console.log(
    `StreamServer [${label}]: rss=${(m.rss / 1e6).toFixed(0)}MB ` +
    `heap=${(m.heapUsed / 1e6).toFixed(0)}MB torrents=${activeTorrents.size}`
  )
}

function destroyTorrent(infoHash) {
  return new Promise(resolve => {
    const entry = activeTorrents.get(infoHash)
    if (entry?.cleanupTimer) clearTimeout(entry.cleanupTimer)
    activeTorrents.delete(infoHash)

    const torrent = client.get(infoHash)
    if (!torrent) return resolve()

    torrent.destroy({ destroyStore: true }, () => {
      console.log(`StreamServer: знищено торрент ${infoHash}`)
      resolve()
    })
  })
}

async function evictOtherTorrents(keepInfoHash) {
  const others = [...activeTorrents.keys()].filter(h => h !== keepInfoHash)
  if (others.length === 0) return
  // Keep only MAX_ACTIVE_TORRENTS (typically 1) to survive 512MB hosts
  const overflow = Math.max(0, others.length - (MAX_ACTIVE_TORRENTS - 1))
  await Promise.all(others.slice(0, overflow).map(destroyTorrent))
}

function scheduleCleanup(infoHash) {
  const entry = activeTorrents.get(infoHash)
  if (!entry) return
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
  entry.cleanupTimer = setTimeout(() => {
    console.log(`StreamServer: прибираємо неактивний торрент ${infoHash}`)
    destroyTorrent(infoHash).then(() => logMemory('cleanup'))
  }, IDLE_TIMEOUT)
}

// WebTorrent selects the entire torrent with low priority on ready.
// That alone OOMs on 512MB for multi-GB releases — remove it immediately.
function deselectEntireTorrent(torrent) {
  if (!torrent.pieces || torrent.pieces.length === 0) return
  try {
    torrent.deselect(0, torrent.pieces.length - 1, false)
  } catch (err) {
    console.error('StreamServer deselect error:', err.message)
  }
}

async function addTorrent(torrentBuffer, infoHash) {
  if (activeTorrents.has(infoHash)) {
    scheduleCleanup(infoHash)
    return activeTorrents.get(infoHash).torrent
  }

  const existing = client.get(infoHash)
  if (existing) {
    activeTorrents.set(infoHash, { torrent: existing })
    scheduleCleanup(infoHash)
    return existing
  }

  await evictOtherTorrents(infoHash)

  return new Promise((resolve, reject) => {
    let torrent
    try {
      torrent = client.add(torrentBuffer, {
        maxWebConns: MAX_WEB_CONNS,
        uploads: false,
        storeCacheSlots: STORE_CACHE_SLOTS,
        destroyStoreOnDestroy: true,
      }, t => {
        deselectEntireTorrent(t)
        console.log(`StreamServer: торрент додано, файлів: ${t.files.length}`)
        activeTorrents.set(infoHash, { torrent: t })
        scheduleCleanup(infoHash)
        logMemory('add')
        resolve(t)
      })
    } catch (err) {
      return reject(err)
    }

    // Also deselect on ready in case selection is re-applied during verify
    torrent.on('ready', () => deselectEntireTorrent(torrent))

    torrent.on('error', err => {
      console.error('StreamServer torrent error:', err.message)
      activeTorrents.delete(infoHash)
      reject(err)
    })
  })
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

  // Якщо клієнт (Stremio) закриває з'єднання достроково — просто
  // прибираємо read-стрім, це нормальна поведінка, не помилка сервера
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

    // pipeline сам коректно обробляє помилки з обох боків (readStream і res)
    // і не кидає необроблений 'error', на відміну від .pipe()
    pipeline(fileStream, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'PREMATURE_CLOSE') {
        console.error('Stream pipeline error:', err.message)
      }
      // Прибираємо обробник щоб не накопичувались листенери
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
