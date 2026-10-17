import { beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { configureDatabaseDirectory } from '../src/main/localDatabase'
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tia-database-test-'))
  configureDatabaseDirectory(directory)
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
