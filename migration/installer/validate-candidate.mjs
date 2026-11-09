import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

const id = process.argv[2], repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN
if (!/^[1-9]\d*$/.test(id ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !token) throw new Error('Candidate ID and authenticated repository context are required.')
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30_000)})
  if (!response.ok) throw new Error(`GitHub candidate validation failed: HTTP ${response.status}`)
  return response.json()
}
const run = await api(`actions/runs/${id}`)
if (run.event!=='workflow_dispatch' || run.status!=='completed' || !['success','failure'].includes(run.conclusion) || run.path.split('@')[0]!=='.github/workflows/native-release.yml' || run.head_repository?.full_name!==repository || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('Only a completed release candidate from this repository can be promoted.')
const required = ['build (ubuntu-24.04)','build (windows-latest)','build (macos-latest)','checks / nixos',...['ubuntu-24.04','windows-latest','macos-latest'].map(os=>`checks / migration (${os})`)]
const jobs = (await api(`actions/runs/${id}/jobs?filter=all&per_page=100`)).jobs
for (const name of required) {
  const latest = jobs.filter(job=>job.name===name).sort((a,b)=>b.id-a.id)[0]
  if (!latest || latest.conclusion!=='success') throw new Error(`Candidate platform verification has not passed: ${name}`)
}
const git = (...args)=>execFileSync('git',args,{encoding:'utf8'}).trim()
const allowed = new Set([
  '.github/workflows/native-release.yml','.github/workflows/promote-native.yml','.github/workflows/migration-check.yml',
  'migration/installer/validate-candidate.mjs','migration/installer/publish-release.py','migration/installer/publisher-requirements.txt',
  'migration/installer/merge-artifacts.mjs','migration/installer/release-layout.mjs',
  'migration/installer/download-candidate.mjs','migration/installer/extract-artifact.py'
])
const changes = git('diff','--name-only',run.head_sha,'HEAD').split('\n').filter(Boolean)
for (const path of changes) {
  if (!allowed.has(path) && !path.startsWith('tests/') && !path.startsWith('src-tauri/tests/') && !/^migration\/windows\/validate-native-[\w-]+\.ps1$/.test(path)) throw new Error(`Launcher source changed after the candidate was built; build a new candidate: ${path}`)
}
const before = git('show',`${run.head_sha}:.github/workflows/native-release.yml`)
const after = await readFile('.github/workflows/native-release.yml','utf8')
const buildDefinition = source=>source.match(/^  build:\n[\s\S]*?(?=^  assemble:)/m)?.[0]
if (!buildDefinition(before) || buildDefinition(before)!==buildDefinition(after)) throw new Error('The native build configuration changed; build a new candidate.')
const artifacts = (await api(`actions/runs/${id}/artifacts?per_page=100`)).artifacts
for (const name of ['release-Linux','release-Windows','release-macOS']) {
  if (artifacts.filter(artifact=>artifact.name===name&&!artifact.expired&&artifact.size_in_bytes>0).length!==1) throw new Error(`Missing immutable platform artifact: ${name}`)
}
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,`source-sha=${run.head_sha}\n`,{flag:'a'})
console.log(`Candidate ${id}: all seven platform/build jobs passed; launcher source and build configuration match ${run.head_sha}.`)
