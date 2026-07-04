// src/streamServer.js
// WebTorrent-проксі: завантажує торрент з приватного трекера на нашому
// сервері (де є правильні announce URL з токеном) і віддає відео як
// звичайний HTTP-стрім з підтримкою Range-заголовків.
//
// Це вирішує проблему: вбудований BitTorrent-клієнт Stremio не вміє
// коректно працювати з приватними трекерами навіть коли infoHash +
// sources передані правильно (відома проблема, підтверджена в
// офіційному репозиторії Stremio: issues #676, #687).

const WebTorrent = require('webtorrent')

const client = new WebTorrent()
// Кеш активних торрентів за infoHash щоб не додавати один і той самий
// торрент повторно при кількох запитах (наприклад повторні Range-запити)
const activeTorrents = new Map()

// Автоматично прибираємо торрент з клієнта через 30 хв бездіяльності,
// щоб не тримати вічно відкриті з'єднання і не вичерпати RAM/CPU на Render
const IDLE_TIMEOUT = 30 * 60 * 1000

function scheduleCleanup(infoHash) {
  const entry = activeTorrents.get(infoHash)
  if (!entry) return
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
  entry.cleanupTimer = setTimeout(() => {
    console.log(`StreamServer: прибираємо неактивний торрент ${infoHash}`)
    const torrent = client.get(infoHash)
    if (torrent) torrent.destroy()
    activeTorrents.delete(infoHash)
  }, IDLE_TIMEOUT)
}

// Додає торрент у WebTorrent клієнт (буфер .torrent файлу з правильними
// announce URL, витягнутими на боці аддону де вже є credentials/cookies)
function addTorrent(torrentBuffer, infoHash) {
  return new Promise((resolve, reject) => {
    if (activeTorrents.has(infoHash)) {
      scheduleCleanup(infoHash)
      return resolve(activeTorrents.get(infoHash).torrent)
    }

    const existing = client.get(infoHash)
    if (existing) {
      activeTorrents.set(infoHash, { torrent: existing })
      scheduleCleanup(infoHash)
      return resolve(existing)
    }

    const torrent = client.add(torrentBuffer, torrent => {
      console.log(`StreamServer: торрент додано, файлів: ${torrent.files.length}`)
      activeTorrents.set(infoHash, { torrent })
      scheduleCleanup(infoHash)
      resolve(torrent)
    })

    torrent.on('error', err => {
      console.error('StreamServer torrent error:', err.message)
      reject(err)
    })
  })
}

// Обирає найбільший відеофайл у торренті (або конкретний за індексом)
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

// Обробляє HTTP-запит на стрімінг відео з підтримкою Range
async function handleStreamRequest(req, res, torrentBuffer, infoHash, fileIdx) {
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

    if (!range) {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      })
      file.createReadStream().pipe(res)
      return
    }

    const parts = range.replace(/bytes=/, '').split('-')
    const start = parseInt(parts[0], 10)
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    const chunkSize = end - start + 1

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    })

    file.createReadStream({ start, end }).pipe(res)

  } catch (err) {
    console.error('handleStreamRequest error:', err.message)
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('Streaming error')
    }
  }
}

module.exports = { handleStreamRequest }
