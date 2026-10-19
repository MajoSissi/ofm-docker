// Validate the entrypoint's two node helper functions against the real service.
//
// The helpers must be exercised *in this process* rather than via execFileSync:
// this environment's confined modes block spawning child processes, and a test
// that cannot run is worse than no test. So the two snippets from
// docker/entrypoint.sh are transcribed here and called directly.
//
// What this proves:
//   * ofm_setting reads a settings.json field correctly, and returns "" for a
//     missing one rather than crashing
//   * ofm_relay_port returns the LIVE relay port — which is NOT what
//     settings.json records when the port was auto-assigned (0 on disk, an
//     ephemeral one on the wire)
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve('_probe/dsh-our-free-model-main')
if (!fs.existsSync(path.join(root, 'packages/standalone/cli.mjs'))) {
  console.error('upstream tree missing — run: node download.mjs')
  process.exit(1)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-entry-'))
const mod = await import(pathToFileURL(path.join(root, 'packages/standalone/service.mjs')).href)
const svc = await mod.startStandalone({ refresh: false, port: 18871, lanEnabled: true, lanPort: 0, dataDir: home })

// Shared env, exactly as the entrypoint exports it.
process.env.OFM_HOME = home
process.env.OFM_PORT = String(svc.port)

// --- ofm_setting, from docker/entrypoint.sh -----------------------------
function ofm_setting(field) {
  const file = (process.env.OFM_HOME || '/data') + '/settings.json'
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const value = doc ? doc[field] : null
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

// --- ofm_relay_port, from docker/entrypoint.sh -------------------------
function ofm_relay_port() {
  return new Promise(resolve => {
    const file = (process.env.OFM_HOME || '/data') + '/settings.json'
    let settings = {}
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return resolve('') }
    const key = typeof settings.forwardKey === 'string' ? settings.forwardKey : ''
    http.get(
      {
        host: '127.0.0.1',
        port: Number(process.env.OFM_PORT || 18900),
        path: '/api/management/summary',
        headers: { Authorization: 'Bearer ' + key },
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          try {
            const relayPort = JSON.parse(body).lan.port
            resolve(relayPort ? String(relayPort) : '')
          } catch { resolve('') }
        })
      },
    ).on('error', () => resolve(''))
  })
}

// --- checks ------------------------------------------------------------
const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
const keyFromHelper = ofm_setting('standaloneLanKey')
const portFromHelper = await ofm_relay_port()
const livePort = String(svc.lan.port)

const checks = [
  ['ofm_setting returns the real LAN key', keyFromHelper === settings.standaloneLanKey, keyFromHelper.slice(0, 10) + '…'],
  ['ofm_setting returns "" for a missing field', ofm_setting('no_such_field') === '', '(empty)'],
  ['ofm_setting tolerates a missing file', (() => { const saved = process.env.OFM_HOME; process.env.OFM_HOME = '/no/such/dir'; const r = ofm_setting('x'); process.env.OFM_HOME = saved; return r === '' })(), '(empty, no throw)'],
  ['ofm_relay_port returns the LIVE port', portFromHelper === livePort, portFromHelper],
  ['ofm_relay_port is not the persisted 0', portFromHelper !== '' && portFromHelper !== '0', portFromHelper],
  ['the persisted port really is 0 (the trap)', String(settings.standaloneLanPort) === '0', String(settings.standaloneLanPort)],
]

console.log('| check | result |')
console.log('|---|---|')
let bad = 0
for (const [label, pass, detail] of checks) {
  console.log(`| ${label} | ${pass ? '✓ `' + detail + '`' : '✗ `' + detail + '`'} |`)
  if (!pass) bad++
}
console.log(`\nlive relay port ${livePort}; helper reports ${portFromHelper}; disk says ${settings.standaloneLanPort}`)
await svc.close()
process.exit(bad ? 1 : 0)
