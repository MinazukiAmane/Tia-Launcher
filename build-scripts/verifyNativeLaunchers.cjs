// Native implementation/tests remain private; never publish their diagnostics.
const { spawnSync } = require('child_process')
const { mkdirSync, writeFileSync } = require('fs')
const { join, resolve } = require('path')
const root = join(__dirname, '..')
const helper = resolve(process.env.TIA_HELPER_SOURCE || join(root, '.private-helper'))
const result = spawnSync('python', [join(helper, 'tests', 'csore_smoke.py'), '--bin-dir', join(root, 'build', 'native')], { encoding: 'utf8' })
if (result.error || result.status !== 0) {
  mkdirSync(join(helper, 'build'), { recursive: true })
  writeFileSync(join(helper, 'build', 'private-startup-test-errors.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''))
  throw new Error('Native startup verification failed. Reproduce in the private helper repository for diagnostics.')
}
console.log('Native startup verification passed.')
