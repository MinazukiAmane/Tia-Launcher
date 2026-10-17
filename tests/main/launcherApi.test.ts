
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { fetchLauncherInfo } from '../../src/main/launcherApi'

let server: Server
let baseUrl: string

const SAMPLE_RESPONSE = {
  retcode: 0,
  message: 'OK',
  data: {
    game_packages: [
      {
        game: { id: 'abc', biz: 'csore_global' },
        main: {
          major: { version: '0.1.51', game_pkgs: [{ url: 'http://x/1', md5: 'a', size: '100', decompressed_size: '200' }], res_list_url: '' },
          patches: [],
          required_client_version: ''
        }
      }
    ]
  }
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(SAMPLE_RESPONSE))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => server.close())

describe('fetchLauncherInfo', () => {
  it('returns the first game_packages entry on retcode 0', async () => {
    const entry = await fetchLauncherInfo(baseUrl, 'csore_global')
    expect(entry.game.biz).toBe('csore_global')
    expect(entry.main.major?.version).toBe('0.1.51')
  })
})
