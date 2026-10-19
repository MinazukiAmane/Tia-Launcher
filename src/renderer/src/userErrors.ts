export type ErrorAction = 'install' | 'launch' | 'verify' | 'repair' | 'move' | 'folder' | 'background' | 'settings' | 'storage' | 'uninstall' | 'runtime' | 'update' | 'cache' | 'logs' | 'general'

const messages = {
  aborted: 'The operation stopped before it finished. Try again.',
  timeout: 'The connection took too long. Check your internet connection, then try again.',
  network: 'Could not connect. Check your internet connection, then try again.',
  service: 'The service is temporarily unavailable. Try again later.',
  unavailable: 'This download is not available right now. Try again later or contact support.',
  space: 'There is not enough free space. Free up space on the installation drive, then try again.',
  locked: 'Some files are being used by another app. Close the game and any apps using its folder, then try again.',
  permission: 'The launcher cannot save files in this folder. Choose a folder you can write to, then try again.',
  disk: 'Some files could not be saved. Check free space and folder access, then try again.',
  busy: 'Another task is still running. Wait for it to finish, then try again.',
  running: 'Close the game first, then try again.',
  launcherUpdate: 'Update the launcher to continue.',
  gameUpdate: 'Update the game first, then try repairing it again.',
  files: 'Some game files are missing or damaged. Repair the game in Game Settings, then try Play again.',
  download: 'Some downloaded files are incomplete or damaged. Try downloading again.',
  repairUnavailable: 'File repair is temporarily unavailable. Try again later or contact support.',
  notInstalled: 'Choose the folder where your game is installed, or install the game first.',
  nonempty: 'Choose an empty destination folder so your other files stay safe.',
  nested: 'Choose a different folder outside the current game folder.',
  root: 'Choose a game folder instead of an entire drive.',
  background: 'Choose a PNG, JPG, WEBP or GIF image up to 25 MB.',
  storage: 'Your saved launcher data needs attention. Restart the launcher. If it keeps happening, contact support before reinstalling.',
  clientStart: 'The game could not start. Repair its files in Game Settings, then try Play again. If it continues, contact support.',
  launch: 'The game could not start. Close any running game, then try again. If it continues, share the launcher log with support.',
  component: 'The game needs an additional component before it can run. Contact support for setup help.',
  mac: 'Complete the macOS game setup in Game Settings, then try again.',
  command: 'The launch options could not be used. Check Launch Command in Game Settings, then try again.',
  archive: 'The download could not be installed safely. Try again. If it happens again, contact support.',
  install: 'The installation could not finish. Try again. If it keeps happening, open Launcher Logs in Launcher Settings and share the log with support.',
  verify: 'The files could not be checked. Close the game, then try again.',
  repair: 'The repair could not finish. Try again. If it keeps happening, share the launcher log with support.',
  move: 'The game could not be moved. Close the game and choose an empty destination folder, then try again.',
  folder: 'This folder cannot be used. Choose another folder and try again.',
  settings: 'The settings could not be saved or loaded. Close and reopen the launcher, then try again.',
  update: 'The launcher update could not finish. Try again. If it keeps happening, contact support.',
  uninstall: "Removal could not finish. Close the game and try again, or use your system's app manager.",
  runtime: 'The game components could not be set up. Try again. If it keeps happening, contact support.',
  cache: 'The download cache could not be cleared. Wait for any downloads to finish, then try again.',
  logs: 'The folder could not be opened. Try again or contact support.',
  general: 'Something went wrong. Try again. If it keeps happening, share the launcher log with support.'
} as const

function errorDetails(error: unknown, depth = 0): string {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object' || depth > 2) return ''
  const detail = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
  return [detail.name, detail.code, detail.message].filter(value => typeof value === 'string').join(' ') + ' ' + errorDetails(detail.cause, depth + 1)
}

// Return a translation key; never expose exception text, paths, URLs, or stack traces.
export function userError(error: unknown, action: ErrorAction = 'general'): string {
  const detail = errorDetails(error)
  if (/database.*(?:newer|requires)|latest launcher|launcher update.*required|update.*launcher.*before/i.test(detail)) return messages.launcherUpdate
  if (/\bENOSPC\b|not enough (?:free )?(?:space|disk)|no space left/i.test(detail)) return messages.space
  if (/\bEBUSY\b|resource busy|sharing violation|file.*(?:locked|in use)/i.test(detail)) return messages.locked
  if (/\b(?:EACCES|EPERM|EROFS)\b|not writable|unwritable|permission denied|read.only/i.test(detail)) return messages.permission
  if (/\b(?:EIO|UNKNOWN)\b.*(?:open|write|read|access download file)|disk.*error/i.test(detail)) return messages.disk
  if (/database|sqlite|invalid saved|saved.*metadata/i.test(detail)) return messages.storage
  if (/another operation|current operation|another task|operation.*in progress/i.test(detail)) return messages.busy
  if (/close the game|game.*already running/i.test(detail)) return messages.running
  if (/entire drive|filesystem root/i.test(detail)) return messages.root
  if (/empty folder|unrelated files|destination.*not empty/i.test(detail)) return messages.nonempty
  if (/outside the current installation|nested destination|same.*folder/i.test(detail)) return messages.nested
  if (/background.*too large|unsupported image type|choose a background file/i.test(detail)) return messages.background
  if (/per.file repair.*not available|regenerate.*manifest/i.test(detail)) return messages.repairUnavailable
  if (/update the game before repairing/i.test(detail)) return messages.gameUpdate
  if (/no install found|no installed game|not an approved install directory/i.test(detail)) return messages.notInstalled
  if (/game executable not found|executable not found.*cstrike|ENOENT.*cstrike-online/i.test(detail)) return messages.files
  if (/flags initialization|exported flags|client flags|client export table|initialize game launch|client was not confirmed ready|error:.*(?:client|flags|remote image)/i.test(detail)) return messages.clientStart
  if (/umu.launcher.*not installed|umu.run.*not found/i.test(detail)) return messages.component
  if (/container runtime|steamrt.*validation failed/i.test(detail)) return messages.runtime
  if (/Sikarugir|wrapper.*(?:not found|not initialized)|prefix not initialized/i.test(detail)) return messages.mac
  if (/launch command|unsupported quote|control character.*argument/i.test(detail)) return messages.command
  if (/unsafe zip|outside.*root|directory traversal|repair directory escapes/i.test(detail)) return messages.archive
  if (/MD5|SHA(?:256|512)|checksum|digest mismatch|exceeded declared size/i.test(detail)) return messages.download
  if (/HTTP\s+(?:5\d\d|429)|service.*(?:unavailable|maintenance)|no published main version|invalid (?:JSON|response|repair metadata)/i.test(detail)) return messages.service
  if (/HTTP\s+(?:401|403|404|410)/i.test(detail)) return messages.unavailable
  // A launch readiness timeout is different from a connection timeout.
  if (action === 'launch' && /timed?\s*out|timeout/i.test(detail)) return messages.launch
  if (/timed?\s*out|timeout|\bETIMEDOUT\b|download stalled/i.test(detail)) return messages.timeout
  if (/AbortError|operation was aborted|operation.*cancel(?:led|ed)|uninstall canceled/i.test(detail)) return messages.aborted
  if (/fetch failed|failed to fetch|NetworkError|ECONN|ENOTFOUND|EAI_AGAIN|network.*(?:error|unreachable)|certificate|TLS/i.test(detail)) return messages.network
  return messages[action]
}
