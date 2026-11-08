(async () => {
  const invoke = (channel, ...args) => window.__TAURI_INTERNALS__.invoke('launcher_request', {channel, args})
  const test = await invoke('preview:nativeUpdateTest')
  await invoke('update:check').catch(() => {})
  let state
  for (let n = 0; n < 200; n++) {
    state = await invoke('update:get-state')
    if (state.versionStatus !== 'checking') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (state.available?.version !== test.version) throw new Error('Expected native update was not offered: ' + JSON.stringify(state))
  let rejected = false
  try { await invoke('update:start-download') } catch { rejected = true }
  state = await invoke('update:get-state')
  if (test.expect === 'reject') {
    await invoke('preview:nativeUpdateReport', {ok: rejected && !state.downloaded && !state.downloading, rejected, state})
    return
  }
  if (rejected || !state.downloaded) throw new Error('Valid signed native update was not verified: ' + JSON.stringify(state))
  await invoke('preview:nativeUpdateReport', {ok:true, stage: test.expect === 'install' ? 'verified-ready' : 'completed', state})
  if (test.expect === 'install') await invoke('update:quit-and-install')
})().catch(async error => {
  await window.__TAURI_INTERNALS__.invoke('launcher_request', {channel:'preview:nativeUpdateReport',args:[{ok:false,error:String(error)}]})
})
