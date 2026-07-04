// index.js
const { buildAddon } = require('./src/addon')
const { decodeConfig } = require('./src/config')
const torrentCache = require('./src/torrentCache')
const { handleStreamRequest } = require('./src/streamServer')
const http = require('http')

const PORT = process.env.PORT || 7000

function configPage() {
  return `
<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🇺🇦 UA Torrents — Налаштування</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, sans-serif;
      background: #1a1a2e;
      color: #eee;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      background: #16213e;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 500px;
    }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #aaa; margin-bottom: 30px; font-size: 14px; }
    .section {
      background: #0f3460;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .section h2 { font-size: 16px; margin-bottom: 15px; color: #e94560; }
    label { display: block; font-size: 13px; color: #aaa; margin-bottom: 5px; }
    input {
      width: 100%;
      padding: 10px 12px;
      background: #1a1a2e;
      border: 1px solid #333;
      border-radius: 6px;
      color: #eee;
      font-size: 14px;
      margin-bottom: 12px;
    }
    input:focus { outline: none; border-color: #e94560; }
    .optional { font-size: 11px; color: #666; margin-left: 5px; }
    button {
      width: 100%;
      padding: 14px;
      background: #e94560;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      cursor: pointer;
      font-weight: bold;
    }
    button:hover { background: #c73652; }
    .note {
      font-size: 12px;
      color: #666;
      text-align: center;
      margin-top: 15px;
      line-height: 1.5;
    }
    .install-link {
      display: none;
      margin-top: 20px;
      padding: 15px;
      background: #0f3460;
      border-radius: 8px;
      text-align: center;
    }
    .install-link a {
      color: #e94560;
      word-break: break-all;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🇺🇦 UA Torrents</h1>
    <p class="subtitle">Українські торренти з Toloka та Mazepa для Stremio</p>

    <div class="section">
      <h2>Toloka.to</h2>
      <label>Логін <span class="optional">(опціонально)</span></label>
      <input type="text" id="tolokaLogin" placeholder="ваш логін">
      <label>Пароль</label>
      <input type="password" id="tolokaPassword" placeholder="ваш пароль">
    </div>

    <div class="section">
      <h2>Mazepa.to</h2>
      <label>Логін <span class="optional">(опціонально)</span></label>
      <input type="text" id="mazepaLogin" placeholder="ваш логін">
      <label>Пароль</label>
      <input type="password" id="mazepaPassword" placeholder="ваш пароль">
    </div>

    <button onclick="install()">Встановити в Stremio</button>

    <div class="install-link" id="installLink">
      <p style="margin-bottom:10px">Якщо Stremio не відкрився — скопіюй це посилання і встав вручну:</p>
      <a id="manifestUrl" href="#"></a>
    </div>

    <p class="note">Ваші дані шифруються та зберігаються лише в URL аддону.<br>Сервер їх не зберігає.</p>
  </div>

  <script>
    function install() {
        const config = {
            tolokaLogin: document.getElementById('tolokaLogin').value,
            tolokaPassword: document.getElementById('tolokaPassword').value,
            mazepaLogin: document.getElementById('mazepaLogin').value,
            mazepaPassword: document.getElementById('mazepaPassword').value,
        }

        const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(config))))

        const baseUrl = window.location.origin

        const manifestUrl = baseUrl + '/' + encoded + '/manifest.json'
        const stremioUrl = 'stremio://' + window.location.host + '/' + encoded + '/manifest.json'

        document.getElementById('installLink').style.display = 'block'
        document.getElementById('manifestUrl').textContent = manifestUrl
        document.getElementById('manifestUrl').href = manifestUrl

        window.location.href = stremioUrl
        }
  </script>
</body>
</html>
`
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')

  const url = req.url.split('?')[0]
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`

  // Головна сторінка
  if (url === '/' || url === '/configure') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(configPage())
    return
  }

  // Стрім-проксі: /watch/<infoHash>/<fileIdx>.mp4
  const watchMatch = url.match(/^\/watch\/([a-fA-F0-9]{40})\/(\d+)\.mp4$/)
  if (watchMatch) {
    const infoHash = watchMatch[1].toLowerCase()
    const fileIdx = parseInt(watchMatch[2], 10)

    const buffer = torrentCache.get(infoHash)
    if (!buffer) {
      console.error(`Watch: буфер для ${infoHash} не знайдено в кеші (можливо, застарів)`)
      res.writeHead(404)
      res.end('Torrent expired, please reload streams in Stremio')
      return
    }

    await handleStreamRequest(req, res, buffer, infoHash, fileIdx)
    return
  }

  // Запити аддону: /{encoded}/manifest.json або /{encoded}/stream/...
  const match = url.match(/^\/([A-Za-z0-9+/=]+)\/(manifest\.json|stream\/.+)$/)
  if (match) {
    const encoded = match[1]
    const path = match[2]
    const config = decodeConfig(encoded)
    const addonInterface = buildAddon(config, baseUrl)

    if (path === 'manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(addonInterface.manifest))
      return
    }

    const streamMatch = path.match(/^stream\/(\w+)\/(.+)\.json$/)
    if (streamMatch) {
      const type = streamMatch[1]
      const id = streamMatch[2]
      try {
        const result = await addonInterface.get('stream', type, id)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error('Stream error:', err)
        res.writeHead(500)
        res.end(JSON.stringify({ streams: [] }))
      }
      return
    }
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`\n🇺🇦 UA Torrents аддон запущено!`)
  console.log(`Відкрий в браузері: http://localhost:${PORT}`)
  console.log(`Налаштуй credentials та встанови в Stremio\n`)
})
