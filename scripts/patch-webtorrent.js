const fs = require('fs')
const path = require('path')

const EXPECTED_VERSION = '1.9.7'
const webtorrentRoot = path.dirname(require.resolve('webtorrent/package.json'))

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source

  const first = source.indexOf(before)
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Cannot apply WebTorrent patch: ${label}`)
  }

  return source.slice(0, first) + after + source.slice(first + before.length)
}

function patchFile(relativePath, replacements) {
  const filename = path.join(webtorrentRoot, relativePath)
  let source = fs.readFileSync(filename, 'utf8')
  const original = source

  for (const [label, before, after] of replacements) {
    source = replaceOnce(source, before, after, label)
  }

  if (source !== original) fs.writeFileSync(filename, source)
}

const { version } = require(path.join(webtorrentRoot, 'package.json'))
if (version !== EXPECTED_VERSION) {
  throw new Error(
    `Expected webtorrent ${EXPECTED_VERSION}, found ${version}; review compatibility patch`
  )
}

patchFile('lib/torrent.js', [
  [
    'track pending connections',
    `    this._peersLength = 0 // number of elements in \`this._peers\` (cache, for perf)
`,
    `    this._peersLength = 0 // number of elements in \`this._peers\` (cache, for perf)
    this._numPending = 0 // outgoing connections that have not connected yet
`,
  ],
  [
    'select uTP peers without a blocklist',
    `    if (this.client.blocked) {
      if (typeof peer === 'string') {
        let parts
        try {
          parts = addrToIPPort(peer)
        } catch (e) {
          this._debug('ignoring peer: invalid %s', peer)
          this.emit('invalidPeer', peer)
          return false
        }
        host = parts[0]
      } else if (typeof peer.remoteAddress === 'string') {
        host = peer.remoteAddress
      }

      if (host && this.client.blocked.contains(host)) {
        this._debug('ignoring peer: blocked %s', peer)
        if (typeof peer !== 'string') peer.destroy()
        this.emit('blockedPeer', peer)
        return false
      }
    }
`,
    `    if (typeof peer === 'string') {
      let parts
      try {
        parts = addrToIPPort(peer)
      } catch (e) {
        this._debug('ignoring peer: invalid %s', peer)
        this.emit('invalidPeer', peer)
        return false
      }
      host = parts[0]
    } else if (typeof peer.remoteAddress === 'string') {
      host = peer.remoteAddress
    }

    if (this.client.blocked && host && this.client.blocked.contains(host)) {
      this._debug('ignoring peer: blocked %s', peer)
      if (typeof peer !== 'string') peer.destroy()
      this.emit('blockedPeer', peer)
      return false
    }
`,
  ],
  [
    'prevent duplicate peer removal',
    `    if (this.destroyed) return

    this._debug('removePeer %s', id)
`,
    `    if (this.destroyed || !this._peers[id]) return

    this._debug('removePeer %s', id)
`,
  ],
  [
    'cap in-flight peer connections',
    `    this._debug('_drain numConns %s maxConns %s', this._numConns, this.client.maxConns)
    if (typeof net.connect !== 'function' || this.destroyed || this.paused ||
        this._numConns >= this.client.maxConns) {
`,
    `    this._debug(
      '_drain numConns %s pending %s maxConns %s',
      this._numConns,
      this._numPending,
      this.client.maxConns
    )
    if (typeof net.connect !== 'function' || this.destroyed || this.paused ||
        this._numConns + this._numPending >= this.client.maxConns) {
`,
  ],
  [
    'reuse the uTP server socket',
    `    if (this.client.utp && peer.type === 'utpOutgoing') {
      peer.conn = utp.connect(opts.port, opts.host)
    } else {
      peer.conn = net.connect(opts)
    }
`,
    `    if (this.client.utp && peer.type === 'utpOutgoing') {
      const utpServer = this.client._connPool?.utpServer
      peer.conn = utpServer
        ? utpServer.connect(opts.port, opts.host)
        : utp.connect(opts.port, opts.host)
    } else {
      peer.conn = net.connect(opts)
    }
`,
  ],
  [
    'release pending connection slots',
    `    conn.once('connect', () => { if (!this.destroyed) peer.onConnect() })
    conn.once('error', err => { peer.destroy(err) })
    peer.startConnectTimeout()
`,
    `    this._numPending += 1
    let pending = true
    const donePending = () => {
      if (!pending) return
      pending = false
      this._numPending -= 1
    }

    conn.once('connect', () => {
      donePending()
      if (!this.destroyed) peer.onConnect()
    })
    conn.once('error', err => {
      donePending()
      peer.destroy(err)
    })
    conn.once('close', donePending)
    peer.startConnectTimeout()
`,
  ],
])

patchFile('lib/peer.js', [
  [
    'track peer throttle streams',
    `    this.retries = 0 // outgoing TCP connection retry count
`,
    `    this.retries = 0 // outgoing TCP connection retry count
    this._throttleStreams = []
`,
  ],
  [
    'retain peer throttle stream handles',
    `  setThrottlePipes () {
    const self = this
    this.conn
      .pipe(this.throttleGroups.down.throttle())
`,
    `  setThrottlePipes () {
    const self = this
    const downloadThrottle = this.throttleGroups.down.throttle()
    const uploadThrottle = this.throttleGroups.up.throttle()
    this._throttleStreams.push(downloadThrottle, uploadThrottle)

    this.conn
      .pipe(downloadThrottle)
`,
  ],
  [
    'use retained upload throttle stream',
    `      .pipe(this.wire)
      .pipe(this.throttleGroups.up.throttle())
`,
    `      .pipe(this.wire)
      .pipe(uploadThrottle)
`,
  ],
  [
    'destroy peer throttle streams',
    `    if (wire) wire.destroy()
    if (swarm) swarm.removePeer(this.id)
`,
    `    if (wire) wire.destroy()
    for (const throttle of this._throttleStreams) throttle.destroy()
    this._throttleStreams = []
    if (swarm) swarm.removePeer(this.id)
`,
  ],
])

console.log(`Applied WebTorrent ${EXPECTED_VERSION} connection compatibility patch`)
