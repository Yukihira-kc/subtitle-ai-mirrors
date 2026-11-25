'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {on, once} = require('node:events');
const {mkdtemp, readFile, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {setTimeout:delay} = require('node:timers/promises');
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
  const review=async ({audio, text, signal, dictionary}) => {
    const digest = createHash('sha256').update(audio).digest('hex');
    appendFileSync(process.env.TEST_GEMINI_CALLS, JSON.stringify({text,digest,dictionaryUri:dictionary?.uri})+'\\n');
    const attempt = (attempts.get(text)||0)+1;
    attempts.set(text,attempt);
    if (text.startsWith('二度停止する原文')) return new Promise(()=>{});
    if ((text==='再試行で復旧する原文' || text==='処理できない原文') && attempt===1) {
      // The provider may resolve after its attempt is canceled.
      await setTimeout(1100);
      appendFileSync(process.env.TEST_GEMINI_STALE,text+'\\n');
      return '期限切れの結果：'+text;
    }
    await setTimeout(5, undefined, {signal});
    if (text==='処理できない原文')
      throw new Error('A private upstream fixture error');
    if (text==='一時エラーの原文' && attempt===1)
      throw Object.assign(new Error('Temporary fixture error'),{status:503});
    return '校正：'+text;
  };
  let uploads = 0;
  review.registerDictionary = async text => {
    appendFileSync(process.env.TEST_GEMINI_DICTIONARIES,text+'\\n');
    if (text.includes('アップロード失敗')) throw new Error('Provider unavailable');
    return {uri:'https://mock.invalid/files/'+(++uploads),expiresAt:Date.now()+86400000};
  };
  return review;
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
  const stale = path.join(directory, 'gemini-stale.log');
  const dictionaries = path.join(directory, 'gemini-dictionaries.txt');
  await Promise.all([writeFile(fixture, mockGemini), writeFile(calls, ''), writeFile(stale, ''), writeFile(dictionaries, '')]);
  const processEnv = {
    ...process.env, PORT:'0', ROOM_STORE_PATH:path.join(directory,'rooms.json'),
    GEMINI_API_KEY:'', COMPLETE_AI_ACCESS_CODE:'', GEMINI_REVIEW_TIMEOUT_MS:'',
    TEST_GEMINI_CALLS:calls, TEST_GEMINI_STALE:stale, TEST_GEMINI_DICTIONARIES:dictionaries,
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
  async function waitForStaleResult(text) {
    const deadline = Date.now()+3000;
    while (!(await readFile(stale,'utf8')).split('\n').includes(text)) {
      if (Date.now()>=deadline) throw new Error('The canceled provider attempt did not settle');
      await delay(20);
    }
  }
  return {url,room,socket,connect,geminiCalls,waitForStaleResult,readDictionaries:()=>readFile(dictionaries,'utf8')};
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

test('再試行中の箱を追い越さず、校閲がF1で元の順に一度ずつ取得する', {timeout:12000}, async t => {
  const app = await startServer(t,{
    GEMINI_API_KEY:'fake-api-key',COMPLETE_AI_ACCESS_CODE:accessCode,GEMINI_REVIEW_TIMEOUT_MS:'350',
  });
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
  assert.equal(admission.aiAcquiredId,0);
  assert.deepEqual(admission.aiBoxes,[]);
  assert.deepEqual(admission.raw,[]);
  assert.equal((await call(desk,'joinDesk',{})).ok,true);

  const forwarded = [];
  const publication = new Set();
  let otherEvents = 0;
  editor.on('aiReviewBox',box=>{if (box.delivered) publication.add(box.id);});
  editor.on('reviewItem',item=>forwarded.push(item));
  other.on('aiReviewBox',()=>{otherEvents++;});
  const firstAudio = wave(250), secondAudio = wave(-310);
  const first = {key:'recording/1',version:1,text:'再試行で復旧する原文',clip:firstAudio,forReview:true};
  const second = {key:'recording/2',version:1,text:'次の原文',clip:secondAudio,forReview:true};
  const secondWaiting = waitForBox(editor,card=>card.id===2 && card.aiStatus==='ready' && !card.delivered);
  const firstRetrying = waitForBox(editor,card=>card.id===1 && card.aiStatus==='retrying');
  const allPublished = waitForBox(editor,card=>card.id===2 && card.delivered);
  const acquire = (socket,id,session=admission.session) => call(socket,'takeAiReviewBox',{id,session});

  assert.equal((await call(desk,'publishBox',{...first,clip:null})).ok,false);
  assert.deepEqual(await app.geminiCalls(),[]);
  assert.equal((await call(desk,'publishBox',first)).ok,true);
  assert.equal((await call(desk,'publishBox',first)).ok,true);
  assert.equal((await call(desk,'publishBox',second)).ok,true);
  assert.equal((await call(desk,'claim',{id:1})).ok,false);
  const waiting = await secondWaiting;
  assert.equal(waiting.text,'');
  assert.equal((await acquire(editor,2)).ok,false);
  assert.equal((await firstRetrying).audio,true);
  await allPublished;
  await app.waitForStaleResult(first.text);

  const pending = await call(editor,'joinReviewer',reviewer);
  assert.equal(otherEvents,0);
  assert.deepEqual([...publication],[1,2]);
  assert.deepEqual(forwarded,[]);
  assert.deepEqual(pending.raw,[]);
  assert.equal(pending.reviewDraft.text,'');
  assert.equal(pending.aiAcquiredId,0);
  assert.deepEqual(pending.display.lines,[]);
  assert.deepEqual(pending.waiting,[]);
  assert.deepEqual(pending.aiBoxes.map(box=>box.text),['校正：'+first.text,'校正：'+second.text]);
  const savedCalls = await app.geminiCalls();
  assert.deepEqual(savedCalls,[
    {text:first.text,digest:sha256(firstAudio)},
    {text:second.text,digest:sha256(secondAudio)},
    {text:first.text,digest:sha256(firstAudio)},
  ]);
  assert.equal((await acquire(desk,1)).ok,false);
  assert.equal((await acquire(editor,1,'previous-session')).ok,false);
  assert.equal((await acquire(editor,2)).ok,false);

  const firstAcquisition = await acquire(editor,1);
  assert.equal(firstAcquisition.ok,true);
  assert.equal(firstAcquisition.box.id,1);
  assert.equal(firstAcquisition.box.acquired,true);
  assert.equal((await acquire(editor,1)).ok,true);
  assert.deepEqual(forwarded.map(item=>item.boxId),[1]);
  const released = once(desk,'caption',{signal:AbortSignal.timeout(2000)});
  editor.disconnect();
  await released;
  const successor = await app.connect(complete);
  const nextReviewer = {...reviewer,clientId:'complete-ai-test-successor'};
  const resumed = await call(successor,'joinReviewer',nextReviewer);
  assert.equal(resumed.session,admission.session);
  assert.equal(resumed.aiAcquiredId,1);
  assert.deepEqual(resumed.raw.map(item=>item.text),['校正：'+first.text]);
  assert.equal((await acquire(successor,1)).ok,true);

  const secondItem = once(successor,'reviewItem',{signal:AbortSignal.timeout(2000)});
  assert.equal((await acquire(successor,2)).box.id,2);
  assert.equal((await secondItem)[0].text,'校正：'+second.text);
  const snapshot = await call(successor,'joinReviewer',nextReviewer);
  assert.equal(snapshot.aiAcquiredId,2);
  assert.deepEqual(snapshot.raw.map(item=>item.boxId),[1,2]);
  assert.deepEqual(snapshot.aiBoxes.map(box=>box.acquired),[true,true]);
  assert.deepEqual(snapshot.display.lines,[]);
  for (const [index,audio] of [firstAudio,secondAudio].entries()) {
    const box = snapshot.aiBoxes[index];
    const clip = app.url+'/ai/api/rooms/'+complete.room.id+'/clips/'+box.id+'?version='+box.version;
    assert.equal((await fetch(clip,{headers:authorization(standard.token)})).status,403);
    const playable = await fetch(clip,{headers:authorization(complete.token)});
    assert.equal(playable.status,200);
    assert.deepEqual(Buffer.from(await playable.arrayBuffer()),audio);
  }

  const edited = '手動校閲済み';
  const draft = {...snapshot.reviewDraft,session:snapshot.session,text:edited+'\n校正：'+second.text};
  const sent = await call(successor,'captionAction',{kind:'send',id:'manual-f12',lines:[edited],
    consumed:edited.length+1,draft});
  assert.equal(sent.ok,true);
  const updated = await call(successor,'joinReviewer',nextReviewer);
  assert.deepEqual(updated.display.lines,[edited]);
  assert.equal(updated.reviewDraft.text,'校正：'+second.text);

  assert.equal((await call(other,'joinDesk',{})).ok,true);
  assert.equal((await call(other,'publishBox',{...first,key:'standard/1',forReview:false})).ok,true);
  assert.equal((await call(other,'deskState',{})).boxes.length,1);
  assert.deepEqual(await app.geminiCalls(),savedCalls);
});

test('二度の校閲失敗で原音だけの箱を順に渡し、その取得は編集欄へ追記しない', {timeout:10000}, async t => {
  const app = await startServer(t,{
    GEMINI_API_KEY:'fake-api-key',COMPLETE_AI_ACCESS_CODE:accessCode,GEMINI_REVIEW_TIMEOUT_MS:'350',
  });
  const complete = await app.room('失敗時の完全AI案件',{mode:'complete-ai',code:accessCode});
  assert.equal(complete.status,201);
  const [desk, editor] = await Promise.all([app.connect(complete),app.connect(complete)]);
  assert.equal((await call(desk,'deskState',{})).ok,true);
  assert.equal((await call(desk,'joinDesk',{})).ok,true);
  const joined = await call(editor,'joinReviewer',reviewer);
  assert.equal(joined.ok,true);
  const firstAudio = wave(160), secondAudio = wave(270), thirdAudio = wave(-380);
  const sentToEditor = [];
  const editorBoxBroadcasts = [];
  const deskBoxText = new Map();
  const delivered = new Set();
  editor.on('reviewItem',item=>sentToEditor.push(item));
  editor.on('aiReviewBox',box=>{if (box.delivered) delivered.add(box.id);});
  editor.on('box',box=>editorBoxBroadcasts.push(box));
  desk.on('box',box=>deskBoxText.set(box.id,box.text));
  const thirdWaiting = waitForBox(editor,card=>card.id===3 && card.aiStatus==='ready' && !card.delivered);
  const allDelivered = waitForBox(editor,card=>card.id===3 && card.delivered);
  const inputs = [
    {text:'処理できない原文',clip:firstAudio},
    {text:'一時エラーの原文',clip:secondAudio},
    {text:'後続の原文',clip:thirdAudio},
  ];
  for (const [index,input] of inputs.entries()) {
    assert.equal((await call(desk,'publishBox',{...input,key:'failures/'+index,version:1,forReview:true})).ok,true);
  }
  assert.equal((await thirdWaiting).text,'');
  await allDelivered;
  await app.waitForStaleResult(inputs[0].text);

  const pending = await call(editor,'joinReviewer',reviewer);
  assert.deepEqual([...delivered],[1,2,3]);
  assert.deepEqual(editorBoxBroadcasts,[]);
  assert.equal(deskBoxText.get(1),inputs[0].text);
  assert.deepEqual(pending.raw,[]);
  assert.equal(pending.aiAcquiredId,0);
  assert.deepEqual(pending.aiBoxes.map(box=>box.aiStatus),['audio-only','ready','ready']);
  assert.deepEqual(pending.aiBoxes.map(box=>box.text),['','校正：一時エラーの原文','校正：後続の原文']);
  assert.ok(pending.aiBoxes.every(box=>box.audio));
  assert.doesNotMatch(JSON.stringify(pending.aiBoxes),/private upstream|期限切れの結果/);
  const acquire = id=>call(editor,'takeAiReviewBox',{id,session:joined.session});
  assert.equal((await acquire(2)).ok,false);
  const audioOnly = await acquire(1);
  assert.equal(audioOnly.ok,true);
  assert.equal(audioOnly.box.aiStatus,'audio-only');
  assert.equal(audioOnly.box.text,'');
  assert.equal(audioOnly.box.acquired,true);
  assert.equal((await acquire(1)).ok,true);
  const first = await call(editor,'joinReviewer',reviewer);
  assert.equal(first.aiAcquiredId,1);
  assert.deepEqual(first.raw,[]);
  assert.deepEqual(sentToEditor,[]);

  assert.equal((await acquire(2)).ok,true);
  assert.equal((await acquire(3)).ok,true);
  const final = await call(editor,'joinReviewer',reviewer);
  assert.equal(final.aiAcquiredId,3);
  assert.deepEqual(sentToEditor.map(item=>item.boxId),[2,3]);
  assert.deepEqual(final.raw.map(item=>item.text),['校正：一時エラーの原文','校正：後続の原文']);
  assert.deepEqual(final.display.lines,[]);
  assert.deepEqual(final.waiting,[]);
  const replay = await fetch(app.url+'/ai/api/rooms/'+complete.room.id+'/clips/1?version=1',
    {headers:authorization(complete.token)});
  assert.equal(replay.status,200);
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()),firstAudio);

  const calls = await app.geminiCalls();
  assert.deepEqual(inputs.map(({text,clip})=>calls.filter(entry=>entry.text===text && entry.digest===sha256(clip)).length),
    [2,2,1]);
  assert.equal(calls.length,5);
});

