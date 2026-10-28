import {afterEach,describe,it,expect} from "vitest";
import {get} from "node:http";
import {startChatGPTBridge} from "../scripts/authorize-chatgpt-plan.mjs";

const backendOrigin="https://leanbridge-ai-production.up.railway.app";
const siteOrigin="https://leanbridge-ai-demo.jaunty-thyme-0223.chatgpt.site";
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(cleanups.splice(0).map(close=>close()));});
async function fixture(){
 let authorizationUrl="",completions=0;
 const requests:Array<{url:string;body:Record<string,string>}>=[];
 const fetchImpl:typeof fetch=async(input,init)=>{
  const url=String(input),body=JSON.parse(String(init?.body));requests.push({url,body});
  expect(url.startsWith(backendOrigin)).toBe(true);expect(init?.redirect).toBe("error");
  if(url.endsWith("/inspect"))return Response.json({authorizationUrl});
  completions++;return Response.json({connected:true,state:"connected",transport:"chatgpt-plan"});
 };
 const bridge=await startChatGPTBridge({port:0,backendOrigin,siteOrigin,fetchImpl});cleanups.push(bridge.close);
 const state="s".repeat(43),ticket="t".repeat(43);
 const url=new URL("https://auth.openai.com/api/accounts/authorize");
 url.search=new URLSearchParams({client_id:"oaiapp_test",response_type:"code",redirect_uri:bridge.origin+"/auth/callback",state,nonce:"n".repeat(43),scope:"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",resource:"https://api.openai.com/v1",code_challenge_method:"S256",code_challenge:"c".repeat(43)}).toString();
 authorizationUrl=url.toString();
 const setup={authorizationUrl,state,ticket,completeUrl:backendOrigin+"/api/subscription/callback"};
 const connect=(value=setup,origin=siteOrigin)=>fetch(bridge.origin+"/connect",{method:"POST",headers:{Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({payload:JSON.stringify(value)}),redirect:"manual"});
 return {...bridge,setup,connect,requests,count:()=>completions};
}
describe("desktop OAuth code bridge",()=>{
 it("rejects wrong Host, untrusted Origin and off-service destinations",async()=>{
  const b=await fixture();
  const host=await new Promise<number|undefined>((resolve,reject)=>get(b.origin+"/",{headers:{Host:"evil.example"}},r=>{r.resume();resolve(r.statusCode);}).on("error",reject));expect(host).toBe(403);
  expect((await b.connect(b.setup,"https://evil.example")).status).toBe(403);
  expect((await b.connect({...b.setup,completeUrl:"https://evil.example/collect"})).status).toBe(400);
  expect(b.requests).toHaveLength(0);
 });
 it("verifies the backend ticket before navigating and forwards no durable tokens",async()=>{
  const b=await fixture(),start=await b.connect();expect(start.status).toBe(303);expect(start.headers.get("location")).toBe(b.setup.authorizationUrl);
  expect(b.requests[0]!.body).toEqual({state:b.setup.state,ticket:b.setup.ticket});
  const cookie=start.headers.get("set-cookie")!.split(";")[0]!;
  const callback=b.origin+"/auth/callback?"+new URLSearchParams({code:"CODE_NOT_LOGGED",state:b.setup.state,client_id:"oaiapp_test"});
  expect((await fetch(callback,{redirect:"manual"})).status).toBe(403);
  const accepted=await fetch(callback,{headers:{Cookie:cookie},redirect:"manual"});expect(accepted.status).toBe(303);
  expect(b.requests[1]!.body).toEqual({code:"CODE_NOT_LOGGED",state:b.setup.state,ticket:b.setup.ticket,clientId:"oaiapp_test"});expect(b.count()).toBe(1);
  expect((await fetch(callback,{headers:{Cookie:cookie},redirect:"manual"})).status).toBe(400);expect(b.count()).toBe(1);
  const status=await (await fetch(b.origin+"/status")).text();expect(status).toContain("connected");expect(status).not.toMatch(/CODE_NOT_LOGGED|tttttt|access_token|refresh_token/);
 });
 it("rejects mismatched state and duplicated callback parameters",async()=>{
  const b=await fixture(),start=await b.connect(),cookie=start.headers.get("set-cookie")!.split(";")[0]!;
  const bad=b.origin+"/auth/callback?code=test&state=bad";
  expect((await fetch(bad,{headers:{Cookie:cookie}})).status).toBe(400);expect(b.count()).toBe(0);
  const duplicate=b.origin+"/auth/callback?"+new URLSearchParams({state:b.setup.state,code:"test"})+"&code=again";
  expect((await fetch(duplicate,{headers:{Cookie:cookie}})).status).toBe(400);expect(b.count()).toBe(0);
 });
});
