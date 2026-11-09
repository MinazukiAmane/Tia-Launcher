import { invoke, convertFileSrc } from '@tauri-apps/api/core'

export async function resolveVideoSource(path: string): Promise<string> {
  const source = await invoke<string>('launcher_request', { channel: 'launcher:videoSource', args: [path] })
  return source.startsWith('/assets/') || source.startsWith('http://127.0.0.1:') ? source : convertFileSrc(source)
}
