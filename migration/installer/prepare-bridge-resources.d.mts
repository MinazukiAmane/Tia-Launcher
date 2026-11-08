export interface BridgeResourceOptions {
 installer:string
 helper:string
 keyPath:string
 output:string
 bridgeVersion:string
 targetVersion:string
 platform?:import('../electron/bridgeRelease').MigrationPlatform
}
export function prepareBridgeResources(options:BridgeResourceOptions):Promise<{keyId:string;output:string}>
