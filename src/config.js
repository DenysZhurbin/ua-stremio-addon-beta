// src/config.js
// Конфігурація аддону - credentials користувача

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64')
}

function decodeConfig(encoded) {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch (e) {
    return {}
  }
}

const defaultConfig = {
  tolokaLogin: '',
  tolokaPassword: '',
  mazepaLogin: '',
  mazepaPassword: '',
}

module.exports = { encodeConfig, decodeConfig, defaultConfig }