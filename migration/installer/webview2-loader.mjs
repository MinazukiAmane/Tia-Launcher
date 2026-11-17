import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readdir,stat} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
const execute=promisify(execFile)
async function cargoMetadata(){
 const {stdout}=await execute('cargo',['metadata','--locked','--offline','--format-version','1','--filter-platform','x86_64-pc-windows-msvc','--manifest-path',resolve(import.meta.dirname,'../../src-tauri/Cargo.toml')],{maxBuffer:16*1024*1024})
 return JSON.parse(stdout)
}
async function isFile(path){try{return(await stat(path)).isFile()}catch{return false}}
export async function findWebViewLoader(directory,{metadata=cargoMetadata}={}){
 const direct=join(directory,'WebView2Loader.dll')
 if(await isFile(direct))return direct
 const entries=await readdir(join(directory,'build')).catch(error=>{if(error.code==='ENOENT')return[];throw error})
 for(const name of entries){
  if(!name.startsWith('webview2-com-sys-'))continue
  const path=join(directory,'build',name,'out/x64/WebView2Loader.dll')
  if(await isFile(path))return path
 }
 // Cargo caches may omit DLL outputs; use the exact resolved crate's SDK copy.
 const graph=await metadata()
 const resolved=new Set(graph.resolve?.nodes.map(node=>node.id)??[])
 const packages=graph.packages.filter(pkg=>pkg.name==='webview2-com-sys'&&resolved.has(pkg.id))
 if(packages.length===1){
  const path=join(dirname(packages[0].manifest_path),'x64/WebView2Loader.dll')
  if(await isFile(path))return path
 }
 throw new Error('WebView2Loader.dll is missing from both the Windows build and its resolved Cargo SDK.')
}
