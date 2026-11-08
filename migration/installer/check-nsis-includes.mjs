import windowsTools from 'app-builder-lib/out/toolsets/windows.js'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname,'../..')
await mkdir(join(root,'release-test'),{recursive:true})
const directory = await mkdtemp(join(root,'release-test/nsis include check '))
const escape = value=>value.replaceAll('$','$$').replaceAll('"','$\\"')
try {
  const script = join(directory,'probe.nsi')
  await writeFile(script,`Name "Tia NSIS include check"\nOutFile "${escape(join(directory,'probe.exe'))}"\n!include "${escape(join(root,'build-scripts/install-scope.nsh'))}"\nSection\nDetailPrint "Include checks passed"\nSectionEnd\n`)
  const tool = await windowsTools.getMakeNsisPath(undefined,undefined)
  execFileSync(tool.path,process.platform==='win32'?['/V2',script]:['-V2',script],{stdio:'inherit',env:{...process.env,...tool.env}})
  console.log('Native NSIS compiler resolved the installation and WebView2 includes.')
} finally { await rm(directory,{recursive:true,force:true}) }
