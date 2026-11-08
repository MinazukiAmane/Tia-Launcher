export function buildLinuxPackage(options:{binary:string;output:string;version:string;arch?:string;strip?:boolean;kind?:'pacman'|'nix'}):Promise<string>
export function stageLinuxPackage(options:{binary:string;directory:string;version:string;kind?:'pacman'|'nix';strip?:boolean}):Promise<string>
