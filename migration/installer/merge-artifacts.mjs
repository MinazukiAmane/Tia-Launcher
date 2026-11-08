import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2])
const combined = {native:[],migration:[],bridge:[],downloads:[]}
const expected = ['artifacts-darwin.json','artifacts-linux.json','artifacts-win32.json']
const found = (await readdir(directory)).filter(name=>name.startsWith('artifacts-')&&name.endsWith('.json')).sort()
if (JSON.stringify(found)!==JSON.stringify(expected)) throw new Error('All three platform builds are required before publishing.')
for (const name of expected) {
  const definition = JSON.parse(await readFile(join(directory,name),'utf8'))
  const metadata = definition.metadata
  if (!metadata || !/^[a-f0-9]{40}$/.test(metadata.commit) || !Number.isFinite(Date.parse(metadata.releaseDate))) throw new Error('Missing release build provenance.')
  if (combined.metadata && JSON.stringify(combined.metadata)!==JSON.stringify(metadata)) throw new Error('Platform artifacts came from different versions or source commits.')
  combined.metadata = metadata
  for (const key of ['native','migration','bridge','downloads']) {
    if (!Array.isArray(definition[key])) throw new Error('Invalid platform release manifest.')
    combined[key].push(...definition[key])
  }
}
await writeFile(join(directory,'release-artifacts.json'),JSON.stringify(combined,null,2)+'\n')
