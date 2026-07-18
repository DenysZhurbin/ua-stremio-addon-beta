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
const {
  createWebTorrentClientOptions,
  deselectDefaultDownload,
  formatAnnounceList,
  parseByteRange,
  parseCgroupInactiveFile,
  releasePeerThrottleStreams,
  restrictToSingleFile,
} = require('./streamUtils')

// WebTorrent already uses FSChunkStore in Node. A dedicated path makes
// ephemeral files predictable and lets destroyStore remove them reliably.
const DOWNLOAD_PATH = path.join(os.tmpdir(), 'ua-stremio-torrents')

// Hosts like Render/Beamup often cap ephemeral /tmp around 2GB. Stay under
// that with a watermark and wipe leftovers from previous crashes on boot.
const DISK_HIGH_WATERMARK = 1200 * 1024 * 1024

function getDirectorySizeBytes(dirPath) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (_) {
    return 0
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    try {
      if (entry.isDirectory()) {
        total += getDirectorySizeBytes(fullPath)
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size
      }
    } catch (_) {}
  }
  return total
}

function removeStoreDirsForHash(infoHash) {
  if (!infoHash) return
  const suffix = ` - ${String(infoHash).slice(0, 8).toLowerCase()}`
  let entries
  try {
    entries = fs.readdirSync(DOWNLOAD_PATH)
  } catch (_) {
    return
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(suffix)) continue
    try {
      fs.rmSync(path.join(DOWNLOAD_PATH, name), { recursive: true, force: true })
      console.log(`StreamServer: примусово видалено store "${name}"`)
    } catch (err) {
      console.error(`StreamServer: не вдалось видалити store "${name}":`, err.message)
    }
  }
}

function resetDownloadPath() {
  try {
    fs.rmSync(DOWNLOAD_PATH, { recursive: true, force: true })
  } catch (err) {
    console.error('Не вдалось очистити папку torrent-даних:', err.message)
  }
  try {
    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true })
  } catch (err) {
    console.error('Не вдалось створити папку для torrent-даних:', err.message)
  }
}

resetDownloadPath()

const MAX_CONNECTIONS = 6
const STORE_CACHE_SLOTS = 0
const DOWNLOAD_LIMIT = 5 * 1024 * 1024
const UPLOAD_LIMIT = 512 * 1024
const MEMORY_HIGH_WATERMARK = 420 * 1024 * 1024

// Keep peer/native-buffer pressure bounded. A non-zero upload allowance is
// required because WebTorrent's outbound throttle also carries handshakes and
// piece requests; uploadLimit:0 makes downloads look idle forever.
const client = new WebTorrent(createWebTorrentClientOptions({
  maxConnections: MAX_CONNECTIONS,
  downloadLimit: DOWNLOAD_LIMIT,
  uploadLimit: UPLOAD_LIMIT,
}))
console.log(
  `StreamServer: peer transports TCP${client.utp ? ' + uTP (shared UDP socket)' : ' only'}`
)

client.on('error', err => {
  console.error('WebTorrent client error:', err.message)
})

const CGROUP_MEMORY_PATHS = [
  '/sys/fs/cgroup/memory.current',
  '/sys/fs/cgroup/memory/memory.usage_in_bytes',
]
const CGROUP_MEMORY_STAT_PATHS = [
  '/sys/fs/cgroup/memory.stat',
  '/sys/fs/cgroup/memory/memory.stat',
]

function readCgroupMemory() {
  for (const memoryPath of CGROUP_MEMORY_PATHS) {
    try {
      const value = Number(fs.readFileSync(memoryPath, 'utf8').trim())
      if (Number.isSafeInteger(value) && value > 0) return value
    } catch (_) {}
  }
  return null
}

function readCgroupWorkingSet() {
  const current = readCgroupMemory()
  if (current === null) return null

  for (const statPath of CGROUP_MEMORY_STAT_PATHS) {
    try {
      const stats = fs.readFileSync(statPath, 'utf8')
      return Math.max(0, current - parseCgroupInactiveFile(stats))
    } catch (_) {}
  }
  return current
}

