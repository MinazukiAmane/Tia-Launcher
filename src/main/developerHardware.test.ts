import { expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign, verify } from 'crypto'
import { ecdsaRawToDer } from './developerHardware'
vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))
it('converts Windows TPM raw ECDSA signatures to DER without changing their proof', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const message = Buffer.from('tia-launcher-dev/v1\nauthorize\nfixture')
  for (let i = 0; i < 30; i++) {
    const raw = sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    expect(verify('sha256', message, publicKey, ecdsaRawToDer(raw))).toBe(true)
    expect(verify('sha256', Buffer.from('altered'), publicKey, ecdsaRawToDer(raw))).toBe(false)
  }
  expect(() => ecdsaRawToDer(Buffer.alloc(63))).toThrow()
})
