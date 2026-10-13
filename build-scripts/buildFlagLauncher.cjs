// Rebuild the checked-in Windows helpers with Zig (tested with 0.16.0).
const { mkdirSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')
const root = join(__dirname, '..')
mkdirSync(join(root, 'build', 'native'), { recursive: true })
for (const [name, target] of [['x86', 'x86-windows-gnu'], ['x64', 'x86_64-windows-gnu']]) {
  const result = spawnSync('zig', ['cc', '-target', target, '-O2', '-s', '-municode', '-Wl,--subsystem,windows', join(root, 'native', 'flag-launch.c'), '-lshell32', '-o', join(root, 'build', 'native', `flag-launch-${name}.exe`)], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
