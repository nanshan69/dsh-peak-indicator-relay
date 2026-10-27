import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Context} from '@deepseek-ai/cordis';
const require=createRequire(import.meta.url);
function load(fetchImpl=globalThis.fetch){let client;vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:d=>{client=d.factory(require)}}},fetch:fetchImpl,Date,URLSearchParams,setInterval,clearInterval});return client;}
const client=load();
const t=(key,args={})=>(client.zh[key]??key).replace(/\{(\w+)\}/g,(_,k)=>args[k]??'');
const store=value=>({getSnapshot:()=>value,subscribe:()=>()=>{},refresh:async()=>{}});
const ready={status:'ready',total:'¥12.34',recharge:'¥10.00',bonus:'¥2.34'};
function header(provider,balance=store(ready),totalCost=0.28){
 return renderToStaticMarkup(React.createElement(client.PeakBadge,{t,balance,directory:store({status:'ready',current:null}),useProjection:key=>key==='peakCost'?{currency:'CNY',totalCost}:{next:provider?{provider,model:'deepseek-flash'}:null,lastUsed:null}}));
}
function turnCost(cost,currency='CNY'){
 return turnCostEntries({m:{provider:'gpt',model:'gpt-6-astra',turn:1,cost}},'m',currency);
}
function turnCostEntries(messageCosts,messageId='m',currency='CNY'){
 return renderToStaticMarkup(React.createElement(client.TurnCost,{messageId,t,useProjection:()=>({currency,messageCosts})}));
}
test('balance is a separate account-qualified badge after the peak badge',()=>{
 const html=header('deepseek-official');
 assert.match(html,/class="dsh-peak-indicator-header"/);
 assert.ok(html.indexOf('class="dsh-peak-indicator-balance"')>html.indexOf('class="dsh-peak-indicator-badge"'));
 assert.match(html,/账户余额 ¥12.34/);assert.match(html,/DSH 登录账户 · 充值 ¥10.00 · 赠金 ¥2.34/);
});
test('account balance remains visible on account, API-key, third-party and unknown routes',()=>{
 for(const provider of ['deepseek-account','deepseek-official','openai',undefined])assert.match(header(provider),/账户余额 ¥12.34/,String(provider));
});
test('loading, login, error and no-wallet states remain visible and do not invent zero balances',()=>{
 for(const [status,text]of [['loading','账户余额加载中…'],['signed-out','账户余额：未登录'],['failed','账户余额：读取失败'],['unavailable','账户余额：暂不可用'],['no-cny','账户余额：无人民币钱包']]){
  const html=header('deepseek-official',store({status}));
  assert.match(html,/dsh-peak-indicator-balance/);assert.ok(html.includes(text));assert.doesNotMatch(html,/¥0\.00/);
  if(status==='signed-out')assert.match(html,/请先在 DSH 设置中登录 DeepSeek 账户/);
 }
 const zero=header('deepseek-official',store({...ready,total:'¥0.00',recharge:'¥0.00',bonus:'¥0.00'}));assert.match(zero,/账户余额 ¥0.00/);
});
test('a missing balance service still renders an explicit badge',()=>{
 const html=renderToStaticMarkup(React.createElement(client.PeakBadge,{t,directory:null,useProjection:key=>key==='peakCost'?{currency:'CNY',totalCost:0.28}:undefined}));
 assert.match(html,/账户余额：暂不可用/);assert.match(html,/DSH 账户余额接口暂不可用/);
});
test('session and turn costs keep positive sub-cent estimates visible',()=>{
 for(const amount of ['0.001','0.0049','0.005']){
  const value=Number(amount);
  const expected=value<0.01?amount:value.toFixed(2);
  assert.match(header('gpt',store(ready),value),new RegExp('¥'+expected.replace('.','\\.')));
  assert.match(turnCost(value),new RegExp('本轮 ¥'+expected.replace('.','\\.')));
 }
 assert.match(turnCost(0.001,'USD'),/本轮 \$0\.001/);
 assert.match(header('gpt',store(ready),0.000000001),/¥(?:&lt;|<)0\.00000001/);
 assert.match(turnCost(0.000000001),/本轮 ¥(?:&lt;|<)0\.00000001/);
});
test('turn cost aggregates failed attempts with a successful retry',()=>{
 const markup=turnCostEntries({
  'attempt:19':{provider:'gpt',model:'gpt-6-sol',turn:1,cost:0.000208},
  success:{provider:'gpt',model:'gpt-6-sol',turn:1,cost:0.000364}
 },'success');
 assert.match(markup,/本轮 ¥0\.000572/);
});
test('TurnCost has no cost entry to render for a failed-only attempt',()=>{
 const markup=turnCostEntries({
  'attempt:19':{provider:'gpt',model:'gpt-6-sol',turn:1,cost:0.000208}
 },'no-assistant-message');
 assert.equal(markup,'');
});
test('a forced relay refresh cannot be overwritten by a stale same-provider response',async()=>{
 const requests=[];
 const isolated=load(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})));
 const relay=isolated.createRelayStore();
 const response=remaining=>({ok:true,json:async()=>({kind:'relay',status:'ready',currency:'¥',remaining,total:10,used:10-remaining,provider:'gpt',prices:{}})});
 try{
  relay.update('gpt');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,1);
  const forced=relay.refresh(true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2);
  requests[1].resolve(response(9));
  await forced;
  assert.equal(relay.getSnapshot().remaining,'¥9.00');
  requests[0].resolve(response(2));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(relay.getSnapshot().remaining,'¥9.00');
 }finally{relay.dispose()}
});

