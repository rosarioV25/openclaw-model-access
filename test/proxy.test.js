import test from "node:test";
import assert from "node:assert/strict";
import {generatePrivateKey,privateKeyToAccount} from "viem/accounts";
import {mockGateway,freshHome,PAY_TO} from "./helpers.js";

freshHome();
const {startProxy,gatewayBody,toSSE}=await import("../proxy.js");
const {readSpend}=await import("../state.js");

const KEY=generatePrivateKey();
const TOKEN="a".repeat(48);
async function setup(gw={},lim={}){
 const g=await mockGateway(gw);
 const p=await startProxy({port:0,token:TOKEN,walletKey:KEY,gateway:g.url,payTo:PAY_TO,
  maxPerCallMicro:lim.perCall??500000n,maxPerDayMicro:lim.perDay??5000000n});
 const call=(body,headers={})=>fetch(p.baseUrl+"/chat/completions",{method:"POST",
  headers:{"content-type":"application/json",authorization:"Bearer "+TOKEN,...headers},body:JSON.stringify(body)});
 return {g,p,call,done:async()=>{await p.close();await g.close();}};
}
const BODY={model:"anthropic/claude-sonnet-5.5",messages:[{role:"user",content:"hi"}],max_tokens:100};

test("non-streaming call: quote, real signed payment to the pinned wallet, answer",async()=>{
 const t=await setup();
 const before=BigInt(readSpend().dayMicro);
 const r=await t.call(BODY);
 assert.equal(r.status,200,await r.clone().text());
 const j=await r.json();
 assert.equal(j.choices[0].message.content,"OK from anthropic/claude-sonnet-5.5");
 assert.deepEqual([t.g.st.quotes,t.g.st.paid],[1,1]);
 const pay=t.g.st.payments[0];
 assert.equal(pay.accepted.payTo,PAY_TO);
 assert.equal(pay.payload.authorization.from,privateKeyToAccount(KEY).address);
 assert.equal(pay.payload.authorization.value,"19000");
 assert.equal(BigInt(readSpend().dayMicro)-before,19000n,"spend recorded");
 await t.done();
});

test("streaming client: the answer comes back as OpenAI chunks with usage and [DONE]",async()=>{
 const t=await setup();
 const r=await t.call({...BODY,stream:true,stream_options:{include_usage:true}});
 assert.equal(r.status,200);
 assert.match(r.headers.get("content-type"),/text\/event-stream/);
 const text=await r.text();
 const events=text.split("\n\n").filter(Boolean).map(x=>x.replace(/^data: /,""));
 assert.equal(events.at(-1),"[DONE]");
 const chunks=events.slice(0,-1).map(JSON.parse);
 assert.equal(chunks[0].choices[0].delta.role,"assistant");
 assert.equal(chunks.map(c=>c.choices[0]?.delta?.content||"").join(""),"OK from anthropic/claude-sonnet-5.5");
 assert.equal(chunks.find(c=>c.choices[0]?.finish_reason)?.choices[0].finish_reason,"stop");
 assert.deepEqual(chunks.at(-1).usage,{prompt_tokens:12,completion_tokens:3,total_tokens:15});
 assert.equal(t.g.st.bodies.at(-1).stream,false,"the gateway always gets stream:false");
 await t.done();
});

