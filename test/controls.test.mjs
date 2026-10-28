import {test} from 'node:test';
import assert from 'node:assert/strict';
import extension from '../dist/index.js';
function fixture({codemode=true}={}) {
  const handlers={},tools=new Map(),entries=[],messages=[],notices=[],statuses=[];
  let command, idle=true, pending=false, active=['read'];
  const pi={
    registerTool:t=>tools.set(t.name,t), registerCommand:(_n,c)=>command=c.handler,
    appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),
    sendMessage:m=>{messages.push(m);if(idle)handlers.message_start({message:{role:'custom',...m}});},on:(name,fn)=>handlers[name]=fn,
    getAllTools:()=>[...(codemode?[{name:'codemode'}]:[]),...tools.values()],
    getActiveTools:()=>active,setActiveTools:a=>active=a,
  };
  const ctx={mode:'tui',hasUI:false,isIdle:()=>idle,hasPendingMessages:()=>pending,sessionManager:{getBranch:()=>entries},ui:{notify:(...args)=>notices.push(args),setStatus:(...args)=>statuses.push(args)}};
  extension(pi);
  return {handlers,tools,entries,messages,notices,statuses,ctx,run:arg=>command(arg,ctx),idle:v=>idle=v,pending:v=>pending=v,active:()=>active,state:()=>entries.at(-1)?.data};
}


