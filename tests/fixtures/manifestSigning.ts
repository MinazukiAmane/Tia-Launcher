import { sign, createPrivateKey } from 'node:crypto'

// Test-only signing identity, never trusted by shipped builds.
export const fixtureKey = {
  "id": "7fc819ae34f4ea1f64521695ac9690efca3eee69e8d83d1d69a15f42a098829c",
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAYlRcAnuCZHogXKk2Kppl4TRndJ41AmY5WK55ROdNtro=\n-----END PUBLIC KEY-----\n"
}
const privateKey = createPrivateKey("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBrJWG5adHk+jBgFEVhBPtoi5og8TdFyNBOYKmzdSP/U\n-----END PRIVATE KEY-----\n")
export function fixtureProof(manifest: unknown, gameBiz = 'csore_global') {
  const body = JSON.stringify(manifest)
  return { keyId: fixtureKey.id, gameBiz, body, signature: sign(null, Buffer.from('Tia version manifest v1\0' + gameBiz + '\0' + body), privateKey).toString('base64') }
}
