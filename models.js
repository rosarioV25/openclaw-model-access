// OpenClaw model rows for the provider block. The list comes from the gateway's free GET /models (cached on
// disk for offline starts); a short built-in list is used only before the first successful read.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {stateDir,PROVIDER_ID} from "./state.js";

export const FALLBACK_MODELS=[
 {id:"anthropic/claude-sonnet-5.5",name:"Claude Sonnet 5.5"},{id:"anthropic/claude-opus-5.5",name:"Claude Opus 5.5"},
 {id:"openai/gpt-5.5",name:"GPT-5.5"},{id:"google/gemini-3.1-pro",name:"Gemini 3.1 Pro"},{id:"moonshot/kimi-k3",name:"Kimi K3"},
 {id:"xai/grok-4.7",name:"Grok 4.7"},{id:"zai/glm-5.3",name:"GLM 5.3"},{id:"deepseek/deepseek-chat",name:"DeepSeek Chat"},
 {id:"openai/gpt-4o-mini",name:"GPT-4o mini"}];
// Good agent models first in pickers; also the default suggested by `setup`.
export const PREFERRED=["anthropic/claude-sonnet-5.5","google/gemini-3.1-pro","openai/gpt-5.5","moonshot/kimi-k3","zai/glm-5.3"];
const cacheFile=()=>join(stateDir(),"models.json");

export function cachedModels(){
 try{if(existsSync(cacheFile())){const d=JSON.parse(readFileSync(cacheFile(),"utf8"));if(Array.isArray(d)&&d.length)return d;}}catch{}
 return FALLBACK_MODELS;
}
export async function fetchModels(gateway,fetcher=fetch){
 const r=await fetcher(gateway+"/models",{signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error("gateway /models HTTP "+r.status);
 const d=await r.json();
 const list=(d.models||d.data||[]).filter(m=>typeof m?.id==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9._/:-]{1,140}$/.test(m.id))
  .map(m=>({id:m.id,name:typeof m.name==="string"&&m.name?m.name.slice(0,80):m.id}));
 if(!list.length)throw Error("gateway returned no models");
 try{mkdirSync(stateDir(),{recursive:true});writeFileSync(cacheFile(),JSON.stringify(list));}catch{}
 return list;
}
// Per-request pricing (x402), so OpenClaw's per-token cost fields stay 0. contextTokens keeps every request under
// the gateway's 384 KB body limit; OpenClaw compacts the session before reaching it.
export function modelRow(m,{contextTokens=60000}={}){
 return {id:m.id,name:(m.name||m.id)+" · x402",reasoning:false,input:["text"],
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,contextTokens,maxTokens:8192,
  compat:{maxTokensField:"max_tokens",supportsStore:false,supportsDeveloperRole:false,supportsPromptCacheKey:false,
   supportsUsageInStreaming:true,requiresStringContent:true,supportsTools:true}};
}
export function sortModels(list){
 const rank=(id)=>{const i=PREFERRED.indexOf(id);return i<0?PREFERRED.length:i;};
 return [...list].sort((a,b)=>rank(a.id)-rank(b.id)||a.id.localeCompare(b.id));
}
export function providerBlock({port,token,models,contextTokens}){
 return {baseUrl:"http://127.0.0.1:"+port+"/v1",apiKey:token,api:"openai-completions",timeoutSeconds:240,
  models:sortModels(models).map(m=>modelRow(m,{contextTokens}))};
}
export const qualified=(id)=>PROVIDER_ID+"/"+id;
