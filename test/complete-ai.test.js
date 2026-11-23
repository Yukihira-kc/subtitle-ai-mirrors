'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {on, once} = require('node:events');
const {mkdtemp, readFile, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {io} = require('socket.io-client');

const root = path.join(__dirname, '..');
const accessCode = 'test-complete-room-access';
const reviewer = {draftProtocol:1, clientId:'complete-ai-test-reviewer'};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const mockGemini = `
const Module = require('node:module');
const {appendFileSync} = require('node:fs');
const {setTimeout} = require('node:timers/promises');
const {createHash} = require('node:crypto');
const originalLoad = Module._load;
function createGeminiReview() {
  const attempts = new Map();
  return async ({audio, text, signal}) => {
    const digest = createHash('sha256').update(audio).digest('hex');
    appendFileSync(process.env.TEST_GEMINI_CALLS, JSON.stringify({text,digest})+'\\n');
    const attempt = (attempts.get(text)||0)+1;
    attempts.set(text,attempt);
    await setTimeout(text==='最初の誤認識' ? 150 : 5, undefined, {signal});
    if (text==='処理できない原文' || (text==='再試行できる原文' && attempt===1))
      throw new Error('A private upstream fixture error');
    return '校正：'+text;
  };
}
Module._load = function(request, parent, isMain) {
  if (/^\\.\\/gemini-review(?:\\.js)?$/.test(request) && parent?.filename.endsWith('/server.js'))
    return {createGeminiReview};
  return originalLoad.call(this, request, parent, isMain);
};
global.fetch = () => { throw new Error('External network is disabled in this test'); };
`;

async function startServer(t, settings = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'complete-ai-test-'));
  const fixture = path.join(directory, 'gemini-mock.cjs');
  const calls = path.join(directory, 'gemini-calls.jsonl');
  await Promise.all([writeFile(fixture, mockGemini), writeFile(calls, '')]);
  const processEnv = {
    ...process.env, PORT:'0', ROOM_STORE_PATH:path.join(directory,'rooms.json'),
    GEMINI_API_KEY:'', COMPLETE_AI_ACCESS_CODE:'', TEST_GEMINI_CALLS:calls,
    ...settings,
  };
  const child = spawn(process.execPath, ['--require', fixture, 'server.js'], {cwd:root, env:processEnv});
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exiting = once(child, 'exit');
      if (child.kill()) await exiting;
    }
    await rm(directory, {recursive:true, force:true});
  });
  let stderr = '';
  child.stderr.on('data', data => {stderr += data;});
  const [banner] = await once(child.stdout, 'data', {signal:AbortSignal.timeout(4000)})
    .catch(error => {throw new Error('The local server did not start: '+stderr, {cause:error});});
  const url = 'http://127.0.0.1:'+String(banner).match(/port (\d+)/)[1];
  async function room(name, {mode, code} = {}) {
    const response = await fetch(url+'/ai/api/rooms', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,password:'1234',mode,accessCode:code}),
    });
    return {status:response.status, ...await response.json()};
  }
  function socket(entry, token = entry.token) {
    const client = io(url,{path:'/ai/socket.io',auth:{roomId:entry.room.id,token},transports:['websocket'],
      autoConnect:false,reconnection:false,forceNew:true});
    sockets.push(client);
    return client;
  }
  async function connect(entry) {
    const client = socket(entry);
    const connected = once(client,'connect',{signal:AbortSignal.timeout(2000)});
    client.connect();
    await connected;
    return client;
  }
  const geminiCalls = async () => (await readFile(calls,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  return {url,room,socket,connect,geminiCalls};
}

function wave(sample) {
  const dataLength = 6400;
  const audio = Buffer.alloc(44+dataLength);
  audio.write('RIFF',0);audio.writeUInt32LE(36+dataLength,4);audio.write('WAVEfmt ',8);
  audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);
  audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);
  audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(dataLength,40);
  for (let offset=44;offset<audio.length;offset+=2) audio.writeInt16LE(sample,offset);
  return audio;
}

const call = (socket, event, payload) => socket.timeout(2000).emitWithAck(event,payload);
const authorization = token => ({Authorization:'Bearer '+token});
async function waitForBox(socket, match) {
  for await (const [card] of on(socket,'aiReviewBox',{signal:AbortSignal.timeout(4000)})) {
    if (match(card)) return card;
  }
}

