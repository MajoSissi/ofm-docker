#!/usr/bin/env node
// verify.mjs — check the packaging against the real upstream tree.
//
// Run this before trusting a build: it fetches nothing, it only compares the
// files in this repository against the upstream source at a pinned ref and the
// runtime's real import graph. What it proves:
//
//   * every file the service imports is in the image tree (so no MODULE_NOT_FOUND)
//   * every file the Dockerfile deletes is genuinely unused
//   * the pruned tree still *boots* — it starts the real service from it and
//     asks /health, /v1/models and the LAN relay
//   * the workflow's required triggers and the AMD64 pin are present
//
// Usage: node verify.mjs [upstream-root]
//        (defaults to _probe/dsh-our-free-model-main, which download.mjs makes)
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const root = path.resolve(process.argv[2] ?? '_probe/dsh-our-free-model-main')
if (!fs.existsSync(path.join(root, 'packages/standalone/cli.mjs'))) {
  console.error(`upstream tree not found at ${root}`)
  console.error('run: node download.mjs   (fetches the tarball and extracts it)')
  process.exit(1)
}

let failures = 0
const fail = msg => { console.log('  ✗ ' + msg); failures++ }
const ok = msg => console.log('  ✓ ' + msg)

// Pull a short human-readable message out of an OpenAI- or Anthropic-shaped
// error body, without throwing on a shape we did not expect.
const safeMessage = body => {
  try {
    const j = JSON.parse(body)
    return j.error?.message ?? j.choices?.[0]?.message?.content ?? j.type ?? body.slice(0, 90)
  } catch { return body.slice(0, 90) }
}

// ---------------------------------------------------- 1. inventory ------
const needed = new Set()
const resolveSpec = (from, spec) => {
  const base = path.resolve(path.dirname(from), spec)
  return [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json',
    path.join(base, 'index.js'), path.join(base, 'index.mjs')]
    .find(c => fs.existsSync(c) && fs.lstatSync(c).isFile())
}
const walk = file => {
  if (needed.has(file)) return
  needed.add(file)
  const text = fs.readFileSync(file, 'utf8')
  const specs = [
    ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"`\n;]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]),
    // new Worker(new URL('...', import.meta.url)) and fs URL reads
    ...[...text.matchAll(/new URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/g)].map(m => m[1]),
  ]
  for (const s of specs) {
    if (s.startsWith('node:') || s.startsWith('http')) continue
    const r = s.startsWith('.') ? resolveSpec(file, s) : (fs.existsSync(path.join(path.dirname(file), s)) ? path.join(path.dirname(file), s) : null)
    if (r) walk(r)
  }
  // module-local data files addressed through a variable, not a specifier
  for (const m of text.matchAll(/['"`]([\w.-]+\.(?:json|wasm))['"`]/g)) {
    const r = resolveSpec(file, './' + m[1])
    if (r) walk(r)
  }
}
for (const entry of ['packages/standalone/cli.mjs', 'packages/standalone/channels/worker.mjs']) {
  walk(path.join(root, entry))
}
for (const f of ['packages/standalone/package.json', 'packages/standalone/web/index.html',
  'packages/standalone/web/splash.html', 'vendor/channel-pack/qoder-auth-wasm.wasm']) {
  needed.add(path.join(root, f))
}
for (const a of JSON.parse(fs.readFileSync(path.join(root, 'packages/standalone/web/assets.json'), 'utf8'))) {
  needed.add(path.join(root, 'packages/standalone/web/' + a))
}
needed.add(path.join(root, 'packages/standalone/web/assets.json'))

console.log('\n=== 1. runtime inventory ===')
console.log(`  ${needed.size} files, ${([...needed].reduce((n, f) => n + fs.statSync(f).size, 0) / 1048576).toFixed(2)} MiB`)

// ---------------------------------------------------- 2. deletions ------
console.log('\n=== 2. Dockerfile deletions are safe ===')
const df = fs.readFileSync('Dockerfile', 'utf8')
const rel = [...needed].map(f => path.relative(root, f).split(path.sep).join('/'))
const collect = (re) => {
  const m = df.match(re)
  if (!m) return []
  return m[1].replace(/\\/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
}
for (const t of collect(/for\s+target\s+in\s+([\s\S]*?);\s*do/)) {
  if (rel.some(r => r === t || r.startsWith(t + '/'))) fail(`rm -rf ${t} deletes a needed file`)
}
for (const t of collect(/for\s+dead\s+in\s+([\s\S]*?);\s*do/)) {
  if (rel.includes(t)) fail(`rm -f ${t} deletes a needed file`)
}
if (failures === 0) ok('nothing the runtime needs is deleted')
// every Dockerfile test -f path must exist in the upstream tree
for (const m of df.matchAll(/test -f (\/src\/[^\s;]+)/g)) {
  const relPath = m[1].replace('/src/', '')
  if (!needed.has(path.join(root, relPath)) && !fs.existsSync(path.join(root, relPath))) fail(`Dockerfile asserts ${m[1]} which does not exist upstream`)
}
if (failures === 0) ok('every Dockerfile `test -f` target exists upstream')

// ---------------------------------------------------- 3. boot ----------
console.log('\n=== 3. pruned tree boots ===')
const work = '_probe/verify-pruned'
if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true })
fs.cpSync(root, work, { recursive: true })
for (const t of [...collect(/for\s+target\s+in\s+([\s\S]*?);\s*do/),
  ...collect(/for\s+dead\s+in\s+([\s\S]*?);\s*do/)]) {
  fs.rmSync(path.join(work, t), { recursive: true, force: true })
}
const webDir = path.join(work, 'packages/standalone/web')
const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'assets.json'), 'utf8'))
const keep = new Set(['index.html', 'splash.html', 'assets.json', ...manifest])
for (const e of fs.readdirSync(webDir)) if (!keep.has(e)) fs.rmSync(path.join(webDir, e), { force: true })

const dataDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ofm-verify-'))
let svc
try {
  const mod = await import(pathToFileURL(path.resolve(work, 'packages/standalone/service.mjs')).href)
  svc = await mod.startStandalone({ refresh: false, port: 18877, lanEnabled: true, dataDir })
} catch (e) {
  fail('service would not start from the pruned tree: ' + e.message)
}
if (svc) {
  const get = (port, p, key) => new Promise((res, rej) => {
    const req = http.request(`http://127.0.0.1:${port}${p}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} }, r => {
      let o = ''; r.setEncoding('utf8'); r.on('data', c => o += c); r.on('end', () => res({ s: r.statusCode, o }))
    })
    req.on('error', rej); req.end()
  })
  const settings = JSON.parse(fs.readFileSync(path.join(svc.dataDir, 'settings.json'), 'utf8'))
  const expect = async (label, port, p, key, want) => {
    try {
      const r = await get(port, p, key)
      r.s === want ? ok(`${label} → ${r.s}`) : fail(`${label} → ${r.s}, expected ${want}`)
    } catch (e) { fail(`${label} → ${e.code}`) }
  }
  await expect('local  /health', svc.port, '/health', null, 200)
  await expect('local  /v1/models', svc.port, '/v1/models', settings.forwardKey, 200)
  await expect('relay  /v1/models (keyed)', svc.lan.port, '/v1/models', settings.standaloneLanKey, 200)
  await expect('relay  /v1/models (anonymous)', svc.lan.port, '/v1/models', null, 401)
  await expect('relay  /health must be refused', svc.lan.port, '/health', settings.standaloneLanKey, 404)
  await expect('relay  /api/management must be refused', svc.lan.port, '/api/management/summary', settings.standaloneLanKey, 404)
  // A real completion with no credentials at all. This is the whole point of
  // the image: someone pulls it, sets one env var, and has models. If this
  // fails, the container is decoration.
  try {
    const post = (port, p, key, body) => new Promise((res, rej) => {
      const payload = JSON.stringify(body)
      const req = http.request(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
      }, r => { let o = ''; r.setEncoding('utf8'); r.on('data', c => o += c); r.on('end', () => res({ s: r.statusCode, o })) })
      req.on('error', rej); req.end(payload)
    })
    let models = []
    for (let i = 0; i < 10 && models.length === 0; i++) {
      const r = await get(svc.lan.port, '/v1/models', settings.standaloneLanKey)
      if (r.s === 200) { try { models = JSON.parse(r.o).data ?? JSON.parse(r.o) } catch { } }
      if (!models.length) await new Promise(r => setTimeout(r, 2000))
    }
    if (models.length === 0) {
      fail('no models reachable — is the network available? (catalog needs upstream)')
    } else {
      // What is asserted here is the *relay*, not the free lane. A working relay
      // answers a completion with either a 200 (a real completion) or one of
      // upstream's own verdicts, each of which proves the request reached the
      // lane and came back: 403 (egress refused by OpenCode's abuse policy),
      // 410 (deprecated), 400 (unavailable today), 404 (not found), and 502
      // from a `combo:` row, which is that row's own "every candidate in my
      // chain failed, here is why" answer. What is never acceptable is 401/500/
      // ECONNREFUSED, which would mean the container itself is broken.
      //
      // This distinction matters: an earlier draft demanded a 200 and failed a
      // perfectly good image because the free lane refused the build machine's
      // egress. From a refused egress the model list still answers 200 and the
      // relay still authenticates; only the lane itself says no.
      const attempts = []
      for (const m of models) {
        const r = await post(svc.lan.port, '/v1/chat/completions', settings.standaloneLanKey,
          { model: m.id, messages: [{ role: 'user', content: 'Answer with exactly one word: ready' }], max_tokens: 16, stream: false })
        attempts.push({ model: m.id, status: r.s, detail: safeMessage(r.o) })
        if (r.s === 200) break
      }
      const good = a => a.status === 200 || [400, 403, 404, 410, 502].includes(a.status)
      if (attempts.every(good)) {
        const first = attempts[0]
        ok(first.status === 200
          ? `real completion through the relay (${first.model}) → 200`
          : `relay authenticated and reached the lane (${first.status}); the image is sound — the lane's own verdict was "${first.detail}"`)
        for (const a of attempts.slice(0, 9)) console.log(`        ${String(a.status).padStart(3)}  ${a.model} — ${a.detail}`)
      } else {
        fail('relay completion failed in a way that is NOT an upstream lane verdict: ' + JSON.stringify(attempts.filter(a => !good(a))))
      }
    }
  } catch (e) { fail('relay completion threw: ' + e.message) }
  await svc.close()
}
fs.rmSync(work, { recursive: true, force: true })

