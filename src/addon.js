// src/addon.js
const { addonBuilder } = require('stremio-addon-sdk')
const axios = require('axios')
const toloka = require('./toloka')
const mazepa = require('./mazepa')
const torrentCache = require('./torrentCache')

const manifest = {
  id: 'ua.stremio.addon',
  version: '2.1.0',
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

// Toloka пакує серіали ЦІЛИМИ СЕЗОНАМИ (напр. "Сезон 1-4"), а не окремими
// епізодами — рядка "S01E01" в назвах роздач просто не існує. Тому:
//   1) шукаємо тільки по назві серіалу (без сезону/епізоду)
//   2) серед знайдених роздач пріоритизуємо ті, що згадують потрібний сезон
//   3) конкретний епізод шукаємо вже всередині файлів торренту
function titleMatchesSeason(title, season) {
  if (!season) return true
  const s = parseInt(season, 10)

  // "Сезон 3", "Season 3", "S3", "С3"
  if (new RegExp(`(?:Сезон|Season|С)\\.?\\s*0*${s}(?!\\d)`, 'i').test(title)) return true

  // Діапазон: "Сезони 1-4", "Seasons 1-4", "Сезон 1-2"
  const rangeMatch = title.match(/(?:Сезон[иі]?|Seasons?)\.?\s*(\d+)\s*[-–]\s*(\d+)/i)
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10)
    const end = parseInt(rangeMatch[2], 10)
    if (s >= start && s <= end) return true
  }

  return false
}

// Якщо є кілька файлів у торренті (сезон з багатьма серіями) — шукаємо
// файл що відповідає конкретному епізоду за назвою файлу
function pickVideoFileIdx(files, episode) {
  if (!Array.isArray(files) || files.length === 0) return undefined
  if (files.length === 1) return undefined

  const videoExt = /\.(mp4|mkv|avi|mov|webm|m4v|ts)$/i
  const videoFiles = files
    .map((f, idx) => ({ ...f, idx }))
    .filter(f => videoExt.test(f.name))

  if (episode) {
    const e = parseInt(episode, 10)
    const patterns = [
      new RegExp(`[Ss]0*\\d+[Ee]0*${e}(?!\\d)`),           // S01E05
      new RegExp(`[Ee]p?\\.?\\s*0*${e}(?!\\d)`, 'i'),        // E05, Ep 05, Episode 05
      new RegExp(`(?:^|[^\\d])0*${e}(?!\\d)\\s*(?:серія|episode)`, 'i'), // "5 серія"
    ]
    for (const pattern of patterns) {
      const found = videoFiles.find(f => pattern.test(f.name))
      if (found) return found.idx
    }
  }

  // Не знайшли конкретний епізод — повертаємо найбільший файл
  let best = videoFiles[0]
  for (const f of videoFiles) {
    if (f.length > best.length) best = f
  }
  return best?.idx
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function resultsToStreams(results, cookieString, source, baseUrl, episode) {
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

      if (info.type !== 'file') {
        console.log(`Пропускаємо magnet (не підтримується проксі): ${result.title}`)
        continue
      }

      const parsed = await parseTorrentInfo(info)
      if (!parsed?.infoHash) {
        console.error(`infoHash не отримано для "${result.title}"`)
        continue
      }

      if (!torrentCache.set(parsed.infoHash, info.buffer)) {
        console.warn('Пропускаємо завеликий .torrent файл')
        continue
      }

      const fileIdx = pickVideoFileIdx(parsed.files, episode)
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

    let title
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const meta = await axios.get(
          `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
          { timeout: attempt === 1 ? 8000 : 15000 }
        )
        title = meta.data?.meta?.name
        break
      } catch (err) {
        console.error(`Cinemeta error (спроба ${attempt}):`, err.message || 'unknown')
        if (attempt === 2) return { streams: [] }
      }
    }

    if (!title) return { streams: [] }

    // Пошук тільки по назві — БЕЗ S01E01, бо Toloka пакує серіали сезонами
    console.log(`Шукаємо: "${title}"${season ? ` (сезон ${season}, епізод ${episode})` : ''}`)

    const tasks = []

    if (config.tolokaLogin && config.tolokaPassword) {
      tasks.push(
        getSession('toloka', config.tolokaLogin, config.tolokaPassword)
          .then(session => {
            if (!session) return
            return toloka.search(session.cookieString, title)
              .then(results => {
                if (season) {
                  const filtered = results.filter(r => titleMatchesSeason(r.title, season))
                  console.log(`Toloka: ${filtered.length}/${results.length} роздач відповідають сезону ${season}`)
                  return filtered.length > 0 ? filtered : results
                }
                return results
              })
              .then(results => resultsToStreams(results, session.cookieString, 'toloka', baseUrl, episode))
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
            return mazepa.search(session.cookieString, title)
              .then(results => {
                if (season) {
                  const filtered = results.filter(r => titleMatchesSeason(r.title, season))
                  return filtered.length > 0 ? filtered : results
                }
                return results
              })
              .then(results => resultsToStreams(results, session.cookieString, 'mazepa', baseUrl, episode))
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
