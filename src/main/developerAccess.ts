import { developerHardware, type HardwareIdentity, type HardwareSigner } from './developerHardware'
const API_BASE = 'https://tia-launcher.serenetia.com/api/dev'
const MAX_SESSION_MS = 30 * 60_000
export interface DeveloperState { unlocked: boolean; checkApi: boolean; expiresAt: number | null }
type Purpose = 'unlock' | 'authorize'
export class DeveloperAccess {
  private value: DeveloperState = { unlocked: false, checkApi: true, expiresAt: null }
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private pendingUnlock = false
  private authorization: Promise<boolean> | null = null
  onChange: (value: DeveloperState) => void = () => {}
  constructor(private hardware: HardwareSigner = developerHardware, private transport: typeof fetch = (input, init) => fetch(input, init), private now: () => number = Date.now) {}
  state(): DeveloperState {
    if (this.value.expiresAt !== null && this.value.expiresAt <= this.now()) this.lock()
    return { ...this.value }
  }
  lock(): DeveloperState {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.value = { unlocked: false, checkApi: true, expiresAt: null }
    this.onChange({ ...this.value })
    return { ...this.value }
  }
  private lease(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= this.now() || value > this.now() + MAX_SESSION_MS + 5_000) throw new Error('Invalid developer authorization expiry.')
    return value
  }
  private async request(operation: string, body: object): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await this.transport(API_BASE + '/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    } catch { throw new Error('Could not contact the developer verification server.') }
    let data: Record<string, unknown>
    try { data = await response.json() as Record<string, unknown> } catch { throw new Error('Invalid developer verification response.') }
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error.slice(0, 250) : 'Developer verification failed.')
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid developer verification response.')
    return data
  }
  private async proof(purpose: Purpose): Promise<{ challengeId: string; signature: string }> {
    const identity: HardwareIdentity = await this.hardware.identity()
    const response = await this.request('challenge', { purpose, publicKey: identity.publicKey })
    if (typeof response.challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.challengeId) || typeof response.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(response.nonce) || response.purpose !== purpose || response.deviceId !== identity.deviceId || typeof response.expiresAt !== 'number' || !Number.isSafeInteger(response.expiresAt) || response.expiresAt <= this.now() || response.expiresAt > this.now() + 90_000) throw new Error('Invalid hardware challenge.')
    const message = ['tia-launcher-dev/v1', purpose, response.challengeId, identity.deviceId, response.nonce, String(response.expiresAt)].join('\n')
    const signature = await this.hardware.sign(Buffer.from(message))
    return { challengeId: response.challengeId, signature: signature.toString('base64') }
  }
  async unlock(code: string): Promise<DeveloperState> {
    if (typeof code !== 'string' || !code.length || Buffer.byteLength(code) > 128) throw new Error('Enter a valid developer code.')
    if (this.pendingUnlock) throw new Error('Developer verification is already in progress.')
    this.pendingUnlock = true
    const generation = this.generation
    try {
      const proof = await this.proof('unlock')
      const response = await this.request('unlock', { ...proof, code })
      if (response.unlocked !== true) throw new Error('Developer verification failed.')
      const expiresAt = this.lease(response.expiresAt)
      if (generation !== this.generation) throw new Error('Developer verification canceled.')
      this.value = { unlocked: true, checkApi: true, expiresAt }
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.lock(), expiresAt - this.now()); this.timer.unref()
      this.onChange(this.state())
      return this.state()
    } finally { code = ''; this.pendingUnlock = false }
  }
  private async authorize(): Promise<boolean> {
    if (!this.state().unlocked) return false
    if (this.authorization) return this.authorization
    const generation = this.generation
    this.authorization = (async () => {
      try {
        const proof = await this.proof('authorize')
        const response = await this.request('authorize', proof)
        if (response.authorized !== true) throw new Error('Developer authorization rejected.')
        const expiresAt = this.lease(response.expiresAt)
        if (generation !== this.generation || !this.state().unlocked) return false
        this.value.expiresAt = Math.min(this.value.expiresAt!, expiresAt)
        return true
      } catch { if (generation === this.generation) this.lock(); return false }
    })().finally(() => { this.authorization = null })
    return this.authorization
  }
  async setApiChecks(enabled: boolean): Promise<DeveloperState> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid developer setting.')
    if (!enabled && (!this.state().unlocked || !(await this.authorize()))) throw new Error('Verify your developer code and hardware device first.')
    this.value.checkApi = enabled
    this.onChange(this.state())
    return this.state()
  }
  async useBypass(): Promise<boolean> {
    const state = this.state()
    if (!state.unlocked || state.checkApi) return false
    return await this.authorize() && this.state().unlocked && !this.value.checkApi
  }
}
export const developerAccess = new DeveloperAccess()
