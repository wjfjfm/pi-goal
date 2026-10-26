import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
const model = {id:'goal-test',name:'goal-test',api:'openai-completions',provider:'goal-test',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function fixture(t, respond, extensions = [], maxRequests = 10, goalFirst = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-goal-test-'));
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:1},retry:{enabled:false}});
  let api;
  const loader = new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,extensionFactories:[createCodemodeExtension({models:false}),...(goalFirst?[extension,...extensions]:[...extensions,extension]),pi => {api=pi;pi.registerProvider('goal-test',{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]});}]});
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const sm = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({cwd,agentDir:join(cwd,'agent'),settingsManager,resourceLoader:loader,sessionManager:sm,model});
  const errors=[];
  await session.bindExtensions({onError:e=>errors.push(e)});
  const requests=[];
  session.agent.streamFunction = (_model, context) => {
    requests.push(context);
    assert.ok(!getCurrentTools(context.messages).some(tool => ["goal_show","goal_update","goal_add","goal_delete"].includes(tool.name)),
      "goal tools must only be exposed through codemode, never as standalone model tools");
    assert.ok(requests.length < maxRequests, 'runaway goal loop');
    const response = respond(requests.length, context, api);
    const message={role:'assistant',content:response.content ?? [{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:response.error?'error':response.content?'toolUse':'stop',timestamp:Date.now(),...(response.error?{errorMessage:response.error}:{})};
    const stream=createAssistantMessageEventStream();
    stream.push(response.error?{type:'error',reason:'error',error:message}:{type:'done',reason:message.stopReason,message});stream.end();return stream;
  };
  t.after(async()=>{session.dispose();await rm(cwd,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return {session,requests,api,sm};
}
async function settled(session) {
  // Slash commands queue a turn rather than awaiting it.
  for (let n=0;n<1500;n++) {
    await new Promise(r=>setTimeout(r,10));
    if (!session.isStreaming && !session.agent.state.isStreaming) return;
  }
  throw new Error('Agent did not settle');
}


const code=code=>({content:[{type:'toolCall',name:'codemode',id:'call',arguments:{code}}]});
const finish=code('const s=JSON.parse(await tools.goal_show({})); for(const g of s.goals) if(s.run.ids.includes(g.id)) text(await tools.goal_update({id:g.id,status:"done"}));');
const state=h=>h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1)?.data;
test('real codemode creates multilevel goals without starting a run',async t=>{
  const h=await fixture(t,n=>n===1?code('const root=JSON.parse(await tools.goal_add({text:"root"})); const child=JSON.parse(await tools.goal_add({text:"child",parentId:root.id})); text(await tools.goal_add({text:"grandchild",parentId:child.id})); text(await tools.goal_show({}));'):{});
  h.api.setActiveTools([...h.api.getActiveTools(),'codemode']);
  await h.session.prompt('Plan a task tree');await settled(h.session);
  const s=state(h);
  assert.equal(s.goals.length,3);
  assert.equal(s.goals[1].parentId,s.goals[0].id);
  assert.equal(s.goals[2].parentId,s.goals[1].id);
  assert.equal(s.run,null);assert.equal(h.requests.length,2);
});
test('real codemode CRUD stays idle and records assistant provenance',async t=>{
  const h=await fixture(t,n=>n===1?code('text(await tools.goal_add({text:"plan only"}));'):n===3?code('const s=JSON.parse(await tools.goal_show({})); text(await tools.goal_update({id:s.goals[0].id,status:"doing"}));'):{});
  h.api.setActiveTools([...h.api.getActiveTools(),'codemode']);
  await h.session.prompt('Plan');await settled(h.session);
  assert.equal(state(h).goals[0].setBy,'assistant');assert.equal(state(h).run,null);
  await h.session.prompt('Update');await settled(h.session);
  assert.equal(state(h).goals[0].status,'doing');assert.equal(state(h).run,null);
  assert.equal(h.requests.length,4);
});
test('real goal run repeats then completes using ID; user author is retained',async t=>{
  const h=await fixture(t,n=>n===2?finish:{});
  await h.session.prompt('/goal test task');await settled(h.session);
  assert.equal(h.requests.length,3);
  assert.equal(state(h).run.status,'complete');
  assert.equal(state(h).goals[0].status,'done');
  assert.equal(state(h).goals[0].setBy,'user');
  assert.equal(state(h).goals[0].updatedBy,'assistant');
  assert.match(JSON.stringify(h.requests[1].messages),/Goals still active/);
});
test('real run pauses after ten rapid auto-continue intervals',async t=>{
  const h=await fixture(t,()=>({}),[],15);
  await h.session.prompt('/goal looping task');await settled(h.session);
  assert.equal(h.requests.length,11);
  assert.equal(state(h).run.status,'paused');
  assert.equal('turnsRemaining' in state(h).run,false);
});
test('real tool-driven execution can exceed twenty model turns',async t=>{
  const h=await fixture(t,n=>n<=25?code('text(await tools.goal_show({}));'):n===26?finish:{},[],35);
  await h.session.prompt('/goal long task');await settled(h.session);
  assert.equal(h.requests.length,27);
  assert.equal(state(h).run.status,'complete');
});
test('blocked list pauses; editing to todo does not resume until user requests',async t=>{
  const h=await fixture(t,n=>n===1?code('const s=JSON.parse(await tools.goal_show({})); text(await tools.goal_update({id:s.goals[0].id,status:"blocked"}));'):n===3?finish:{});
  await h.session.prompt('/goal wait for input');await settled(h.session);
  assert.equal(state(h).run.status,'paused');
  const id=state(h).goals[0].id;
  await h.session.prompt('/goal update '+id+' todo');await settled(h.session);
  assert.equal(state(h).run.status,'paused');assert.equal(h.requests.length,2);
  await h.session.prompt('/goal resume');await settled(h.session);
  assert.equal(state(h).run.status,'complete');assert.equal(h.requests.length,4);
});
test('user edits during a tool batch reject stale writes and arrive before next request',async t=>{
  let release,entered;
  const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);
  const h=await fixture(t,n=>n===1?{content:[{type:'toolCall',name:'hold',id:'hold',arguments:{}}]}:{});
  h.api.registerTool({name:'hold',label:'hold',description:'barrier',parameters:{type:'object',properties:{}},async execute(){
    entered();await gate;
    return {content:[{type:'text',text:'released'}]};
  }});
  t.after(()=>release());
  await h.session.prompt('/goal original');
  await started;
  const id=state(h).goals[0].id;
  await h.session.prompt('/goal update '+id+' cancelled');
  assert.equal(h.requests.length,1);release();await settled(h.session);
  assert.equal(state(h).goals[0].status,'cancelled');
  assert.equal(h.requests.length,2);
  const msgs=h.requests[1].messages;
  const result=msgs.findIndex(m=>m.role==='toolResult'&&m.toolCallId==='hold');
  const change=msgs.findIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('Goals changed by user'));
  assert.ok(change>result && result>=0);
});
test('provider retry retains errors, then completes; abort stops retry',async t=>{
  const h=await fixture(t,n=>n<=2?{error:'failure'}:n===3?finish:{});
  await h.session.prompt('/goal retry');await settled(h.session);
  assert.equal(state(h).run.status,'complete');assert.equal(h.requests.length,4);
  assert.equal(h.sm.getBranch().filter(e=>e.type==='message'&&e.message.role==='assistant'&&e.message.stopReason==='error').length,2);
  assert.equal(h.sm.getBranch().filter(e=>e.type==='custom_message'&&String(e.content).startsWith('Goals retrying')).length,1);
});
test('aborting real retry pauses execution',async t=>{
  const h=await fixture(t,()=>({error:'failure'}));
  await h.session.prompt('/goal abort');
  while(!h.requests.length)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));
  await h.session.abort();await settled(h.session);
  assert.equal(h.requests.length,1);assert.equal(state(h).run.status,'paused');
});
test('manual compact injects digest without starting a turn or changing run state',async t=>{
  const h=await fixture(t,()=>({}),[
    pi=>pi.on('session_before_compact',event=>({compaction:{summary:'Test summary',firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:1}})),
  ]);
  await h.session.prompt('/goal add retained task');
  await h.session.prompt('hello');await settled(h.session);
  await h.session.prompt('more context');await settled(h.session);
  const before=JSON.stringify(state(h));
  await h.session.compact();
  assert.equal(h.requests.length,2);
  assert.equal(JSON.stringify(state(h)),before);
  const digests=h.sm.getBranch().filter(e=>e.type==='custom_message'&&String(e.content).startsWith('[goal status:'));
  assert.equal(digests.length,1);
  await h.session.prompt('continue');await settled(h.session);
  assert.match(JSON.stringify(h.requests[2].messages),/goal status: 1 todo/);
});

