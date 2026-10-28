import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const BACKEND='https://leanbridge-ai-production.up.railway.app';
const SITE='https://leanbridge-ai-demo.jaunty-thyme-0223.chatgpt.site';
const equal=(a,b)=>typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const opaque=value=>typeof value==='string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
async function requestBody(req){
 return new Promise((resolve,reject)=>{let text='',bytes=0,done=false;req.on('data',chunk=>{if(done)return;bytes+=chunk.length;if(bytes>24000){done=true;reject(new Error('SIZE'));return;}text+=chunk.toString('utf8');});req.once('end',()=>{if(!done)resolve(text);});req.once('error',()=>reject(new Error('BODY')));});
}
async function jsonResponse(response){
 if(!response.ok){await response.body?.cancel();throw new Error('BACKEND');}
 const reader=response.body.getReader();let text='',bytes=0;const decoder=new TextDecoder();
 try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>24000)throw new Error('SIZE');text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function startChatGPTBridge({port=1455,backendOrigin=BACKEND,siteOrigin=SITE,fetchImpl=fetch}={}){
 if(new URL(backendOrigin).protocol!=='https:' || new URL(backendOrigin).origin!==backendOrigin)throw new Error('Invalid backend origin');
 let origin,pending,busy=false;
 const status={state:'idle',connected:false};
 function send(res,code,body,headers={}){
  res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",...headers});res.end(body);
 }
 const page=message=>'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LeanBridge 官方订阅授权桥接</title><h1>LeanBridge AI</h1><p>'+message+'</p><p>账号登录及套餐授权仅在 auth.openai.com 官方页面完成；此程序只转发一次性授权码，长期凭据保存在你的云端服务。</p></html>';
 async function backend(path,body){return jsonResponse(await fetchImpl(backendOrigin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(60000)}));}
 function validateSetup(value){
  if(!value || typeof value!=='object' || !opaque(value.state)||!opaque(value.ticket)||value.completeUrl!==backendOrigin+'/api/subscription/callback'||typeof value.authorizationUrl!=='string'||value.authorizationUrl.length>16000)throw new Error('SETUP');
  const url=new URL(value.authorizationUrl);
  if(url.origin!=='https://auth.openai.com'||url.pathname!=='/api/accounts/authorize'||url.username||url.password||url.hash||url.searchParams.get('state')!==value.state||url.searchParams.get('redirect_uri')!==origin+'/auth/callback'||url.searchParams.get('resource')!=='https://api.openai.com/v1'||url.searchParams.get('response_type')!=='code'||url.searchParams.get('code_challenge_method')!=='S256')throw new Error('SETUP');
  const clientId=url.searchParams.get('client_id');if(clientId!=='dynamic_agent_client'&&!/^oaiapp_[A-Za-z0-9_-]{1,160}$/.test(clientId||''))throw new Error('SETUP');
  if(!url.searchParams.get('scope')?.split(' ').includes('chatgpt.tokens.use.direct'))throw new Error('SETUP');
  return {authorizationUrl:url.toString(),state:value.state,ticket:value.ticket};
 }
 async function handle(req,res){
  if(req.headers.host!==new URL(origin).host)return send(res,403,'Forbidden');
  const url=new URL(req.url,origin);
  if(req.method==='GET' && url.pathname==='/')return send(res,200,page('授权桥接已启动。请在同一电脑打开 LeanBridge 工作台，点击连接订阅，再点“在电脑完成官方授权”。完成后可关闭此程序，手机使用无需电脑开机。'));
  if(req.method==='GET' && url.pathname==='/status')return send(res,200,JSON.stringify(status),{'Content-Type':'application/json'});
  if(req.method==='GET' && url.pathname==='/result')return send(res,200,page(status.connected?'订阅直连已连接。授权已安全保存到云端，可返回手机工作台使用。':'授权未完成。请查看工作台的订阅状态；网络暂时中断时不需要反复授权。'));
  if(req.method==='POST' && url.pathname==='/connect'){
   // Some browsers serialize an HTTPS-to-loopback form Origin as null. Such
   // forms still need an unguessable owner-issued ticket validated by the
   // pinned backend BEFORE any navigation; no token or arbitrary URL is trusted.
   if(![siteOrigin,backendOrigin,origin,'null'].includes(req.headers.origin))return send(res,403,'Forbidden');
   if(busy||(pending&&!pending.used&&pending.expiresAt>Date.now()))return send(res,409,page('已有授权流程正在进行，请继续原官方页面。'));
   busy=true;
   try{
    const body=await requestBody(req);let value;
    if(req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')){const form=new URLSearchParams(body);if(form.getAll('payload').length!==1)throw new Error('SETUP');value=JSON.parse(form.get('payload'));}else throw new Error('SETUP');
    const setup=validateSetup(value);
    const inspected=await backend('/api/subscription/inspect',{state:setup.state,ticket:setup.ticket});
    if(inspected.authorizationUrl!==setup.authorizationUrl)throw new Error('SETUP');
    const cookie=randomBytes(32).toString('base64url');pending={...setup,cookie,expiresAt:Date.now()+600000,used:false};status.state='pending';
    return send(res,303,'',{'Location':setup.authorizationUrl,'Set-Cookie':`lb_bridge=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`});
   }catch(error){return send(res,error?.message==='SIZE'?413:400,page('授权入口无效或已过期，请回到已登录的工作台重新连接。'));}finally{busy=false;}
  }
  if(req.method==='GET' && url.pathname==='/auth/callback'){
   const current=pending,cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('lb_bridge='))?.slice(10);
   if(!current||!equal(cookie,current.cookie))return send(res,403,'Forbidden');
   if(current.used||current.expiresAt<Date.now())return send(res,400,page('此一次性回调已使用或过期。'));
   if(['state','code','client_id','error'].some(key=>url.searchParams.getAll(key).length>1)||!equal(url.searchParams.get('state'),current.state))return send(res,400,page('授权回调校验失败。'));
   current.used=true;
   const code=url.searchParams.get('code');
   if(url.searchParams.has('error')||!code||code.length>8192){status.state='failed';return send(res,400,page('授权未完成。'));}
   try{
    const clientId=url.searchParams.get('client_id');
    const result=await backend('/api/subscription/callback',{code,state:current.state,ticket:current.ticket,...(clientId?{clientId}:{})});
    status.connected=result.connected===true;status.state=status.connected?'connected':'failed';
   }catch{status.state='failed';}
   return send(res,303,'',{'Location':'/result','Set-Cookie':'lb_bridge=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
  }
  return send(res,404,'Not found');
 }
 const server=createServer((req,res)=>{handle(req,res).catch(()=>{if(!res.headersSent)send(res,500,'Bridge error');else res.end();});});
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 origin='http://127.0.0.1:'+server.address().port;
 return {origin,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const bridge=await startChatGPTBridge();
  console.log('LeanBridge 官方授权桥接已启动：'+bridge.origin+'/');
  console.log('请在同一电脑打开工作台并连接订阅。长期授权直接保存在云端；20 分钟后此桥接自动关闭。');
  const close=async()=>{await bridge.close();process.exit(0);};
  process.once('SIGINT',close);setTimeout(close,20*60000).unref();
 }catch{console.error('无法启动授权桥接。请检查本机 1455 端口是否已被旧探针占用。');process.exitCode=1;}
}
