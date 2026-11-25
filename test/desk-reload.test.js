'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {EventEmitter, once} = require('node:events');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {runInNewContext} = require('node:vm');
const {io} = require('socket.io-client');

test('reloading a desk displays shared text and recovers ownership after the old socket releases', {timeout:10000}, async t => {
  const root = path.resolve(__dirname, '..');
  const store = await mkdtemp(path.join(tmpdir(), 'speech-desk-reload-'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd:root,
    env:{...process.env, PORT:'0', ROOM_STORE_PATH:path.join(store, 'rooms.json')},
  });
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    if (server.exitCode === null && server.signalCode === null) {
      const exit = once(server, 'exit');
      if (server.kill()) await exit;
    }
    await rm(store, {recursive:true, force:true});
  });
  const [banner] = await once(server.stdout, 'data', {signal:AbortSignal.timeout(3500)});
  const url = 'http://127.0.0.1:' + banner.toString().match(/port (\d+)/)[1];
  function socket() {
    const connection = io(url, {
      path:'/ai/socket.io', auth:{roomId:'practice'}, transports:['websocket'],
      autoConnect:false, reconnection:false, forceNew:true,
    });
    sockets.push(connection);
    return connection;
  }

  const previous = socket();
  const connected = once(previous, 'connect', {signal:AbortSignal.timeout(3000)});
  previous.connect();
  await connected;
  assert.equal((await previous.timeout(2000).emitWithAck('joinDesk', {})).ok, true);
  const original = {key:'previous/1', version:1, text:'更新前の原稿'};
  assert.equal((await previous.timeout(2000).emitWithAck('publishBox', original)).ok, true);

  const refreshed = socket();
  const source = await readFile(path.join(root, 'public', 'room-client.js'), 'utf8');
  const lifecycle = new EventTarget();
  const client = runInNewContext(source + '\n({roomReady, subscribeRoom, roomUpload});', {
    SubtitleConnection:{connect:() => refreshed},
    location:{pathname:'/desk.html'},
    addEventListener:lifecycle.addEventListener.bind(lifecycle),
    setTimeout, clearTimeout,
  });
  const changes = new EventEmitter();
  client.subscribeRoom(change => changes.emit(change.type, change));
  const joining = AbortSignal.timeout(3000);
  const snapshot = once(changes, 'snapshot', {signal:joining});
  const waiting = once(changes, 'waiting', {signal:joining});
  const deskReady = client.roomReady;
  let readyWhileBusy = false;
  changes.once('ready', () => { readyWhileBusy = previous.connected; });
  // Keep a failed join observable even if a snapshot never arrives.
  void deskReady.catch(() => {});
  refreshed.connect();
  const [[{state}]] = await Promise.all([snapshot, waiting]);
  assert.equal(state.boxes.length, 1);
  assert.equal(state.boxes[0].text, original.text);
  assert.equal(previous.connected, true);

  const followup = {key:'refreshed/1', version:1, text:'更新後の原稿'};
  assert.equal((await refreshed.timeout(2000).emitWithAck('publishBox', followup)).ok, false);
  const refreshedId = refreshed.id;
  const ready = once(changes, 'ready', {signal:AbortSignal.timeout(2000)});
  previous.disconnect();
  await Promise.all([ready, deskReady]);
  assert.equal(readyWhileBusy, false);
  assert.equal(refreshed.id, refreshedId);

  const received = once(changes, 'event', {signal:AbortSignal.timeout(2000)});
  await client.roomUpload(followup, null);
  const [update] = await received;
  assert.equal(update.kind, 'box');
  assert.equal(update.value.text, followup.text);

  lifecycle.dispatchEvent(new Event('pagehide'));
  assert.equal(refreshed.connected, false);
  const restoring = AbortSignal.timeout(2000);
  const restoredSnapshot = once(changes, 'snapshot', {signal:restoring});
  const restoredDesk = once(changes, 'ready', {signal:restoring});
  const restorePage = Object.assign(new Event('pageshow'), {persisted:true});
  lifecycle.dispatchEvent(restorePage);
  const [[restored]] = await Promise.all([restoredSnapshot, restoredDesk]);
  assert.deepEqual(restored.state.boxes.map(box => box.text), [original.text, followup.text]);
});
