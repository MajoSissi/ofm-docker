#!/usr/bin/env node
// test.mjs — run every check in this repository, in order, and stop at the first
// failure. This is the command to run before pushing a packaging change.
//
//   1. download.mjs      fetch the upstream tree (what the image will build from)
//   2. verify.mjs        inventory, Dockerfile deletions, boot the pruned tree,
//                        assert the HTTP surface and the workflow contract
//   3. run-workflow-verify.mjs
//                         extract the workflow's own verify script and run it
//   4. test-entrypoint-helpers.mjs
//                         the entrypoint's node helpers against the real service
//
// Steps 3 and 4 matter because a passing `verify.mjs` does not prove the
// workflow's CI step is correct — that script only ever runs in CI, where it
// cannot be inspected. Both are executed here against the real service.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

const steps = [
  ['Download the upstream tree', 'download.mjs'],
  ['Verify the packaging', 'verify.mjs'],
  ['Run the workflow\'s verify script', 'run-workflow-verify.mjs'],
  ['Test the entrypoint helpers', 'test-entrypoint-helpers.mjs'],
]

const env = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
let failed = false

for (const [title, file] of steps) {
  console.log('\n' + '═'.repeat(70))
  console.log('  ' + title + '   (' + file + ')')
  console.log('═'.repeat(70))
  if (!fs.existsSync(file)) { console.log('  ✗ ' + file + ' is missing'); failed = true; continue }
  try {
    // Inherit stdio so the output streams live, exactly as running it by hand.
    execFileSync(process.execPath, [file], { stdio: 'inherit', env })
  } catch {
    console.log('\n  ✗ ' + file + ' FAILED')
    failed = true
    break
  }
}

console.log('\n' + '═'.repeat(70))
console.log(failed ? '  TESTS FAILED' : '  ALL TESTS PASSED')
console.log('═'.repeat(70))
process.exit(failed ? 1 : 0)
