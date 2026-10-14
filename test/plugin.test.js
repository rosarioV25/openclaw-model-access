import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile);
import {readFileSync,writeFileSync,existsSync,statSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {mockGateway,freshHome} from "./helpers.js";

const home=freshHome();
const plugin=(await import("../index.js")).default;
const {ensureProxy,stopProxy}=await import("../index.js");
const {mergeConfig}=await import("../cli.js");
const CLI=fileURLToPath(new URL("../cli.js",import.meta.url));

function fakeApi(pluginConfig={},registrationMode="full"){
 const got={providers:[],services:[]};
 return {got,api:{id:"openclaw-model-access",pluginConfig,registrationMode,logger:{info(){},warn(){},error(){}},
  registerProvider:(p)=>got.providers.push(p),registerService:(s)=>got.services.push(s)}};
}

test("manifest, package.json and entry agree on the ids",()=>{
 const man=JSON.parse(readFileSync(new URL("../openclaw.plugin.json",import.meta.url)));
 const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url)));
 assert.equal(man.id,pkg.name,"OpenClaw requires manifest id == npm package name");
 assert.equal(plugin.id,man.id);
 assert.deepEqual(man.providers,["model-access"]);
 assert.deepEqual(pkg.openclaw.extensions,["./index.js"]);
 for(const f of pkg.openclaw.extensions)assert.ok(pkg.files.includes(f.replace("./","")));
});

test("register: provider with a local baseUrl; the proxy service only in the full runtime",async()=>{
 const g=await mockGateway();
 const disc=fakeApi({gateway:g.url},"discovery");
 plugin.register(disc.api);
 assert.equal(disc.got.providers.length,1);
 assert.equal(disc.got.services.length,0,"no listener during discovery");
 const full=fakeApi({gateway:g.url,port:18423});
 plugin.register(full.api);
 const prov=full.got.providers[0];
 assert.equal(prov.id,"model-access");
 assert.deepEqual(prov.auth,[]);
 const cat=await prov.catalog.run({});
 assert.equal(cat.provider.baseUrl,"http://127.0.0.1:18423/v1");
 assert.equal(cat.provider.api,"openai-completions");
 assert.match(cat.provider.apiKey,/^[a-f0-9]{48}$/);
 assert.deepEqual(cat.provider.models.map(m=>m.id),["anthropic/claude-sonnet-5.5","openai/gpt-4o-mini"],"live list from the gateway");
 assert.equal(cat.provider.models[0].compat.requiresStringContent,true);
 const dyn=prov.resolveDynamicModel({modelId:"xai/grok-4.7"});
 assert.equal(dyn.baseUrl,"http://127.0.0.1:18423/v1");
 assert.equal(full.got.services[0].id,"model-access-proxy");
 await full.got.services[0].start({});
 await full.got.services[0].start({});            // idempotent: no EADDRINUSE
 const {proxyToken}=await import("../state.js");
 const h=await (await fetch("http://127.0.0.1:18423/health",{headers:{authorization:"Bearer "+proxyToken()}})).json();
 await full.got.services[0].stop();
 assert.equal(h.ok,true);
 assert.equal(h.wallet,null,"no wallet yet in this fresh home");
 await assert.rejects(fetch("http://127.0.0.1:18423/health",{signal:AbortSignal.timeout(1000)}));
 await g.close();
});