test("tool calls stream back as tool_call deltas; tools and history reach the gateway",async()=>{
 const call={role:"assistant",content:null,tool_calls:[{id:"call_7",type:"function",function:{name:"read",arguments:"{\"p\":\"a\"}"}}]};
 const t=await setup({answer:call});
 const tools=[{type:"function",function:{name:"read",parameters:{type:"object"}}}];
 const r=await t.call({...BODY,stream:true,tools,tool_choice:"auto",messages:[
  {role:"developer",content:[{type:"text",text:"be brief"}]},{role:"user",content:[{type:"text",text:"look "},{type:"image_url",image_url:{url:"data:x"}}]},
  {role:"assistant",content:"",tool_calls:[{id:"call|1",type:"function",function:{name:"read",arguments:{p:"b"}}}]},
  {role:"tool",tool_call_id:"call|1",content:[{type:"text",text:"file"}]}]});
 const chunks=(await r.text()).split("\n\n").filter(x=>x&&x!=="data: [DONE]").map(x=>JSON.parse(x.slice(6)));
 const tc=chunks.find(c=>c.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
 assert.deepEqual(tc,{index:0,id:"call_7",type:"function",function:{name:"read",arguments:"{\"p\":\"a\"}"}});
 assert.equal(chunks.find(c=>c.choices[0]?.finish_reason).choices[0].finish_reason,"tool_calls");
 const sent=t.g.st.bodies.at(-1);
 assert.deepEqual(sent.tools,tools);
 assert.equal(sent.tool_choice,"auto");
 assert.equal(sent.messages[0].content,"be brief");
 assert.equal(sent.messages[1].content,"look [attachment omitted: this provider accepts text only]");
 assert.equal(sent.messages[2].content,null);
 assert.equal(sent.messages[2].tool_calls[0].id,sent.messages[3].tool_call_id,"ids sanitized the same way");
 assert.match(sent.messages[2].tool_calls[0].id,/^[a-zA-Z0-9_.:-]+$/);
 assert.equal(sent.messages[2].tool_calls[0].function.arguments,"{\"p\":\"b\"}");
 await t.done();
});

test("a quote above the per-call limit is refused before anything is signed",async()=>{
 const t=await setup({price:600000});
 const r=await t.call(BODY);
 assert.equal(r.status,402);
 assert.match((await r.json()).error.message,/per-call limit/);
 assert.equal(t.g.st.payments.length,0);
 await t.done();
});

test("the daily limit stops payments",async()=>{
 const t=await setup({price:300000},{perDay:BigInt(readSpend().dayMicro)+400000n});
 assert.equal((await t.call(BODY)).status,200);
 const r=await t.call(BODY);
 assert.equal(r.status,402);
 assert.match((await r.json()).error.message,/daily limit/);
 assert.equal(t.g.st.payments.length,1);
 await t.done();
});

test("a quote naming another payee is refused: nothing signed",async()=>{
 const t=await setup({payTo:"0x1111111111111111111111111111111111111111"});
 const r=await t.call(BODY);
 assert.equal(r.status,502);
 assert.match((await r.json()).error.message,/pinned wallet/);
 assert.equal(t.g.st.payments.length,0);
 await t.done();
});

test("only OpenClaw can use the proxy: token required, browser requests refused",async()=>{
 const t=await setup();
 const noTok=await fetch(t.p.baseUrl+"/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(BODY)});
 assert.equal(noTok.status,401);
 const browser=await t.call(BODY,{origin:"https://evil.example"});
 assert.equal(browser.status,403);
 assert.equal(t.g.st.quotes,0,"nothing reached the gateway");
 await t.done();
});

test("gateway re-quote after payment: paid once more at the new price; a refunded failure is not counted",async()=>{
 const t=await setup({requote:1});
 const r=await t.call(BODY);
 assert.equal(r.status,200);
 assert.equal(t.g.st.lastPaidValue,"19500");
 await t.done();
 const f=await setup({status:502});
 const before=BigInt(readSpend().dayMicro);
 const r2=await f.call(BODY);
 assert.equal(r2.status,502);
 assert.match((await r2.json()).error.message,/refunded/);
 assert.equal(BigInt(readSpend().dayMicro),before,"refunded call not counted as spent");
 await f.done();
});

test("models list and health",async()=>{
 const t=await setup();
 const m=await (await fetch(t.p.baseUrl+"/models",{headers:{authorization:"Bearer "+TOKEN}})).json();
 assert.deepEqual(m.data.map(x=>x.id),["anthropic/claude-sonnet-5.5","openai/gpt-4o-mini"]);
 const h=await (await fetch(t.p.baseUrl.replace("/v1","/health"),{headers:{authorization:"Bearer "+TOKEN}})).json();
 await t.done();
 assert.equal(h.ok,true);
 assert.equal(h.wallet,privateKeyToAccount(KEY).address);
});

test("gatewayBody: limits and shapes",()=>{
 const b=gatewayBody({model:"model-access/openai/gpt-5.5",messages:[{role:"user",content:"x"}],max_completion_tokens:99999,stream:true,store:false,tools:[]});
 assert.deepEqual(b,{model:"openai/gpt-5.5",messages:[{role:"user",content:"x"}],max_tokens:16384,stream:false});
 assert.throws(()=>gatewayBody({messages:[]}),/model/);
 const sse=toSSE({id:"x",model:"m",created:1,choices:[{index:0,message:{role:"assistant",content:"hi"},finish_reason:"stop"}]});
 assert.ok(sse.endsWith("data: [DONE]\n\n"));
});

// ---------------- review fixes (14/10/2026): spend counted at signing, credited back only when not charged ----------------
const {paidCompletion}=await import("../proxy.js");
test("spend is counted when signed: a 500 after payment stays counted, 503 charged:false is credited back",async()=>{
 const t=await setup({status:500,errorBody:{error:"internal"}});
 const before=BigInt(readSpend().dayMicro);
 assert.equal((await t.call(BODY)).status,500);
 assert.equal(BigInt(readSpend().dayMicro)-before,19000n,"uncertain outcome: counted");
 await t.done();
 const u=await setup({status:503,errorBody:{error:"preflight failed",charged:false}});
 const b2=BigInt(readSpend().dayMicro);
 assert.equal((await u.call(BODY)).status,503);
 assert.equal(BigInt(readSpend().dayMicro),b2,"gateway said not charged: credited back");
 await u.done();
});

test("a connection lost after signing leaves the payment counted",async()=>{
 const g=await mockGateway();
 const {createPayer}=await import("../proxy.js");
 let n=0;
 const fetcher=async(url,init)=>{n++;if(n===1)return fetch(url,init);throw Error("socket hang up");};
 const before=BigInt(readSpend().dayMicro);
 await assert.rejects(paidCompletion({model:"openai/gpt-4o-mini",messages:[{role:"user",content:"x"}],max_tokens:5,stream:false},
  {gateway:g.url,payTo:PAY_TO,maxPerCallMicro:500000n,maxPerDayMicro:BigInt(readSpend().dayMicro)+10000000n,payer:createPayer(KEY),fetcher,reserved:{value:0n}}),/hang up/);
 assert.equal(BigInt(readSpend().dayMicro)-before,19000n);
 await g.close();
});

test("re-quotes never take one request above the per-call limit",async()=>{
 const t=await setup({price:300000,requote:1},{perCall:500000n,perDay:BigInt(readSpend().dayMicro)+5000000n});
 // first signature 0.30 refused by the gateway (402 re-quote, credited back), second at 0.3005 is within 0.50
 const r=await t.call(BODY);
 assert.equal(r.status,200);
 assert.equal(t.g.st.payments.length,2);
 await t.done();
});

test("Permit2 transfers and long-lived authorizations are refused",async()=>{
 const a=await setup({method:"permit2"});
 const r=await a.call(BODY);
 assert.equal(r.status,502);
 assert.match((await r.json()).error.message,/transfer method/);
 assert.equal(a.g.st.payments.length,0);
 await a.done();
 const b=await setup({ttl:86400});
 const r2=await b.call(BODY);
 assert.equal(r2.status,502);
 assert.match((await r2.json()).error.message,/validity/);
 await b.done();
});

test("health: no details without the token; proof of identity with a challenge",async()=>{
 const {createHmac}=await import("node:crypto");
 const t=await setup();
 const base=t.p.baseUrl.replace("/v1","");
 const anon=await (await fetch(base+"/health")).json();
 assert.deepEqual(anon,{ok:true});
 const ch="ab".repeat(16);
 const proof=await (await fetch(base+"/health?challenge="+ch)).json();
 assert.equal(proof.proof,createHmac("sha256",TOKEN).update(ch).digest("hex"));
 const full=await (await fetch(base+"/health",{headers:{authorization:"Bearer "+TOKEN}})).json();
 assert.equal(full.wallet,privateKeyToAccount(KEY).address);
 await t.done();
});

test("settings: an unreadable cap stops the proxy instead of falling back to the default",async()=>{
 const {settings}=await import("../state.js");
 assert.throws(()=>settings({maxPerDayUsd:"1,5"}),/maxPerDayUsd/);
 assert.throws(()=>settings({maxPerCallUsd:0}),/maxPerCallUsd/);
 assert.equal(settings({maxPerDayUsd:2}).maxPerDayMicro,2000000n);
});
