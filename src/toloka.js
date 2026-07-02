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
  const loginPage = await client.get('/login.php')
  let cookieString = extractCookies(loginPage.headers)

  const response = await client.post('/login.php', new URLSearchParams({
    username,
    password,
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

  if (!isLoggedIn) throw new Error('Невірний логін або пароль Toloka')

  console.log('Toloka: успішний логін')
  return { cookieString }
}

async function search(cookieString, query) {
  const client = createClient()

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

  $('a').each((i, el) => {
    const href = $(el).attr('href') || ''
    const title = $(el).text().trim()
    if (!href.match(/^t\d+$/) || title.length < 5) return

    const $row = $(el).closest('tr')
    let seeders = 0
    let size = ''

    $row.find('td').each((j, td) => {
      const text = $(td).text().trim()
      if (text.match(/^\d+$/) && parseInt(text) < 10000) {
        seeders = Math.max(seeders, parseInt(text))
      }
      if (text.match(/\d+(\.\d+)?\s*(GB|MB)/i)) size = text
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
}

// Повертає { type: 'magnet', magnet } або { type: 'file', buffer }
// НІКОЛИ не повертає голий URL — Stremio не може відкрити його з cookies
async function getTorrentInfo(cookieString, torrentUrl) {
  const client = createClient()

  try {
    // 1. Отримуємо сторінку топіку
    const page = await client.get(torrentUrl, {
      headers: { 'Cookie': cookieString },
    })
    const $ = cheerio.load(page.data)

    // 2. Якщо є magnet — повертаємо одразу
    const magnetLink = $('a[href^="magnet:"]').first().attr('href')
    if (magnetLink) {
      console.log('Toloka: знайдено magnet')
      return { type: 'magnet', magnet: magnetLink }
    }

    // 3. Знаходимо посилання на download.php
    const downloadHref = $('a[href*="download.php"]').first().attr('href')
    if (!downloadHref) {
      console.log('Toloka: download link не знайдено для', torrentUrl)
      return null
    }

    const downloadUrl = downloadHref.startsWith('http')
      ? downloadHref
      : `${TOLOKA_URL}/${downloadHref}`

    // 4. Завантажуємо .torrent файл на боці аддону (з cookies)
    let torrentResp
    try {
      torrentResp = await client.get(downloadUrl, {
        headers: { 'Cookie': cookieString, 'Referer': torrentUrl },
        responseType: 'arraybuffer',
      })
    } catch (err) {
      if (err.response?.status === 429) {
        console.log('Toloka: 429, чекаємо 4с...')
        await new Promise(r => setTimeout(r, 4000))
        torrentResp = await client.get(downloadUrl, {
          headers: { 'Cookie': cookieString, 'Referer': torrentUrl },
          responseType: 'arraybuffer',
        })
      } else throw err
    }

    const buffer = Buffer.from(torrentResp.data)

    // 5. Валідація: torrent файл завжди починається з 'd' (0x64)
    if (buffer.length === 0 || buffer[0] !== 0x64) {
      console.error('Toloka: download.php повернув не .torrent (можливо, cookies недійсні)')
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