// ---------------------------------------------------- 4. workflow -------
// Load both files: some assertions belong to the workflow (triggers, registry,
// platform), and some to the Dockerfile (immutable upstream fetch). Checking
// the wrong file for a Dockerfile-only contract is a real bug — the assertion
// would silently pass for the wrong reason or fail for the right one.
console.log('\n=== 4. workflow contract ===')
const wfPath = '.github/workflows/build-ghcr.yml'
if (!fs.existsSync(wfPath)) fail('workflow missing at ' + wfPath)
else {
  const wf = fs.readFileSync(wfPath, 'utf8')
  const df = fs.readFileSync('Dockerfile', 'utf8')
  const has = (re, source, msg) => (re.test(source) ? ok(msg) : fail(msg))
  has(/-\s*cron:\s*'[^']+'\s*$/m, wf, 'daily cron trigger present')
  has(/workflow_dispatch:/, wf, 'manual trigger (workflow_dispatch) present')
  has(/packages:\s*write/, wf, 'packages: write permission present')
  has(/platforms:\s*linux\/amd64/, wf, 'linux/amd64 platform pinned')
  has(/registry:\s*ghcr\.io/, wf, 'pushes to ghcr.io')
  // The pinned-SHA fetch. `$`, `{` and `}` are literal characters in the
  // Dockerfile's text, so each needs escaping in a regex. The tarball URL must
  // be built from the resolved SHA, never from UPSTREAM_REF directly — using
  // the ref would fetch a different tree at each step.
  const codeloadRe = /codeload\.github\.com\/\$\{UPSTREAM_REPO\}\/tar\/gz\/\$\{UPSTREAM_SHA\}/
  if (!codeloadRe.test(df)) {
    // Fall back to a plain substring check — this is the assertion that matters,
    // not the regex.
    const target = 'codeload.github.com/${UPSTREAM_REPO}/tar.gz/${UPSTREAM_SHA}'
    df.includes(target) ? ok('Dockerfile fetches an immutable upstream tarball at a pinned SHA')
                        : fail('Dockerfile does not fetch the pinned SHA tarball')
  } else {
    ok('Dockerfile fetches an immutable upstream tarball at a pinned SHA')
  }
  df.includes('[0-9a-f]\\{40\\}')
    ? ok('pins a full 40-char commit SHA, not a moving ref')
    : fail('no 40-char SHA pin found')
  has(/FROM\s+node:\$\{NODE_VERSION\}/, df, 'Dockerfile final stage is a node base')
  has(/USER\s+node/, df, 'Dockerfile runs as a non-root user')
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASSED'))
process.exit(failures ? 1 : 0)
