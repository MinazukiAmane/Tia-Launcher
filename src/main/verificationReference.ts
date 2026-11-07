import { DatabaseIntegrityError } from './databaseCipher'
import { activeGame } from './activeGame'
import { authenticateManifest } from './manifestTrust'
import { databaseIsProtected, gameScope, readRecord, writeRecords } from './localDatabase'
import type { VersionManifest } from './manifestVerify'
import type { InstallState } from './installState'

export function verificationReference(installDir: string, state: InstallState, remote: VersionManifest | null): {
  version?: string; files: { path: string; md5: string; size?: number }[]
} {
  if (!databaseIsProtected()) return remote?.version === state.version ? remote : { files: state.files }
  const scope = gameScope(installDir)
  if (remote?.version === state.version) {
    if (!remote.proof) throw new Error('The game verification service needs an update. Try again later or contact support.')
    const authenticated = authenticateManifest(remote.proof, activeGame().biz) as VersionManifest
    if (authenticated.version !== state.version) throw new DatabaseIntegrityError()
    const trusted = { ...authenticated, proof: remote.proof }
    writeRecords(scope, { trustedManifest: trusted }, undefined, false)
    return trusted
  }
  const saved = readRecord<VersionManifest>(scope, 'trustedManifest')
  if (saved?.version === state.version && saved.proof) {
    const authenticated = authenticateManifest(saved.proof, activeGame().biz) as VersionManifest
    if (authenticated.version === state.version) return authenticated
  }
  throw new Error('Connect to the internet once to confirm this installation. After that, you can play while the update service is unavailable.')
}
