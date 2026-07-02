// src/addon.js
// Основна логіка Stremio аддону

const { addonBuilder } = require('stremio-addon-sdk')
const axios = require('axios')
const { decodeConfig } = require('./config')
const toloka = require('./toloka')
const mazepa = require('./mazepa')

// Маніфест аддону
const manifest = {
  id: 'ua.stremio.addon',
  version: '1.0.0',
  name: '🇺🇦 UA Torrents',
  description: 'Українські торренти з Toloka та Mazepa з українським озвученням',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt'],
}

// Кеш сесій щоб не логінитись кожен раз
const sessionCache = new Map()

// Отримуємо або створюємо сесію
async function getSession(source, login, password) {
  const key = `${source}:${login}`

  if (sessionCache.has(key)) {
    return sessionCache.get(key)
  }

  let session
  if (source === 'toloka') {
    session = await toloka.login(login, password)
  } else if (source === 'mazepa') {
    session = await mazepa.login(login, password)
  }

  // Зберігаємо сесію на 6 годин
  sessionCache.set(key, session)
  setTimeout(() => sessionCache.delete(key), 6 * 60 * 60 * 1000)

  return session
}

// parse-torrent (v10+) — чистий ESM-пакет, тому в CommonJS-коді
// його можна підключити лише через динамічний import().
let parseTorrentPromise = null
function getParseTorrent() {
  if (!parseTorrentPromise) {
    parseTorrentPromise = import('parse-torrent').then(m => m.default || m)
  }
  return parseTorrentPromise
}

// Парсить або magnet-рядок, або Buffer реального .torrent файлу.
// В обох випадках вся потрібна інформація вже міститься в самих даних,
// тож мережеві запити (DHT) для цього не потрібні.
async function parseTorrentInfo(info) {
  const parseTorrent = await getParseTorrent()
  const source = info.type === 'magnet' ? info.magnet : info.buffer
  return parseTorrent(source)
}

// Якщо в торренті кілька файлів — обираємо найбільший відеофайл,
// щоб Stremio одразу відтворював потрібне, а не список файлів.
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Отримуємо назву фільму по IMDB ID через Cinemeta
async function getTitleById(type, id) {
  try {
    const response = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
      { timeout: 8000 }
    )
    const name = response.data?.meta?.name
    console.log(`Назва для ${id}: ${name}`)
    return name
  } catch (err) {
    console.error('Cinemeta error:', err.message)
    return null
  }
}

// Конвертуємо результати пошуку в Stremio streams
async function resultsToStreams(results, cookieString, source) {
  const streams = []

  // Беремо топ 5 за кількістю сідів (429 вже вирішено паузою між запитами)
  const topResults = results
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, 5)

  let isFirst = true
  for (const result of topResults) {
    try {
      // Пауза між запитами до download.php, щоб не впертись у rate-limit (429)
      if (!isFirst) await sleep(2500)
      isFirst = false

      const info = source === 'toloka'
        ? await toloka.getTorrentInfo(cookieString, result.url)
        : await mazepa.getTorrentInfo(cookieString, result.url)

      if (!info) continue

      const parsed = await parseTorrentInfo(info)

      if (!parsed?.infoHash) {
        console.error(`Не вдалося отримати infoHash для "${result.title}"`)
        continue
      }

      // Визначаємо якість з назви
      const quality = result.title.match(/4K|2160p|1080p|720p|480p/i)?.[0] || 'HD'

      // Флаг джерела
      const flag = source === 'toloka' ? '🇺🇦 Toloka' : '🇺🇦 Mazepa'

      // Трекери з .torrent/magnet + DHT як запасний варіант
      const trackers = (parsed.announce || []).filter(
        a => a.startsWith('http') || a.startsWith('udp')
      )
      // DHT свідомо не додаємо: Toloka — приватний трекер,
      // легітимні клієнти на приватних трекерах DHT/PEX не використовують.
      const sources = trackers.map(t => `tracker:${t}`)

      streams.push({
        name: flag,
        title: `${result.title}\n${quality} | ${result.size} | 👥 ${result.seeders}`,
        infoHash: parsed.infoHash,
        fileIdx: pickVideoFileIdx(parsed.files),
        sources,
        behaviorHints: {
          bingeGroup: `ua-addon-${source}`,
        },
      })
    } catch (err) {
      console.error(`Помилка отримання torrent-даних для "${result.title}":`, err.message)
    }
  }

  return streams
}

// Створюємо builder з конфігом
function buildAddon(config) {
  const builder = new addonBuilder(manifest)

  // Обробник запитів стрімів
  builder.defineStreamHandler(async ({ type, id }) => {
    console.log(`Запит стрімів: ${type} ${id}`)

    const streams = []

    // Для серіалів Stremio передає id у форматі "tt1234567:сезон:епізод" —
    // Cinemeta ж очікує лише базовий tt-ідентифікатор, інакше 404.
    const [imdbId, season, episode] = id.split(':')

    // Отримуємо назву фільму/серіалу по IMDB ID через Cinemeta
    let searchQuery
    try {
      const meta = await axios.get(
        `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
        { timeout: 8000 }
      )
      searchQuery = meta.data?.meta?.name

      // Додаємо S01E01 до пошукового запиту, щоб не отримувати весь серіал
      // впереміш з потрібним епізодом
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

    // Паралельний пошук на обох трекерах
    const tasks = []

    if (config.tolokaLogin && config.tolokaPassword) {
      tasks.push(
        getSession('toloka', config.tolokaLogin, config.tolokaPassword)
          .then(session => toloka.search(session.cookieString, searchQuery)
            .then(results => resultsToStreams(results, session.cookieString, 'toloka'))
            .then(s => streams.push(...s))
          )
          .catch(err => console.error('Toloka error:', err.message))
      )
    }

    if (config.mazepaLogin && config.mazepaPassword) {
      tasks.push(
        getSession('mazepa', config.mazepaLogin, config.mazepaPassword)
          .then(session => mazepa.search(session.cookieString, searchQuery)
            .then(results => resultsToStreams(results, session.cookieString, 'mazepa'))
            .then(s => streams.push(...s))
          )
          .catch(err => console.error('Mazepa error:', err.message))
      )
    }

    await Promise.all(tasks)

    console.log(`Повертаємо ${streams.length} стрімів`)
    return { streams }
  })

  return builder.getInterface()
}

module.exports = { buildAddon }