test('完全AIモードはサーバーの設定がそろっている場合に限り作成できる', {timeout:8000}, async t => {
  const app = await startServer(t, {COMPLETE_AI_ACCESS_CODE:accessCode});
  const complete = await app.room('完全AIルーム', {mode:'complete-ai',code:accessCode});
  assert.equal(complete.status,503);
  const standard = await app.room('通常ルーム');
  assert.equal(standard.status,201);
  assert.equal(standard.room.mode,'standard');
  assert.deepEqual(await app.geminiCalls(),[]);
});

test('手動で送った原文のAI校閲と対応音声を、同じ案件ルームの校閲へ順番に渡す', {timeout:12000}, async t => {
  const app = await startServer(t,{GEMINI_API_KEY:'fake-api-key',COMPLETE_AI_ACCESS_CODE:accessCode});
  assert.equal((await app.room('認可されていない完全AI案件',{mode:'complete-ai',code:'wrong'})).status,403);
  const complete = await app.room('完全AI案件',{mode:'complete-ai',code:accessCode});
  const standard = await app.room('通常案件');
  assert.equal(complete.status,201);
  assert.equal(complete.room.mode,'complete-ai');
  assert.equal(complete.room.protected,true);
  assert.equal(standard.room.mode,'standard');

  const denied = app.socket(complete,standard.token);
  const rejected = once(denied,'connect_error',{signal:AbortSignal.timeout(2000)});
  denied.connect();
  assert.equal((await rejected)[0].data.code,'ROOM_AUTH');

  const [desk, editor, other] = await Promise.all([app.connect(complete),app.connect(complete),app.connect(standard)]);
  assert.equal((await call(desk,'register',{key:'A'})).ok,false);
  const admission = await call(editor,'joinReviewer',reviewer);
  assert.equal(admission.mode,'complete-ai');
  assert.deepEqual(admission.aiBoxes,[]);
  assert.deepEqual(admission.raw,[]);
  assert.equal((await call(desk,'joinDesk',{})).ok,true);

  const forwarded = [];
  const readyBoxes = [];
  let otherEvents = 0;
  editor.on('aiReviewBox',box => {if (box.aiStatus==='ready') readyBoxes.push(box);});
  editor.on('reviewItem',item => forwarded.push(item));
  other.on('aiReviewBox',() => {otherEvents++;});
  const firstAudio = wave(250);
  const secondAudio = wave(-310);
  const first = {key:'recording/1',version:1,text:'最初の誤認識',clip:firstAudio,forReview:true};
  const second = {key:'recording/2',version:1,text:'次の誤認識',clip:secondAudio,forReview:true};

  assert.equal((await call(desk,'publishBox',{...first,clip:null})).ok,false);
  assert.deepEqual(await app.geminiCalls(),[]);
  const forwardedBoth = new Promise(resolve => {
    editor.on('reviewItem',() => {if (forwarded.length===2) resolve();});
  });
  assert.equal((await call(desk,'publishBox',first)).ok,true);
  assert.equal((await call(desk,'publishBox',first)).ok,true);
  assert.equal((await call(desk,'publishBox',second)).ok,true);
  assert.equal((await call(desk,'claim',{id:1})).ok,false);
  await Promise.race([
    forwardedBoth,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI校閲の結果が届きませんでした')),4000).unref()),
  ]);
  assert.deepEqual(forwarded.map(item=>item.text),['校正：最初の誤認識','校正：次の誤認識']);
  assert.ok(forwarded.every(item=>item.key==='Gemini'));
  assert.equal(new Set(forwarded.map(item=>item.id)).size,2);
  assert.equal(otherEvents,0);

  const snapshot = await call(editor,'joinReviewer',reviewer);
  assert.deepEqual(snapshot.raw.map(item=>item.text),forwarded.map(item=>item.text));
  assert.deepEqual(snapshot.display.lines,[]);
  assert.deepEqual(snapshot.waiting,[]);
  assert.deepEqual(snapshot.aiBoxes.map(item=>item.text),forwarded.map(item=>item.text));
  for (const [index,audio] of [firstAudio,secondAudio].entries()) {
    const box = snapshot.aiBoxes[index];
    assert.equal(box.id,forwarded[index].boxId);
    assert.equal(box.aiStatus,'ready');
    assert.equal(box.audio,true);
    assert.ok(readyBoxes.some(event=>event.id===box.id));
    const clip = app.url+'/ai/api/rooms/'+complete.room.id+'/clips/'+box.id+'?version='+box.version;
    assert.equal((await fetch(clip,{headers:authorization(standard.token)})).status,403);
    const accessible = await fetch(clip,{headers:authorization(complete.token)});
    assert.equal(accessible.status,200);
    assert.deepEqual(Buffer.from(await accessible.arrayBuffer()),audio);
  }
  const byText = (left,right) => left.text.localeCompare(right.text);
  const saved = (await app.geminiCalls()).sort(byText);
  const expected = [
    {text:first.text,digest:sha256(firstAudio)},
    {text:second.text,digest:sha256(secondAudio)},
  ].sort(byText);
  assert.deepEqual(saved,expected);

  const edited = '手動校閲済み';
  const draft = {...snapshot.reviewDraft,session:snapshot.session,text:edited+'\n校正：次の誤認識'};
  const sent = await call(editor,'captionAction',{kind:'send',id:'manual-f12',lines:[edited],
    consumed:edited.length+1,draft});
  assert.equal(sent.ok,true);
  const updated = await call(editor,'joinReviewer',reviewer);
  assert.deepEqual(updated.display.lines,[edited]);
  assert.equal(updated.reviewDraft.text,'校正：次の誤認識');

  assert.equal((await call(other,'joinDesk',{})).ok,true);
  assert.equal((await call(other,'publishBox',{...first,key:'standard/1',forReview:false})).ok,true);
  assert.equal((await call(other,'deskState',{})).boxes.length,1);
  assert.deepEqual((await app.geminiCalls()).sort(byText),saved);
});

