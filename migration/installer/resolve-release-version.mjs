import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveReleaseVersion(version, requested, ref, event) {
  if (!/^2\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version ?? '')) throw new Error('Build requires a stable native version in package.json')
  if (requested && requested !== version) throw new Error('Requested version does not match package.json')
  if (event === 'push') {
    if (ref !== `refs/tags/v${version}`) throw new Error('Publish tag must match the version in package.json')
  } else if (event !== 'workflow_dispatch') throw new Error('Build requires a version tag or manual dispatch')
  return version
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = JSON.parse(await readFile('package.json', 'utf8'))
  const version = resolveReleaseVersion(source.version, process.env.REQUESTED_VERSION, process.env.GITHUB_REF, process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch')
  if (process.env.GITHUB_ENV) await writeFile(process.env.GITHUB_ENV, `NATIVE_VERSION=${version}\n`, { flag: 'a' })
  console.log(`Verified launcher build version: ${version}`)
}
