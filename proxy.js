// Local OpenAI-compatible proxy (127.0.0.1 only). OpenClaw (or any OpenAI client) talks to it like to any
// OpenAI endpoint; for every chat completion it:
//   1. turns the request into what the gateway accepts (non-streaming, text-only content, max_tokens);
//   2. asks the gateway for the price (HTTP 402, x402 v2 "exact", USDC on Base);
//   3. checks the quote: right network and token, the PINNED payee, under the per-call and per-day caps;
//   4. signs the USDC authorization with the local wallet and sends the request again with it;
//   5. returns the answer, as JSON or as a stream of OpenAI chunks when the client asked for streaming.
// Nothing is ever signed for another payee, another token or another network, or above a cap.
import http from "node:http";
import {timingSafeEqual} from "node:crypto";
import {x402Client} from "@x402/core/client";
import {registerExactEvmScheme} from "@x402/evm/exact/client";
import {privateKeyToAccount} from "viem/accounts";
import {readSpend,addSpend,creditSpend,PROVIDER_ID} from "./state.js";
import {createHmac} from "node:crypto";

export const BASE="eip155:8453";
export const USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX_BODY=2*1024*1024;
const GATEWAY_MAX_TOKENS=16384;
const DEFAULT_MAX_TOKENS=4096;
const b64json=(x)=>Buffer.from(JSON.stringify(x),"utf8").toString("base64");
const unb64json=(s)=>JSON.parse(Buffer.from(String(s),"base64").toString("utf8"));
const usdOf=(micro)=>(Number(micro)/1e6).toFixed(6).replace(/0+$/,"").replace(/\.$/,"");

export class PaymentRefused extends Error{constructor(message,status=402){super(message);this.status=status;}}

// ---------- request shaping ----------
const ID_RE=/^[a-zA-Z0-9_.:-]{1,128}$/;
const safeId=(id)=>{const s=String(id??"");return ID_RE.test(s)?s:("id_"+s.replace(/[^a-zA-Z0-9_.:-]/g,"_")).slice(0,128);};
function textOf(c){
 if(c===null||c===undefined)return null;
 if(typeof c==="string")return c;
 if(Array.isArray(c))return c.map(p=>{
  if(typeof p==="string")return p;
  if(p&&(p.type==="text"||p.type==="input_text"||p.type==="output_text"))return String(p.text??"");
  if(p&&/image|audio|file|video/.test(String(p.type)))return "[attachment omitted: this provider accepts text only]";
  return "";
 }).join("");
 return String(c);
}
export function gatewayBody(req){
 if(!req||typeof req!=="object"||Array.isArray(req))throw new PaymentRefused("invalid JSON body",400);
 if(typeof req.model!=="string"||!req.model)throw new PaymentRefused("model is required",400);
 if(!Array.isArray(req.messages)||!req.messages.length)throw new PaymentRefused("messages are required",400);
 const model=req.model.startsWith(PROVIDER_ID+"/")?req.model.slice(PROVIDER_ID.length+1):req.model;
 const messages=req.messages.map(m=>{
  const role=m?.role==="function"?"tool":m?.role;
  if(role==="assistant"&&Array.isArray(m.tool_calls)&&m.tool_calls.length){
   const t=textOf(m.content);
   return {role,content:t===""?null:t,tool_calls:m.tool_calls.map(c=>({id:safeId(c?.id),type:"function",
    function:{name:String(c?.function?.name??""),arguments:typeof c?.function?.arguments==="string"?c.function.arguments:JSON.stringify(c?.function?.arguments??{})}}))};
  }
  if(role==="tool")return {role,tool_call_id:safeId(m.tool_call_id),content:textOf(m.content)??""};
  return {role,content:textOf(m.content)??""};
 });
 let max=Number(req.max_tokens??req.max_completion_tokens??DEFAULT_MAX_TOKENS);
 if(!Number.isInteger(max)||max<1)max=DEFAULT_MAX_TOKENS;
 const out={model,messages,max_tokens:Math.min(max,GATEWAY_MAX_TOKENS),stream:false};
 if(Array.isArray(req.tools)&&req.tools.length){
  out.tools=req.tools;
  if(req.tool_choice!==undefined&&req.tool_choice!==null)out.tool_choice=req.tool_choice;
  if(typeof req.parallel_tool_calls==="boolean")out.parallel_tool_calls=req.parallel_tool_calls;
 }
 return out;
}

