const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const createTorrent = require('create-torrent')
const WebTorrent = require('webtorrent')

const {
  createWebTorrentClientOptions,
  deselectDefaultDownload,
  limitTorrentTrackers,
  parseByteRange,
  parseCgroupInactiveFile,
  releasePeerThrottleStreams,
  selectTrackerUrls,
} = require('../src/streamUtils')

test('builds a bounded client without disabling peer protocol traffic', () => {
  assert.deepEqual(createWebTorrentClientOptions({
    maxConnections: 6,
    downloadLimit: 3 * 1024 * 1024,
    uploadLimit: 512 * 1024,
  }), {
    dht: false,
    lsd: false,
    utp: true,
    webSeeds: false,
    maxConns: 6,
    downloadLimit: 3 * 1024 * 1024,
    uploadLimit: 512 * 1024,
  })

  assert.throws(
    () => createWebTorrentClientOptions({
      maxConnections: 6,
      downloadLimit: 3 * 1024 * 1024,
      uploadLimit: 0,
    }),
    /above zero/
  )
})

test('parses reclaimable file cache from cgroup v1 and v2 stats', () => {
  assert.equal(parseCgroupInactiveFile('anon 100\ninactive_file 2048\n'), 2048)
  assert.equal(
    parseCgroupInactiveFile('total_cache 4096\ntotal_inactive_file 1024\n'),
    1024
  )
  assert.equal(parseCgroupInactiveFile('anon 100\nfile 200\n'), 0)
})

test('releases retained peer throttles only after the last torrent closes', () => {
  let destroyed = 0
  const makeGroup = () => {
    const group = { throttles: [] }
    const throttle = {
      destroy() {
        destroyed += 1
        group.throttles.splice(group.throttles.indexOf(throttle), 1)
      },
    }
    group.throttles.push(throttle)
    return group
  }
  const client = {
    torrents: [{}],
    throttleGroups: {
      down: makeGroup(),
      up: makeGroup(),
    },
  }

  assert.equal(releasePeerThrottleStreams(client), 0)
  assert.equal(destroyed, 0)

  client.torrents = []
  assert.equal(releasePeerThrottleStreams(client), 2)
  assert.equal(destroyed, 2)
  assert.equal(client.throttleGroups.down.throttles.length, 0)
  assert.equal(client.throttleGroups.up.throttles.length, 0)
})

test('preserves large explicit and open-ended player ranges', () => {
  const size = 50 * 1024 * 1024

  assert.deepEqual(parseByteRange('bytes=0-10485759', size), {
    start: 0,
    end: 10485759,
  })
  assert.deepEqual(parseByteRange('bytes=10485760-', size), {
    start: 10485760,
    end: size - 1,
  })
})

test('supports suffix ranges', () => {
  assert.deepEqual(parseByteRange('bytes=-500', 2000), {
    start: 1500,
    end: 1999,
  })
  assert.deepEqual(parseByteRange('bytes=-5000', 2000), {
    start: 0,
    end: 1999,
  })
})

test('rejects malformed, multiple, and out-of-bounds byte ranges', () => {
  assert.deepEqual(parseByteRange('bytes=100-20', 2000), {
    unsatisfiable: true,
  })
  assert.deepEqual(parseByteRange('bytes=0-10,20-30', 2000), {
    unsatisfiable: true,
  })
  assert.deepEqual(parseByteRange('bytes=2000-', 2000), {
    unsatisfiable: true,
  })
  assert.equal(parseByteRange('items=0-10', 2000), null)
})

test('prefers the source tracker and retains a bounded fallback set', () => {
  const trackers = [
    'udp://tracker-one.example:80/announce',
    'https://bt.toloka.to/announce?token=secret',
    'udp://tracker-two.example:1337/announce',
    'udp://tracker-three.example:1337/announce',
  ]

  assert.deepEqual(selectTrackerUrls(trackers, 3), [
    'https://bt.toloka.to/announce?token=secret',
    'udp://tracker-one.example:80/announce',
    'udp://tracker-two.example:1337/announce',
  ])
})

test('falls back to a bounded HTTP tracker list', () => {
  const torrent = {
    announce: [
      'udp://tracker-one.example:80/announce',
      'https://tracker-two.example/announce',
      'http://tracker-three.example/announce',
      'https://tracker-four.example/announce',
    ],
  }

  assert.deepEqual(limitTorrentTrackers(torrent, 2), {
    before: 4,
    after: 2,
  })
  assert.deepEqual(torrent.announce, [
    'https://tracker-two.example/announce',
    'http://tracker-three.example/announce',
  ])
})

test('WebTorrent metadata hook removes its default whole-torrent selection', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-stream-test-'))
  const client = new WebTorrent({
    dht: false,
    lsd: false,
    tracker: false,
    utp: false,
    maxConns: 1,
  })

  t.after(async () => {
    await new Promise(resolve => client.destroy(resolve))
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  const torrentBuffer = await new Promise((resolve, reject) => {
    createTorrent(
      Buffer.alloc(32 * 1024, 1),
      {
        name: 'video.mp4',
        announce: [
          'udp://public-one.example:80/announce',
          'https://bt.toloka.to/announce?token=test',
          'udp://public-two.example:80/announce',
        ],
      },
      (err, buffer) => err ? reject(err) : resolve(buffer)
    )
  })

  const torrent = client.add(torrentBuffer, {
    path: tempDir,
    private: true,
    storeCacheSlots: 0,
    destroyStoreOnDestroy: true,
  })
  torrent.once('infoHash', () => limitTorrentTrackers(torrent, 1))
  torrent.once('metadata', () => deselectDefaultDownload(torrent))

  await once(torrent, 'ready')

  assert.deepEqual(torrent.announce, [
    'https://bt.toloka.to/announce?token=test',
  ])
  assert.equal(torrent._selections.length, 0)
})
