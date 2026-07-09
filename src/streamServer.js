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

// DHT/LSD/NAT-traversal вимкнені навмисно:
//   - Toloka — приватний трекер, піри доступні ТІЛЬКИ через
//     announce URL з персональним токеном, DHT там нічого не знайде
//   - WebTorrent з увімкненим DHT відкриває десятки UDP-портів
//     через що Render.com попереджав про ліміт портів і, судячи
//     з логів, перезапускав контейнер
const client = new WebTorrent({
  dht: false,
  lsd: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
})

client.on('error', err => {
  console.error('WebTorrent client error:', err.message)
})

// Render free tier має тільки 512MB RAM. Кожен активний торрент тримає
// піри, буфери шматків і відкриті з'єднання — кілька одночасних торрентів
// (наприклад, юзер за 20 хв "потикав" 4-5 різних фільмів) можуть вичерпати
// пам'ять і призвести до OOM-рестарту процесу (саме це й спостерігалось:
// сервер "падав через якийсь час"). Тому:
//   - тримаємо не більше MAX_CONCURRENT торрентів одночасно (LRU-витіснення)
//   - і чистимо неактивні набагато швидше (10 хв замість 30)
const MAX_CONCURRENT_TORRENTS = 2
const IDLE_TIMEOUT = 10 * 60 * 1000

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
  entry.cleanupTimer = setTimeout(() => destroyTorrent(infoHash, 'неактивний 10 хв'), IDLE_TIMEOUT)
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
      // path — пише завантажені шматки на диск замість накопичення в RAM
      torrent = client.add(torrentBuffer, { path: DOWNLOAD_PATH, maxWebConns: 20 }, t => {
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
