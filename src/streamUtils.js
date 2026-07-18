const PRIVATE_TRACKER_HOSTS = ['toloka.to', 'mazepa.to']

function createWebTorrentClientOptions({
  maxConnections,
  downloadLimit,
  uploadLimit,
}) {
  if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) {
    throw new Error('maxConnections must be a positive integer')
  }
  if (!Number.isSafeInteger(downloadLimit) || downloadLimit <= 0) {
    throw new Error('downloadLimit must be a positive integer')
  }
  if (!Number.isSafeInteger(uploadLimit) || uploadLimit <= 0) {
    throw new Error('uploadLimit must stay above zero for peer protocol traffic')
  }

  return {
    dht: false,
    lsd: false,
    // Toloka swarms contain many peers reachable only through uTP. A
    // postinstall compatibility patch reuses one UDP socket for all peers.
    utp: true,
    webSeeds: false,
    maxConns: maxConnections,
    downloadLimit,
    uploadLimit,
  }
}

function isPrivateTracker(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return PRIVATE_TRACKER_HOSTS.some(
      host => hostname === host || hostname.endsWith(`.${host}`)
    )
  } catch (_) {
    return false
  }
}

function isHttpTracker(url) {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch (_) {
    return false
  }
}

// Prefer the source tracker's announces, but retain a small fallback set.
// Some Toloka torrents report zero peers on the first announce URL while the
// other bundled trackers return the swarm. The hard cap prevents the old
// unbounded tracker/port behavior.
function selectTrackerUrls(announce, maxTrackers = 2) {
  const unique = Array.from(
    new Set((Array.isArray(announce) ? announce : []).map(String).filter(Boolean))
  )

  const sourceHttp = unique.filter(url => isPrivateTracker(url) && isHttpTracker(url))
  const sourceOther = unique.filter(url => isPrivateTracker(url) && !isHttpTracker(url))
  const fallbackHttp = unique.filter(url => !isPrivateTracker(url) && isHttpTracker(url))
  const fallbackOther = unique.filter(url => !isPrivateTracker(url) && !isHttpTracker(url))
  const preferred = [
    ...sourceHttp,
    ...sourceOther,
    ...fallbackHttp,
    ...fallbackOther,
  ]

  return preferred.slice(0, Math.max(1, maxTrackers))
}

function limitTorrentTrackers(torrent, maxTrackers = 2) {
  const before = Array.isArray(torrent.announce) ? torrent.announce.length : 0
  torrent.announce = selectTrackerUrls(torrent.announce, maxTrackers)
  return { before, after: torrent.announce.length }
}

function deselectDefaultDownload(torrent) {
  if (!torrent.pieces || torrent.pieces.length === 0) return false
  torrent.deselect(0, torrent.pieces.length - 1, false)
  return true
}

// WebTorrent 1.x retains per-peer speed-limiter transforms after peers close.
// Once the last torrent is gone, no live connection can use these transforms,
// so release them instead of retaining every peer seen by this process.
function releasePeerThrottleStreams(client) {
  if (client?.torrents?.length > 0) return 0

  let released = 0
  for (const group of Object.values(client?.throttleGroups || {})) {
    const throttles = Array.isArray(group?.throttles)
      ? Array.from(group.throttles)
      : []

    for (const throttle of throttles) {
      if (typeof throttle?.destroy !== 'function') continue
      try {
        throttle.destroy()
        released += 1
      } catch (_) {}
    }
  }
  return released
}

function parseCgroupInactiveFile(stats) {
  const match = String(stats).match(
    /^(?:inactive_file|total_inactive_file)\s+(\d+)$/m
  )
  return match ? Number(match[1]) : 0
}

// Parse one RFC 9110 byte range without altering the range requested by the
// player. Returning a shorter response than requested caused Stremio playback
// to stall in the reverted implementation.
function parseByteRange(header, size) {
  if (!header || typeof header !== 'string') return null
  if (!header.toLowerCase().startsWith('bytes=')) return null
  if (!Number.isSafeInteger(size) || size <= 0) return { unsatisfiable: true }

  const value = header.slice(header.indexOf('=') + 1).trim()
  if (!value || value.includes(',')) return { unsatisfiable: true }

  const match = /^(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return { unsatisfiable: true }

  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { unsatisfiable: true }
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    }
  }

  const start = Number(match[1])
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    return { unsatisfiable: true }
  }

  let end = size - 1
  if (match[2]) {
    end = Number(match[2])
    if (!Number.isSafeInteger(end) || end < start) {
      return { unsatisfiable: true }
    }
    end = Math.min(end, size - 1)
  }

  return { start, end }
}

module.exports = {
  createWebTorrentClientOptions,
  deselectDefaultDownload,
  limitTorrentTrackers,
  parseCgroupInactiveFile,
  parseByteRange,
  releasePeerThrottleStreams,
  selectTrackerUrls,
}
