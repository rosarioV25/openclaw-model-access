#!/usr/bin/env node
// openclaw-model-access <command>
//   setup [--write] [--default <model>] [--port N]   wallet + proxy token; prints (or merges) the openclaw.json block
//   wallet                                            wallet address and USDC balance on Base (read only)
//   doctor                                            configuration, gateway, proxy and spending check
//   proxy [--port N]                                  run the paying proxy alone, for any OpenAI-compatible client
//   spend                                             what the proxy has paid so far
import {existsSync,readFileSync,writeFileSync,statSync,chmodSync,renameSync,realpathSync,mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {PLUGIN_ID,PROVIDER_ID,DEFAULT_PORT,settings,resolveWalletKey,generateWallet,proxyToken,readSpend,walletFile,
 openclawConfigFile,readPluginConfig,tokenFile} from "./state.js";
import {fetchModels,cachedModels,providerBlock,PREFERRED,qualified} from "./models.js";
import {startProxy,USDC} from "./proxy.js";

const args=process.argv.slice(2);
const cmd=args[0]||"help";
const opt=(k)=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
const has=(k)=>args.includes(k);
const out=(s="")=>process.stdout.write(s+"\n");
const usd=(micro)=>"$"+(Number(micro)/1e6).toFixed(4);
const RPC=process.env.MODEL_ACCESS_BASE_RPC||"https://mainnet.base.org";

async function usdcBalance(address){
 const data="0x70a08231"+address.toLowerCase().replace(/^0x/,"").padStart(64,"0");
 const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(15000),
  body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:USDC,data},"latest"]})});
 const j=await r.json();
 if(!/^0x[0-9a-f]*$/i.test(j?.result||""))throw Error("RPC answer invalid");
 return BigInt(j.result);
}

// Merge only our keys into openclaw.json; anything else in the file is kept as is.
export function mergeConfig(existing,{port,token,models,contextTokens,defaultModel}){
 const t=existing&&typeof existing==="object"&&!Array.isArray(existing)?existing:{};
 t.models??={};t.models.providers??={};
 t.models.providers[PROVIDER_ID]=providerBlock({port,token,models,contextTokens});
 t.plugins??={};t.plugins.entries??={};
 const entry=t.plugins.entries[PLUGIN_ID]??={};
 entry.enabled??=true;
 // The proxy reads its port from here and OpenClaw dials baseUrl: both always written together.
 if(port!==DEFAULT_PORT)entry.config={...(entry.config||{}),port};
 else if(entry.config&&"port" in entry.config){const {port:_p,...rest}=entry.config;entry.config=rest;}
 if(defaultModel){
  t.agents??={};t.agents.defaults??={};
  t.agents.defaults.model={...(t.agents.defaults.model||{}),primary:qualified(defaultModel)};
 }
 return t;
}

async function setup(){
 const cfg=readPluginConfig();
 const port=Number(opt("--port"))||Number(cfg.port)||DEFAULT_PORT;
 const s=settings({...cfg,port});
 let w=null;
 if(resolveWalletKey(cfg)){
  const {privateKeyToAccount}=await import("viem/accounts");
  out("wallet: already configured ("+privateKeyToAccount(resolveWalletKey(cfg)).address+")");
 }
 else{
  w=await generateWallet();
  out("A new wallet was created for paying the models:");
  out("  address: "+w.address);
  out("  key file: "+walletFile()+" (only copy: back it up somewhere safe)");
  out("Send USDC on Base (network eip155:8453) to that address. $2-5 is enough to start: a short call costs from $0.002.");
 }
 const token=proxyToken();
 let models=cachedModels();
 try{models=await fetchModels(s.gateway);out("gateway: "+models.length+" models on sale");}
 catch(e){out("gateway not reachable now ("+e.message+"): using the "+models.length+" models known offline");}
 const def=opt("--default");
 if(def&&!models.some(m=>m.id===def.replace(PROVIDER_ID+"/","")))out("warning: "+def+" is not in the gateway's list right now");
 const block={port,token,models,contextTokens:s.contextTokens,defaultModel:def?def.replace(PROVIDER_ID+"/",""):null};
 const file=openclawConfigFile();
 if(!has("--write")){
  out("\nAdd this to "+file+" (or run again with --write):");
  out(JSON.stringify(mergeConfig({},block),null,2));
  return 0;
 }
 let existing={};
 if(existsSync(file)){
  try{existing=JSON.parse(readFileSync(file,"utf8"));}
  catch{out(file+" is JSON5 (comments?): not touching it. Add this block by hand:");out(JSON.stringify(mergeConfig({},block),null,2));return 2;}
 }
 let mode=0o600;try{if(existsSync(file))mode=statSync(file).mode&0o777;}catch{}
 mkdirSync(dirname(file),{recursive:true});
 const tmp=file+"."+process.pid+".tmp";
 writeFileSync(tmp,JSON.stringify(mergeConfig(existing,block),null,2)+"\n",{mode});
 try{chmodSync(tmp,mode);}catch{}
 renameSync(tmp,file);
 out("wrote provider \""+PROVIDER_ID+"\" ("+models.length+" models) into "+file+(block.defaultModel?" · default model "+qualified(block.defaultModel):""));
 out("next: openclaw gateway restart   then pick a model such as "+qualified(PREFERRED[0]));
 return 0;
}

