export interface BridgeOptions {port?:number;backendOrigin?:string;siteOrigin?:string;fetchImpl?:typeof fetch}
export function startChatGPTBridge(options?:BridgeOptions):Promise<{origin:string;close:()=>Promise<void>}>;
