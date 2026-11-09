import { createHash, createPublicKey, verify } from 'node:crypto'

export const MIGRATION_PLATFORMS = ['windows-x64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'] as const
export type MigrationPlatform = typeof MIGRATION_PLATFORMS[number]
export function migrationPlatform(platform: string, architecture: string): MigrationPlatform {
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform
  const value = `${name}-${architecture}`
  if (!MIGRATION_PLATFORMS.includes(value as MigrationPlatform)) throw new Error('This launcher migration is not available for your platform yet.')
  return value as MigrationPlatform
}

export interface MigrationRelease {
  protocol: 1
  appId: string
  bridgeVersion: string
  targetVersion: string
  platform: MigrationPlatform
  installerSha512: string
  helperSha256: string
}
export interface SignedMigrationRelease { body: string; signature: string; keyId: string }
export interface MigrationPublicKey { id: string; publicKey: string }
const DOMAIN = 'Tia launcher framework migration v1\0'

export function authenticateRelease(signed: SignedMigrationRelease, keys: MigrationPublicKey[], appId: string, bridgeVersion: string, targetVersion: string, platform: MigrationPlatform = 'windows-x64'): MigrationRelease {
  if (typeof signed?.body !== 'string' || Buffer.byteLength(signed.body) > 8192 || !/^[a-f0-9]{64}$/.test(signed.keyId) || !/^[A-Za-z0-9+/]{86}==$/.test(signed.signature)) throw new Error('The migration release could not be verified.')
  const pinned = keys.find(key => key.id === signed.keyId)
  if (!pinned) throw new Error('The migration release uses an unrecognized signing key.')
  const key = createPublicKey(pinned.publicKey)
  if (key.asymmetricKeyType !== 'ed25519' || createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') !== signed.keyId || !verify(null, Buffer.from(DOMAIN + signed.body), key, Buffer.from(signed.signature, 'base64'))) throw new Error('The migration release signature is invalid.')
  const release = JSON.parse(signed.body) as MigrationRelease
  if (release.protocol !== 1 || release.appId !== appId || release.bridgeVersion !== bridgeVersion || release.targetVersion !== targetVersion || !MIGRATION_PLATFORMS.includes(platform) || release.platform !== platform || !/^[A-Za-z0-9+/]{86}==$/.test(release.installerSha512) || !/^[a-f0-9]{64}$/.test(release.helperSha256)) throw new Error('This migration release does not match the installed launcher and downloaded update.')
  return release
}
