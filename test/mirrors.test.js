'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {mkdtemp, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {io} = require('socket.io-client');

test('同一名の案件がある独立したミラーで、入力途中・音声・送信済み原稿を分離する', {timeout:15000}, async t=>{
  const temp=await mkdtemp(path.join(tmpdir(),'ai-mirrors-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  async function server(label) {
    const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',ROOM_STORE_PATH:path.join(temp,label,'rooms.json')}});
    t.after(()=>child.kill());
    const [line]=await once(child.stdout,'data');
    return 'http://127.0.0.1:'+line.toString().match(/port (\d+)/)[1];
  }
  const [first,second]=await Promise.all([server('split'),server('azure')]);
  const create=async url=> {
    const r=await fetch(url+'/ai/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'同一案件',password:'1234'})});
    assert.equal(r.status,201);return r.json();
  };
  const [one,two]=await Promise.all([create(first),create(second)]);
  assert.notEqual(one.room.id,two.room.id);
  assert.equal((await fetch(second+'/ai/api/rooms/'+one.room.id)).status,404);
  async function enter(url,room) {
    const s=io(url,{path:'/ai/socket.io',auth:{roomId:room.room.id,token:room.token}});
    t.after(()=>s.disconnect());await once(s,'connect');return s;
  }
  const desk=await enter(first,one), a=await enter(first,one), b=await enter(first,one), spare=await enter(second,two);
  await desk.emitWithAck('joinDesk',{});
  const snapshot=once(a,'operatorSnapshot');await a.emitWithAck('register',{key:'A'});const [{session}]=await snapshot;
  await b.emitWithAck('register',{key:'B'});
  const nextTyping=once(b,'typing');a.emit('typing',{key:'A',value:'にゅう'});assert.equal((await nextTyping)[0].value,'にゅう');
  const clip=Buffer.alloc(128);const box={key:'recording/1',version:1,text:'認識した原稿',clip};
  assert.ok((await desk.emitWithAck('publishBox',box)).ok);await desk.emitWithAck('publishBox',box);
  assert.equal((await desk.emitWithAck('deskState',{})).boxes.length,1);
  assert.deepEqual((await spare.emitWithAck('deskState',{})).boxes,[]);
  const clipUrl=first+'/ai/api/rooms/'+one.room.id+'/clips/1?version=1';
  assert.equal((await fetch(clipUrl,{headers:{Authorization:'Bearer '+two.token}})).status,403);
  assert.deepEqual(Buffer.from(await (await fetch(clipUrl,{headers:{Authorization:'Bearer '+one.token}})).arrayBuffer()),clip);
  assert.ok((await a.emitWithAck('claim',{id:1})).ok);assert.equal((await b.emitWithAck('claim',{id:1})).ok,false);
  const send={key:'A',request:'test-send',epoch:session,text:'校閲用原稿',box:1};
  assert.ok((await a.emitWithAck('send',send)).ok);assert.ok((await a.emitWithAck('send',send)).ok);
  assert.equal((await desk.emitWithAck('deskState',{})).raw.length,1);
  assert.deepEqual((await spare.emitWithAck('deskState',{})).raw,[]);
  assert.equal((await fetch(clipUrl,{headers:{Authorization:'Bearer '+one.token}})).status,404);
});
