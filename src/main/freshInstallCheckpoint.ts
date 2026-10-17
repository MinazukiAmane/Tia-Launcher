import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { rm } from 'fs/promises'
import { readGameRecord, writeRecords, readRecord, gameScope } from './localDatabase'
import { join } from 'path'
import type { VersionBlock } from './launcherApi'
import type { InstalledFileEntry } from './installState'
import { resolveWithinRoot } from './pathSafety'

const FILENAME = '.csore_fresh_game.json'

function packageKey(target: VersionBlock): string {
  // URLs may expire/change without changing the package content.
  return JSON.stringify([target.version, target.game_pkgs.map((p) => [p.md5, p.size])])
}

export async function readFreshGameCheckpoint(
  installDir: string,
  target: VersionBlock
): Promise<InstalledFileEntry[] | null> {
  const stored = await readGameRecord<{ packageKey: string; files: InstalledFileEntry[] }>(installDir, 'checkpoint')
  try {
    const checkpoint = stored
    if (!checkpoint) return null
    if (checkpoint.packageKey !== packageKey(target) || !Array.isArray(checkpoint.files)) return null
    // A checkpoint is usable only while every extracted game file still matches.
    for (const file of checkpoint.files) {
      if (typeof file.path !== 'string' || typeof file.md5 !== 'string') return null
      const filePath = resolveWithinRoot(installDir, file.path, 'checkpoint file', (reason) => {
        throw new Error(reason)
      })
      const hash = createHash('md5')
      for await (const chunk of createReadStream(filePath)) hash.update(chunk)
      if (hash.digest('hex') !== file.md5) return null
    }
    return checkpoint.files as InstalledFileEntry[]
  } catch {
    // Missing, interrupted, or damaged checkpoint: redo the game phase.
    return null
  }
}

export async function writeFreshGameCheckpoint(
  installDir: string,
  target: VersionBlock,
  files: InstalledFileEntry[]
): Promise<void> {
  writeRecords(gameScope(installDir), { checkpoint: { packageKey: packageKey(target), files } })
}

export async function clearFreshGameCheckpoint(installDir: string): Promise<void> {
  writeRecords(gameScope(installDir), { checkpoint: null })
  await rm(join(installDir, FILENAME), { force: true })
  await rm(join(installDir, `${FILENAME}.tmp`), { force: true })
}

export function hasFreshGameCheckpoint(installDir: string): boolean {
  return !!readRecord(gameScope(installDir), 'checkpoint')
}
