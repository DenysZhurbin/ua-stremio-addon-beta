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
const { pipeline } = require('stream')

const client = new WebTorrent()

// На всяк випадок ловимо помилки самого клієнта, щоб вони не валили процес
client.on('error', err => {
  console.error('WebTorrent client error:', err.message)
})

const activeTorrents = new Map()
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

    let torrent
    try {
      torrent = client.add(torrentBuffer, t => {
        console.log(`StreamServer: торрент додано, файлів: ${t.files.length}`)
        activeTorrents.set(infoHash, { torrent: t })
        scheduleCleanup(infoHash)
        resolve(t)
      })
    } catch (err) {
      return reject(err)
    }

    torrent.on('error', err => {
      console.error('StreamServer torrent error:', err.message)
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
      end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
      headers['Content-Length'] = end - start + 1
    } else {
      headers['Content-Length'] = fileSize
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
