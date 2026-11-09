import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NativeBridge } from '../../migration/electron/nativeBridge'
export const helper = resolve(`src-tauri/target/debug/tia-migration-helper${process.platform === 'win32' ? '.exe' : ''}`)
export const native = new NativeBridge(helper, createHash('sha256').update(readFileSync(helper)).digest('hex'))
export function startMigratedAppImage(path: string, args: string[] = [], environment = process.env, timeoutMs = 90000): Promise<{ pid: number }> {
  return native.start(path, { args, environment, timeoutMs })
}