function getGuardedMemoryUsage() {
  return readCgroupWorkingSet() || process.memoryUsage().rss
}

const memoryLogTimer = setInterval(() => {
  const mem = process.memoryUsage()
  const containerMemory = readCgroupMemory()
  const containerWorkingSet = readCgroupWorkingSet()
  const peers = client.torrents.reduce(
    (total, torrent) => total + (torrent.wires?.length || 0),
    0
  )
  const pendingPeers = client.torrents.reduce(
    (total, torrent) => total + (torrent._numPending || 0),
    0
  )
  const queuedPeers = client.torrents.reduce(
    (total, torrent) => total + (torrent._queue?.length || 0),
    0
  )
  const streams = Array.from(activeTorrents.values()).reduce(
    (total, entry) => total + entry.streams.size,
    0
  )
  const diskUsed = getDirectorySizeBytes(DOWNLOAD_PATH)
  console.log(
    `📊 RAM: rss=${Math.round(mem.rss / 1024 / 1024)}MB ` +
    `heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB ` +
    `external=${Math.round(mem.external / 1024 / 1024)}MB ` +
    `arrayBuffers=${Math.round((mem.arrayBuffers || 0) / 1024 / 1024)}MB ` +
    (containerMemory
      ? `container=${Math.round(containerMemory / 1024 / 1024)}MB `
      : '') +
    (containerWorkingSet
      ? `workingSet=${Math.round(containerWorkingSet / 1024 / 1024)}MB `
      : '') +
    `disk=${Math.round(diskUsed / 1024 / 1024)}MB ` +
    `торрентів=${activeTorrents.size} peers=${peers} ` +
    `pending=${pendingPeers} queued=${queuedPeers} streams=${streams}`
  )
}, 30 * 1000)
memoryLogTimer.unref?.()

// Match main's concurrency window so Stremio probing another quality does not
// immediately destroy the torrent that is still buffering peers.
const MAX_CONCURRENT_TORRENTS = 2
// Keep idle piece data briefly; long holds fill the 2GB /tmp quota.
const IDLE_TIMEOUT = 2 * 60 * 1000

// infoHash -> { torrent, cleanupTimer, lastUsed, streams: Set<Readable> }
const activeTorrents = new Map()
const pendingAdds = new Map()    // infoHash -> Promise (захист від подвійного client.add при паралельних Range-запитах)
const pendingDestroys = new Map()
let addQueue = Promise.resolve()
let memoryGuardRunning = false
let diskGuardRunning = false

const memoryGuardTimer = setInterval(async () => {
  if (memoryGuardRunning || client.torrents.length === 0) return
  const usage = getGuardedMemoryUsage()
  if (usage < MEMORY_HIGH_WATERMARK) return

  const infoHash = activeTorrents.keys().next().value || client.torrents[0]?.infoHash
  if (!infoHash) return

  memoryGuardRunning = true
  console.error(
    `StreamServer: memory high watermark ` +
    `${Math.round(usage / 1024 / 1024)}MB; зупиняємо активний торрент`
  )
  try {
    await destroyTorrent(infoHash, 'memory high watermark')
  } catch (err) {
    console.error('StreamServer memory guard error:', err.message)
  } finally {
    memoryGuardRunning = false
  }
}, 5 * 1000)
memoryGuardTimer.unref?.()

const diskGuardTimer = setInterval(async () => {
  if (diskGuardRunning) return
  const diskUsed = getDirectorySizeBytes(DOWNLOAD_PATH)
  if (diskUsed < DISK_HIGH_WATERMARK) return

  if (activeTorrents.size === 0) {
    console.error(
      `StreamServer: disk ${Math.round(diskUsed / 1024 / 1024)}MB over watermark ` +
      `без активних торрентів — очищаємо store`
    )
    resetDownloadPath()
    return
  }

  const idleCandidate = Array.from(activeTorrents.entries())
    .filter(([, entry]) => entry.streams.size === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]

  if (!idleCandidate) {
    console.error(
      `StreamServer: disk ${Math.round(diskUsed / 1024 / 1024)}MB over watermark, ` +
      `але всі торренти активні — чекаємо idle cleanup`
    )
    return
  }

  const [infoHash] = idleCandidate
  diskGuardRunning = true
  console.error(
    `StreamServer: disk high watermark ` +
    `${Math.round(diskUsed / 1024 / 1024)}MB; зупиняємо торрент ${infoHash}`
  )
  try {
    await destroyTorrent(infoHash, 'disk high watermark')
  } catch (err) {
    console.error('StreamServer disk guard error:', err.message)
  } finally {
    diskGuardRunning = false
  }
}, 5 * 1000)
diskGuardTimer.unref?.()