// ---------- OpenAI streaming from a finished answer ----------
export function toSSE(res,{includeUsage=false}={}){
 const id=res.id||"chatcmpl-"+Date.now().toString(36);
 const created=res.created||Math.floor(Date.now()/1000);
 const model=res.model;
 const chunk=(choices,extra={})=>"data: "+JSON.stringify({id,object:"chat.completion.chunk",created,model,choices,...extra})+"\n\n";
 let out="";
 for(const c of res.choices||[]){
  const i=c.index??0,m=c.message||{};
  out+=chunk([{index:i,delta:{role:"assistant",content:""},finish_reason:null}]);
  if(typeof m.reasoning_content==="string"&&m.reasoning_content)out+=chunk([{index:i,delta:{reasoning_content:m.reasoning_content},finish_reason:null}]);
  if(typeof m.content==="string"&&m.content)out+=chunk([{index:i,delta:{content:m.content},finish_reason:null}]);
  (m.tool_calls||[]).forEach((t,k)=>{
   out+=chunk([{index:i,delta:{tool_calls:[{index:k,id:t.id,type:"function",function:{name:t.function?.name,arguments:typeof t.function?.arguments==="string"?t.function.arguments:JSON.stringify(t.function?.arguments??{})}}]},finish_reason:null}]);
  });
  out+=chunk([{index:i,delta:{},finish_reason:c.finish_reason||(m.tool_calls?.length?"tool_calls":"stop")}]);
 }
 if(includeUsage&&res.usage)out+=chunk([],{usage:res.usage});
 return out+"data: [DONE]\n\n";
}

// ---------- x402 payment ----------
const MAX_VALIDITY_S=600;
export function pickAccept(challenge,{payTo,maxPerCallMicro}){
 if(challenge?.x402Version!==2||!Array.isArray(challenge.accepts))throw new PaymentRefused("gateway sent an invalid x402 quote",502);
 const a=challenge.accepts.find(x=>x?.scheme==="exact"&&x.network===BASE&&String(x.asset).toLowerCase()===USDC.toLowerCase());
 if(!a)throw new PaymentRefused("gateway quote is not USDC on Base",502);
 if(String(a.payTo).toLowerCase()!==payTo.toLowerCase())
  throw new PaymentRefused("refused: the gateway asked to pay "+a.payTo+" instead of the pinned wallet "+payTo,502);
 // Only EIP-3009 transferWithAuthorization (never a Permit2 transfer), valid at most 10 minutes.
 if(a.extra?.assetTransferMethod!==undefined&&a.extra.assetTransferMethod!=="eip3009")
  throw new PaymentRefused("refused: unsupported transfer method "+String(a.extra.assetTransferMethod).slice(0,20),502);
 const ttl=Number(a.maxTimeoutSeconds);
 if(!Number.isInteger(ttl)||ttl<1||ttl>MAX_VALIDITY_S)throw new PaymentRefused("refused: payment validity "+a.maxTimeoutSeconds+" s",502);
 if(!/^[1-9][0-9]{0,15}$/.test(String(a.amount)))throw new PaymentRefused("gateway quote amount is invalid",502);
 const amount=BigInt(a.amount);
 if(amount>maxPerCallMicro)throw new PaymentRefused("refused: this request costs $"+usdOf(amount)+", above the per-call limit $"+usdOf(maxPerCallMicro)+
  " (plugin config maxPerCallUsd)",402);
 return {accept:a,amount};
}

