
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GoalState} from '../dist/state.js';
test('nested goals preserve hierarchy, independent statuses and execution scope',()=>{
  const s=new GoalState();
  const root=s.add('root','user');s.start();
  const child=s.add('child','assistant',root.id);
  const other=s.add('other root','user');
  const grandchild=s.add('grandchild','user',child.id);
  assert.deepEqual(s.outline().map(r=>[r.goal.id,r.depth]),[[root.id,0],[child.id,1],[grandchild.id,2],[other.id,0]]);
  assert.equal('turnsRemaining' in s.run,false);assert.deepEqual(s.run.ids,[root.id]);
  assert.throws(()=>s.delete(root.id,'user'),/child goals/);
  s.update(child.id,{status:'done'},'assistant');
  assert.equal(s.get(root.id).status,'todo');assert.equal(s.get(grandchild.id).status,'todo');
  const snapshot=s.snapshot();s.restore(snapshot);
  assert.equal(s.get(grandchild.id).parentId,child.id);
  assert.equal(s.get(child.id).setBy,'assistant');
  assert.deepEqual(s.outline().map(r=>r.depth),[0,1,2,0]);
  s.delete(grandchild.id,'user');s.delete(child.id,'user');s.delete(root.id,'user');
  assert.equal(s.get(child.id).parentId,root.id);
  assert.deepEqual(s.visible().map(g=>g.id),[other.id]);
});
test('invalid parents are rejected and malformed persisted graphs repaired',()=>{
  const s=new GoalState();
  assert.throws(()=>s.add('orphan','user','missing'),/Unknown/);
  const root=s.add('root','user');
  for(const status of ['done','cancelled']){
    s.update(root.id,{status},'user');
    assert.throws(()=>s.add('child','assistant',root.id),/Reopen/);
  }
  s.delete(root.id,'user');
  assert.throws(()=>s.add('child','user',root.id),/deleted/);
  const goal=(id,parentId)=>({id,parentId,text:id,status:'todo'});
  s.restore({version:2,goals:[goal('a','b'),goal('b','a'),goal('c','missing'),goal('self','self'),goal('legacy')],run:null});
  assert.equal(s.outline().length,5);
  assert.equal(s.get('c').parentId,undefined);assert.equal(s.get('self').parentId,undefined);
  assert.equal(s.get('legacy').parentId,undefined);
});
test('no-op edits preserve goal identity, authorship and timestamps',()=>{
  let now=100;
  const s=new GoalState(()=>now),g=s.add('task','user'),goals=s.goals;
  now=200;s.update(g.id,{text:' task ',status:'todo'},'assistant');
  assert.equal(s.goals,goals);
  assert.deepEqual(s.get(g.id),g);
  s.update(g.id,{status:'doing'},'assistant');
  assert.notEqual(s.goals,goals);
  assert.equal(s.get(g.id).updatedAt,200);
});
test('source, timestamps and tombstones persist; snapshots are detached',()=>{
  let now=100;
  const s=new GoalState(()=>now),g=s.add('first','user');
  now=200;s.update(g.id,{text:'edited'},'assistant');
  assert.equal(s.get(g.id).setAt,100);assert.equal(s.get(g.id).setBy,'user');
  assert.equal(s.get(g.id).updatedAt,200);assert.equal(s.get(g.id).updatedBy,'assistant');
  now=300;s.delete(g.id,'user');
  const snap=s.snapshot();s.restore(snap);
  assert.equal(s.visible().length,0);assert.equal(s.get(g.id).deletedAt,300);
  snap.goals[0].text='bad';assert.equal(s.get(g.id).text,'edited');
});
test('elapsed time excludes pause and offline intervals; restore pauses without an obsolete turn budget',()=>{
  let now=0;const s=new GoalState(()=>now);
  s.add('work','assistant');s.start();now=1000;s.transition('paused');
  now=5000;assert.equal(s.elapsed(),1000);s.start();now=6000;
  const snap=s.snapshot();assert.equal(snap.run.elapsedMs,2000);
  now=100000;s.restore(snap);assert.equal(s.run.status,'paused');
  assert.equal(s.elapsed(),2000);assert.equal('turnsRemaining' in s.run,false);
});
test('legacy migration preserves known assistant source without inventing unknown provenance',()=>{
  const s=new GoalState();
  s.restore({text:'old',status:'active',elapsedMs:100,agentTurnsRemaining:10,setAt:123});
  assert.equal(s.goals[0].setBy,'assistant');assert.equal(s.goals[0].setAt,123);
  assert.equal(s.run.status,'paused');
  s.restore({text:'old',status:'complete',elapsedMs:100});
  assert.equal(s.goals[0].status,'done');assert.equal(s.goals[0].setBy,undefined);
  s.restore({text:'old',status:'closed',elapsedMs:100});
  assert.equal(s.goals[0].status,'cancelled');
  s.restore({text:'bad',status:'active',elapsedMs:-1});assert.equal(s.goals.length,0);
});
test('malformed snapshots are filtered; obsolete budget is discarded',()=>{
  const s=new GoalState();
  s.restore({version:2,goals:[null,{id:'x',text:'ok',status:'todo',setBy:'fake',setAt:Infinity},{id:'x',text:'duplicate',status:'done'}],run:{status:'active',ids:['x','missing'],elapsedMs:20,turnsRemaining:999}});
  assert.equal(s.goals.length,1);assert.equal(s.goals[0].setBy,undefined);
  assert.equal(s.goals[0].setAt,undefined);assert.equal('turnsRemaining' in s.run,false);
  assert.deepEqual(s.run.ids,['x']);assert.equal(s.run.status,'paused');
});
