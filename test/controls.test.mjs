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
  const ctx={hasUI:false,isIdle:()=>idle,hasPendingMessages:()=>pending,sessionManager:{getBranch:()=>entries},ui:{notify:(...args)=>notices.push(args),setStatus:(...args)=>statuses.push(args)}};
  extension(pi);
  return {handlers,tools,entries,messages,notices,statuses,ctx,run:arg=>command(arg,ctx),idle:v=>idle=v,pending:v=>pending=v,active:()=>active,state:()=>entries.at(-1)?.data};
}
test('footer shows goal lifecycle and clears on clear or empty session restore',async()=>{
  const h=fixture();h.ctx.hasUI=true;
  const status=()=>h.statuses.at(-1);
  h.handlers.session_start({},h.ctx);assert.deepEqual(status(),['pi-goal',undefined]);
  await h.run('target');assert.match(status()[1],/^Pursuing goal \(/);
  await h.run('pause');assert.equal(status()[1],'Goal paused (/goal resume)');
  await h.run('continue');assert.match(status()[1],/^Pursuing goal/);
  h.handlers.turn_end({},h.ctx);assert.match(status()[1],/^Pursuing goal/);
  await h.tools.get('goal_update').execute('done',{status:'complete'},undefined,undefined,h.ctx);
  assert.match(status()[1],/^Goal achieved \(/);
  await h.run('clear');assert.deepEqual(status(),['pi-goal',undefined]);
  await h.run('new');h.handlers.session_start({},h.ctx);
  assert.equal(status()[1],'Goal paused (/goal resume)');
  h.entries.length=0;h.handlers.session_tree({},h.ctx);
  assert.deepEqual(status(),['pi-goal',undefined]);
  assert.equal(h.messages.length,3);
});

test('only activation transitions add messages to model context', async()=>{
  const h=fixture();
  const notice=()=>h.notices.at(-1)?.[0];
  await h.run('first');assert.equal(notice(),'Goal set: active.');
  await h.run('second');assert.equal(notice(),'Goal changed: active.');
  const count=h.messages.length;
  await h.run('pause');assert.match(notice(),/^Goal paused/);
  await h.run('continue');assert.equal(notice(),'Goal active.');
  await h.tools.get('goal_update').execute('pause',{status:'pause'},undefined,undefined,h.ctx);
  assert.equal(notice(),'Goal paused.');
  await h.run('continue');
  await h.tools.get('goal_update').execute('complete',{status:'complete'},undefined,undefined,h.ctx);
  assert.equal(notice(),'Goal completed.');
  await h.run('clear');assert.equal(notice(),'Goal cleared.');
  assert.equal(h.messages.length,count+2);
  await h.run('third');
  h.handlers.agent_before_settle({outcome:'error'},h.ctx);
  assert.equal(notice(),'Goal paused after an error.');
  await h.run('continue');
  h.handlers.agent_before_settle({outcome:'aborted'},h.ctx);
  assert.equal(notice(),'Goal paused after interruption.');
  h.handlers.session_start({},h.ctx);
  assert.equal(notice(),'Goal restored: paused.');
});

test('pause/parse stop continuation, continue resumes, clear hides the tool', async()=>{
  const h=fixture(); await h.run('target');
  assert.deepEqual(h.active(),['read','codemode']);
  assert.equal(h.tools.get('goal_update').exposure,'codemode');
  const event={outcome:'completed',entries:[],continue:false};
  for (const alias of ['parse','pause']) {
    await h.run(alias); assert.equal(h.state().status,'paused');
    assert.equal(h.handlers.agent_before_settle(event,h.ctx),undefined);
    await assert.rejects(()=>h.tools.get('goal_update').execute('id',{}),/No active/);
    await h.run('continue'); assert.equal(h.state().status,'active');
  }
  assert.equal(h.messages.length,3);
  await h.run('clear'); assert.equal(h.state().status,'closed');
  assert.equal(h.tools.get('goal_update').exposure,'hidden');
});
test('paused to active injects once; repeated resume and continue are no-ops',async()=>{
  const h=fixture();await h.run('target');await h.run('pause');
  const count=h.messages.length;
  await h.run('resume');
  assert.equal(h.messages.length,count+1);
  assert.match(h.messages.at(-1).content,/^goal resumed: target/);
  assert.equal(h.messages.at(-1).customType,'pi-goal');
  await h.run('resume');await h.run('continue');
  assert.equal(h.messages.length,count+1);
  await h.run('pause');await h.run('continue');
  assert.equal(h.messages.length,count+2);
});
test('pending messages and existing boundary continuation suppress redundant reminders',async()=>{
  const h=fixture();await h.run('target');
  const event={outcome:'completed',entries:[{type:'custom',customType:'other'}],continue:false};
  h.pending(true);assert.equal(h.handlers.agent_before_settle(event,h.ctx),undefined);
  h.pending(false);assert.equal(h.handlers.agent_before_settle({...event,continue:true},h.ctx),undefined);
  const result=h.handlers.agent_before_settle(event,h.ctx);
  assert.equal(result.continue,true);assert.deepEqual(result.entries[0],event.entries[0]);
  assert.match(result.entries[1].content,/^goal still active: target/);
});
test('abort pauses goal; reload and branch changes restore only branch state without running',async()=>{
  const h=fixture();await h.run('target');
  h.handlers.agent_before_settle({outcome:'aborted'},h.ctx);
  assert.equal(h.state().status,'paused');
  await h.run('continue');
  const count=h.messages.length;
  h.handlers.session_start({},h.ctx);
  assert.equal(h.tools.get('goal_update').exposure,'hidden');
  assert.equal(h.messages.length,count);
  await h.run('continue');assert.equal(h.state().status,'active');
  h.entries.length=0;h.handlers.session_tree({},h.ctx);
  assert.equal(h.tools.get('goal_update').exposure,'hidden');
  await h.run('continue');assert.equal(h.messages.length,count+1);
});
test('busy agent queues replacement and rejects old completion until delivery; missing codemode leaves goal unset',async()=>{
  const h=fixture();await h.run('original');
  const oldTool=h.tools.get('goal_update');
  h.idle(false);await h.run('replacement');
  assert.equal(h.state().text,'replacement');
  assert.match(h.messages[1].content,/^goal changed: replacement/);
  await assert.rejects(()=>oldTool.execute('old',{status:'complete'}),/awaiting delivery/);
  h.handlers.message_start({message:{role:'custom',...h.messages[1]}});
  await h.run('pause');assert.equal(h.state().status,'paused');
  await h.run('continue');assert.equal(h.state().status,'active');
  assert.equal(h.messages.length,3);
  const boundary={outcome:'completed',entries:[],continue:false};
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
  await assert.rejects(()=>oldTool.execute('old',{status:'complete'}),/awaiting delivery/);
  h.handlers.message_start({message:{role:'custom',...h.messages[2]}});
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx).continue,true);
  await h.run('exit');assert.equal(h.state().status,'closed');
  assert.equal(h.messages.length,3);
  assert.equal(h.handlers.agent_before_settle(boundary,h.ctx),undefined);
  const absent=fixture({codemode:false});await absent.run('target');
  assert.equal(absent.entries.length,0);assert.equal(absent.messages.length,0);
});
test('menu reports state and time, shortcuts pause/resume/clear',async()=>{
  const h=fixture();await h.run('menu goal'); h.ctx.hasUI=true;
  for (const [key,status] of [['p','paused'],['r','active'],['x','closed']]) {
    h.ctx.ui.custom=async factory=>{
      let result;
      const component=await factory({requestRender(){}},{},{},value=>result=value);
      try {
        assert.match(component.render(100).join('\n'),/menu goal/);
        assert.match(component.render(100).join('\n'),/Running time:/);
        component.handleInput(key);
        return result;
      } finally {component.dispose();}
    };
    await h.run('');assert.equal(h.state().status,status);
  }
});
