const test = require('node:test')
const assert = require('node:assert/strict')
const { Duplex } = require('node:stream')
const { EventEmitter } = require('node:events')
const Torrent = require('webtorrent/lib/torrent')
const Peer = require('webtorrent/lib/peer')
const { ThrottleGroup } = require('speed-limiter')

test('patched WebTorrent selects uTP for IPv4 tracker peers', () => {
  const torrent = Object.create(Torrent.prototype)
  let selectedType = null

  torrent.destroyed = false
  torrent.infoHash = '0'.repeat(40)
  torrent.client = { blocked: null, utp: true }
  torrent._addPeer = (_, type) => {
    selectedType = type
    return {}
  }
  torrent.emit = () => {}

  assert.equal(torrent.addPeer('127.0.0.1:6881'), true)
  assert.equal(selectedType, 'utp')
})

test('patched WebTorrent shares one uTP socket and caps pending attempts', () => {
  const conn = new EventEmitter()
  let connectCalls = 0
  let peerConnected = 0
  const utpServer = {
    connect(port, host) {
      connectCalls += 1
      assert.equal(port, 6881)
      assert.equal(host, '127.0.0.1')
      return conn
    },
  }
  const peer = {
    addr: '127.0.0.1:6881',
    type: 'utpOutgoing',
    retries: 0,
    startConnectTimeout() {},
    onConnect() {
      peerConnected += 1
    },
  }
  const torrent = Object.create(Torrent.prototype)
  torrent.client = {
    maxConns: 6,
    utp: true,
    _connPool: { utpServer },
  }
  torrent.destroyed = false
  torrent.paused = false
  torrent._debug = () => {}
  torrent._queue = [peer]
  torrent._peers = {}
  torrent._peersLength = 1
  torrent._numPending = 0
  torrent.wires = []

  torrent._drain()
  assert.equal(connectCalls, 1)
  assert.equal(torrent._numPending, 1)

  conn.emit('connect')
  assert.equal(torrent._numPending, 0)
  assert.equal(peerConnected, 1)

  torrent._queue.push(peer)
  torrent._numPending = 6
  torrent._drain()
  assert.equal(connectCalls, 1)
  assert.equal(torrent._queue.length, 1)
})

test('patched WebTorrent releases throttles whenever a peer closes', () => {
  class DiscardDuplex extends Duplex {
    _read() {}

    _write(_chunk, _encoding, callback) {
      callback()
    }
  }

  const throttleGroups = {
    down: new ThrottleGroup({ rate: 0, enabled: false }),
    up: new ThrottleGroup({ rate: 0, enabled: false }),
  }
  const swarm = {
    infoHash: '0'.repeat(40),
    private: true,
    wires: [],
    client: {
      dht: false,
      peerId: Buffer.alloc(20, 1),
    },
    removePeer() {},
  }
  const peer = Peer.createTCPOutgoingPeer(
    '127.0.0.1:6881',
    swarm,
    throttleGroups
  )
  peer.conn = new DiscardDuplex()
  peer.onConnect()
  swarm.wires.push(peer.wire)

  assert.equal(throttleGroups.down.throttles.length, 1)
  assert.equal(throttleGroups.up.throttles.length, 1)

  peer.destroy()

  assert.equal(throttleGroups.down.throttles.length, 0)
  assert.equal(throttleGroups.up.throttles.length, 0)
})
