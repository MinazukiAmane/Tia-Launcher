import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { authenticateManifest } from '../../src/main/manifestTrust'
import { fetchVersionManifest } from '../../src/main/manifestVerify'
import { protectDatabase } from '../../src/main/localDatabase'
import { fixtureProof } from '../fixtures/manifestSigning'
vi.mock('../../src/shared/manifestKeys.json', async () => ({ default: [(await import('../fixtures/manifestSigning')).fixtureKey] }))
const manifest = { version: '1', files: [{ path: 'asset', md5: 'a'.repeat(32), size: 4 }] }

it('authenticates exact manifest bytes and rejects tampering, unknown keys, and another game', () => {
 const proof = fixtureProof(manifest)
 expect(authenticateManifest(proof, 'csore_global')).toEqual(manifest)
 expect(() => authenticateManifest({ ...proof, body: JSON.stringify({ ...manifest, files: [] }) }, 'csore_global')).toThrow()
 expect(() => authenticateManifest({ ...proof, keyId: 'unknown' }, 'csore_global')).toThrow()
 expect(() => authenticateManifest(proof, 'cedar_global')).toThrow()
 expect(() => authenticateManifest({ ...proof, signature: '' }, 'csore_global')).toThrow()
})

it('requires a pinned signature on protected installs without an additional network request', async () => {
 protectDatabase(randomBytes(32), true)
 const proof = fixtureProof(manifest)
 let requests = 0
 const server = createServer((req, res) => {
  requests++
  if (req.url === '/signed') {
   res.setHeader('X-Tia-Manifest-Key', proof.keyId)
   res.setHeader('X-Tia-Manifest-Signature', proof.signature)
   res.setHeader('X-Tia-Manifest-Game', proof.gameBiz)
  }
  res.end(proof.body)
 })
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
 try {
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No address')
  const base = `http://127.0.0.1:${address.port}`
  expect(await fetchVersionManifest(base + '/unsigned')).toBeNull()
  expect(await fetchVersionManifest(base + '/signed')).toEqual({ ...manifest, proof })
  expect(requests).toBe(2)
 } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