test('a relay response from an earlier provider is rejected after a provider switch',async()=>{
 const requests=[];
 const isolated=load(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})));
 const relay=isolated.createRelayStore();
 const response=(provider,remaining)=>({ok:true,json:async()=>({kind:'relay',status:'ready',currency:'¥',remaining,total:10,used:10-remaining,provider,prices:{}})});
 try{
  relay.update('gpt');
  await new Promise(resolve=>setImmediate(resolve));
  relay.update('target');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2);
  requests[1].resolve(response('target',7));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(relay.getSnapshot().remaining,'¥7.00');
  requests[0].resolve(response('gpt',2));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(relay.getSnapshot().remaining,'¥7.00');
 }finally{relay.dispose()}
});

test('an ABA provider switch does not admit the first provider response',async()=>{
 const requests=[];
 const isolated=load(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})));
 const relay=isolated.createRelayStore();
 const response=remaining=>({ok:true,json:async()=>({kind:'relay',status:'ready',currency:'¥',remaining,total:10,used:10-remaining,provider:'gpt',prices:{}})});
 try{
  relay.update('gpt');
  await new Promise(resolve=>setImmediate(resolve));
  relay.update('target');
  await new Promise(resolve=>setImmediate(resolve));
  relay.update('gpt');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,3);
  requests[2].resolve(response(8));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(relay.getSnapshot().remaining,'¥8.00');
  requests[0].resolve(response(1));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(relay.getSnapshot().remaining,'¥8.00');
 }finally{relay.dispose()}
});

test('an obsolete relay request rejection cannot replace the latest successful snapshot',async()=>{
 const requests=[];
 const isolated=load(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})));
 const relay=isolated.createRelayStore();
 const response={ok:true,json:async()=>({kind:'relay',status:'ready',currency:'¥',remaining:8,total:10,used:2,provider:'gpt',prices:{}})};
 try{
  relay.update('gpt');
  await new Promise(resolve=>setImmediate(resolve));
  const forced=relay.refresh(true);
  await new Promise(resolve=>setImmediate(resolve));
  requests[1].resolve(response);
  await forced;
  requests[0].reject(new Error('stale failure'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(relay.getSnapshot().remaining,'¥8.00');
  assert.equal(relay.getSnapshot().status,'ready');
 }finally{relay.dispose()}
});

test('actual client apply connects the optional account RPC and exposes its balance to the header',async()=>{
 const ctx=new Context();const registrations=new Map();let finish,reads=0,metadata;
 const stream={async *[Symbol.asyncIterator](){yield{value:{status:'credential-stored'},accept(){}};await new Promise(resolve=>{finish=resolve})},dispose(){finish?.()}};
 const remote={account:{getBalance:async value=>{reads++;metadata=value;return{ok:true,value:{status:'ready',value:[{currency:'CNY',balance:'10'}],bonusWallets:[{currency:'CNY',balance:'2.34'}]}}}},$stream:()=>stream};
 try{
  await ctx.plugin({name:'balance-test-providers',apply(p){
   p.provide('slots',{inject:(_,fn)=>fn(),register:(options,component)=>{registrations.set(options.name,{options,component});return()=>{}}});
   p.provide('locale',{register:()=>()=>{},getSnapshot:()=>({active:'zh-CN'})});
   p.provide('modelDirectories',{directoryFor:()=>({store:store({current:{provider:'deepseek-official',model:'deepseek-flash'}}),load:async()=>{}})});
   p.provide('remote',remote);p.provide('remote.account',remote.account);
  }});
  const fiber=ctx.plugin({name:'balance-test-client',apply:client.apply,inject:client.inject});await fiber.await();
  await new Promise(resolve=>setImmediate(resolve));
  const props=registrations.get('conversation.session.header.actions').options.inject('fixture');
  assert.equal(props.balance.getSnapshot().status,'ready');assert.equal(props.balance.getSnapshot().total,'¥12.34');assert.equal(reads,1);
  assert.equal(metadata.version,'0.2.1-rc.3');assert.equal(metadata.locale,'zh-CN');
  const html=renderToStaticMarkup(React.createElement(registrations.get('conversation.session.header.actions').component,{...props,t,useProjection:key=>key==='peakCost'?{currency:'CNY',totalCost:0.28}:{next:{provider:'deepseek-official',model:'deepseek-flash'},lastUsed:null}}));
  assert.match(html,/账户余额 ¥12.34/);
 }finally{await ctx.fiber.dispose()}
});
