// OpenClaw plugin entry (package.json "openclaw.extensions"). OpenClaw calls register() several times per start
// (discovery, activation, sessions): registration is idempotent and the local proxy starts once per process,
// as a plugin service, only in the Gateway's full runtime.
import {randomBytes,createHmac} from "node:crypto";
import {PLUGIN_ID,PROVIDER_ID,settings,resolveWalletKey,proxyToken} from "./state.js";
import {cachedModels,fetchModels,providerBlock,modelRow} from "./models.js";
import {startProxy} from "./proxy.js";

const g=globalThis;
const KEY="__openclawModelAccess";
const shared=()=>(g[KEY]??={proxy:null,starting:null});

export function buildProvider(cfg={}){
 const st=()=>settings(cfg);
 const block=(models)=>{const s=st();return providerBlock({port:s.port,token:proxyToken(),models,contextTokens:s.contextTokens});};
 return {
  id:PROVIDER_ID,
  label:"Model Access (x402, USDC on Base)",
  docsPath:"https://github.com/rosarioV25/openclaw-model-access#readme",
  envVars:["MODEL_ACCESS_WALLET_KEY"],
  // No provider credential: the local proxy pays every request from the plugin wallet. OpenClaw still wants an
  // API key for the provider: the synthetic one is the local proxy token (never a payment secret).
  auth:[],
  resolveSyntheticAuth:()=>({apiKey:proxyToken(),source:"local x402 proxy (pays from the plugin wallet)",mode:"api-key"}),
  // Called just before every inference: makes sure the paying proxy is up in THIS process. Embedded runs
  // (`openclaw agent exec`, `agent --local`) do not start plugin services; in the Gateway it is already running.
  prepareRuntimeAuth:async(ctx)=>{
   await ensureProxy(cfg,(m)=>console.error(m));
   return {apiKey:ctx?.apiKey||proxyToken()};
  },
  buildMissingAuthMessage:()=>"Run `npx openclaw-model-access setup` to create the wallet and the local proxy token, then fund the wallet with USDC on Base.",
  // Older hosts read a static `models` block; newer hosts call catalog.run().
  get models(){return block(cachedModels());},
  catalog:{order:"simple",run:async()=>{
   let models=cachedModels();
   try{models=await fetchModels(st().gateway);}catch{}
   return {provider:block(models)};
  }},
  // Any id the gateway sells works even if it is not in the cached list yet.
  resolveDynamicModel:(ctx)=>{
   const s=st();
   return {...modelRow({id:ctx.modelId,name:ctx.modelId},{contextTokens:s.contextTokens}),provider:PROVIDER_ID,
    api:"openai-completions",baseUrl:"http://127.0.0.1:"+s.port+"/v1"};
  },
 };
}

export async function ensureProxy(cfg={},log=()=>{}){
 const sh=shared();
 if(sh.proxy)return sh.proxy;
 if(sh.starting)return sh.starting;
 sh.starting=(async()=>{
  const s=settings(cfg);
  const walletKey=resolveWalletKey(cfg);
  let p;
  // unref: the listener never keeps a finished CLI run alive (open requests still do).
  try{p=await startProxy({...s,token:proxyToken(),walletKey,log,unref:true});}
  catch(e){
   // Port taken: another OpenClaw process (the Gateway, or a CLI run) already runs the proxy.
   if(e?.code!=="EADDRINUSE")throw e;
   // Only a listener that knows the token (i.e. our proxy, started by another OpenClaw process of this user)
   // can answer the challenge; anything else on the port is never sent prompts or the token.
   const challenge=randomBytes(16).toString("hex");
   const h=await fetch("http://127.0.0.1:"+s.port+"/health?challenge="+challenge,{signal:AbortSignal.timeout(3000)}).then(r=>r.json()).catch(()=>null);
   const expected=createHmac("sha256",proxyToken()).update(challenge).digest("hex");
   if(!h?.ok||h.proof!==expected)throw Error("port "+s.port+" is used by another program: set plugins.entries."+PLUGIN_ID+".config.port");
   log("[model-access] proxy already running on port "+s.port+" (another OpenClaw process)");
   return {port:s.port,baseUrl:"http://127.0.0.1:"+s.port+"/v1",wallet:h.wallet,external:true,close:async()=>{}};
  }
  sh.proxy=p;
  log("[model-access] proxy on "+p.baseUrl+(p.wallet?" · wallet "+p.wallet:" · NO WALLET: run `openclaw-model-access setup`"));
  return p;
 })();
 try{return await sh.starting;}finally{sh.starting=null;}
}
export async function stopProxy(){
 const sh=shared();
 const p=sh.proxy;sh.proxy=null;
 if(p)await p.close();
}

const plugin={
 id:PLUGIN_ID,
 name:"Model Access (x402)",
 description:"130+ AI models with tool calling, paid per request in USDC on Base via x402 from a local wallet, with spending limits.",
 register(api){
  const cfg=api.pluginConfig||{};
  api.registerProvider(buildProvider(cfg));
  if(api.registrationMode&&api.registrationMode!=="full")return;
  // One service per registry generation; the proxy itself is shared by the process (ensureProxy is idempotent).
  const log=(m)=>api.logger?.info?.(m);
  api.registerService({
   id:"model-access-proxy",
   start:async()=>{await ensureProxy(cfg,log);},
   stop:async()=>{await stopProxy();},
  });
 },
};
export default plugin;