function releaseUnusedPeerThrottles() {
  const released = releasePeerThrottleStreams(client)
  if (released > 0) {
    console.log(`StreamServer: звільнено peer throttle streams: ${released}`)
  }
}

function destroyTorrent(infoHash, reason) {
  const entry = activeTorrents.get(infoHash)
  const torrent = entry?.torrent || client.get(infoHash)
  if (!entry && !torrent) {
    releaseUnusedPeerThrottles()
    return pendingDestroys.get(infoHash) || Promise.resolve()
  }

  activeTorrents.delete(infoHash)
  if (entry?.cleanupTimer) clearTimeout(entry.cleanupTimer)
  for (const stream of entry?.streams || []) {
    if (!stream.destroyed) stream.destroy()
  }

  if (!torrent || torrent.destroyed) {
    releaseUnusedPeerThrottles()
    return pendingDestroys.get(infoHash) || Promise.resolve()
  }

  console.log(`StreamServer: прибираємо торрент ${infoHash} (${reason})`)
  let resolveCleanup
  const cleanup = new Promise(resolve => {
    resolveCleanup = resolve
  })
  pendingDestroys.set(infoHash, cleanup)

  try {
    torrent.destroy({ destroyStore: true }, err => {
      if (err) {
        console.error(`Помилка видалення торренту ${infoHash}:`, err.message)
        removeStoreDirsForHash(infoHash)
      }
      releaseUnusedPeerThrottles()
      resolveCleanup()
    })
  } catch (err) {
    console.error(`Помилка видалення торренту ${infoHash}:`, err.message)
    removeStoreDirsForHash(infoHash)
    resolveCleanup()
  }

  // torrent.destroy() synchronously closes peer sockets. Release their
  // throttles now; tracker/store cleanup can take many seconds on Render.
  releaseUnusedPeerThrottles()
  cleanup.then(() => {
    if (pendingDestroys.get(infoHash) === cleanup) pendingDestroys.delete(infoHash)
  })
  return cleanup
}

function scheduleCleanup(infoHash) {
  const entry = activeTorrents.get(infoHash)
  if (!entry) return

  entry.lastUsed = Date.now()
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer)
    entry.cleanupTimer = null
  }

  // Never let an idle timer terminate an HTTP response that is still active.
  if (entry.streams.size > 0) return

  entry.cleanupTimer = setTimeout(() => {
    const current = activeTorrents.get(infoHash)
    if (!current || current.streams.size > 0) return
    destroyTorrent(infoHash, `неактивний ${IDLE_TIMEOUT / 60000} хв`)
      .catch(err => console.error('StreamServer cleanup error:', err.message))
  }, IDLE_TIMEOUT)
  entry.cleanupTimer.unref?.()
}

function registerStream(infoHash, stream) {
  const entry = activeTorrents.get(infoHash)
  if (!entry) throw new Error('Torrent was removed before streaming started')

  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer)
    entry.cleanupTimer = null
  }
  entry.lastUsed = Date.now()
  entry.streams.add(stream)

  let released = false
  return () => {
    if (released) return
    released = true
    const current = activeTorrents.get(infoHash)
    if (!current) return
    current.streams.delete(stream)
    scheduleCleanup(infoHash)
  }
}

