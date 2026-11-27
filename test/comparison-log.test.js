'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createComparisonLog,boxRecognition} = require('../comparison-log');

test('recognition is idempotent, validates the source and does not retain other fields', () => {
  const log = createComparisonLog();
  const event = {id:'speech-1',at:1234,text:'認識結果',engine:'F0'};
  assert.deepEqual(log.recordRecognition({...event,key:'secret'}),{ok:true});
  assert.deepEqual(log.recordRecognition({...event,text:'別の文'}),{ok:true});
  assert.equal(log.recordRecognition({...event,id:'bad',engine:'other'}).ok,false);
  assert.deepEqual(log.snapshot('room',[],'').recognition,[event]);
  const value = {text:'途中',engine:'vosk',partial:true,approximate:false};
  assert.deepEqual(boxRecognition({...value,unrelated:'private'}),value);
  assert.equal(boxRecognition({...value,engine:'other'}),null);
});

test('groups merged inputs and split sends, deferring unseen F1 boxes across the empty boundary', () => {
  const log = createComparisonLog();
  log.acquire(1,1,false);
  log.acquire(2,2,false);
  const draft = {text:'最初\n最後',inputId:2,comparisonAcquiredId:2};
  log.send({id:'first',kind:'send',consumed:3,draft},['最初'],15);
  log.acquire(3,6,false);
  const before = log.snapshot('room',[],'最後\n次');
  assert.deepEqual(before.groups,[{boxIds:[1,2,3],sends:[{id:'first',text:'最初',automatic:false,at:15}],complete:false}]);
  log.send({id:'second',kind:'send-all',automatic:true,draft:{...draft,text:'最後'}},['最後'],18);
  const after = log.snapshot('room',[],'次');
  assert.deepEqual(after.groups.map(group=>[group.boxIds,group.complete]),[[[1,2],true],[[3],false]]);
  assert.deepEqual(after.groups[0].sends[1],{id:'second',text:'最後',automatic:true,at:18});
});

test('audio-only retrieval without a raw input does not cross an older empty send snapshot', () => {
  const log = createComparisonLog();
  log.acquire(1,1,false);
  log.acquire(2,1,true);
  log.send({id:'a',kind:'send',consumed:1,draft:{text:'一',inputId:1,comparisonAcquiredId:1}},['一'],10);
  log.save({text:'',inputId:1,comparisonAcquiredId:2});
  assert.deepEqual(log.snapshot('room',[],'').groups.map(g=>[g.boxIds,g.complete]),[[[1],true],[[2],false]]);
  log.send({id:'b',kind:'send-all',draft:{text:'聞き直し',inputId:1,comparisonAcquiredId:2}},['聞き直し'],12);
  assert.deepEqual(log.snapshot('room',[],'').groups[1],{
    boxIds:[2],sends:[{id:'b',text:'聞き直し',automatic:false,at:12}],complete:true});
});

test('accepted deletion closes an unsent corrected box; manual-only sends have no assumed source', () => {
  const log = createComparisonLog();
  log.acquire(1,4,false);
  log.save({inputId:4,text:'',comparisonAcquiredId:1});
  log.send({id:'m',kind:'send-all',draft:{text:'手入力',inputId:4,comparisonAcquiredId:1}},['手入力'],7);
  const {groups}=log.snapshot('room',[],'');
  assert.deepEqual(groups[0],{boxIds:[1],sends:[],complete:true});
  assert.deepEqual(groups[1].boxIds,[]);
});