async function main(){
 if(cmd==="help"||has("--help")){
  out("openclaw-model-access setup [--write] [--default <model>] [--port N] | wallet | doctor | proxy [--port N] | spend");
  return 0;
 }
 if(cmd==="setup")return setup();
 if(cmd==="wallet"){
  const pk=resolveWalletKey(readPluginConfig());
  if(!pk){out("no wallet: run `openclaw-model-access setup`");return 2;}
  const {privateKeyToAccount}=await import("viem/accounts");
  const address=privateKeyToAccount(pk).address;
  out("address: "+address);
  try{const b=await usdcBalance(address);out("USDC on Base: "+usd(b));if(b===0n)out("fund it: send USDC on Base to "+address);}
  catch(e){out("balance not readable now: "+e.message);}
  return 0;
 }
 if(cmd==="spend"){
  const s=readSpend();
  out("today "+usd(s.dayMicro)+" · total "+usd(s.totalMicro)+" · paid calls "+s.calls+(s.lastAt?" · last "+s.lastAt:""));
  return 0;
 }
 if(cmd==="doctor"){
  const cfg=readPluginConfig();
  const s=settings({...cfg,port:Number(opt("--port"))||cfg.port});
  out("gateway: "+s.gateway+" · pinned payee "+s.payTo);
  out("limits: "+usd(s.maxPerCallMicro)+" per call, "+usd(s.maxPerDayMicro)+" per day");
  const pk=resolveWalletKey(cfg);
  if(pk){const {privateKeyToAccount}=await import("viem/accounts");out("wallet: "+privateKeyToAccount(pk).address);}else out("wallet: none (run setup)");
  try{const m=await fetchModels(s.gateway);out("gateway models: "+m.length);}catch(e){out("gateway: NOT reachable ("+e.message+")");}
  try{const r=await fetch("http://127.0.0.1:"+s.port+"/health",{signal:AbortSignal.timeout(3000),headers:{authorization:"Bearer "+proxyToken()}});const h=await r.json();
   out("local proxy: running on port "+s.port+(h.spentTodayUsd!==undefined?" · spent today $"+h.spentTodayUsd:" (answers without our token: another program?)"));}
  catch{out("local proxy: not running (it starts with `openclaw gateway`, or run `openclaw-model-access proxy`)");}
  const sp=readSpend();out("spent: today "+usd(sp.dayMicro)+", total "+usd(sp.totalMicro));
  return 0;
 }
 if(cmd==="proxy"){
  const cfg=readPluginConfig();
  const s=settings({...cfg,port:Number(opt("--port"))||cfg.port});
  const token=proxyToken();
  const p=await startProxy({...s,token,walletKey:resolveWalletKey(cfg),log:(m)=>console.error(m)});
  out("OpenAI-compatible endpoint: "+p.baseUrl+" · limits $"+(Number(s.maxPerCallMicro)/1e6)+"/call, $"+(Number(s.maxPerDayMicro)/1e6)+"/day");
  out("API key for your client: the content of "+tokenFile());
  out(p.wallet?"paying from "+p.wallet:"NO WALLET: run `openclaw-model-access setup` first");
  await new Promise(()=>{});
 }
 console.error("unknown command: "+cmd);return 2;
}
function invokedDirectly(){try{return import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{return false;}}
if(invokedDirectly())main().then(c=>process.exit(c??0),e=>{console.error(e?.message||e);process.exit(1);});
