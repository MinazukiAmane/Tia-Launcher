import { createPublicKey, verify } from 'node:crypto'
import trustedKeys from '../shared/manifestKeys.json'
import { DatabaseIntegrityError } from './databaseCipher'

export interface ManifestProof {
  keyId: string
  gameBiz: string
  signature: string
  body: string
}

const domain = 'Tia version manifest v1\0'
const publicKeys = new Map(trustedKeys.map(key => [key.id, createPublicKey(key.publicKey)]))
const verified = new Map<string, { gameBiz: string; body: string }>()

export function authenticateManifest(proof: ManifestProof, expectedGame: string): unknown {
  if (proof.gameBiz !== expectedGame || !publicKeys.has(proof.keyId)) throw new DatabaseIntegrityError()
  const identity = JSON.stringify([proof.keyId, proof.signature, proof.gameBiz])
  const cached = verified.get(identity)
  if (cached?.gameBiz !== expectedGame || cached?.body !== proof.body) {
    try {
      const signature = Buffer.from(proof.signature, 'base64')
      if (signature.length !== 64 || !verify(null, Buffer.from(domain + proof.gameBiz + '\0' + proof.body), publicKeys.get(proof.keyId)!, signature)) throw new DatabaseIntegrityError()
      if (verified.size >= 8) verified.delete(verified.keys().next().value!)
      verified.set(identity, { gameBiz: proof.gameBiz, body: proof.body })
    } catch { throw new DatabaseIntegrityError() }
  }
  return JSON.parse(proof.body) as unknown
}
