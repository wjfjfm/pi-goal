import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
import { GoalState, reminder } from '../dist/state.js';

test('time excludes pauses and offline time; restore validates persisted data', () => {
  let now = 0;
  const s = new GoalState(() => now);
  s.set('test'); now = 1000; s.transition('paused'); now = 5000;
  assert.equal(s.elapsed(), 1000);
  s.transition('active'); now = 6000;
  const snapshot = s.snapshot(); assert.equal(snapshot.elapsedMs, 2000);
  now = 100000; s.restore(snapshot);
  assert.equal(s.goal.status, 'paused'); assert.equal(s.elapsed(), 2000);
  s.transition('complete'); assert.equal(s.goal.status, 'complete');
  s.restore({ text: 'bad', status: 'active', elapsedMs: -1 }); assert.equal(s.goal, undefined);
  assert.match(reminder('test', 'set'), /^goal set: test/);
  assert.match(reminder('test', 'still active'), /^goal still active: test/);
});

const model = {id:'goal-test',name:'goal-test',api:'openai-completions',provider:'goal-test',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function fixture(t, respond) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-goal-test-'));
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  let api;
  const loader = new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,extensionFactories:[createCodemodeExtension({models:false}),extension,pi => {api=pi;pi.registerProvider('goal-test',{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]});}]});
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const sm = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({cwd,agentDir:join(cwd,'agent'),settingsManager,resourceLoader:loader,sessionManager:sm,model});
  const errors=[];
  await session.bindExtensions({onError:e=>errors.push(e)});
  const requests=[];
  session.agent.streamFunction = (_model, context) => {
    requests.push(context);
    assert.ok(requests.length < 10, 'runaway goal loop');
    const response = respond(requests.length, context, api);
    const message={role:'assistant',content:response.content ?? [{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:response.error?'error':response.content?'toolUse':'stop',timestamp:Date.now(),...(response.error?{errorMessage:response.error}:{})};
    const stream=createAssistantMessageEventStream();
    stream.push(response.error?{type:'error',reason:'error',error:message}:{type:'done',reason:message.stopReason,message});stream.end();return stream;
  };
  t.after(async()=>{session.dispose();await rm(cwd,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return {session,requests,api,sm};
}
const complete = {content:[{type:'toolCall',name:'codemode',id:'complete',arguments:{code:'text(await tools.goal_update({status:"complete"}));'}}]};
async function settled(session) {
  // Slash commands queue a turn rather than awaiting it.
  for (let n=0;n<500;n++) {
    await new Promise(r=>setTimeout(r,10));
    if (!session.isStreaming && !session.agent.state.isStreaming) return;
  }
  throw new Error('Agent did not settle');
}

test('disabled goal is invisible; active goal uses real codemode and repeats until completed', async t => {
  const h = await fixture(t, (n, context) => {
    const tools=getCurrentTools(context.messages);
    assert.ok(!tools.some(tool=>tool.name==='goal_update'));
    if (n===1) { assert.doesNotMatch(JSON.stringify(context.messages), /goal set:|goal_update/); return {}; }
    if (n===2) { assert.match(JSON.stringify(context.messages), /goal set: test goal/); return {}; }
    if (n===3) { assert.match(JSON.stringify(context.messages), /goal still active: test goal/); return complete; }
    return {};
  });
  await h.session.prompt('hello');
  assert.equal(h.api.getAllTools().find(t=>t.name==='goal_update').exposure, 'hidden');
  await h.session.prompt('/goal test goal'); await settled(h.session);
  assert.equal(h.requests.length,4);
  assert.equal(h.api.getAllTools().find(t=>t.name==='goal_update').exposure, 'hidden');
  assert.equal(h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data.status,'complete');
});

test('agent can pause through real codemode and user can resume', async t => {
  const pause = {content:[{type:'toolCall',name:'codemode',id:'pause',arguments:{code:'text(await tools.goal_update({status:"pause"}));'}}]};
  const h = await fixture(t,n=>n===1?pause:n===3?complete:{});
  const state=()=>h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data;
  await h.session.prompt('/goal needs input'); await settled(h.session);
  assert.equal(h.requests.length,2);
  assert.equal(state().status,'paused');
  assert.equal(h.api.getAllTools().find(t=>t.name==='goal_update').exposure,'hidden');
  assert.doesNotMatch(JSON.stringify(h.requests[1].messages), /goal still active:/);
  await h.session.prompt('/goal resume');
  assert.equal(h.requests.length,2);
  assert.equal(state().status,'active');
  await h.session.prompt('Proceed'); await settled(h.session);
  assert.equal(h.requests.length,4);
  assert.equal(state().status,'complete');
});

test('new goal during a running tool is delivered after its result, before the next request', async t => {
  let release, entered;
  const gate=new Promise(resolve=>release=resolve);
  const started=new Promise(resolve=>entered=resolve);
  const h=await fixture(t,(n,context)=>{
    if(n===1)return {content:[{type:'toolCall',name:'hold',id:'hold',arguments:{}}]};
    if(n===2){
      const messages=context.messages;
      const result=messages.findIndex(m=>m.role==='toolResult'&&m.toolCallId==='hold');
      const changed=messages.findIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('goal changed: replacement'));
      assert.ok(result>=0&&changed>result,'replacement must follow the completed tool batch');
      return complete;
    }
    return {};
  });
  h.api.registerTool({name:'hold',label:'hold',description:'test barrier',parameters:{type:'object',properties:{}},async execute(){entered();await gate;return {content:[{type:'text',text:'released'}]};}});
  t.after(()=>release());
  await h.session.prompt('/goal original');
  await Promise.race([started,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('tool did not start')),3000);timer.unref();})]);
  await h.session.prompt('/goal replacement');
  assert.equal(h.requests.length,1);
  const state=()=>h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data;
  assert.equal(state().text,'replacement');
  await h.session.prompt('/goal pause');assert.equal(state().status,'paused');
  await h.session.prompt('/goal resume');assert.equal(state().status,'active');
  assert.equal(h.requests.length,1);
  release();await settled(h.session);
  assert.equal(h.requests.length,3);
  assert.equal(state().status,'complete');
});

test('provider failure pauses goal rather than looping; continue and clear commands work', async t => {
  const h=await fixture(t,n=>n===1?{error:'test failure'}:n===2?complete:{});
  await h.session.prompt('/goal retry goal'); await settled(h.session);
  const state=()=>h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data;
  assert.equal(state().status,'paused'); assert.equal(h.requests.length,1);
  await h.session.prompt('/goal continue');
  assert.equal(h.requests.length,1);
  assert.equal(state().status,'active');
  await h.session.prompt('Proceed'); await settled(h.session);
  assert.equal(state().status,'complete'); assert.equal(h.requests.length,3);
  await h.session.prompt('/goal clear'); assert.equal(state().status,'closed');
  await h.session.prompt('/goal continue'); assert.equal(h.requests.length,3);
});
