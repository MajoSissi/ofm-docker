// The confined modes of this environment block spawning any child process
// (spawnSync EPERM), which is why `node script.mjs` cannot be exec'd from
// another node process here. The workflow's verify script is still validated —
// by extracting it from the workflow and running it *in this process*, with a
// tiny module loader, rather than by spawning.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const root = path.resolve('_probe/dsh-our-free-model-main')
if (!fs.existsSync(path.join(root, 'packages/standalone/cli.mjs'))) {
  console.error('upstream tree missing — run: node download.mjs')
  process.exit(1)
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-verify-'))
const mod = await import(pathToFileURL(path.join(root, 'packages/standalone/service.mjs')).href)
const svc = await mod.startStandalone({ refresh: false, port: 18868, lanEnabled: true, dataDir: home })

// --- pull the script out of the workflow, between the heredoc markers -------
const wf = fs.readFileSync('.github/workflows/build-ghcr.yml', 'utf8')
const start = wf.indexOf("node /dev/stdin <<'EOF'")
if (start < 0) { console.error('heredoc not found in workflow'); process.exit(1) }
const after = wf.indexOf('\n', start)
const end = wf.indexOf('\n          EOF', after)
const script = wf.slice(after + 1, end)
console.log('extracted ' + script.split('\n').length + ' lines from the workflow')

// --- run it as an ESM module, in this process ------------------------------
// Written to a .mjs inside the ESM upstream tree so module resolution matches
// the container, then imported.
const target = path.join(root, '__workflow_verify__.mjs')
fs.writeFileSync(target, script)
// Point it at the real data dir, exactly as the container's ENV does.
process.env.OFM_HOME = home
let failed = false
try {
  await import(pathToFileURL(target).href)
  console.log('--- workflow verify script: ALL ASSERTIONS HELD ---')
} catch (e) {
  failed = true
  console.log('--- workflow verify script FAILED ---')
  console.log(e.message)
}
fs.rmSync(target, { force: true })

await svc.close()
process.exit(failed ? 1 : 0)
