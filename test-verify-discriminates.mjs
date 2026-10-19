// Prove verify.mjs's new entrypoint section CATCHES the failure that actually
// happened, not just that it passes on the fixed tree. A check that cannot fail
// is not a check.
//
// This temporarily rewrites the Dockerfile with the old (broken) COPY, runs the
// exact assertion logic from verify.mjs, and then restores it.
import fs from 'node:fs'

const real = fs.readFileSync('Dockerfile', 'utf8')
const fixed = 'COPY --chmod=0755 --chown=node:node docker/entrypoint.sh /usr/local/bin/ofm-entrypoint.sh'

// The original line, which is what caused the CI failure.
const broken = 'COPY --chown=node:node docker/entrypoint.sh /usr/local/bin/ofm-entrypoint.sh'

if (!real.includes(fixed)) { console.error('expected the fixed COPY line in Dockerfile'); process.exit(1) }

const assert = (df, label) => {
  const copyRe = /^COPY\s+(?:--chmod=(\d+)\s+)?(?:--chown=[^\s]+\s+)?.*docker\/entrypoint\.sh\s+(\/\S+)/m
  const m = df.match(copyRe)
  console.log(`${label}: regex matched=${!!m} chmod=${m ? m[1] : 'n/a'}`)
  return m && m[1] === '0755'
}

console.log('=== on the fixed Dockerfile ===')
const fixedOk = assert(real, 'fixed  ')
console.log('  → ' + (fixedOk ? 'PASSES' : 'FAILS') + '  ' + (fixedOk ? '(correct)' : 'WRONG'))

console.log('\n=== on the original broken Dockerfile ===')
const brokenOk = assert(real.replace(fixed, broken), 'broken ')
console.log('  → ' + (brokenOk ? 'PASSES' : 'FAILS') + '  ' + (!brokenOk ? '(correct — this is the bug)' : 'WRONG — the check would have missed it'))

// Also confirm the ENTRYPOINT assertion sees the invocation.
const epOk = /ENTRYPOINT\s+\[[^\]]*entrypoint\.sh/.test(real)
console.log('\nENTRYPOINT invokes the script: ' + (epOk ? 'PASSES' : 'FAILS'))

const shebang = fs.readFileSync('docker/entrypoint.sh', 'utf8').split('\n')[0]
const sbOk = shebang === '#!/bin/sh'
console.log('shebang on line 1          : ' + (sbOk ? 'PASSES' : 'FAILS'))

console.log('\n' + (fixedOk && !brokenOk && epOk && sbOk
  ? 'THE CHECK DISCRIMINATES — passes on the fix, fails on the bug'
  : 'THE CHECK DOES NOT DISCRIMINATE — it needs fixing'))
process.exit(fixedOk && !brokenOk && epOk && sbOk ? 0 : 1)
