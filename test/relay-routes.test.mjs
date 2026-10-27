import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin, {Config} from '../lib/index.js';

const relayURL = 'https://relay.queqiaoapi.com/v1';
const officialURL = 'https://api.example.net/v1';
const config = Config['~standard'].validate({currency:'CNY'}).value;

function row(id, live, inherited={}, override={}) {
  return {entry:{options:{id, config:live}}, inherited, override};
}
function providerConfig(provider, route) { return {providers:{[provider]:route}}; }
function mount(rows, {wireRoute=false, resolveCredential=async()=>undefined, patchPath='/not-a-real-profile/cordis.patch.yml'}={}) {
  let projection, handler;
  const ctx = {
    get(name) {
      if (name === 'configEditor') return {configuration:()=>rows};
      if (name === 'settings') return {describe:()=>[]};
      if (name === 'llm') return {listProviders:()=>[]};
      if (name === 'profileContext') return {patchPath};
      if (name === 'credentials') return {resolve:resolveCredential};
      return undefined;
    },
    sessionProjections:{register(value){projection=value;}},
    inject(_services, callback) {
      if (!wireRoute) return;
      callback({
        effect(run){run();},
        webServer:{register(route){handler=route.handler;return()=>{};}},
        connection:{requestRejection:()=>undefined}
      });
    },
    logger:{warn() {}}
  };
  plugin.apply(ctx, config);
  return {projection, get handler(){return handler;}};
}
function channelFor(rows, options, provider='gpt') {
  const {projection} = mount(rows, options);
  let state = projection.init();
  const model = provider === 'deepseek-official' ? 'deepseek-flash' : 'gpt-6-sol';
  state = projection.apply(state, {type:'request/header',data:{header:{config:{provider,model}}}});
  state = projection.apply(state, {type:'assistant/message',time:Date.parse('2026-10-27T03:00:00Z'),data:{turn:1,step:1,message:{id:'m'},usage:{inputTokens:10,outputTokens:10}}});
  return projection.view(state).messageCosts.m.channel;
}

test('profile URL fallback is resolved per provider regardless of sibling route order',()=>{
  const sibling = row('sibling-row',providerConfig('unused',{baseURL:relayURL,apiKeyEnv:'SIBLING_KEY'}));
  const target = row('target-row',providerConfig('gpt',{apiKeyEnv:'TARGET_KEY'}),providerConfig('gpt',{baseURL:relayURL,apiKeyEnv:'INHERITED_KEY'}));
  assert.equal(channelFor([sibling,target]),'relay');
  assert.equal(channelFor([target,sibling]),'relay');
});

test('route baseURL precedence is live then override then inherited',()=>{
  const liveWins = row('gpt-live',
    providerConfig('gpt',{baseURL:officialURL,apiKeyEnv:'LIVE_KEY'}),
    providerConfig('gpt',{baseURL:relayURL}),
    providerConfig('gpt',{baseURL:relayURL}));
  const overrideWins = row('gpt-override',
    providerConfig('gpt',{apiKeyEnv:'LIVE_KEY'}),
    providerConfig('gpt',{baseURL:relayURL}),
    providerConfig('gpt',{baseURL:officialURL}));
  const inheritedFills = row('gpt-inherited',
    providerConfig('gpt',{apiKeyEnv:'LIVE_KEY'}),
    providerConfig('gpt',{baseURL:relayURL}),
    providerConfig('gpt',{}));
  assert.equal(channelFor([liveWins]),'official');
  assert.equal(channelFor([overrideWins]),'official');
  assert.equal(channelFor([inheritedFills]),'relay');
  const overrideRelay = row('gpt-override-relay',
    providerConfig('gpt',{apiKeyEnv:'LIVE_KEY'}),
    providerConfig('gpt',{baseURL:officialURL}),
    providerConfig('gpt',{baseURL:relayURL}));
  assert.equal(channelFor([overrideRelay]),'relay');
});

