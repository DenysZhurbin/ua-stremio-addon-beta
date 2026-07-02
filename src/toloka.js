// src/toloka.js
const axios = require('axios')
const cheerio = require('cheerio')

const TOLOKA_URL = 'https://toloka.to'

function createClient() {
  return axios.create({
    baseURL: TOLOKA_URL,
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })
}

function extractCookies(headers, existingCookies = '') {
  const newCookies = (headers['set-cookie'] || []).map(c => c.split(';')[0])
  const existing = existingCookies ? existingCookies.split('; ') : []
  const cookieMap = new Map()
  ;[...existing, ...newCookies].forEach(c => {
    const [name] = c.split('=')
    if (name) cookieMap.set(name.trim(), c)
  })
  return Array.from(cookieMap.values()).join('; ')
}

async function login(username, password) {
  const client = createClient()

  try {
    const loginPage = await client.get('/login.php')
    let cookieString = extractCookies(loginPage.headers)

    const response = await client.post('/login.php', new URLSearchParams({
      username: username,
      password: password,
      login: 'Вхід',
      redirect: '',
      autologin: 'on',
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
        'Referer': `${TOLOKA_URL}/login.php`,
      },
      maxRedirects: 5,
    })

    cookieString = extractCookies(response.headers, cookieString)

    const $after = cheerio.load(response.data)
    const isLoggedIn = $after(`a:contains("${username}")`).length > 0 ||
                       $after('a[href*="logout"]').length > 0

    if (!isLoggedIn) {
      throw new Error('Невірний логін або пароль Toloka')
    }

    console.log('Toloka: успішний логін')
    return { cookieString }

  } catch (err) {
    console.error('Toloka login error:', err.message)
    throw err
  }
}

async function search(cookieString, query) {
  const client = createClient()

  try {
    const response = await client.post('/tracker.php', new URLSearchParams({
      nm: query,
      submit: 'Пошук',
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
        'Referer': `${TOLOKA_URL}/tracker.php`,
      },
    })

    const $ = cheerio.load(response.data)
    const results = []

    // Посилання мають формат /tXXXXX
    $('a').each((i, el) => {
      const href = $(el).attr('href') || ''
      const title = $(el).text().trim()

      // Фільтруємо тільки посилання на топіки
      if (!href.match(/^t\d+$/) || title.length < 5) return

      // Знаходимо батьківський рядок таблиці
      const $row = $(el).closest('tr')

      // Витягуємо сіди і розмір з рядка
      const cells = $row.find('td')
      let seeders = 0
      let size = ''

      cells.each((j, td) => {
        const text = $(td).text().trim()
        if (text.match(/^\d+$/) && parseInt(text) < 10000) {
          seeders = Math.max(seeders, parseInt(text))
        }
        if (text.match(/\d+(\.\d+)?\s*(GB|MB)/i)) {
          size = text
        }
      })

      results.push({
        title,
        url: `${TOLOKA_URL}/${href}`,
        seeders,
        size,
        source: 'Toloka',
      })
    })

    console.log(`Toloka: знайдено ${results.length} результатів для "${query}"`)
    return results

  } catch (err) {
    console.error('Toloka search error:', err.message)
    return []
  }
}

// Повертає інформацію, достатню щоб побудувати повноцінний torrent-стрім:
// або готовий magnet-рядок, або реальні байти .torrent файлу.
// НІКОЛИ не повертає "голий" URL на download.php — Stremio не вміє
// відкривати його з cookies, тож раніше саме тут була причина
// "нічого не відтворюється".
async function getTorrentInfo(cookieString, torrentUrl) {
  const client = createClient()

  try {
    const response = await client.get(torrentUrl, {
      headers: { Cookie: cookieString },
    })

    const $ = cheerio.load(response.data)

    // Спочатку перевіряємо чи є готовий magnet
    const magnetLink = $('a[href^="magnet:"]').first().attr('href')
    if (magnetLink) {
      console.log('Toloka: знайдено MAGNET')
      return { type: 'magnet', magnet: magnetLink }
    }

    // Інакше шукаємо посилання на завантаження .torrent файлу
    const downloadHref = $('a[href*="download.php"]').first().attr('href')
    if (!downloadHref) {
      console.log('Toloka: посилання на завантаження не знайдено')
      return null
    }

    const downloadUrl = downloadHref.startsWith('http')
      ? downloadHref
      : `${TOLOKA_URL}/${downloadHref}`

    // Завантажуємо САМ .torrent файл (бінарно), з тими самими cookies,
    // на боці аддону — а не віддаємо це посилання в Stremio
    const torrentResponse = await client.get(downloadUrl, {
      headers: { Cookie: cookieString },
      responseType: 'arraybuffer',
    })

    const buffer = Buffer.from(torrentResponse.data)

    // .torrent файл — це bencode-словник, він завжди починається з байта 'd' (0x64).
    // Якщо це не так — значить cookies недійсні і нам віддали HTML-сторінку логіну.
    if (buffer.length === 0 || buffer[0] !== 0x64) {
      console.error('Toloka: download.php повернув не .torrent файл (ймовірно, недійсні cookies)')
      return null
    }

    console.log(`Toloka: отримано .torrent файл (${buffer.length} байт)`)
    return { type: 'file', buffer }

  } catch (err) {
    console.error('Toloka getTorrentInfo error:', err.message)
    return null
  }
}

module.exports = { login, search, getTorrentInfo }
