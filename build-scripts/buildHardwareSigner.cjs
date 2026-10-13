const { existsSync, mkdirSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')
const root = join(__dirname, '..'), output = join(root, 'build', 'hardware')
mkdirSync(output, { recursive: true })
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (process.argv.includes('--rebuild-windows')) {
  run('zig', ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-s', join(root, 'native/dev-signer-windows.c'), '-lncrypt', '-lbcrypt', '-o', join(output, 'dev-signer-win-x64.exe')])
}
if (!existsSync(join(output, 'dev-signer-win-x64.exe'))) throw new Error('Missing checked-in hardware signer. Rebuild with --rebuild-windows.')
if (process.platform === 'darwin') {
  run('xcrun', ['clang', '-O2', '-Wall', '-Wextra', join(root, 'native/dev-signer-macos.c'), '-framework', 'Security', '-framework', 'CoreFoundation', '-o', join(output, 'dev-signer-macos')])
}
