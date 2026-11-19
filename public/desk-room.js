const boxes = []; // Local word timing references for the current recording.

const pendingBoxes = new Map(), deskRows = new Map();
const role='デスク';
let deskConnected=false, switchingEngine=false, deskRecognitionBusy=false;
let deskConnectionMessage='';
const recordingKey = crypto.randomUUID();
let uploading=false, retryError='';
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));

function showDelivery(){
  $('delivery').textContent = deskConnectionMessage || retryError || (pendingBoxes.size?'音声認識テキストに送信中':'');
}
function publishBox(box) {
  if (!box.key) box.key=recordingKey+'/'+box.id;
  box.version=(box.version||0)+1;
  pendingBoxes.set(box.key,box);
  uploadBoxes();
}
async function uploadBoxes(){
  if(uploading)return;
  uploading=true;
  while(pendingBoxes.size){
    const [key,box]=pendingBoxes.entries().next().value;
    const {version,text,approx}=box;
    const meta={key,version,text,approx:!!approx};
    const clip=box.audio;
    showDelivery();
    try {
      await roomUpload(meta,clip);
      if(box.version===version)pendingBoxes.delete(key);
      else {pendingBoxes.delete(key);pendingBoxes.set(key,box)}
      retryError='';
    }catch(error){
      retryError='音声認識テキストへの送信を再試行中　'+error.message;
      showDelivery();await sleep(700);
    }
  }
  uploading=false;showDelivery();
}
function showDeskBox(box){
  let row=deskRows.get(box.id);
  if(!row){
    row=document.createElement('div');row.className='row';
    row.append(document.createElement('b'),document.createElement('span'),document.createElement('small'));
    $('boxes').append(row);deskRows.set(box.id,row);
  }
  row.children[0].textContent='#'+box.id;
  row.children[1].textContent=box.text+(box.audio?'':'　（音声なし）')+(box.approx?'　（音声は前後を含みます）':'');
  row.children[2].textContent=box.sent?'送信済み':box.owner?box.owner+' 取得中':'未取得';
}
function applyDeskState(change){
  if(change.type==='snapshot'){
    deskRows.clear();
    $('boxes').replaceChildren();
    change.state.boxes.forEach(showDeskBox);
  }else if(change.type==='event' && change.kind==='box'){
    showDeskBox(change.value);
  }else if(change.type==='ready' || change.type==='waiting'){
    deskConnected=change.type==='ready';
    deskConnectionMessage=change.message;
    updateDeskControls();showDelivery();
  }
}
function draw(){
  $('cut').disabled=!deskConnected||composing||!editor.value.trim();
}
function updateDeskControls(){
  $('start').disabled=$('engine').disabled=!deskConnected||deskRecognitionBusy;
  draw();
}
function setDeskRecognitionBusy(busy){
  deskRecognitionBusy=busy;
  updateDeskControls();
}
function switchEngine(previous){
 const picker=$('engine'),next=picker.value;
 if(switchingEngine || picker.disabled || next===previous){picker.value=previous;return;}
 if((pendingBoxes.size || editor.value.trim()) && !confirm('未送信の原稿と転送中の音声は引き継がれません。認識エンジンを切り替えますか？')){
   picker.value=previous;return;
 }
 const url=new URL(roomLink('desk'),location.href);
 url.pathname=next==='vosk'?'/desk.html':'/azure.html';
 if(next==='S0'){
   // The marker travels only with this navigation; a shared link opens at F0.
   try{sessionStorage.setItem(SubtitleConnection.storageKey('open-s0'),'1');}catch{}
   url.hash='select-s0';
 }
 switchingEngine=true;
 picker.value=previous;
 deskSocket.disconnect();
 location.assign(url);
}
async function watchDesk(){
 subscribeRoom(applyDeskState);
 await roomReady;
 if(SubtitleConnection.roomId==='practice')$('end-room').textContent='ルームを退出';
 for(const [key,label] of [['A','入力 A'],['B','入力 B'],['reviewer','校閲']]){
   const url=new URL(roomLink(key),location.href).href;
   const a=document.createElement('a');
   a.href=url;a.target='_blank';a.rel='noopener';a.textContent=label+'を開く';$('roles').append(a);
   const row=document.createElement('p'),name=document.createElement('span'),address=document.createElement('input'),copy=document.createElement('button');
   name.textContent=label;address.value=url; address.readOnly=true;address.setAttribute('aria-label',label+'の参加リンク');
   copy.textContent='コピー';copy.onclick=async()=>{
     try{await navigator.clipboard.writeText(url);copy.textContent='コピー済み'}
     catch{address.focus();address.select()}
   };
   row.append(name,address,copy);$('invitations').append(row);
 }
}
addEventListener('pageshow',event=>{if(event.persisted)switchingEngine=false;});
addEventListener('beforeunload',event=>{
 if(!switchingEngine && (pendingBoxes.size || document.getElementById('pool')?.value.trim())){
   event.preventDefault();event.returnValue='';
 }
});

$('end-room').onclick=async()=>{
 if(SubtitleConnection.roomId!=='practice' && !confirm('このルームを終了し、共有した音声と原稿をサーバーから削除しますか？'))return;
 try{await endDeskRoom()}catch(e){$('delivery').textContent=e.message}
};
