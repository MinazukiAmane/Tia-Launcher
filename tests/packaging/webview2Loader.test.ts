import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
// @ts-expect-error Packaging modules run directly in Node.
import {findWebViewLoader} from '../../migration/installer/webview2-loader.mjs'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'tia-loader-'));roots.push(root);return root}
async function file(path:string){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,'SDK fixture');return path}
it('uses the adjacent loader without invoking Cargo',async()=>{
 const root=await fixture(),path=await file(join(root,'WebView2Loader.dll')),metadata=vi.fn()
 expect(await findWebViewLoader(root,{metadata})).toBe(path);expect(metadata).not.toHaveBeenCalled()
})
it('finds fresh Cargo build outputs',async()=>{
 const root=await fixture(),path=await file(join(root,'build/webview2-com-sys-123/out/x64/WebView2Loader.dll'))
 expect(await findWebViewLoader(root,{metadata:vi.fn()})).toBe(path)
})
it('recovers a cached build missing DLLs from its exact resolved SDK',async()=>{
 const root=await fixture(),sdk=join(root,'registry/webview2-com-sys-0.39.1')
 const path=await file(join(sdk,'x64/WebView2Loader.dll'))
 await file(join(root,'registry/webview2-com-sys-other/x64/WebView2Loader.dll'))
 const metadata=async()=>({packages:[{id:'sdk',name:'webview2-com-sys',manifest_path:join(sdk,'Cargo.toml')},{id:'unresolved',name:'webview2-com-sys',manifest_path:join(root,'registry/webview2-com-sys-other/Cargo.toml')}],resolve:{nodes:[{id:'sdk'}]}})
 expect(await findWebViewLoader(join(root,'release'),{metadata})).toBe(path)
})
it('fails when the resolved SDK has no loader',async()=>{
 const root=await fixture()
 await expect(findWebViewLoader(root,{metadata:async()=>({packages:[],resolve:{nodes:[]}})})).rejects.toThrow('resolved Cargo SDK')
})
