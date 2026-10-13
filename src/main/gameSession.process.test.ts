import { it, expect, vi } from 'vitest'
import { spawn } from 'child_process'
import { once } from 'events'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { isGameProcessRunning } from './gameSession'

vi.mock('./logger', () => ({ logError: vi.fn() }))

it.skipIf(process.platform !== 'linux')('observes an actual game process and detects its exit, without confusing another installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csore-process-'))
  const target = join(dir, 'fixture-client.exe')
  // argv[0] simulates Wine exposing the Windows executable in /proc.
  const child = spawn('/bin/bash', ['-c', 'exec -a "$1" /usr/bin/sleep 30', 'fixture', target], { cwd: dir, stdio: 'ignore' })
  try {
    await once(child, 'spawn')
    let found = false
    for (let attempt = 0; attempt < 20 && !found; attempt++) {
      found = await isGameProcessRunning(target)
      if (!found) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(found).toBe(true)
    expect(await isGameProcessRunning(join(dir, 'other-install', 'fixture-client.exe'))).toBe(false)
    const exited = once(child, 'exit')
    child.kill()
    await exited
    expect(await isGameProcessRunning(target)).toBe(false)
  } finally {
    child.kill()
    await rm(dir, { recursive: true, force: true })
  }
})
