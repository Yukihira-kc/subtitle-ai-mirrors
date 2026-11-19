'use strict';
const deskSocket = SubtitleConnection.connect();
let deskListener, currentDeskState, deskOnline = false;
let haveSnapshot = false, deskRetry, resolveRoomReady;
let deskConnection = {type:'waiting',message:'デスクに接続中…'};
const roomReady = new Promise(resolve => {resolveRoomReady=resolve;});
const deskWaiters = [];
function deskEvent(kind, value) {
  if (!haveSnapshot) return;
  if (kind === 'settings') currentDeskState.settings = value;
  if (kind === 'log') currentDeskState.raw.push(value);
  if (kind === 'box') {
    const i = currentDeskState.boxes.findIndex(box => box.id === value.id);
    if (i < 0) currentDeskState.boxes.push(value);
    else currentDeskState.boxes[i] = value;
  }
  deskListener?.({type:'event',kind,value});
}
for (const kind of ['box','log','settings']) deskSocket.on(kind, value => deskEvent(kind, value));
function setDeskConnection(type, message='') {
  deskConnection={type,message};
  deskOnline=type==='ready';
  deskListener?.(deskConnection);
}
function retryDesk(action, socketId, message) {
  setDeskConnection('waiting',message);
  deskRetry=setTimeout(()=>{
    if(deskSocket.id===socketId)action(socketId);
  },1000);
}
function loadDeskState(socketId) {
  deskSocket.timeout(5000).emit('deskState',{},(error,snapshot)=>{
    if(deskSocket.id!==socketId)return;
    if(error || !snapshot?.ok){
      retryDesk(loadDeskState,socketId,'音声認識テキストを再取得しています…');
      return;
    }
    currentDeskState=snapshot;
    haveSnapshot=true;
    deskListener?.({type:'snapshot',state:snapshot});
    joinDesk(socketId);
  });
}
function joinDesk(socketId) {
  deskSocket.timeout(5000).emit('joinDesk',{},(error,result)=>{
    if(deskSocket.id!==socketId)return;
    if(error || !result?.ok){
      const message=error ? 'デスクへの接続を再試行しています…' : (result?.error||'デスクに接続できません')+'。自動で再試行します。';
      retryDesk(joinDesk,socketId,message);
      return;
    }
    setDeskConnection('ready');
    resolveRoomReady();
    for(const ready of deskWaiters.splice(0))ready();
  });
}
deskSocket.on('connect',()=>loadDeskState(deskSocket.id));
deskSocket.on('disconnect',()=>{
  clearTimeout(deskRetry);
  haveSnapshot=false;
  setDeskConnection('waiting','デスクの再接続を待っています…');
});
addEventListener('pagehide',()=>deskSocket.disconnect());
addEventListener('pageshow',event=>{if(event.persisted)deskSocket.connect();});
function subscribeRoom(fn) {
  deskListener=fn;
  if (currentDeskState) fn({type:'snapshot',state:currentDeskState});
  fn(deskConnection);
}
async function roomUpload(meta, blob) {
  await roomReady;
  if (!deskOnline) await new Promise(resolve=>deskWaiters.push(resolve));
  const result=await deskSocket.timeout(30000).emitWithAck('publishBox',{...meta,clip:blob?await blob.arrayBuffer():null});
  if (!result.ok) throw Error(result.error);
}
function roomLink(role) {
  const page={desk:'desk.html',A:'index.html',B:'index.html',reviewer:'reviewer.html'}[role];
  const u=new URL(page,location.href);
  u.searchParams.set('room',SubtitleConnection.roomId);
  if(role==='A'||role==='B')u.searchParams.set('role',role);
  return u.href;
}
async function endDeskRoom() {
  const id=SubtitleConnection.roomId;
  if(id!=='practice') {
    await SubtitleConnection.api('/rooms/'+id,{method:'DELETE',token:SubtitleConnection.token()});
    SubtitleConnection.remember(id,'');
  }
  location.replace('/rooms.html');
}