function createTorrent(torrentBuffer, infoHash) {
  return new Promise((resolve, reject) => {
    let settled = false
    let torrent

    const rejectOnce = err => {
      if (settled) return
      settled = true
      reject(err)
    }

    try {
      // private: true blocks WebTorrent's global public announce list.
      // Keep the .torrent announce URLs untouched — main's working path.
      torrent = client.add(torrentBuffer, {
        path: DOWNLOAD_PATH,
        addUID: true,
        private: true,
        storeCacheSlots: STORE_CACHE_SLOTS,
        destroyStoreOnDestroy: true,
      }, readyTorrent => {
        if (readyTorrent.infoHash !== infoHash) {
          readyTorrent.destroy({ destroyStore: true })
          return rejectOnce(new Error('Torrent info hash does not match watch URL'))
        }

        // WebTorrent selects every piece on metadata; undo that so only the
        // active HTTP Range is fetched into /tmp.
        deselectDefaultDownload(readyTorrent)

        settled = true
        activeTorrents.set(infoHash, {
          torrent: readyTorrent,
          cleanupTimer: null,
          lastUsed: Date.now(),
          streams: new Set(),
        })
        scheduleCleanup(infoHash)
        console.log(
          `StreamServer: торрент додано, файлів: ${readyTorrent.files.length} ` +
          `(trackers=${readyTorrent.announce.length}, cacheSlots=${STORE_CACHE_SLOTS}, ` +
          `utp=${client.utp}, port=${client.torrentPort || 0})`
        )
        resolve(readyTorrent)
      })
    } catch (err) {
      return rejectOnce(err)
    }

    // Deselect as soon as pieces exist — before ready — to avoid filling /tmp
    // while season packs announce and connect peers.
    torrent.on('metadata', () => {
      deselectDefaultDownload(torrent)
    })

    torrent.once('infoHash', () => {
      const announces = formatAnnounceList(torrent.announce)
      console.log(
        `StreamServer: announce[${announces.length}]=${announces.join(' | ') || '(none)'}`
      )
    })

    let discoveredPeers = 0
    let loggedConnectedPeer = false
    torrent.on('peer', () => {
      discoveredPeers += 1
    })
    torrent.on('wire', () => {
      if (loggedConnectedPeer) return
      loggedConnectedPeer = true
      console.log(
        `StreamServer: peer підключено ` +
        `(discovered=${discoveredPeers}, connected=${torrent.numPeers})`
      )
    })
    torrent.on('warning', err => {
      console.warn(`StreamServer tracker warning: ${err.message}`)
    })
    torrent.on('noPeers', source => {
      console.warn(
        `StreamServer: поки немає підключених peers ` +
        `(source=${source}, discovered=${discoveredPeers}, ` +
        `pending=${torrent._numPending || 0}, queued=${torrent._queue?.length || 0}, ` +
        `trackers=${torrent.announce?.length || 0}, port=${client.torrentPort || 0})`
      )
    })

    torrent.on('error', err => {
      console.error('StreamServer torrent error:', err.message)
      rejectOnce(err)
      destroyTorrent(infoHash, 'torrent error')
        .catch(destroyErr => {
          console.error('StreamServer torrent cleanup error:', destroyErr.message)
        })
    })
    torrent.once('close', () => {
      rejectOnce(new Error('Torrent closed before it became ready'))
      const entry = activeTorrents.get(infoHash)
      if (entry?.torrent === torrent) {
        if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
        activeTorrents.delete(infoHash)
      }
      releaseUnusedPeerThrottles()
    })
  })
}

