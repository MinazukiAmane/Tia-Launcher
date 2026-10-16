const { existsSync, mkdirSync } = require('fs')
const { join, resolve } = require('path')
const { spawnSync } = require('child_process')
const root = join(__dirname, '..')
const helper = resolve(process.env.TIA_HELPER_SOURCE || join(root, '.private-helper'))
const source = join(helper, 'native', 'flag-launch.c')
if (!existsSync(source)) throw new Error('Private helper source missing. Clone Tia-Launcher-Helpers into .private-helper or set TIA_HELPER_SOURCE.')
mkdirSync(join(root, 'build', 'native'), { recursive: true })
for (const [name, target] of [['x86', 'x86-windows-gnu'], ['x64', 'x86_64-windows-gnu']]) {
  const result = spawnSync('zig', ['cc', '-target', target, '-O2', '-s', '-municode', '-Wl,--subsystem,windows', source, '-lshell32', '-o', join(root, 'build', 'native', `flag-launch-${name}.exe`)], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