const call=(h,name,args={},signal)=>h.tools.get(name).execute('test',args,signal,undefined,h.ctx);
const show=h=>call(h,'goal_show').then(r=>r.details);
const boundary={outcome:'completed',entries:[]};
const inject=h=>h.handlers.agent_before_settle(boundary,h.ctx);
const budget=async h=>(await show(h)).continuationBudget.remaining;
test('only show and complete/blocked tools remain; no list, IDs, creation or editing',async()=>{
  const h=fixture();
  assert.deepEqual([...h.tools.keys()].sort(),['goal_show','goal_update']);
  for(const tool of h.tools.values())assert.equal(tool.exposure,'codemode');
  assert.deepEqual(Object.keys(h.tools.get('goal_show').parameters.properties),[]);
  assert.deepEqual(Object.keys(h.tools.get('goal_update').parameters.properties),['status']);
  assert.equal(h.tools.get('goal_update').parameters.additionalProperties,false);
  assert.equal((await show(h)).goal,null);
  await assert.rejects(()=>call(h,'goal_update',{status:'complete'}),/No active/);
  await h.run('first');await h.run('second');
  assert.equal(h.state().version,3);assert.equal(h.state().goal.text,'second');
  assert.equal(h.state().goal.setBy,'user');
  assert.equal('id' in h.state().goal,false);assert.equal('goals' in h.state(),false);
  await assert.rejects(()=>call(h,'goal_update',{status:'doing'}),/Only complete or blocked/);
  assert.equal(h.state().goal.status,'active');
});
test('show and status digest keep model-facing text minimal',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();assert.equal((await call(h,'goal_show')).content[0].text,'No goal set.');
  await h.run('work');
  assert.equal((await call(h,'goal_show')).content[0].text,'Goal: work\nStatus: active');
  t.mock.timers.tick(2603000);
  h.handlers.session_compact({},h.ctx);
  assert.equal(h.messages.at(-1).content,'[pursuing goal (0h 43m 23s); codemode tools.goal_show() for detail]');
  await h.run('show');
  assert.match(h.notices.at(-1)[0],/Running time:/);
  assert.doesNotMatch(h.notices.at(-1)[0],/budget|setBy|setAt/);
  assert.equal((await call(h,'goal_update',{status:'blocked'})).content[0].text,'Goal blocked.');
});
test('show is read-only in every lifecycle state and respects cancellation',async()=>{
  const h=fixture();await h.run('work');
  for(const action of ['active','pause','resume','blocked','resume','complete','clear']){
    if(action==='blocked'||action==='complete')await call(h,'goal_update',{status:action});
    else if(action!=='active')await h.run(action);
    const before=[h.entries.length,h.messages.length,h.notices.length,h.statuses.length];
    const s=await show(h);s.goal.text='mutated';
    assert.equal((await show(h)).goal.text,'work');
    assert.deepEqual([h.entries.length,h.messages.length,h.notices.length,h.statuses.length],before);
  }
  await assert.rejects(()=>call(h,'goal_show',{},AbortSignal.abort()),/cancelled/);
});
test('agent can only complete/block active delivered goal; blocked resumes directly',async()=>{
  const h=fixture();await h.run('work');
  await call(h,'goal_update',{status:'blocked'});
  assert.equal(h.state().goal.status,'blocked');assert.equal(inject(h),undefined);
  await assert.rejects(()=>call(h,'goal_update',{status:'complete'}),/No active/);
  await h.run('resume');assert.equal(h.state().goal.status,'active');
  const n=h.messages.length;await h.run('resume');assert.equal(h.messages.length,n);
  await call(h,'goal_update',{status:'complete'});
  await h.run('resume');assert.equal(h.state().goal.status,'complete');
  await h.run('clear');await h.run('resume');
  assert.equal(h.state().goal.status,'closed');
});
test('pause/parse and resume/continue control one status and reject stale writes',async()=>{
  const h=fixture();await h.run('old');h.idle(false);await h.run('replacement');
  const msg=h.messages.at(-1);
  await assert.rejects(()=>call(h,'goal_update',{status:'complete'}),/awaiting delivery/);
  assert.equal(inject(h),undefined);
  h.handlers.message_start({message:{role:'custom',...msg}});
  await h.run('parse');assert.equal(h.state().goal.status,'paused');
  await assert.rejects(()=>call(h,'goal_update',{status:'complete'}),/No active/);
  await h.run('continue');assert.equal(h.state().goal.status,'active');
  await assert.rejects(()=>call(h,'goal_update',{status:'blocked'}),/awaiting delivery/);
  h.handlers.message_start({message:{role:'custom',...h.messages.at(-1)}});
  await call(h,'goal_update',{status:'blocked'});
  assert.equal(h.state().goal.status,'blocked');
});
test('clear blocks queued old completion, while future user set is allowed',async()=>{
  const h=fixture();h.idle(false);await h.run('old');const old=h.messages.at(-1);
  await h.run('clear');
  h.handlers.message_start({message:{role:'custom',...old}});
  await assert.rejects(()=>call(h,'goal_update',{status:'complete'}),/No active/);
  await h.run('new');assert.equal(h.state().goal.text,'new');assert.equal(h.state().goal.status,'active');
});
test('obsolete CRUD commands do not create accidental goals; missing codemode is inert',async()=>{
  const h=fixture();
  for(const args of ['add task','update id done','delete id','add','--parent id child','--parent-id=id child']){
    await h.run(args);assert.equal(h.entries.length,0);assert.equal(h.messages.length,0);
  }
  const absent=fixture({codemode:false});await absent.run('work');assert.equal(absent.entries.length,0);
});
test('ten short repeat intervals exhaust module budget; ordinary turns and reads do not',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();await h.run('work');assert.equal(inject(h).continue,true);
  for(let i=1;i<=9;i++){t.mock.timers.tick(59999);assert.equal(inject(h).continue,true);}
  assert.equal(await budget(h),1);
  for(let i=0;i<100;i++)h.handlers.turn_end({entries:[]},h.ctx);
  await h.run('show');await h.run('resume');h.handlers.session_compact({},h.ctx);
  h.handlers.tool_result({toolName:'backtrack',isError:false});h.handlers.turn_end({entries:[]},h.ctx);
  assert.equal(await budget(h),1);t.mock.timers.tick(59999);
  assert.equal(inject(h),undefined);assert.equal(h.state().goal.status,'paused');assert.equal(await budget(h),0);
  await h.run('resume');assert.equal(await budget(h),10);
});
test('user replacement refills module budget; goal timing starts over',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();await h.run('old');
  for(let i=0;i<10;i++)assert.equal(inject(h).continue,true);
  assert.equal(await budget(h),1);
  t.mock.timers.tick(1000);await h.run('replacement');
  assert.equal(await budget(h),10);assert.equal(h.state().goal.elapsedMs,0);
  assert.equal(inject(h).continue,true);assert.equal(await budget(h),10);
});
test('long gaps do not refill; ten minutes of continuous execution refill periodically',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();await h.run('work');
  for(let i=0;i<10;i++)assert.equal(inject(h).continue,true);
  t.mock.timers.tick(60000);assert.equal(inject(h).continue,true);assert.equal(await budget(h),1);
  t.mock.timers.setTime(599999);assert.equal(inject(h).continue,true);assert.equal(await budget(h),1);
  t.mock.timers.tick(1);assert.equal(inject(h).continue,true);assert.equal(await budget(h),10);
  t.mock.timers.tick(1);inject(h);assert.equal(await budget(h),9);
  t.mock.timers.setTime(1200000);inject(h);assert.equal(await budget(h),10);
});
test('replacement does not delay periodic refill; paused time does not count',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();await h.run('work');inject(h);
  t.mock.timers.setTime(599999);await h.run('replacement');inject(h);
  t.mock.timers.setTime(600000);inject(h);assert.equal(await budget(h),10);
  await h.run('pause');t.mock.timers.setTime(1199999);await h.run('resume');inject(h);
  t.mock.timers.setTime(1200000);inject(h);assert.equal(await budget(h),9);
});
test('pending/external/error boundaries do not charge or replenish; clock rollback only resets baseline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const h=fixture();h.idle(false);await h.run('work');
  for(let i=0;i<15;i++)assert.equal(inject(h),undefined);
  h.handlers.message_start({message:{role:'custom',...h.messages.at(-1)}});
  for(let i=0;i<10;i++)assert.equal(inject(h).continue,true);
  h.pending(true);assert.equal(inject(h),undefined);h.pending(false);
  for(let i=0;i<15;i++)assert.equal(h.handlers.agent_before_settle({...boundary,continue:true},h.ctx),undefined);
  assert.equal(h.handlers.agent_before_settle({outcome:'error',entries:[],continue:true},h.ctx),undefined);
  assert.equal(await budget(h),1);
  t.mock.timers.setTime(0);inject(h);assert.equal(await budget(h),1);
  assert.equal(inject(h),undefined);assert.equal(await budget(h),0);
});
test('restore, abort and shutdown pause without automatically resuming',async()=>{
  const h=fixture();await h.run('work');
  h.handlers.agent_before_settle({outcome:'aborted'},h.ctx);assert.equal(h.state().goal.status,'paused');
  await h.run('resume');const count=h.messages.length;
  h.handlers.session_start({},h.ctx);
  assert.equal((await show(h)).goal.status,'paused');assert.equal(h.messages.length,count);
  await h.run('resume');h.handlers.session_shutdown();assert.equal(h.state().goal.status,'paused');
  h.entries.length=0;h.handlers.session_tree({},h.ctx);assert.equal((await show(h)).goal,null);
});
test('ten exponential retries preserve raw history and stop; show does not cancel retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=fixture();await h.run('work');
  for(let i=1;i<=10;i++){
    h.entries.push({type:'message',id:'error-'+i,message:{role:'assistant',stopReason:'error'}});
    const retry=h.handlers.agent_before_settle({outcome:'error',entries:[]},h.ctx);
    await show(h);t.mock.timers.tick(1000*2**(i-1));
    const r=await retry;assert.equal(r.continue,true);
    if(i>1)assert.deepEqual(r.entries[0],{type:'context_edit',targetId:'error-'+i,replacement:null});
    h.handlers.agent_start();
  }
  await h.handlers.agent_before_settle({outcome:'error',entries:[]},h.ctx);
  assert.equal(h.state().goal.status,'paused');
});
test('pause, replacement, clear, restore and shutdown cancel pending retry',async()=>{
  for(const action of ['pause','replacement','clear','restore','shutdown']){
    const h=fixture();await h.run('work');
    const retry=h.handlers.agent_before_settle({outcome:'error',entries:[]},h.ctx);
    if(action==='restore')h.handlers.session_start({},h.ctx);
    else if(action==='shutdown')h.handlers.session_shutdown();
    else await h.run(action);
    assert.equal(await retry,undefined);
  }
});
test('compact/backtrack append a small single-goal digest and do not start execution',async()=>{
  const h=fixture();await h.run('work');const before=h.entries.length;
  h.handlers.session_compact({},h.ctx);
  assert.match(h.messages.at(-1).content,/^\[pursuing goal \(/);
  assert.equal(h.entries.length,before);
  h.handlers.tool_result({toolName:'backtrack',isError:true});assert.equal(h.handlers.turn_end({entries:[]},h.ctx),undefined);
  h.handlers.tool_result({toolName:'backtrack',isError:false});
  const existing={type:'custom',customType:'other',data:{}};
  const r=h.handlers.turn_end({entries:[existing]},h.ctx);
  assert.deepEqual(r.entries[0],existing);assert.match(r.entries[1].content,/pursuing goal \(/);
  assert.equal(h.handlers.turn_end({entries:[]},h.ctx),undefined);
  assert.equal(h.state().goal.status,'active');
});
test('inactive goals never inject compact/backtrack status',async()=>{
  for(const action of ['none','pause','blocked','complete','clear']){
    const h=fixture();
    if(action!=='none'){
      await h.run('work');
      if(action==='blocked'||action==='complete')await call(h,'goal_update',{status:action});
      else await h.run(action);
    }
    const before=h.messages.length;
    h.handlers.session_compact({},h.ctx);
    assert.equal(h.messages.length,before);
    h.handlers.tool_result({toolName:'backtrack',isError:false});
    assert.equal(h.handlers.turn_end({entries:[]},h.ctx),undefined);
    await h.run('new goal');
    assert.equal(h.handlers.turn_end({entries:[]},h.ctx),undefined);
  }
});