export function createPayer(walletKey){
 const account=privateKeyToAccount(walletKey);
 return {address:account.address,
  async sign(challenge,accept,amount){
   const client=new x402Client();
   // @x402/core 2.28 refuses more than $1 by default; the proxy has its own caps, checked before this point.
   client.setSpendControls({maxAmountPerPayment:false,allowedAssets:[{network:BASE,asset:USDC,maxAmountPerPayment:String(amount)}]});
   registerExactEvmScheme(client,{signer:account,networks:[BASE]});
   const signed=await client.createPaymentPayload({...challenge,accepts:[accept]});
   // Check what was really signed, not the echo of the quote.
   const auth=signed?.payload?.authorization;
   const now=Math.floor(Date.now()/1000);
   if(!auth||typeof signed.payload.signature!=="string"||String(auth.from).toLowerCase()!==account.address.toLowerCase()||
      String(auth.to).toLowerCase()!==String(accept.payTo).toLowerCase()||String(auth.value)!==String(amount)||
      !(Number(auth.validBefore)<=now+MAX_VALIDITY_S+60))
    throw new PaymentRefused("signed payment differs from the checked quote",500);
   return signed;
  }};
}

// The gateway answered after a payment: was the authorization certainly NOT kept? (then it is not counted)
// 4xx = refused before settlement; 503 with charged:false = preflight failure; 502 "refunded" = refunded on-chain.
function notCharged(status,text){
 if(status>=400&&status<500&&status!==408)return true;
 let j=null;try{j=JSON.parse(text);}catch{}
 if(status===503&&j?.charged===false)return true;
 if(status===502&&/refunded/i.test(String(j?.error||"")))return true;
 return false;
}

// One paid chat completion: quote, checks, payment, answer. Every signature counts as spent the moment it is made
// (the gateway can settle it until it expires) and is credited back only when the gateway says it was not charged.
// Per request at most maxPerCall in total, even if the gateway re-quotes once.
export async function paidCompletion(body,{gateway,payTo,maxPerCallMicro,maxPerDayMicro,payer,fetcher=fetch,reserved,log=()=>{}}){
 const url=gateway+"/v1/chat/completions";
 const send=async(headers={})=>{
  const r=await fetcher(url,{method:"POST",headers:{"content-type":"application/json",...headers},
   body:JSON.stringify(body),signal:AbortSignal.timeout(280000)});
  return {status:r.status,ok:r.ok,headers:r.headers,text:await r.text()};
 };
 let r=await send();
 let signedThisCall=0n;
 for(let attempt=0;attempt<2&&r.status===402;attempt++){
  const header=r.headers.get("payment-required")||r.headers.get("x-payment-required");
  if(!header)throw new PaymentRefused("gateway refused the payment: "+r.text.slice(0,200),402);
  if(!payer)throw new PaymentRefused("no wallet configured: run `openclaw-model-access setup` and fund the address it prints",402);
  const challenge=unb64json(header);
  const {accept,amount}=pickAccept(challenge,{payTo,maxPerCallMicro:maxPerCallMicro-signedThisCall});
  const spent=BigInt(readSpend().dayMicro)+reserved.value;
  if(spent+amount>maxPerDayMicro)throw new PaymentRefused("refused: daily limit $"+usdOf(maxPerDayMicro)+" reached (spent $"+usdOf(spent)+
   " today; plugin config maxPerDayUsd)",402);
  reserved.value+=amount;                 // reserved before any await: concurrent calls see it
  let signed;
  try{signed=await payer.sign(challenge,accept,amount);addSpend(amount);}
  finally{reserved.value-=amount;}
  signedThisCall+=amount;
  log("[model-access] signed $"+usdOf(amount)+" for "+body.model);
  r=await send({"PAYMENT-SIGNATURE":b64json(signed)});   // a timeout or reset leaves it counted (prudent)
  if(!r.ok&&notCharged(r.status,r.text)){
   creditSpend(amount);signedThisCall-=amount;
   log("[model-access] not charged (HTTP "+r.status+"): $"+usdOf(amount)+" credited back");
  }
 }
 return r;
}

// ---------- HTTP server ----------
function tokenOk(req,token){
 const h=String(req.headers.authorization||"");
 const got=h.startsWith("Bearer ")?h.slice(7).trim():String(req.headers["x-api-key"]||"");
 const a=Buffer.from(got),b=Buffer.from(token);
 return a.length===b.length&&timingSafeEqual(a,b);
}
const sendJson=(res,status,obj,headers={})=>{res.writeHead(status,{"content-type":"application/json",...headers});res.end(JSON.stringify(obj));};
const oaiError=(res,status,message,code)=>sendJson(res,status,{error:{message,type:status===402?"payment_error":"gateway_error",code:code||status}});
async function readBody(req){
 const chunks=[];let n=0;
 for await(const c of req){n+=c.length;if(n>MAX_BODY)throw new PaymentRefused("request body above 2 MB",413);chunks.push(c);}
 return Buffer.concat(chunks).toString("utf8");
}

