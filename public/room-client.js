'use strict';
const deskSocket = SubtitleConnection.connect();
let deskListener, currentDeskState, deskOnline = false;
const deskWaiters = [];
function deskEvent(kind, value) {
  if (!currentDeskState || !deskOnline) return;
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
deskSocket.on('disconnect', () => {deskOnline=false;deskListener?.({type:'disconnect'});});
const roomReady = new Promise((resolve, reject) => {
  deskSocket.on('connect', () => {
    deskSocket.emit('joinDesk', {}, result => {
      if (!result.ok) {reject(Error(result.error));return;}
      deskSocket.emit('deskState', {}, snapshot => {
        currentDeskState=snapshot;deskOnline=true;
        deskListener?.({type:'snapshot',state:snapshot});
        resolve();for (const ready of deskWaiters.splice(0)) ready();
      });
    });
  });
});
function subscribeRoom(fn) {
  deskListener=fn;
  if (currentDeskState) fn({type:'snapshot',state:currentDeskState});
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