test('校閲失敗時は原音を保持し、デスクのスキップまたは再試行で処理を進める', {timeout:10000}, async t => {
  const app = await startServer(t,{GEMINI_API_KEY:'fake-api-key',COMPLETE_AI_ACCESS_CODE:accessCode});
  const complete = await app.room('失敗時の完全AI案件',{mode:'complete-ai',code:accessCode});
  assert.equal(complete.status,201);
  const [desk, editor] = await Promise.all([app.connect(complete),app.connect(complete)]);
  assert.equal((await call(desk,'joinDesk',{})).ok,true);
  assert.equal((await call(editor,'joinReviewer',reviewer)).ok,true);
  const firstAudio = wave(160);
  const makeBox = (id,text,clip=firstAudio) => ({key:'failures/'+id,version:1,text,clip,forReview:true});

  const failedFirst = waitForBox(editor,card=>card.id===1 && card.aiStatus==='failed');
  const waitingSecond = waitForBox(editor,card=>card.id===2 && card.aiStatus==='ready');
  assert.equal((await call(desk,'publishBox',makeBox(1,'処理できない原文'))).ok,true);
  assert.equal((await call(desk,'publishBox',makeBox(2,'後続の原文'))).ok,true);
  const [failure,waiting] = await Promise.all([failedFirst,waitingSecond]);
  assert.equal(failure.text,'');
  assert.equal(failure.audio,true);
  assert.match(failure.aiError,/Gemini/);
  assert.doesNotMatch(failure.aiError,/private upstream/);
  assert.equal(waiting.delivered,false);
  assert.deepEqual((await call(editor,'joinReviewer',reviewer)).raw,[]);
  assert.equal((await call(editor,'skipAiBox',{id:1})).ok,false);
  assert.equal((await call(editor,'retryAiBox',{id:1})).ok,false);

  const release = once(editor,'reviewItem',{signal:AbortSignal.timeout(2000)});
  assert.equal((await call(desk,'skipAiBox',{id:1})).ok,true);
  assert.equal((await release)[0].text,'校正：後続の原文');
  const postSkip = await call(editor,'joinReviewer',reviewer);
  assert.equal(postSkip.aiBoxes[0].aiStatus,'skipped');
  assert.equal(postSkip.aiBoxes[0].audio,true);
  const clip = await fetch(app.url+'/ai/api/rooms/'+complete.room.id+'/clips/1?version=1',
    {headers:authorization(complete.token)});
  assert.equal(clip.status,200);
  assert.deepEqual(Buffer.from(await clip.arrayBuffer()),firstAudio);

  const failedThird = waitForBox(editor,card=>card.id===3 && card.aiStatus==='failed');
  assert.equal((await call(desk,'publishBox',makeBox(3,'再試行できる原文',wave(175)))).ok,true);
  await failedThird;
  const revised = once(editor,'reviewItem',{signal:AbortSignal.timeout(2000)});
  assert.equal((await call(desk,'retryAiBox',{id:3})).ok,true);
  assert.equal((await revised)[0].text,'校正：再試行できる原文');
  const final = await call(editor,'joinReviewer',reviewer);
  assert.equal(final.aiBoxes[2].aiStatus,'ready');
  assert.deepEqual(final.raw.map(item=>item.text),['校正：後続の原文','校正：再試行できる原文']);
  assert.deepEqual(final.display.lines,[]);
});
