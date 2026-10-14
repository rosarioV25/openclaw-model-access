// Offline gateway double: answers like the real gateway (x402 v2 "exact" quote, then the paid answer) and checks
// every payment for real: EIP-712 TransferWithAuthorization signature, payee, amount, resource URL.
import http from "node:http";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyTypedData} from "viem";

export const USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAY_TO="0xf7eaf699C6E55887184809c57d597a64aB86d493";
const b64=(x)=>Buffer.from(JSON.stringify(x)).toString("base64");
const unb64=(s)=>JSON.parse(Buffer.from(s,"base64").toString("utf8"));
const TYPES={TransferWithAuthorization:[{name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
 {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}]};

export function freshHome(){
 const d=mkdtempSync(join(tmpdir(),"model-access-"));
 process.env.MODEL_ACCESS_HOME=join(d,"state");
 process.env.OPENCLAW_HOME=d;
 return d;
}
export async function mockGateway(o={}){
 const st={quotes:0,paid:0,bodies:[],payments:[],o:{price:19000,payTo:PAY_TO,answer:null,status:200,requote:0,...o}};
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const raw=Buffer.concat(chunks).toString("utf8");
  const url="http://127.0.0.1:"+server.address().port+req.url;
  if(req.method==="GET"&&req.url==="/models"){res.writeHead(200,{"content-type":"application/json"});
   return res.end(JSON.stringify({models:[{id:"anthropic/claude-sonnet-5.5",name:"Claude Sonnet 5.5"},{id:"openai/gpt-4o-mini",name:"GPT-4o mini"}]}));}
  const body=JSON.parse(raw||"{}");st.bodies.push(body);
  const challenge={x402Version:2,resource:{url,mimeType:"application/json"},
   accepts:[{scheme:"exact",network:"eip155:8453",amount:String(st.o.price),asset:USDC,payTo:st.o.payTo,maxTimeoutSeconds:st.o.ttl||180,
    extra:{name:"USD Coin",version:"2",...(st.o.method?{assetTransferMethod:st.o.method}:{})}}]};
  const sig=req.headers["payment-signature"];
  if(!sig){st.quotes++;res.writeHead(402,{"content-type":"application/json","payment-required":b64(challenge)});return res.end("{}");}
  const p=unb64(sig);st.payments.push(p);
  const a=p.payload.authorization;
  const ok=await verifyTypedData({address:a.from,domain:{name:"USD Coin",version:"2",chainId:8453,verifyingContract:USDC},
   types:TYPES,primaryType:"TransferWithAuthorization",message:{...a,value:BigInt(a.value),validAfter:BigInt(a.validAfter),validBefore:BigInt(a.validBefore)},
   signature:p.payload.signature});
  if(!ok||a.to.toLowerCase()!==PAY_TO.toLowerCase()||p.resource?.url!==url){res.writeHead(402,{"content-type":"application/json"});return res.end(JSON.stringify({error:"invalid buyer payment"}));}
  if(st.o.requote>0){st.o.requote--;st.o.price+=500;challenge.accepts[0].amount=String(st.o.price);
   res.writeHead(402,{"content-type":"application/json","payment-required":b64(challenge)});return res.end("{}");}
  if(st.o.status!==200){res.writeHead(st.o.status,{"content-type":"application/json"});
   return res.end(JSON.stringify(st.o.errorBody||{error:"upstream failed; payment refunded"}));}
  st.paid++;st.lastPaidValue=a.value;
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({id:"chatcmpl-1",object:"chat.completion",created:1760000000,model:body.model,
   choices:[{index:0,message:st.o.answer||{role:"assistant",content:"OK from "+body.model},finish_reason:st.o.answer?.tool_calls?"tool_calls":"stop"}],
   usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}}));
 });
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 return {st,url:"http://127.0.0.1:"+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