test('inherited route settings reach the relay balance endpoint',async()=>{
  const target = row('gpt-row',
    providerConfig('gpt',{apiKeyEnv:'LIVE_KEY'}),
    providerConfig('gpt',{baseURL:relayURL,apiKeyEnv:'INHERITED_KEY'}));
  const mounted = mount([target],{wireRoute:true,resolveCredential:async()=>undefined});
  const response = {statusCode:0,headers:{},setHeader(name,value){this.headers[name]=value;},end(body){this.body=body;}};
  await mounted.handler({method:'GET',url:'/peak-indicator/relay?provider=gpt'},response);
  assert.equal(response.statusCode,200);
  const body = JSON.parse(response.body);
  assert.equal(body.status,'no-key');
  assert.equal(body.baseURL,relayURL);
  assert.equal(body.keyRef,'LIVE_KEY');
});

test('patch fallback ignores top-level URL fields after the providers section',()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'peak-relay-routes-'));
  const patchPath = path.join(dir,'cordis.patch.yml');
  try {
    fs.writeFileSync(patchPath,'providers:\n  gpt:\n    apiKeyEnv: GPT_KEY\notherSection:\n  baseURL: https://relay.queqiaoapi.com/v1\n  apiKeyEnv: WRONG_KEY\n');
    const target = row('gpt-row',providerConfig('gpt',{}));
    assert.equal(channelFor([target],{patchPath}), 'official');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('patch fallback limits single-adapter URL to its config block',()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'peak-relay-routes-'));
  const patchPath = path.join(dir,'cordis.patch.yml');
  try {
    fs.writeFileSync(patchPath,[
      '- insert:',
      '    - id: llm-deepseek',
      "      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
      '      config:',
      '        apiKeyEnv: DEEPSEEK_API_KEY',
      '- update:',
      '    id: unrelated-settings',
      '    config:',
      '      baseURL: https://relay.queqiaoapi.com/v1',
      '      apiKeyEnv: WRONG_KEY',
      ''
    ].join('\n'));
    const target = row('deepseek-row',providerConfig('deepseek-official',{apiKeyEnv:'LIVE_KEY'}));
    assert.equal(channelFor([target],{patchPath},'deepseek-official'), 'official');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('patch fallback ignores URL fields on unrecognized plugin IDs',()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'peak-relay-routes-'));
  const patchPath = path.join(dir,'cordis.patch.yml');
  try {
    fs.writeFileSync(patchPath,[
      '- insert:',
      '    - id: some-other-plugin',
      '      config:',
      '        baseURL: https://relay.queqiaoapi.com/v1',
      '        apiKeyEnv: WRONG_KEY',
      ''
    ].join('\n'));
    const target = row('deepseek-row',providerConfig('deepseek-official',{}));
    assert.equal(channelFor([target],{patchPath},'deepseek-official'), 'official');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('patch fallback reads single-adapter URL from its config block',()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'peak-relay-routes-'));
  const patchPath = path.join(dir,'cordis.patch.yml');
  try {
    fs.writeFileSync(patchPath,[
      '- insert:',
      '    - id: llm-deepseek',
      "      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
      '      config:',
      '        baseURL: https://relay.queqiaoapi.com/v1',
      ''
    ].join('\n'));
    const target = row('deepseek-row',providerConfig('deepseek-official',{}));
    assert.equal(channelFor([target],{patchPath},'deepseek-official'), 'relay');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('live apiKeyEnv is preserved when a profile override supplies the missing baseURL',async()=>{
  let resolvedRef;
  const target = row(
    'target-row',
    providerConfig('target',{apiKeyEnv:'TARGET_LIVE_KEY'}),
    providerConfig('target',{baseURL:officialURL,apiKeyEnv:'INHERITED_KEY'}),
    providerConfig('target',{baseURL:relayURL,apiKeyEnv:'OVERRIDE_KEY'})
  );
  const mounted = mount([target],{wireRoute:true,resolveCredential:async ref=>{resolvedRef=ref;return undefined;}});
  assert.equal(typeof mounted.handler,'function');
  const response = {statusCode:0,headers:{},setHeader(name,value){this.headers[name]=value;},end(body){this.body=body;}};
  await mounted.handler({method:'GET',url:'/peak-indicator/relay?provider=target'},response);
  assert.equal(resolvedRef,'TARGET_LIVE_KEY');
  assert.equal(response.statusCode,200);
  const body = JSON.parse(response.body);
  assert.equal(body.status,'no-key');
  assert.equal(body.keyRef,'TARGET_LIVE_KEY');
  assert.equal(body.baseURL,relayURL);
});