test('すべての枠が二度時間切れでも、待機中の箱は空き枠から新たに校正できる', {timeout:10000}, async t => {
  const app = await startServer(t,{
    GEMINI_API_KEY:'fake-api-key',COMPLETE_AI_ACCESS_CODE:accessCode,GEMINI_REVIEW_TIMEOUT_MS:'500',
  });
  const complete = await app.room('枠待ちの完全AI案件',{mode:'complete-ai',code:accessCode});
  assert.equal(complete.status,201);
  const [desk, editor] = await Promise.all([app.connect(complete),app.connect(complete)]);
  assert.equal((await call(desk,'joinDesk',{})).ok,true);
  assert.equal((await call(editor,'joinReviewer',reviewer)).ok,true);

  const audio = wave(290);
  const submit = (id,text) => call(desk,'publishBox',{key:'queue/'+id,version:1,text,clip:audio,forReview:true});
  const stalledTexts = [1,2,3].map(id=>'二度停止する原文'+id);
  const active = [1,2,3].map(id=>waitForBox(editor,card=>card.id===id && card.aiStatus==='processing'));
  const queued = waitForBox(editor,card=>card.id===4 && card.aiStatus==='queued');
  const released = waitForBox(editor,card=>card.id===4 && card.delivered);
  for (const [index,text] of stalledTexts.entries()) assert.equal((await submit(index+1,text)).ok,true);
  await Promise.all(active);
  assert.equal((await submit(4,'空き枠を待った箱')).ok,true);
  assert.equal((await queued).text,'');
  assert.deepEqual((await app.geminiCalls()).map(item=>item.text),stalledTexts);
  assert.equal((await released).text,'校正：空き枠を待った箱');
  const snapshot = await call(editor,'joinReviewer',reviewer);
  assert.deepEqual(snapshot.aiBoxes.map(box=>box.aiStatus),['audio-only','audio-only','audio-only','ready']);
  assert.ok(snapshot.aiBoxes.every(box=>box.delivered && box.audio));
  assert.deepEqual(snapshot.raw,[]);
  assert.equal(snapshot.aiAcquiredId,0);
  const calls = (await app.geminiCalls()).map(item=>item.text);
  assert.equal(calls.length,7);
  assert.ok(stalledTexts.every(text=>calls.filter(callText=>callText===text).length===2));
});

