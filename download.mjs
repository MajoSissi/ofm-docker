#!/usr/bin/env node
// download.mjs — fetch the upstream source tree for local inspection and for
// verify.mjs. Useful on its own: it answers "what does the thing I am about to
// containerize actually look like?"
//
// Usage: node download.mjs [--ref <ref>] [--out <dir>]
//   --ref   branch, tag or SHA (default: main, resolved to an immutable SHA)
//   --out   extraction directory (default: _probe/dsh-our-free-model-main)
//
// It resolves the ref through the GitHub API first, so `--ref main` still gives
// you a specific tree, and prints the SHA it ended up with. The result is what
// the Docker build does, minus the container.
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const DEFAULT_REPO = 'Ebony-Vinyl/dsh-our-free-model'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const ref = flag('ref', 'main')
const out = path.resolve(flag('out', '_probe/dsh-our-free-model-main'))
const repo = flag('repo', process.env.UPSTREAM_REPO || DEFAULT_REPO)

// A single request helper: https only, no dependencies, follows redirects the
// way the GitHub API expects (it rarely needs it).
const get = (url, { json = false } = {}) => new Promise((resolve, reject) => {
  const req = https.get(url, {
    headers: { 'User-Agent': 'ofm-docker-download', 'Accept': 'application/vnd.github+json' },
  }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return resolve(get(res.headers.location, { json }))
    }
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      const body = Buffer.concat(chunks)
      resolve(json ? JSON.parse(body.toString('utf8')) : body)
    })
  })
  req.on('error', reject)
  req.setTimeout(60000, () => req.destroy(new Error('timeout')))
})

// --- 1. resolve the ref to an immutable SHA ----------------------------
console.log(`resolving ${repo}@${ref} …`)
let sha
try {
  const commit = await get(`https://api.github.com/repos/${repo}/commits/${ref}`, { json: true })
  sha = commit.sha
} catch (e) {
  console.error(`could not resolve ${repo}@${ref}: ${e.message}`)
  console.error('(a private repo needs GITHUB_TOKEN in the environment)')
  process.exit(1)
}
console.log(`  -> ${sha}`)

// --- 2. download and extract the tarball -------------------------------
const tarball = await get(`https://codeload.github.com/${repo}/tar.gz/${sha}`)
console.log(`  downloaded ${(tarball.length / 1048576).toFixed(1)} MiB`)

fs.rmSync(path.resolve('_probe'), { recursive: true, force: true })
fs.mkdirSync(path.resolve('_probe'), { recursive: true })
fs.writeFileSync(path.resolve('_probe/upstream.tar.gz'), tarball)

// A minimal tar reader: only the fields we need, no dependency. Enough for a
// GitHub tarball, which is plain ustar with long names avoided.
const entries = []
let offset = 0
const raw = zlib.gunzipSync(tarball)
const readStr = (buf, o, len) => buf.toString('utf8', o, o + len).replace(/\0.*$/, '')
while (offset + 512 <= raw.length) {
  const name = readStr(raw, offset, 100)
  if (!name) break
  const size = parseInt(readStr(raw, offset + 124, 12).trim(), 8) || 0
  const type = String.fromCharCode(raw[offset + 156])
  const prefix = readStr(raw, offset + 345, 155)
  entries.push({ name: prefix ? `${prefix}/${name}` : name, type, size, data: raw.subarray(offset + 512, offset + 512 + size) })
  offset += 512 + Math.ceil(size / 512) * 512
}

// Strip the single top-level component GitHub adds. Directory entries in a tar
// carry a trailing `/`, and that trailing slash matters: `root + '/'` would then
// be `...//` and match nothing. Normalise it away before using it as a prefix.
const root = (entries.find(e => e.type === '5')?.name.replace(/\/+$/, ''))
  ?? entries[0].name.split('/')[0]
fs.mkdirSync(out, { recursive: true })
let files = 0
for (const e of entries) {
  if (e.type !== '0' && e.type !== '\0') continue
  if (!e.name.startsWith(root + '/')) continue
  const rel = e.name.slice(root.length + 1)
  if (!rel) continue
  const dest = path.join(out, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, e.data)
  files++
}

// Sanity-check the extraction rather than trusting the counter: a zero-file
// result would mean the tar layout changed, and every later check would then
// be meaningless.
if (files === 0 || !fs.existsSync(path.join(out, 'packages/standalone/cli.mjs'))) {
  console.error(`extraction produced ${files} files and the runtime entry is missing — the tarball layout changed`)
  process.exit(1)
}

console.log(`\n${repo}@${sha}`)
console.log(`  extracted to ${out} (${files} files)`)
console.log('\nnext: node verify.mjs')
