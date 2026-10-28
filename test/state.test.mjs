
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoalState} from '../dist/state.js';
test('single user goal replaces previous text and resets its timing',()=>{
  let now=100;const s=new GoalState(()=>now);
  s.set(' first ');now=200;s.set('second');
  assert.deepEqual(s.snapshot(),{version:3,goal:{text:'second',status:'active',elapsedMs:0,setBy:'user',setAt:200}});
  assert.throws(()=>s.set(' '),/blank/);assert.equal(s.goal.text,'second');
});
test('paused and blocked exclude idle time; resume restarts the same timer',()=>{
  let now=0;const s=new GoalState(()=>now);s.set('work');
  now=1000;s.transition('blocked');now=5000;assert.equal(s.elapsed(),1000);
  s.resume();assert.equal(s.goal.status,'active');assert.equal(s.goal.resumedAt,5000);
  now=6000;s.transition('paused');now=9000;assert.equal(s.elapsed(),2000);
  s.resume();now=10000;assert.equal(s.elapsed(),3000);
  s.transition('complete');assert.throws(()=>s.resume(),/No paused or blocked/);
  s.transition('closed');assert.throws(()=>s.resume(),/No paused or blocked/);
});
test('restore is detached, validates data and never counts offline time',()=>{
  let now=0;const s=new GoalState(()=>now);s.set('work');now=500;
  const saved=s.snapshot();now=9000;s.restore(saved);
  assert.equal(s.goal.status,'paused');assert.equal(s.elapsed(),500);
  saved.goal.text='mutated';assert.equal(s.goal.text,'work');
  s.restore({version:3,goal:{text:'bad',status:'active',elapsedMs:-1}});assert.equal(s.goal,null);
  s.restore({text:'legacy',status:'paused',elapsedMs:50,setAt:Infinity,resumedAt:1e20});
  assert.equal(s.goal.setAt,undefined);assert.equal(s.goal.resumedAt,undefined);assert.equal(s.goal.setBy,undefined);
});
test('list migration selects latest user root, never assistant tasks or older deleted goals',()=>{
  const s=new GoalState();
  const user={id:'old',text:'old root',status:'todo',setBy:'user'};
  const latest={id:'new',text:'latest root',status:'blocked',setBy:'user',setAt:123};
  const assistant={id:'assistant',text:'subtask',status:'doing',setBy:'assistant',parentId:'new'};
  const value={version:2,goals:[user,latest,assistant],run:{status:'active',elapsedMs:99999}};
  s.restore(value);
  assert.deepEqual(s.goal,{text:'latest root',status:'blocked',elapsedMs:0,setBy:'user',setAt:123});
  assert.equal('id' in s.goal,false);assert.equal('parentId' in s.goal,false);
  latest.deletedAt=200;s.restore(value);assert.equal(s.goal.text,'latest root');assert.equal(s.goal.status,'closed');
  s.restore({version:2,goals:[assistant],run:null});assert.equal(s.goal,null);
});
test('legacy user goal survives; assistant-created legacy goal is not adopted',()=>{
  const s=new GoalState();
  s.restore({text:'old',status:'active',elapsedMs:10});assert.equal(s.goal.status,'paused');
  s.restore({text:'agent task',status:'active',elapsedMs:10,agentTurnsRemaining:5});assert.equal(s.goal,null);
  s.restore({version:3,goal:null});assert.equal(s.goal,null);
});