test('デスクと校閲が事前登録したIME辞書を同じ部屋の箱が参照する', {timeout:12000}, async t => {
  const app = await startServer(t,{
    GEMINI_API_KEY:'fake-api-key',COMPLETE_AI_ACCESS_CODE:accessCode,
  });
  const complete = await app.room('辞書のある完全AI案件',{mode:'complete-ai',code:accessCode});
  const [desk, editor, observer] = await Promise.all([app.connect(complete),app.connect(complete),app.connect(complete)]);
  assert.equal((await call(desk,'deskState',{})).ok,true);
  assert.equal((await call(desk,'joinDesk',{})).ok,true);
  assert.equal((await call(editor,'joinReviewer',reviewer)).ok,true);
  assert.deepEqual(await call(editor,'getGeminiDictionary',{}),{ok:true,dictionary:null});

  const original = Buffer.from('\ufeff!Microsoft IME Dictionary Tool\r\nよみ\t語句\t品詞\tコメント\r\nらいとくん\t光くん\t人名\t辞書側のメモ\r\nふりがな\tフリガナ\t名詞\t\r\n','utf16le');
  const registration = {name:'出演者.txt',file:original};
  assert.equal((await call(observer,'registerGeminiDictionary',registration)).ok,false);
  assert.equal((await call(desk,'registerGeminiDictionary',{name:'不正.txt',file:Buffer.from('よみのみ')})).ok,false);
  const notification = once(editor,'geminiDictionary',{signal:AbortSignal.timeout(2000)});
  const first = await call(desk,'registerGeminiDictionary',registration);
  assert.equal(first.ok,true);
  assert.equal(first.dictionary.count,2);
  assert.equal(first.dictionary.name,'出演者.txt');
  assert.deepEqual((await notification)[0],first.dictionary);
  assert.equal(await app.readDictionaries(),'らいとくん\t光くん\nふりがな\tフリガナ\n');
  assert.equal((await call(observer,'getGeminiDictionary',{})).ok,false);

  const publish = (id,text) => call(desk,'publishBox',{key:'辞書/'+id,version:1,text,clip:wave(25),forReview:true});
  const ready = waitForBox(editor,card=>card.id===2 && card.delivered);
  assert.equal((await publish(1,'ライト君。')).ok,true);
  assert.equal((await publish(2,'それ以外の一般語。')).ok,true);
  await ready;
  assert.equal((await app.readDictionaries()).split('光くん').length,2);
  assert.deepEqual((await app.geminiCalls()).map(x=>x.dictionaryUri),['https://mock.invalid/files/1','https://mock.invalid/files/1']);

  const invalidReplacement = {name:'失敗.txt',file:Buffer.from('しっぱい\tアップロード失敗\t名詞')};
  assert.equal((await call(editor,'registerGeminiDictionary',invalidReplacement)).ok,false);
  assert.deepEqual((await call(desk,'getGeminiDictionary',{})).dictionary,first.dictionary);
  const replacement = {name:'改訂.txt',file:Buffer.from('ひかるくん\t光くん\t人名\t備考')};
  const deskUpdate = once(desk,'geminiDictionary',{signal:AbortSignal.timeout(2000)});
  assert.equal((await call(editor,'registerGeminiDictionary',replacement)).ok,true);
  assert.equal((await deskUpdate)[0].name,'改訂.txt');
  const third = waitForBox(editor,card=>card.id===3 && card.delivered);
  assert.equal((await publish(3,'光る君。')).ok,true);
  await third;
  assert.equal((await app.geminiCalls()).at(-1).dictionaryUri,'https://mock.invalid/files/2');

  const independent = await app.room('別の完全AI案件',{mode:'complete-ai',code:accessCode});
  const otherDesk = await app.connect(independent);
  await call(otherDesk,'joinDesk',{});
  assert.deepEqual(await call(otherDesk,'getGeminiDictionary',{}),{ok:true,dictionary:null});
});
