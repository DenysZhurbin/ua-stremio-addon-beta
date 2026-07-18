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
    natUpnp: false,
    natPmp: false,
    // Toloka swarms contain many peers reachable only through uTP. A
    // postinstall compatibility patch reuses one UDP socket for all peers.
    utp: true,
    webSeeds: false,
    maxConns: maxConnections,
    downloadLimit,
    uploadLimit,
  }
}

// Redact passkeys/tokens so Render logs stay useful without leaking credentials.
function redactAnnounceUrl(url) {
  try {
    const parsed = new URL(String(url))
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(pass|key|token|auth|uid)/i.test(key)) {
        parsed.searchParams.set(key, 'redacted')
      }
    }
    return parsed.toString()
  } catch (_) {
    return String(url).replace(
      /([?&](?:passkey|token|auth|uk|uid)=)[^&]+/gi,
      '$1redacted'
    )
  }
}

function formatAnnounceList(announce) {
  return (Array.isArray(announce) ? announce : [])
    .map(String)
    .filter(Boolean)
    .map(redactAnnounceUrl)
}

// Match main: keep every announce URL from the .torrent file. private:true is
// what blocks WebTorrent's global public tracker list; trimming Toloka's own
// announce set caused discovered=0 on Render.
function deselectDefaultDownload(torrent) {
  if (!torrent.pieces || torrent.pieces.length === 0) return false
  torrent.deselect(0, torrent.pieces.length - 1, false)
  return true
}

function restrictToSingleFile(torrent, fileIdx) {
  if (!torrent?.files?.length || !torrent.pieces?.length) return false
  if (!Number.isInteger(fileIdx) || !torrent.files[fileIdx]) return false
  if (torrent._uaRestrictedTo === fileIdx) return false

  torrent.deselect(0, torrent.pieces.length - 1, false)
  torrent.files[fileIdx].select()
  torrent._uaRestrictedTo = fileIdx
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
  formatAnnounceList,
  parseCgroupInactiveFile,
  parseByteRange,
  redactAnnounceUrl,
  releasePeerThrottleStreams,
  restrictToSingleFile,
}
