import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
import { GoalState, reminder } from '../dist/state.js';

test('set and latest resume timestamps persist, reset on replacement and tolerate legacy records',()=>{
  let now=1000;
  const s=new GoalState(()=>now);
  s.set('first');assert.equal(s.snapshot().setAt,1000);
  assert.equal(s.snapshot().resumedAt,undefined);
  now=2000;s.transition('paused');
  now=4000;s.transition('active');
  assert.equal(s.snapshot().setAt,1000);
  assert.equal(s.snapshot().resumedAt,4000);
  now=5000;const saved=s.snapshot();
  now=9000;s.restore(saved);
  assert.equal(s.snapshot().setAt,1000);
  assert.equal(s.snapshot().resumedAt,4000);
  assert.equal(s.elapsed(),2000);
  s.transition('active');assert.equal(s.snapshot().resumedAt,9000);
  now=10000;s.set('replacement');
  assert.equal(s.snapshot().setAt,10000);
  assert.equal(s.snapshot().resumedAt,undefined);
  s.restore({text:'legacy',status:'paused',elapsedMs:50});
  assert.equal(s.snapshot().setAt,undefined);
  assert.equal(s.snapshot().resumedAt,undefined);
  s.restore({text:'invalid times',status:'paused',elapsedMs:50,setAt:Infinity,resumedAt:1e20});
  assert.equal(s.snapshot().setAt,undefined);
  assert.equal(s.snapshot().resumedAt,undefined);
});

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
async function fixture(t, respond, extensions = []) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-goal-test-'));
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  let api;
  const loader = new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,extensionFactories:[createCodemodeExtension({models:false}),...extensions,extension,pi => {api=pi;pi.registerProvider('goal-test',{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]});}]});
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
  for (let n=0;n<1500;n++) {
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

test('agent can show the active goal through real codemode without completing it', async t => {
  const h = await fixture(t,(n,context)=>{
    if(n===1)return {content:[{type:'toolCall',name:'codemode',id:'show',arguments:{code:'text(await tools.goal_update({status:"show"}));'}}]};
    if(n===2){
      const result=context.messages.find(m=>m.role==='toolResult'&&m.toolCallId==='show');
      assert.ok(result);
      assert.notEqual(result.isError,true);
      assert.match(JSON.stringify(result.content),/Goal: inspect goal/);
      assert.match(JSON.stringify(result.content),/Status: active/);
      assert.match(JSON.stringify(result.content),/Set time: \d{4}-/);
      assert.doesNotMatch(JSON.stringify(result.content),/Resume time:/);
      assert.match(JSON.stringify(result.content),/Running time:/);
      return complete;
    }
    return {};
  });
  await h.session.prompt('/goal inspect goal');await settled(h.session);
  assert.equal(h.requests.length,3);
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
  await h.session.prompt('/goal resume'); await settled(h.session);
  assert.match(JSON.stringify(h.requests[2].messages),/goal resumed: needs input/);
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
      return {};
    }
    if(n===3){
      assert.match(JSON.stringify(context.messages),/goal resumed: replacement/);
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
  assert.equal(h.requests.length,4);
  assert.equal(state().status,'complete');
});

test('user abort during retry delay pauses without another model request',async t=>{
  const h=await fixture(t,()=>({error:'failure'}));
  await h.session.prompt('/goal abort retry');
  while(!h.requests.length)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));
  await h.session.abort();await settled(h.session);
  assert.equal(h.requests.length,1);
  assert.equal(h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data.status,'paused');
});
test('goal composes with another extension requesting continuation after an error', async t => {
  const h=await fixture(t,n=>n===1?{error:'handled elsewhere'}:n===2?complete:{},[
    pi=>pi.on('agent_before_settle',event=>event.outcome==='error' ? {
      entries:[...event.entries,{type:'custom_message',customType:'other-retry',content:'Continue from the other extension',display:true}],
      continue:true,
    } : undefined),
  ]);
  await h.session.prompt('/goal shared boundary');await settled(h.session);
  assert.equal(h.requests.length,3);
  assert.match(JSON.stringify(h.requests[1].messages),/Continue from the other extension/);
  assert.doesNotMatch(JSON.stringify(h.requests[1].messages),/goal resumed:/);
  assert.equal(h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data.status,'complete');
});

test('provider failure automatically resumes goal; clear still prevents continuation', async t => {
  const h=await fixture(t,n=>n<=2?{error:'test failure'}:n===3?complete:{});
  await h.session.prompt('/goal retry goal'); await settled(h.session);
  const state=()=>h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1).data;
  assert.match(JSON.stringify(h.requests[1].messages),/goal resumed: retry goal/);
  assert.equal(state().status,'complete'); assert.equal(h.requests.length,4);
  const resumes=h.sm.getBranch().filter(e=>e.type==='custom_message'&&e.customType==='pi-goal'&&String(e.content).startsWith('goal resumed:'));
  assert.equal(resumes.length,1,'repeated retries must not append repeated resume messages');
  assert.equal((JSON.stringify(h.requests[2].messages).match(/goal resumed: retry goal/g)||[]).length,1);
  assert.equal(h.sm.getBranch().filter(e=>e.type==='message'&&e.message.role==='assistant'&&e.message.stopReason==='error').length,2,'failed attempts remain in raw history');
  await h.session.prompt('/goal clear'); assert.equal(state().status,'closed');
  await h.session.prompt('/goal continue'); assert.equal(h.requests.length,4);
});
