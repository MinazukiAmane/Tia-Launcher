
import { app } from 'electron'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const LOG_DIR_NAME = 'logs'
const LOG_FILE_NAME = 'launcher.log'

let troubleshootingModeEnabled = false

export function setTroubleshootingMode(enabled: boolean): void {
  troubleshootingModeEnabled = enabled
}

export function isTroubleshootingModeEnabled(): boolean {
  return troubleshootingModeEnabled
}

export function logFilePath(): string {
  return join(app.getPath('userData'), LOG_DIR_NAME, LOG_FILE_NAME)
}

const truncatedPaths = new Set<string>()

function ensureFreshLogFile(path: string): void {
  if (truncatedPaths.has(path)) return
  truncatedPaths.add(path)
  try {
    mkdirSync(dirname(path), { recursive: true })

    writeFileSync(path, '', 'utf-8')
  } catch {
  }
}

function writeLine(level: 'INFO' | 'ERROR' | 'DEBUG', message: string, meta?: Record<string, unknown>): void {
  const path = logFilePath()
  ensureFreshLogFile(path)
  const metaSuffix = meta ? ` ${JSON.stringify(meta)}` : ''
  const line = `${new Date().toISOString()} [${level}] ${message}${metaSuffix}\n`
  try {
    appendFileSync(path, line, 'utf-8')
  } catch {
    // Best-effort, see ensureFreshLogFile's comment above.
  }
}

export function logInfo(message: string, meta?: Record<string, unknown>): void {
  writeLine('INFO', message, meta)
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  writeLine('ERROR', message, meta)
}

export function logDebug(message: string, meta?: Record<string, unknown>): void {
  if (!troubleshootingModeEnabled) return
  writeLine('DEBUG', message, meta)
}
