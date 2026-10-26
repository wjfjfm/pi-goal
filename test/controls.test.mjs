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
test('parentId supports assistant/user children, ordered queries and indented display',async()=>{
  const h=fixture();await h.run('root');
  const id=h.state().goals[0].id;
  const child=(await call(h,'goal_add',{text:'child',parentId:id})).details;
  await h.run('add --parent '+child.id+' grandchild');
  const before=h.entries.length;
  const list=await show(h);
  assert.equal(list.goals[1].parentId,id);
  assert.equal(list.goals[2].parentId,child.id);
  assert.equal(list.goals[2].setBy,'user');
  assert.equal('turnsRemaining' in list.run,false);assert.deepEqual(list.run.ids,[id]);
  await h.run('show');
  assert.ok(h.notices.at(-1)[0].includes('    [todo] '+list.goals[2].id));
  assert.equal(h.entries.length,before);
  await assert.rejects(()=>call(h,'goal_delete',{id}),/child goals/);
  await assert.rejects(()=>call(h,'goal_add',{text:'bad',parentId:'missing'}),/Unknown/);
  await h.run('add --parent');
  assert.equal(h.entries.length,before);
  assert.equal((await call(h,'goal_show',{id:child.id})).details.goals[0].parentId,id);
});
test('CRUD is codemode-only, authorship is immutable, add does not execute',async()=>{
  const h=fixture();
  assert.equal(h.tools.has('goal_set'),false);
  for(const tool of h.tools.values())assert.equal(tool.exposure,'codemode');
  await assert.rejects(()=>call(h,'goal_add',{text:'  '}),/blank/);
  await assert.rejects(()=>call(h,'goal_add',{text:'x'},AbortSignal.abort()),/cancelled/);
  const g=(await call(h,'goal_add',{text:' task '})).details;
  assert.equal(g.setBy,'assistant');assert.equal(g.text,'task');
  assert.equal(h.state().run,null);assert.equal(h.messages.length,0);
  await h.run('update '+g.id+' text user edit');
  const updated=(await show(h)).goals[0];
  assert.equal(updated.setBy,'assistant');assert.equal(updated.updatedBy,'user');
  await call(h,'goal_update',{id:g.id,status:'doing',setBy:'user'});
  assert.equal(h.state().goals[0].setBy,'assistant');
  assert.equal(h.state().run,null);
  await h.run('add user task');
  assert.equal(h.state().goals[1].setBy,'user');
  await assert.rejects(()=>call(h,'goal_update',{id:g.id}),/Specify/);
  await assert.rejects(()=>call(h,'goal_update',{id:g.id,text:' '}),/blank/);
});
test('soft deletion hides the item but keeps its author and history',async()=>{
  const h=fixture(), g=(await call(h,'goal_add',{text:'duplicate'})).details;
  await call(h,'goal_delete',{id:g.id});
  assert.equal((await show(h)).goals.length,0);
  const item=(await call(h,'goal_show',{id:g.id})).details.goals[0];
  assert.equal(item.setBy,'assistant');assert.ok(item.deletedAt);
  await assert.rejects(()=>call(h,'goal_update',{id:g.id,status:'done'}),/deleted/);
  assert.equal(h.entries.length,2);
});
test('queries are read-only, including paused, deleted and pending states',async()=>{
  const h=fixture();await h.run('work');h.idle(false);
  await h.run('add later');
  const before=[h.entries.length,h.messages.length,h.notices.length];
  const s=await show(h);
  assert.equal(s.pendingDelivery,true);
  s.goals[0].text='mutated';s.run.ids.length=0;
  assert.equal((await show(h)).goals[0].text,'work');
  assert.equal((await show(h)).run.ids.length,1);
  assert.deepEqual([h.entries.length,h.messages.length,h.notices.length],before);
});
test('user edit delivery bars stale writes; cancelled tasks cannot be revived',async()=>{
  const h=fixture();await h.run('work');
  const id=h.state().goals[0].id;
  h.idle(false);await h.run('update '+id+' cancelled');
  await assert.rejects(()=>call(h,'goal_update',{id,status:'done'}),/awaiting delivery/);
  h.handlers.message_start({message:{role:'custom',...h.messages.at(-1)}});
  await assert.rejects(()=>call(h,'goal_update',{id,status:'done'}),/Cancelled/);
  await h.run('update '+id+' todo');
  h.handlers.message_start({message:{role:'custom',...h.messages.at(-1)}});
  await call(h,'goal_update',{id,status:'doing'});
  assert.notEqual(h.state().run.status,'active');
});
test('ten consecutive rapid intervals pause; CRUD and summaries do not reset detection',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();await h.run('first');
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true); // Baseline, not an interval.
  for(let i=1;i<=9;i++){
    t.mock.timers.tick(9999);
    assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  }
  await call(h,'goal_add',{text:'later'});
  await call(h,'goal_update',{id:h.state().goals[0].id,status:'doing'});
  await show(h);await h.run('resume'); // Already active: no reset.
  h.handlers.session_compact({},h.ctx);
  h.handlers.tool_result({toolName:'backtrack',isError:false});
  h.handlers.turn_end({entries:[]},h.ctx);
  t.mock.timers.tick(9999);
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
  assert.equal(h.state().run.status,'paused');
  assert.match(h.notices.at(-1)[0],/possible loop/);
  assert.equal('turnsRemaining' in h.state().run,false);
  await h.run('resume');
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  assert.equal(h.state().run.ids.length,2);
});
test('clock rollback and error boundaries restart timing rather than adding rapid intervals',async t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const h=fixture();await h.run('work');
  for(let i=0;i<10;i++)assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  t.mock.timers.setTime(0);
  for(let i=0;i<10;i++)assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  assert.equal(h.handlers.agent_before_settle({outcome:'error',entries:[],continue:true},h.ctx),undefined);
  for(let i=0;i<10;i++)assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
  assert.equal(h.state().run.status,'paused');
});
test('10 seconds or more clears rapid streak; normal execution has no total turn limit',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();await h.run('work');
  for(let cycle=0;cycle<5;cycle++){
    for(let i=0;i<10;i++){
      assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
      t.mock.timers.tick(i===9?10000:1);
    }
  }
  for(let i=0;i<100;i++)h.handlers.turn_end({entries:[]},h.ctx);
  assert.equal(h.state().run.status,'active');
  assert.equal('turnsRemaining' in (await show(h)).run,false);
});
test('pending and external continuations do not count; restore and resume reset timing',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  const h=fixture();h.idle(false);await h.run('work');
  for(let i=0;i<15;i++)assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
  h.handlers.message_start({message:{role:'custom',...h.messages.at(-1)}});
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  for(let i=0;i<15;i++){
    h.pending(true);assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
    h.pending(false);assert.equal(h.handlers.agent_before_settle({...boundary,continue:true},h.ctx),undefined);
  }
  for(let i=0;i<9;i++)assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  h.handlers.session_start({},h.ctx);
  await h.run('resume');h.handlers.message_start({message:{role:'custom',...h.messages.at(-1)}});
  for(let i=0;i<10;i++)assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
});
test('new and reworded tasks are not implicitly authorized; blocked/done reconcile run',async()=>{
  const h=fixture();await h.run('first');
  const first=h.state().goals[0].id;
  await call(h,'goal_add',{text:'later'});
  await call(h,'goal_update',{id:first,status:'done'});
  assert.equal(h.state().run.status,'complete');
  await h.run('resume');
  const later=h.state().goals[1].id;
  await call(h,'goal_update',{id:later,status:'blocked'});
  assert.equal(h.state().run.status,'paused');
  await call(h,'goal_update',{id:later,status:'todo'});
  assert.equal(h.state().run.status,'paused');
  await h.run('resume');
  await call(h,'goal_update',{id:later,text:'different'});
  assert.equal(h.state().run.status,'complete');
  assert.deepEqual(h.state().run.ids,[]);
});
test('pause, abort, restore and clear do not delete list or auto-resume',async()=>{
  const h=fixture();await h.run('work');
  await h.run('pause');assert.equal(h.state().run.status,'paused');
  await h.run('resume');const n=h.messages.length;
  await h.run('resume');assert.equal(h.messages.length,n);
  h.handlers.agent_before_settle({outcome:'aborted'},h.ctx);
  assert.equal(h.state().run.status,'paused');
  await h.run('resume');h.handlers.session_start({},h.ctx);
  assert.equal((await show(h)).run.status,'paused');
  await h.run('clear');assert.equal(h.state().goals[0].status,'cancelled');
  assert.equal(h.state().goals[0].setBy,'user');
  await h.run('resume');assert.notEqual(h.state().run.status,'active');
  h.entries.length=0;h.handlers.session_tree({},h.ctx);
  assert.equal((await show(h)).goals.length,0);
});
test('continuations compose and missing codemode prevents starting',async()=>{
  const h=fixture();await h.run('work');
  h.pending(true);assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
  h.pending(false);assert.equal(h.handlers.agent_before_settle({...boundary,continue:true},h.ctx),undefined);
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  const absent=fixture({codemode:false});await absent.run('work');
  assert.equal(absent.entries.length,0);
  await absent.run('add planning only');assert.equal(absent.state().run,null);
});
test('10 exponential retries preserve failed history and stop; show does not cancel retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=fixture();await h.run('work');
  for(let i=1;i<=10;i++){
    h.entries.push({type:'message',id:'error-'+i,message:{role:'assistant',stopReason:'error'}});
    const retry=h.handlers.agent_before_settle({outcome:'error',entries:[]},h.ctx);
    await show(h);
    t.mock.timers.tick(1000*2**(i-1));
    const r=await retry;assert.equal(r.continue,true);
    if(i>1)assert.deepEqual(r.entries[0],{type:'context_edit',targetId:'error-'+i,replacement:null});
    h.handlers.agent_start();
  }
  await h.handlers.agent_before_settle({outcome:'error',entries:[]},h.ctx);
  assert.equal(h.state().run.status,'paused');
});
test('retry cancellation on pause, edits, clear, restore and shutdown',async()=>{
  for(const action of ['pause','add later','clear','restore','shutdown']){
    const h=fixture();await h.run('work');
    const retry=h.handlers.agent_before_settle({outcome:'error',entries:[]},h.ctx);
    if(action==='restore')h.handlers.session_start({},h.ctx);
    else if(action==='shutdown')h.handlers.session_shutdown();
    else await h.run(action);
    assert.equal(await retry,undefined);
  }
});
test('compact and successful backtrack inject one small digest without starting execution',async()=>{
  const h=fixture();await h.run('add task');
  const before=h.entries.length;
  h.handlers.session_compact({},h.ctx);
  assert.match(h.messages.at(-1).content,/^\[goal status: 1 todo/);
  assert.equal(h.entries.length,before);
  h.handlers.tool_result({toolName:'backtrack',isError:true});
  assert.equal(h.handlers.turn_end({entries:[]},h.ctx),undefined);
  h.handlers.tool_result({toolName:'backtrack',isError:false});
  const original={type:'custom',customType:'other',data:{}};
  const r=h.handlers.turn_end({entries:[original]},h.ctx);
  assert.deepEqual(r.entries[0],original);
  assert.equal(r.entries[1].customType,'pi-goal');
  assert.match(r.entries[1].content,/tools.goal_show/);
  assert.equal(h.handlers.turn_end({entries:[]},h.ctx),undefined);
  assert.equal(h.state().run,null);
});
