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

async function getMagnet(cookieString, torrentUrl) {
  const client = createClient()

  try {
    const response = await client.get(torrentUrl, {
      headers: { 'Cookie': cookieString },
    })

    const $ = cheerio.load(response.data)

    // Toloka використовує download.php?id=XXXXX
    const downloadLink = $('a[href*="download.php"]').first().attr('href') ||
                         $('a[title*="завантажити" i], a[title*="torrent" i]').first().attr('href')

    if (downloadLink) {
      return downloadLink.startsWith('http')
        ? downloadLink
        : `${TOLOKA_URL}/${downloadLink}`
    }

    return null

  } catch (err) {
    console.error('Toloka getMagnet error:', err.message)
    return null
  }
}

module.exports = { login, search, getMagnet }