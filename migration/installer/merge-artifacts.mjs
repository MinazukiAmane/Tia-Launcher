import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2])
const combined = {native:[],migration:[],bridge:[],downloads:[]}
const expected = ['artifacts-darwin.json','artifacts-linux.json','artifacts-win32.json']
const found = (await readdir(directory)).filter(name=>name.startsWith('artifacts-')&&name.endsWith('.json')).sort()
if (JSON.stringify(found)!==JSON.stringify(expected)) throw new Error('All three platform builds are required before publishing.')
for (const name of expected) {
  const definition = JSON.parse(await readFile(join(directory,name),'utf8'))
  for (const key of Object.keys(combined)) {
    if (!Array.isArray(definition[key])) throw new Error('Invalid platform release manifest.')
    combined[key].push(...definition[key])
  }
}
await writeFile(join(directory,'release-artifacts.json'),JSON.stringify(combined,null,2)+'\n')