test('actual pi-backtrack zero reset retains goal digest in either extension order', {skip:!process.env.PI_GOAL_BACKTRACK_TEST},async t=>{
  const {default:backtrack}=await import(process.env.PI_GOAL_BACKTRACK_TEST);
  for(const goalFirst of [false,true])await t.test(String(goalFirst),async t=>{
    const h=await fixture(t,n=>n===1?{content:[{type:'toolCall',name:'backtrack',id:'bt',arguments:{checkpoint:0,message:'Continue pending tasks.'}}]}:{},[backtrack],10,goalFirst);
    await h.session.prompt('/goal add retained task');
    await h.session.prompt('Backtrack then continue');await settled(h.session);
    assert.equal(h.requests.length,2);
    assert.match(JSON.stringify(h.requests[1].messages),/goal status: 1 todo/);
    assert.equal(h.sm.getBranch().filter(e=>e.type==='custom_message'&&String(e.content).startsWith('[goal status:')).length,1);
    assert.equal(state(h).goals[0].setBy,'user');
  });
});

test('successful backtrack result appends a persisted digest at turn boundary',async t=>{
  const h=await fixture(t,n=>n===1?{content:[{type:'toolCall',name:'backtrack',id:'bt',arguments:{}}]}:{},[
    pi=>pi.registerTool({name:'backtrack',label:'Backtrack',description:'test successful boundary tool',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'Backtracked.'}],details:{status:'applied'}};}}),
  ]);
  await h.session.prompt('/goal add retained task');
  await h.session.prompt('Backtrack');await settled(h.session);
  const digests=h.sm.getBranch().filter(e=>e.type==='custom_message'&&String(e.content).startsWith('[goal status:'));
  assert.equal(digests.length,1);
  assert.match(JSON.stringify(h.requests[1].messages),/goal status: 1 todo/);
  assert.equal(state(h).run,null);
});
