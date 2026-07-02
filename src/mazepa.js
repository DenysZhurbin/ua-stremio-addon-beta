// src/mazepa.js
// СТАН: Mazepa блокує хмарні IP (Render, Railway тощо) з кодом 403.
// Це IP-блокування на рівні сервера — не залежить від credentials чи коду.
// Login повертає null при 403 — аддон продовжує працювати тільки з Toloka.
// Коли Mazepa розблокує хмарні IP або буде запущено локально — все запрацює.

const axios = require('axios')
const cheerio = require('cheerio')

const MAZEPA_URL = 'https://mazepa.to'

function createClient() {
  return axios.create({
    baseURL: MAZEPA_URL,
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
      login_username: username,
      login_password: password,
      autologin: 'on',
      redirect: '',
      login: 'Вхід',
    }), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieString,
        'Referer': `${MAZEPA_URL}/login.php`,
      },
      maxRedirects: 5,
    })

    cookieString = extractCookies(response.headers, cookieString)

    const $after = cheerio.load(response.data)
    const isLoggedIn = $after(`a:contains("${username}")`).length > 0 ||
                       $after('a[href*="logout"]').length > 0 ||
                       $after('a[href*="profile"]').length > 0

    if (!isLoggedIn) throw new Error('Невірний логін або пароль Mazepa')

    console.log('Mazepa: успішний логін')
    return { cookieString }

  } catch (err) {
    if (err.response?.status === 403) {
      // IP заблокований хмарним хостингом — не крашимо аддон
      console.warn('Mazepa: 403 — IP сервера заблокований, Mazepa пропускається')
      return null
    }
    // Інші помилки логуємо але теж повертаємо null щоб не крашити аддон
    console.error('Mazepa login error:', err.message)
    return null
  }
}

async function search(cookieString, query) {
  if (!cookieString) return []
  const client = createClient()

  try {
    const response = await client.get('/tracker.php', {
      params: { nm: query },
      headers: {
        'Cookie': cookieString,
        'Referer': `${MAZEPA_URL}/tracker.php`,
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
        url: `${MAZEPA_URL}/${href}`,
        seeders,
        size,
        source: 'Mazepa',
      })
    })

    console.log(`Mazepa: знайдено ${results.length} результатів для "${query}"`)
    return results

  } catch (err) {
    console.error('Mazepa search error:', err.message)
    return []
  }
}

// Повертає { type: 'magnet', magnet } або { type: 'file', buffer }
async function getTorrentInfo(cookieString, torrentUrl) {
  if (!cookieString) return null
  const client = createClient()

  try {
    const page = await client.get(torrentUrl, {
      headers: { 'Cookie': cookieString },
    })
    const $ = cheerio.load(page.data)

    // Спочатку magnet
    const magnet = $('a[href^="magnet:"]').first().attr('href')
    if (magnet) {
      console.log('Mazepa: знайдено magnet')
      return { type: 'magnet', magnet }
    }

    // Потім download посилання
    const downloadHref = $('a[href*="download.php"]').first().attr('href') ||
                         $('a[href*=".torrent"]').first().attr('href') ||
                         $('a[title*="завантажити" i]').first().attr('href')

    if (!downloadHref) {
      console.log('Mazepa: download link не знайдено')
      return null
    }

    const downloadUrl = downloadHref.startsWith('http')
      ? downloadHref
      : `${MAZEPA_URL}/${downloadHref}`

    const torrentResp = await client.get(downloadUrl, {
      headers: { 'Cookie': cookieString, 'Referer': torrentUrl },
      responseType: 'arraybuffer',
    })

    const buffer = Buffer.from(torrentResp.data)

    if (buffer.length === 0 || buffer[0] !== 0x64) {
      console.error('Mazepa: download повернув не .torrent файл')
      return null
    }

    console.log(`Mazepa: отримано .torrent файл (${buffer.length} байт)`)
    return { type: 'file', buffer }

  } catch (err) {
    console.error('Mazepa getTorrentInfo error:', err.message)
    return null
  }
}

module.exports = { login, search, getTorrentInfo }
