const test = require('node:test')
const assert = require('node:assert/strict')

const torrentCache = require('../src/torrentCache')

test('caps entries and evicts least-recently-used torrent metadata', () => {
  for (let index = 0; index < 20; index += 1) {
    torrentCache.set(`hash-${index}`, Buffer.from(`torrent-${index}`))
  }

  // Refresh hash-0, making hash-1 the least recently used entry.
  assert.equal(torrentCache.get('hash-0').toString(), 'torrent-0')
  torrentCache.set('hash-20', Buffer.from('torrent-20'))

  assert.equal(torrentCache.get('hash-1'), undefined)
  assert.equal(torrentCache.get('hash-0').toString(), 'torrent-0')
  assert.equal(torrentCache.get('hash-20').toString(), 'torrent-20')
})

test('caps total metadata bytes and rejects one oversized torrent', () => {
  const sixMegabytes = Buffer.alloc(6 * 1024 * 1024)
  torrentCache.set('large-a', sixMegabytes)
  torrentCache.set('large-b', sixMegabytes)

  assert.equal(torrentCache.get('large-a'), undefined)
  assert.equal(torrentCache.get('large-b'), sixMegabytes)

  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1)
  assert.equal(torrentCache.set('oversized', oversized), false)
  assert.equal(torrentCache.get('oversized'), undefined)
})
