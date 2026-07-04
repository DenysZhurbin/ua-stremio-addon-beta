// src/addon.js
const { addonBuilder } = require('stremio-addon-sdk')
const axios = require('axios')
const toloka = require('./toloka')
const mazepa = require('./mazepa')
const torrentCache = require('./torrentCache')

const manifest = {
  id: 'ua.stremio.addon',
  version: '2.0.0',
  name: '🇺🇦 UA Torrents',
  description: 'Українські торренти з Toloka та Mazepa з українським озвученням',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt'],
}

const sessionCache = new Map()

async function getSession(source, login, password) {
  const key = `${source}:${login}`
  if (sessionCache.has(key)) return sessionCache.get(key)

  let session = null
  try {
    if (source === 'toloka') session = await toloka.login(login, password)
    else if (source === 'mazepa') session = await mazepa.login(login, password)
  } catch (err) {
    console.error(`${source} login failed:`, err.message)
    return null
  }

  if (!session) return null

  sessionCache.set(key, session)
  setTimeout(() => sessionCache.delete(key), 6 * 60 * 60 * 1000)
  return session
}

// parse-torrent — ESM пакет, підключаємо через dynamic import
let _parseTorrent = null
async function getParseTorrent() {
  if (!_parseTorrent) {
    const mod = await import('parse-torrent')
    _parseTorrent = mod.default || mod
  }
  return _parseTorrent
}

async function parseTorrentInfo(info) {
  try {
    const parseTorrent = await getParseTorrent()
    const source = info.type === 'magnet' ? info.magnet : info.buffer
    return await parseTorrent(source)
  } catch (err) {
    console.error('parseTorrentInfo error:', err.message)
    return null
  }
}

function pickVideoFileIdx(files) {
  if (!Array.isArray(files) || files.length <= 1) return undefined
  const videoExt = /\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i
  let bestIdx
  let bestSize = -1
  files.forEach((file, idx) => {
    if (videoExt.test(file.name) && file.length > bestSize) {
      bestSize = file.length
      bestIdx = idx
    }
  })
  return bestIdx
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// baseUrl потрібен щоб побудувати повний URL на наш власний
// стрім-ендпоінт (/watch/<infoHash>/<fileIdx>.mp4)
async function resultsToStreams(results, cookieString, source, baseUrl) {
  const streams = []
  const topResults = results.sort((a, b) => b.seeders - a.seeders).slice(0, 5)

  let isFirst = true
  for (const result of topResults) {
    try {
      if (!isFirst) await sleep(2500)
      isFirst = false

      const info = source === 'toloka'
        ? await toloka.getTorrentInfo(cookieString, result.url)
        : await mazepa.getTorrentInfo(cookieString, result.url)

      if (!info) continue

      // Тільки .torrent-файли можемо проксувати (потребують передачі буфера).
      // Magnet-посилання без токена для приватного трекера все одно
      // не спрацюють через наш проксі так само як напряму в Stremio,
      // тому обробляємо тільки type: 'file'.
      if (info.type !== 'file') {
        console.log(`Пропускаємо magnet (не підтримується проксі): ${result.title}`)
        continue
      }

      const parsed = await parseTorrentInfo(info)
      if (!parsed?.infoHash) {
        console.error(`infoHash не отримано для "${result.title}"`)
        continue
      }

      // Кешуємо .torrent буфер щоб віддати його при реальному запиті відео
      torrentCache.set(parsed.infoHash, info.buffer)

      const fileIdx = pickVideoFileIdx(parsed.files)
      const quality = result.title.match(/4K|2160p|1080p|720p|480p/i)?.[0] || 'HD'
      const flag = source === 'toloka' ? '🇺🇦 Toloka' : '🇺🇦 Mazepa'

      const watchUrl = `${baseUrl}/watch/${parsed.infoHash}/${fileIdx ?? 0}.mp4`

      streams.push({
        name: flag,
        title: `${result.title}\n${quality} | ${result.size} | 👥 ${result.seeders}`,
        url: watchUrl,
        behaviorHints: {
          bingeGroup: `ua-addon-${source}`,
          notWebReady: true,
        },
      })

      console.log(`✅ Stream додано: ${result.title.substring(0, 50)}`)
    } catch (err) {
      console.error(`Помилка для "${result.title}":`, err.message)
    }
  }

  return streams
}

function buildAddon(config, baseUrl) {
  const builder = new addonBuilder(manifest)

  builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`\n▶ Запит стрімів: ${type} ${id}`)
    const streams = []

    const [imdbId, season, episode] = id.split(':')

    let searchQuery
    try {
      const meta = await axios.get(
        `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
        { timeout: 8000 }
      )
      searchQuery = meta.data?.meta?.name
      if (season && episode) {
        const s = String(season).padStart(2, '0')
        const e = String(episode).padStart(2, '0')
        searchQuery = `${searchQuery} S${s}E${e}`
      }
      console.log(`Шукаємо: "${searchQuery}"`)
    } catch (err) {
      console.error('Cinemeta error:', err.message)
      return { streams: [] }
    }

    if (!searchQuery) return { streams: [] }

    const tasks = []

    if (config.tolokaLogin && config.tolokaPassword) {
      tasks.push(
        getSession('toloka', config.tolokaLogin, config.tolokaPassword)
          .then(session => {
            if (!session) return
            return toloka.search(session.cookieString, searchQuery)
              .then(results => resultsToStreams(results, session.cookieString, 'toloka', baseUrl))
              .then(s => streams.push(...s))
          })
          .catch(err => console.error('Toloka task error:', err.message))
      )
    }

    if (config.mazepaLogin && config.mazepaPassword) {
      tasks.push(
        getSession('mazepa', config.mazepaLogin, config.mazepaPassword)
          .then(session => {
            if (!session) return
            return mazepa.search(session.cookieString, searchQuery)
              .then(results => resultsToStreams(results, session.cookieString, 'mazepa', baseUrl))
              .then(s => streams.push(...s))
          })
          .catch(err => console.error('Mazepa task error:', err.message))
      )
    }

    await Promise.all(tasks)

    console.log(`Повертаємо ${streams.length} стрімів\n`)
    return { streams }
  })

  return builder.getInterface()
}

module.exports = { buildAddon }
