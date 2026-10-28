import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, getCurrentTools } from '@earendil-works/pi-ai';
import extension from '../dist/index.js';
const model = {id:'goal-test',name:'goal-test',api:'openai-completions',provider:'goal-test',baseUrl:'http://unused.invalid',reasoning:false,input:['text'],contextWindow:100000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
async function fixture(t, respond, extensions = [], maxRequests = 10, goalFirst = false, seed = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-goal-test-'));
  const settingsManager = SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:1},retry:{enabled:false}});
  let api;
  const loader = new DefaultResourceLoader({cwd,agentDir:join(cwd,'agent'),settingsManager,noExtensions:true,noSkills:true,noContextFiles:true,extensionFactories:[...(seed?[seedPlan]:[]),createCodemodeExtension({models:false}),...(goalFirst?[extension,...extensions]:[...extensions,extension]),pi => {api=pi;pi.registerProvider('goal-test',{apiKey:'dummy',api:model.api,baseUrl:model.baseUrl,models:[model]});}]});
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
const finish=code('text(await tools.goal_update({status:"complete"}));');
const blocked=code('text(await tools.goal_update({status:"blocked"}));');
const seedPlan=pi=>pi.on('session_start',()=>pi.appendEntry('pi-goal-state',{version:3,goal:{text:'retained goal',status:'paused',elapsedMs:0,setBy:'user'}}));
const state=h=>h.sm.getBranch().filter(e=>e.type==='custom'&&e.customType==='pi-goal-state').at(-1)?.data.goal;
test('agent can inspect but cannot create goals or call former list tools',async t=>{
  const h=await fixture(t,n=>n===1?code('text(await tools.goal_show()); text({removed:ALL_TOOLS.filter(t=>["goal_add","goal_delete","goal_set","task_add"].includes(t.name)).length});'):{});
  h.api.setActiveTools([...h.api.getActiveTools(),'codemode']);
  await h.session.prompt('inspect');await settled(h.session);
  assert.equal(h.requests.length,2);assert.equal(state(h),undefined);
  const result=h.requests[1].messages.find(m=>m.role==='toolResult');
  assert.notEqual(result.isError,true);
  assert.match(JSON.stringify(result.content),/removed/);
  assert.equal(h.api.getAllTools().some(t=>t.name.startsWith('task_')),false);
  assert.deepEqual(h.api.getAllTools().filter(t=>t.name.startsWith('goal_')).map(t=>t.name).sort(),['goal_show','goal_update']);
});
test('real codemode rejects editing, IDs and agent resume statuses',async t=>{
  const h=await fixture(t,n=>{
    if(n===1)return code('for(const args of [{status:"doing"},{status:"complete",text:"rewritten"},{status:"complete",id:"old-id"}]) { try { await tools.goal_update(args); text("unexpected success"); } catch(e) { text("rejected"); } }');
    if(n===2){assert.equal(state(h).status,'active');assert.equal(state(h).text,'user objective');return finish;}
    return {};
  });
  await h.session.prompt('/goal user objective');await settled(h.session);
  assert.equal(h.requests.length,3);assert.equal(state(h).status,'complete');
  const result=h.requests[1].messages.find(m=>m.role==='toolResult');
  assert.doesNotMatch(JSON.stringify(result.content),/unexpected success/);
});
test('user-set single goal repeats then agent completes it',async t=>{
  const h=await fixture(t,n=>n===2?finish:{});
  await h.session.prompt('/goal user objective');await settled(h.session);
  assert.equal(h.requests.length,3);assert.equal(state(h).status,'complete');
  assert.equal(state(h).text,'user objective');assert.equal(state(h).setBy,'user');
  assert.equal('id' in state(h),false);
  assert.match(JSON.stringify(h.requests[1].messages),/Goal still active/);
});
test('agent blocks goal; user directly resumes and timing/state agree',async t=>{
  const h=await fixture(t,n=>n===1?blocked:n===3?finish:{});
  await h.session.prompt('/goal wait for input');await settled(h.session);
  assert.equal(state(h).status,'blocked');
  await h.session.prompt('/goal resume');await settled(h.session);
  assert.equal(h.requests.length,4);assert.equal(state(h).status,'complete');
  assert.ok(state(h).resumedAt);
  assert.match(JSON.stringify(h.requests[2].messages),/Resume means retry/);
});
test('new goal during held tool blocks old completion until steer delivery',async t=>{
  let release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const h=await fixture(t,n=>n===1?{content:[{type:'toolCall',name:'hold',id:'hold',arguments:{}}]}:n===2?finish:{});
  h.api.registerTool({name:'hold',label:'hold',description:'barrier',parameters:{type:'object',properties:{}},async execute(_id,_args,_signal,_update,ctx){
    entered();await gate;
    await assert.rejects(()=>ctx.executeTool('goal_update',{status:'complete'}),/awaiting delivery/);
    return {content:[{type:'text',text:'old completion rejected'}],details:undefined};
  }});
  t.after(()=>release());
  await h.session.prompt('/goal original');await started;
  await h.session.prompt('/goal replacement');assert.equal(state(h).text,'replacement');
  release();await settled(h.session);
  assert.equal(h.requests.length,3);assert.equal(state(h).status,'complete');
  const msgs=h.requests[1].messages;
  const result=msgs.findIndex(m=>m.role==='toolResult'&&m.toolCallId==='hold');
  const changed=msgs.findIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('Goal: replacement'));
  assert.ok(result>=0&&changed>result);
});
test('real reminder loop pauses after ten sub-minute intervals',async t=>{
  const h=await fixture(t,()=>({}),[],15);
  await h.session.prompt('/goal loop');await settled(h.session);
  assert.equal(h.requests.length,11);assert.equal(state(h).status,'paused');
});
test('normal tool execution can exceed twenty model turns',async t=>{
  const h=await fixture(t,n=>n<=25?code('text(await tools.goal_show());'):n===26?finish:{},[],35);
  await h.session.prompt('/goal long task');await settled(h.session);
  assert.equal(h.requests.length,27);assert.equal(state(h).status,'complete');
});
test('provider errors retry without accumulating reminders or deleting raw errors',async t=>{
  const h=await fixture(t,n=>n<=2?{error:'failure'}:n===3?finish:{});
  await h.session.prompt('/goal retry');await settled(h.session);
  assert.equal(h.requests.length,4);assert.equal(state(h).status,'complete');
  assert.equal(h.sm.getBranch().filter(e=>e.type==='message'&&e.message.role==='assistant'&&e.message.stopReason==='error').length,2);
  assert.equal(h.sm.getBranch().filter(e=>e.type==='custom_message'&&String(e.content).startsWith('Goal retrying')).length,1);
});
test('aborting retry pauses without further model requests',async t=>{
  const h=await fixture(t,()=>({error:'failure'}));
  await h.session.prompt('/goal abort');
  while(!h.requests.length)await new Promise(r=>setTimeout(r,5));
  await new Promise(r=>setTimeout(r,30));await h.session.abort();await settled(h.session);
  assert.equal(h.requests.length,1);assert.equal(state(h).status,'paused');
});
test('compact injects a single-goal digest without resuming',async t=>{
  const h=await fixture(t,()=>({}),[
    pi=>pi.on('session_before_compact',event=>({compaction:{summary:'Test summary',firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:1}})),
  ],10,false,true);
  await h.session.prompt('hello');await settled(h.session);
  await h.session.prompt('more context');await settled(h.session);
  const before=JSON.stringify(state(h));await h.session.compact();
  assert.equal(h.requests.length,2);assert.equal(JSON.stringify(state(h)),before);
  await h.session.prompt('continue');await settled(h.session);
  assert.match(JSON.stringify(h.requests[2].messages),/goal status: paused;/);
});
test('actual pi-backtrack retains single-goal digest in either extension order',{skip:!process.env.PI_GOAL_BACKTRACK_TEST},async t=>{
  const {default:backtrack}=await import(process.env.PI_GOAL_BACKTRACK_TEST);
  for(const goalFirst of [false,true])await t.test(String(goalFirst),async t=>{
    const h=await fixture(t,n=>n===1?{content:[{type:'toolCall',name:'backtrack',id:'bt',arguments:{checkpoint:0,message:'Continue pending work.'}}]}:{},[backtrack],10,goalFirst,true);
    await h.session.prompt('Backtrack then continue');await settled(h.session);
    assert.equal(h.requests.length,2);
    assert.match(JSON.stringify(h.requests[1].messages),/goal status: paused;/);
    assert.equal(h.sm.getBranch().filter(e=>e.type==='custom_message'&&String(e.content).startsWith('[goal status:')).length,1);
    assert.equal(state(h).text,'retained goal');
  });
});
