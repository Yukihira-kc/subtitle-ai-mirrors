const boxes = []; // Local word timing references for the current recording.

const pendingBoxes = new Map(), deskRows = new Map();
const role='デスク';
let deskConnected=false;
const recordingKey = crypto.randomUUID();
let uploading=false, retryError='';
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));

function showDelivery(){
  $('delivery').textContent = retryError || (pendingBoxes.size?'共有ボックスに転送中':'');
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
      retryError='共有ボックスへの転送を再試行中　'+error.message;
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
function addDeskLog(item){
  const line=document.createElement('div');line.textContent=item.key+'　'+item.text;$('log').append(line);
}
function showColumnGuide(settings){
  if(!Number.isInteger(settings?.columns))return;
  const field=$('pool');
  const style=getComputedStyle(field),canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d');ctx.font=style.fontSize+' '+style.fontFamily;
  const left=parseFloat(style.paddingLeft)+ctx.measureText('あ'.repeat(settings.columns)).width;
  field.style.backgroundImage='linear-gradient(to right, transparent '+left+'px, #c43c3c '+left+'px, #c43c3c '+(left+1)+'px, transparent '+(left+1)+'px)';
}
function applyDeskState(change){
  if(change.type==='snapshot'){
    deskRows.clear();$('boxes').replaceChildren();$('log').replaceChildren();
    change.state.boxes.forEach(showDeskBox);change.state.raw.forEach(addDeskLog);
    showColumnGuide(change.state.settings);
  }else if(change.type==='event'){
    if(change.kind==='box')showDeskBox(change.value);
    if(change.kind==='log')addDeskLog(change.value);
    if(change.kind==='settings')showColumnGuide(change.value);
  }
}
function draw(){
  $('cut').disabled=!deskConnected||composing||!editor.value.trim();
}
function switchEngine(){
 const url=new URL(roomLink('desk'),location.href);
 url.pathname='/'+$('engine').value;
 location.assign(url);
}
async function watchDesk(){
 $('start').disabled=true;
 $('engine').disabled=true;
 try{
   await roomReady;
   if(SubtitleConnection.roomId==='practice')$('end-room').textContent='ルームを退出';
   deskConnected=true;draw();
   $('start').disabled=false;$('engine').disabled=false;
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
   subscribeRoom(applyDeskState);
 }catch(error){
   $('delivery').textContent=error.message||'ルームに接続できません';
 }
}
addEventListener('beforeunload',event=>{
 if(pendingBoxes.size || document.getElementById('pool')?.value.trim()){
   event.preventDefault();event.returnValue='';
 }
});

$('end-room').onclick=async()=>{
 if(SubtitleConnection.roomId!=='practice' && !confirm('このルームを終了し、共有した音声と原稿をサーバーから削除しますか？'))return;
 try{await endDeskRoom()}catch(e){$('delivery').textContent=e.message}
};
