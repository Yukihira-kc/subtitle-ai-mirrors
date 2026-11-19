const roomBoxes = new Map(), cards = new Map();
let epoch, selected = null, owned = null, claiming = null, sending = false;
let playback, node, playNumber = 0;
const sounds = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const notice = message => {document.querySelector('#notice').textContent = message};
const commandId = () => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
const soundKey = box => epoch+'/'+box.id+'/'+box.version;

function stopReplay() {
  playNumber++;
  if (node) {node.stop(); node.disconnect(); node=null}
}

function showOutputState() {
  const ready = playback?.state === 'running';
  document.querySelector('#warm-output').hidden=ready;
  document.querySelector('#output-state').textContent=ready?'音声出力 準備完了':'';
}

async function prepareOutput() {
  if (!playback) {
    playback=new AudioContext({latencyHint:'interactive'});
    // Open the output device once while joining; Firefox may require a user gesture.
    playback.addEventListener('statechange',showOutputState);
    const silence=playback.createBufferSource();
    silence.buffer=playback.createBuffer(1,128,playback.sampleRate);
    silence.connect(playback.destination);
    silence.onended=()=>silence.disconnect();
    silence.start();
  }
  return playback.state==='running' ? Promise.resolve() : playback.resume();
}

function loadSound(box) {
  const key = soundKey(box);
  if (!sounds.has(key)) {
    if (!playback) prepareOutput().catch(()=>{});
    const task = fetch(SubtitleConnection.url+'/ai/api/rooms/'+encodeURIComponent(SubtitleConnection.roomId)+'/clips/'+box.id+'?version='+box.version,
      {headers:{Authorization:'Bearer '+SubtitleConnection.token()},cache:'no-store'}).then(async response => {
      if (!response.ok) throw Error('音声を取得できません');
      // The desk writes mono PCM16 WAV with a fixed 44-byte header.
      const wav=await response.arrayBuffer();
      const header=new DataView(wav);
      const frames=new Int16Array(wav,44,header.getUint32(40,true)/2);
      const buffer=playback.createBuffer(1,frames.length,header.getUint32(24,true));
      const channel=buffer.getChannelData(0);
      for(let i=0;i<frames.length;i++) channel[i]=frames[i]/32768;
      return buffer;
    });
    sounds.set(key, task);
    task.catch(() => {if (sounds.get(key) === task) sounds.delete(key)});
  }
  return sounds.get(key);
}

function paintBox(box) {
  roomBoxes.set(box.id, box);
  let button = cards.get(box.id);
  if (!button) {
    button = document.createElement('button');
    button.className = 'box-card';
    button.onclick = () => {selected=box.id; refreshOffers()};
    document.querySelector('#cards').append(button);
    cards.set(box.id, button);
  }
  button.textContent = '#'+box.id+'　'+(box.sent?'送信済み':box.owner?box.owner+'取得中':'未取得')+
    '\n'+box.text+(box.audio?'':'　音声なし')+(box.approx?'\n音声は前後を含みます':'');
  button.disabled = !!box.owner;
}

let highlighted = null;
function refreshOffers() {
  const oldOwned = owned;
  owned = null;
  let first = null;
  for (const box of roomBoxes.values()) {
    if (!first && !box.owner) first=box;
    if (box.owner===myRole && !box.sent) owned=box;
  }
  if (oldOwned && oldOwned.id!==owned?.id) stopReplay();
  if (!roomBoxes.has(selected) || roomBoxes.get(selected).owner) selected=first?.id;
  cards.get(highlighted)?.classList.remove('selected');
  cards.get(selected)?.classList.add('selected');
  highlighted=selected;
  document.querySelector('#take').disabled = !selected || !!owned || !!claiming || sending;
  document.querySelector('#replay').disabled = !owned?.audio;
  document.querySelector('#owner').textContent = owned?'取得中 #'+owned.id:'';
  const target = owned || roomBoxes.get(claiming?.id ?? selected);
  const key = target && soundKey(target);
  for (const cached of sounds.keys()) if (cached!==key) sounds.delete(cached);
  if (target?.audio) loadSound(target).catch(()=>{});
}

async function command(action, fields) {
  if(!isConnected)throw Error('再接続中です');
  const payload={...fields,key:myRole,epoch,request:commandId()};
  for (;;) {
    if(epoch!==payload.epoch)throw Error('ルームが再起動されました。原稿を確認してください');
    if(isConnected){
      let result;
      try {result=await socket.timeout(4000).emitWithAck(action,payload)} catch {}
      if(result){if(!result.ok)throw Error(result.error);notice('');return result}
    }
    notice('再接続中。操作の受付を確認しています');await pause(400);
  }
}

function finishComposition(field) {
  if (!operatorComposing) return Promise.resolve();
  return new Promise(resolve=>field.addEventListener('compositionend',resolve,{once:true}));
}

async function takeBox() {
  if (claiming || sending || owned || !selected || operatorComposing) return;
  const field=document.getElementById('input-'+myRole);
  const id = selected;
  const done = command('claim',{id}).then(async result=>{
    if (operatorComposing) await finishComposition(field);
    field.value+=result.acquired;
    field.dispatchEvent(new Event('input')); field.focus();
    field.setSelectionRange(field.value.length,field.value.length);
  });
  claiming = {id, done};
  if (document.querySelector('#autoplay-on-take').checked) void replayBox();
  else prepareOutput().catch(()=>{});
  refreshOffers();
  try {await done} catch(error){notice(error.message)}
  finally {claiming=null; refreshOffers()}
}

async function replayBox() {
  const pending = claiming;
  const id = pending?.id ?? owned?.id;
  if (!id || sending || (!pending && !owned.audio)) return;
  stopReplay();
  const ticket = playNumber, session = epoch;
  const canPlay = () => ticket === playNumber && session === epoch && !sending;
  try {
    // Resume audio inside the key or click gesture, while claim acknowledgement is pending.
    await Promise.all([prepareOutput(), pending?.done]);
    while (canPlay() && owned?.id === id && owned.audio) {
      const box = owned;
      let buffer;
      try {
        buffer = await loadSound(box);
      } catch(error) {
        if (!canPlay() || owned?.id !== id) return;
        if (owned.version !== box.version) continue;
        throw error;
      }
      if (!canPlay() || owned?.id !== id) return;
      if (owned.version !== box.version) continue;
      node=playback.createBufferSource(); node.buffer=buffer;
      node.connect(playback.destination); node.start(); notice('');
      return;
    }
  } catch(error){if (canPlay()) notice(error.message)}
}

async function send() {
  if (sending || operatorComposing) return;
  sending=true;
  try {
    if (claiming) await claiming.done;
    const field=document.getElementById('input-'+myRole), text=field.value;
    await command('send',{text,box:owned?.id ?? null});
    if (operatorComposing) await finishComposition(field);
    if (field.value.startsWith(text)) field.setRangeText('',0,text.length,'preserve');
    field.dispatchEvent(new Event('input'));
  } catch(error){notice(error.message)}
  finally {sending=false; refreshOffers()}
}
