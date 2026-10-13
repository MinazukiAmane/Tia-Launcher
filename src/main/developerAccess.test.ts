import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeveloperAccess } from './developerAccess'
vi.mock('./developerHardware', () => ({ developerHardware: {} }))
const identity = { deviceId: 'a'.repeat(64), publicKey: 'public-device-key', provider: 'TPM 2.0' }
let now: number, calls: { operation: string; body: Record<string, unknown> }[], rejectAuthorization: boolean
const accessList: DeveloperAccess[] = []
function create(): { access: DeveloperAccess; sign: ReturnType<typeof vi.fn> } {
  const sign = vi.fn(async (_message: Buffer) => Buffer.from('hardware proof'))
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const operation = String(input).split('/').pop()!
    const body = JSON.parse(init!.body as string)
    calls.push({ operation, body })
    let response: object, status = 200
    if (operation === 'challenge') response = { challengeId: 'n'.repeat(43), nonce: 'r'.repeat(43), purpose: body.purpose, deviceId: identity.deviceId, expiresAt: now + 60_000 }
    else if (operation === 'unlock') { response = body.code === 'correct-code' ? { unlocked: true, expiresAt: now + 30 * 60_000 } : { error: 'Rejected' }; if (body.code !== 'correct-code') status = 401 }
    else if (rejectAuthorization) { response = { error: 'Revoked' }; status = 401 }
    else response = { authorized: true, expiresAt: now + 30 * 60_000 }
    return new Response(JSON.stringify(response), { status })
  }) as unknown as typeof fetch
  const access = new DeveloperAccess({ identity: async () => identity, sign }, transport, () => now)
  accessList.push(access); return { access, sign }
}
beforeEach(() => { now = 1_800_000_000_000; calls = []; rejectAuthorization = false })
afterEach(() => { for (const access of accessList.splice(0)) access.lock() })
describe('hardware developer authorization', () => {
  it('starts locked and cannot disable checks before verification', async () => {
    const { access, sign } = create()
    expect(await access.useBypass()).toBe(false)
    await expect(access.setApiChecks(false)).rejects.toThrow(/Verify/)
    expect(sign).not.toHaveBeenCalled(); expect(calls).toEqual([])
  })
  it('uses hardware proof, enables the option only after code verification, and requests a fresh proof for each bypass', async () => {
    const { access, sign } = create()
    await access.unlock('correct-code')
    expect(access.state()).toMatchObject({ unlocked: true, checkApi: true })
    expect(await access.useBypass()).toBe(false)
    await access.setApiChecks(false)
    expect(await access.useBypass()).toBe(true)
    expect(await access.useBypass()).toBe(true)
    expect(calls.filter(call => call.operation === 'authorize')).toHaveLength(3)
    expect(sign).toHaveBeenCalledTimes(4)
    for (const [message] of sign.mock.calls) expect((message as unknown as Buffer).toString()).toMatch(/^tia-launcher-dev\/v1\n(unlock|authorize)\n/)
    expect(calls.filter(call => call.operation !== 'unlock').every(call => !('code' in call.body))).toBe(true)
    const restarted = create().access
    expect(restarted.state()).toMatchObject({ unlocked: false, checkApi: true })
  })
  it('rejects wrong codes without revealing controls', async () => {
    const { access } = create()
    await expect(access.unlock('wrong-code')).rejects.toThrow('Rejected')
    expect(access.state()).toMatchObject({ unlocked: false, checkApi: true })
  })
  it('locks again when authorization expires or is revoked by the server', async () => {
    const { access } = create()
    await access.unlock('correct-code'); await access.setApiChecks(false)
    rejectAuthorization = true
    expect(await access.useBypass()).toBe(false)
    expect(access.state()).toMatchObject({ unlocked: false, checkApi: true })
    rejectAuthorization = false; await access.unlock('correct-code'); await access.setApiChecks(false)
    now += 30 * 60_000
    expect(await access.useBypass()).toBe(false)
    expect(access.state()).toMatchObject({ unlocked: false, checkApi: true })
  })
  it('refuses hardware absence rather than falling back to a software key', async () => {
    const sign = vi.fn()
    const access = new DeveloperAccess({ identity: async () => { throw new Error('No hardware') }, sign }, vi.fn())
    accessList.push(access)
    await expect(access.unlock('correct-code')).rejects.toThrow('No hardware')
    expect(sign).not.toHaveBeenCalled(); expect(access.state().unlocked).toBe(false)
  })
})
