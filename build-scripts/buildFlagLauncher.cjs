const { existsSync, mkdirSync, writeFileSync } = require('fs')
const { join, resolve } = require('path')
const { spawnSync } = require('child_process')
const root = join(__dirname, '..')
const helper = resolve(process.env.TIA_HELPER_SOURCE || join(root, '.private-helper'))
const source = join(helper, 'native', 'flag-launch.c')
if (!existsSync(source)) throw new Error('Private helper source missing. Clone Tia-Launcher-Helpers into .private-helper or set TIA_HELPER_SOURCE.')
mkdirSync(join(root, 'build', 'native'), { recursive: true })
for (const [name, target] of [['x86', 'x86-windows-gnu'], ['x64', 'x86_64-windows-gnu']]) {
  const result = spawnSync('zig', ['cc', '-target', target, '-O2', '-s', '-municode', '-Wl,--subsystem,windows', source, '-lshell32', '-o', join(root, 'build', 'native', `flag-launch-${name}.exe`)], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    mkdirSync(join(helper, 'build'), { recursive: true })
    writeFileSync(join(helper, 'build', 'private-flag-build-errors.log'), (result.stdout || '') + (result.stderr || ''))
    throw new Error('Private native helper build failed. Inspect diagnostics in the private helper repository.')
  }
}

const cedar = spawnSync(process.execPath, [join(helper, 'build-cedar.cjs')], {
  stdio: 'inherit', env: { ...process.env, TIA_CEDAR_OUTPUT: join(root, 'build', 'native', 'cedar') }
})
if (cedar.error) throw cedar.error
if (cedar.status !== 0) process.exit(cedar.status ?? 1)
