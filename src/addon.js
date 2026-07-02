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

  // Беремо топ 5 за кількістю сідів
  const topResults = results
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, 5)

  for (const result of topResults) {
    try {
      let magnet
      if (source === 'toloka') {
        magnet = await toloka.getMagnet(cookieString, result.url)
      } else {
        magnet = await mazepa.getMagnet(cookieString, result.url)
      }

      if (!magnet) continue

      // Визначаємо якість з назви
      const quality = result.title.match(/4K|2160p|1080p|720p|480p/i)?.[0] || 'HD'

      // Флаг джерела
      const flag = source === 'toloka' ? '🇺🇦 Toloka' : '🇺🇦 Mazepa'

      streams.push({
        name: flag,
        title: `${result.title}\n${quality} | ${result.size} | 👥 ${result.seeders}`,
        url: magnet,
        behaviorHints: {
          bingeGroup: `ua-addon-${source}`,
          notWebReady: true,
        },
      })
    } catch (err) {
      console.error(`Помилка отримання magnet для ${result.title}:`, err.message)
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

    // Отримуємо назву фільму по IMDB ID через Cinemeta
    let searchQuery
    try {
      const meta = await axios.get(
        `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`,
        { timeout: 8000 }
      )
      searchQuery = meta.data?.meta?.name
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