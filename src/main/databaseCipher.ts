import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const prefix = 'tia:gcm:1:'

export class DatabaseIntegrityError extends Error {
  constructor() {
    super('Saved launcher data could not be verified. Restore your launcher data backup or contact support. Your game files have not been changed.')
    this.name = 'DatabaseIntegrityError'
  }
}

export class DatabaseCipher {
  private readonly decoded = new Map<string, { raw: string; plain: string }>()

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new DatabaseIntegrityError()
  }

  seal(scope: string, name: string, plain: string): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(JSON.stringify([scope, name])))
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64')
  }

  open(scope: string, name: string, raw: string): string {
    const id = JSON.stringify([scope, name])
    const hit = this.decoded.get(id)
    if (hit?.raw === raw) return hit.plain
    try {
      if (!raw.startsWith(prefix)) throw new DatabaseIntegrityError()
      const data = Buffer.from(raw.slice(prefix.length), 'base64')
      if (data.length < 28) throw new DatabaseIntegrityError()
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12))
      decipher.setAAD(Buffer.from(id))
      decipher.setAuthTag(data.subarray(12, 28))
      const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
      if (this.decoded.size >= 32) this.decoded.delete(this.decoded.keys().next().value!)
      this.decoded.set(id, { raw, plain })
      return plain
    } catch { throw new DatabaseIntegrityError() }
  }

  isSealed(raw: string): boolean { return raw.startsWith(prefix) }
}