async function addTorrentExclusive(torrentBuffer, infoHash) {
  // Never recreate the same store while its previous files are still being
  // removed. Different hashes use addUID-isolated directories and can switch
  // immediately after peer sockets are synchronously closed.
  const pendingDestroy = pendingDestroys.get(infoHash)
  if (pendingDestroy) await pendingDestroy

  const active = activeTorrents.get(infoHash)
  if (active) {
    scheduleCleanup(infoHash)
    return active.torrent
  }

  const existing = client.get(infoHash)
  if (existing && !existing.destroyed) {
    activeTorrents.set(infoHash, {
      torrent: existing,
      cleanupTimer: null,
      lastUsed: Date.now(),
      streams: new Set(),
    })
    scheduleCleanup(infoHash)
    return existing
  }

  // Do not wait for slow tracker/store callbacks here. Render showed a
  // 17-second wait during quality switches, long enough for Stremio to time
  // out before the new torrent was even added.
  const others = Array.from(activeTorrents.keys()).filter(hash => hash !== infoHash)
  const overflow = Math.max(0, others.length - (MAX_CONCURRENT_TORRENTS - 1))
  for (const hash of others.slice(0, overflow)) {
    destroyTorrent(hash, 'ліміт одночасних торрентів')
      .catch(err => console.error('StreamServer cleanup error:', err.message))
  }

  return createTorrent(torrentBuffer, infoHash)
}

function addTorrent(torrentBuffer, infoHash) {
  const active = activeTorrents.get(infoHash)
  if (active) {
    scheduleCleanup(infoHash)
    return Promise.resolve(active.torrent)
  }
  if (pendingAdds.has(infoHash)) return pendingAdds.get(infoHash)

  const operation = addQueue.then(
    () => addTorrentExclusive(torrentBuffer, infoHash),
    () => addTorrentExclusive(torrentBuffer, infoHash)
  )
  addQueue = operation.catch(() => {})
  pendingAdds.set(infoHash, operation)

  const clearPending = () => {
    if (pendingAdds.get(infoHash) === operation) pendingAdds.delete(infoHash)
  }
  operation.then(clearPending, clearPending)
  return operation
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
async function handleStreamRequest(req, res, torrentBuffer, infoHash, fileIdx) {
  let fileStream = null
  let releaseStream = null

  try {
    const torrent = await addTorrent(torrentBuffer, infoHash)
    if (req.destroyed || res.destroyed) {
      scheduleCleanup(infoHash)
      return
    }

    const file = pickVideoFile(torrent, fileIdx)
    if (!file) {
      scheduleCleanup(infoHash)
      res.writeHead(404)
      res.end('Video file not found in torrent')
      return
    }

    // Deselect the whole torrent (and sibling season-pack files). createReadStream
    // then selects only the requested Range — not the multi-GB file on disk.
    const actualFileIdx = torrent.files.indexOf(file)
    if (restrictToSingleFile(torrent, actualFileIdx)) {
      console.log(
        `StreamServer: обмежено завантаження до файлу [${actualFileIdx}] ` +
        `"${file.name}" (з ${torrent.files.length})`
      )
    }

    const fileSize = file.length
    const range = parseByteRange(req.headers.range, fileSize)
    if (range?.unsatisfiable) {
      scheduleCleanup(infoHash)
      res.writeHead(416, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${fileSize}`,
      })
      res.end()
      return
    }

    // Preserve the exact requested interval. The bounded peer count, disabled
    // piece cache, disk store, and WebTorrent stream backpressure control
    // memory without changing HTTP semantics.
    let start = 0
    let end = fileSize - 1
    let status = 200
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    }

    if (range) {
      start = range.start
      end = range.end
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
      headers['Content-Length'] = end - start + 1
    } else {
      headers['Content-Length'] = fileSize
    }

    if (req.method === 'HEAD') {
      scheduleCleanup(infoHash)
      res.writeHead(status, headers)
      res.end()
      return
    }

    fileStream = file.createReadStream({ start, end })
    releaseStream = registerStream(infoHash, fileStream)
    res.writeHead(status, headers)

    pipeline(fileStream, res, (err) => {
      releaseStream()
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'PREMATURE_CLOSE') {
        console.error('Stream pipeline error:', err.message)
      }
    })
  } catch (err) {
    console.error('handleStreamRequest error:', err.message)
    if (fileStream && !fileStream.destroyed) fileStream.destroy()
    if (releaseStream) releaseStream()
    if (!res.headersSent) {
      res.writeHead(500)
      res.end('Streaming error')
    } else if (!res.destroyed) {
      res.destroy()
    }
  }
}

module.exports = { handleStreamRequest }