test("cli setup --write: creates the wallet (0600), the token and merges openclaw.json without touching other keys",async()=>{
 const g=await mockGateway();
 const cfgFile=join(home,"openclaw.json");
 writeFileSync(cfgFile,JSON.stringify({gateway:{port:18789},models:{providers:{other:{baseUrl:"https://x/v1"}}}},null,2));
 const env={...process.env,MODEL_ACCESS_GATEWAY:g.url};
 const {stdout:out}=await run(process.execPath,[CLI,"setup","--write","--default","anthropic/claude-sonnet-5.5"],{env,encoding:"utf8"});
 assert.match(out,/address: 0x[0-9a-fA-F]{40}/);
 const wallet=join(process.env.MODEL_ACCESS_HOME,"wallet.key");
 assert.ok(existsSync(wallet));
 if(process.platform!=="win32")assert.equal(statSync(wallet).mode&0o777,0o600);
 const cfg=JSON.parse(readFileSync(cfgFile,"utf8"));
 assert.equal(cfg.gateway.port,18789,"unrelated settings kept");
 assert.ok(cfg.models.providers.other,"other providers kept");
 const mine=cfg.models.providers["model-access"];
 assert.equal(mine.baseUrl,"http://127.0.0.1:8423/v1");
 assert.equal(mine.models.length,2,"live list read from the gateway");
 assert.equal(cfg.agents.defaults.model.primary,"model-access/anthropic/claude-sonnet-5.5");
 assert.equal(cfg.plugins.entries["openclaw-model-access"].enabled,true);
 // A second setup never replaces the wallet.
 const key1=readFileSync(wallet,"utf8");
 await run(process.execPath,[CLI,"setup","--write"],{env,encoding:"utf8"});
 assert.equal(readFileSync(wallet,"utf8"),key1);
 await g.close();
});

test("ensureProxy uses the wallet created by setup",async()=>{
 const g=await mockGateway();
 const p=await ensureProxy({gateway:g.url,port:18424});
 assert.match(p.wallet,/^0x[0-9a-fA-F]{40}$/);
 await stopProxy();
 await g.close();
});

test("mergeConfig on an empty file",()=>{
 const c=mergeConfig({},{port:9999,token:"t",models:[{id:"a/b",name:"B"}],contextTokens:60000,defaultModel:null});
 assert.equal(c.plugins.entries["openclaw-model-access"].config.port,9999);
 assert.equal(c.models.providers["model-access"].models[0].id,"a/b");
 assert.equal(c.agents,undefined);
});

test("prepareRuntimeAuth starts the proxy in this process (embedded runs) and returns the token as key",async()=>{
 const g=await mockGateway();
 const {api,got}=fakeApi({gateway:g.url,port:18425},"full");
 plugin.register(api);
 const prov=got.providers[0];
 const syn=prov.resolveSyntheticAuth({});
 assert.match(syn.apiKey,/^[a-f0-9]{48}$/);
 const auth=await prov.prepareRuntimeAuth({apiKey:syn.apiKey});
 assert.equal(auth.apiKey,syn.apiKey);
 const h=await (await fetch("http://127.0.0.1:18425/health")).json();
 assert.equal(h.ok,true);
 // A second process finding the port taken reuses the running proxy instead of failing.
 const {startProxy}=await import("../proxy.js");
 await assert.rejects(startProxy({port:18425,token:"x".repeat(48),gateway:g.url,payTo:"0xf7eaf699C6E55887184809c57d597a64aB86d493",
  maxPerCallMicro:1n,maxPerDayMicro:1n}),/EADDRINUSE/);
 await stopProxy();
 await g.close();
});

test("a foreign program on the port is never used as the proxy",async()=>{
 const http=await import("node:http");
 const impostor=http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({ok:true}));});
 await new Promise(r=>impostor.listen(18426,"127.0.0.1",r));
 await stopProxy();
 await assert.rejects(ensureProxy({port:18426}),/used by another program/);
 await new Promise(r=>impostor.close(r));
});

test("MODEL_ACCESS_WALLET_KEY is read once and removed from the environment",async()=>{
 const {resolveWalletKey}=await import("../state.js");
 const {generatePrivateKey}=await import("viem/accounts");
 const k=generatePrivateKey();
 process.env.MODEL_ACCESS_WALLET_KEY=k;
 assert.equal(resolveWalletKey({}),k);
 assert.equal(process.env.MODEL_ACCESS_WALLET_KEY,undefined,"agent tools never inherit the key");
 assert.equal(resolveWalletKey({}),k,"still available to the proxy");
});