export async function startProxy({port,token,walletKey,gateway,payTo,maxPerCallMicro,maxPerDayMicro,fetcher=fetch,log=()=>{},host="127.0.0.1",unref=false}){
 const payer=walletKey?createPayer(walletKey):null;
 const reserved={value:0n};
 let modelsCache=null;
 const server=http.createServer(async(req,res)=>{
  try{
   // A web page can reach 127.0.0.1 too: browsers always send Origin on such requests, OpenClaw never does.
   if(req.headers.origin||req.headers["sec-fetch-site"])return oaiError(res,403,"browser requests are not allowed");
   const path=new URL(req.url,"http://x").pathname.replace(/\/+$/,"");
   if(req.method==="GET"&&path==="/health"){
    // Anyone may ask whether the proxy is up; only a holder of the token gets details. ?challenge=x returns
    // HMAC(token,x): proof for another OpenClaw process that this listener is really the proxy.
    const ch=new URL(req.url,"http://x").searchParams.get("challenge");
    const out={ok:true};
    if(ch&&/^[a-f0-9]{16,64}$/.test(ch))out.proof=createHmac("sha256",token).update(ch).digest("hex");
    if(tokenOk(req,token)){
     const s=readSpend();
     Object.assign(out,{wallet:payer?.address||null,gateway,spentTodayUsd:usdOf(s.dayMicro),maxPerDayUsd:usdOf(maxPerDayMicro),
      maxPerCallUsd:usdOf(maxPerCallMicro),calls:s.calls});
    }
    return sendJson(res,200,out);
   }
   if(!tokenOk(req,token))return oaiError(res,401,"missing or wrong proxy token");
   if(req.method==="GET"&&(path==="/v1/models"||path==="/models")){
    if(!modelsCache||Date.now()-modelsCache.at>10*60*1000){
     const r=await fetcher(gateway+"/models",{signal:AbortSignal.timeout(20000)});
     if(!r.ok)return oaiError(res,502,"gateway /models HTTP "+r.status);
     const d=await r.json();
     modelsCache={at:Date.now(),data:(d.models||d.data||[]).filter(m=>typeof m?.id==="string")
      .map(m=>({id:m.id,object:"model",owned_by:m.id.split("/")[0],name:m.name||m.id}))};
    }
    return sendJson(res,200,{object:"list",data:modelsCache.data});
   }
   if(req.method!=="POST"||path!=="/v1/chat/completions")return oaiError(res,404,"not found");
   let parsed;
   try{parsed=JSON.parse(await readBody(req));}catch(e){return oaiError(res,e.status||400,e.status?e.message:"invalid JSON body");}
   const body=gatewayBody(parsed);
   const r=await paidCompletion(body,{gateway,payTo,maxPerCallMicro,maxPerDayMicro,payer,fetcher,reserved,log});
   const text=r.text;
   if(!r.ok){
    let msg=text.slice(0,300);try{const j=JSON.parse(text);msg=typeof j.error==="string"?j.error:(j.error?.message||msg);}catch{}
    return oaiError(res,r.status===402?402:r.status,"gateway: "+msg);
   }
   const answer=JSON.parse(text);
   if(parsed.stream===true){
    res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"});
    return res.end(toSSE(answer,{includeUsage:parsed.stream_options?.include_usage===true}));
   }
   return sendJson(res,200,answer);
  }catch(e){
   log("[model-access] "+(e?.message||e));
   if(!res.headersSent)return oaiError(res,e instanceof PaymentRefused?e.status:502,String(e?.message||e).slice(0,300));
   res.end();
  }
 });
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.off("error",reject);resolve();});});
 server.on("error",(e)=>log("[model-access] proxy error: "+(e?.message||e)));   // never an unhandled 'error' in OpenClaw
 if(unref)server.unref();
 const actual=server.address().port;
 return {port:actual,baseUrl:"http://"+host+":"+actual+"/v1",wallet:payer?.address||null,
  close:()=>new Promise(r=>server.close(()=>r()))};
}
