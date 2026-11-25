const boxes = []; // Local word timing references for the current recording.

const deskDictionary = GeminiDictionary.create(deskSocket);
const pendingBoxes = new Map(), deskRows = new Map();
const role='デスク';
let deskConnected=false, switchingEngine=false, deskRecognitionBusy=false;
let deskConnectionMessage='';
const recordingKey = crypto.randomUUID();
let uploading=false, retryError='', deskFeedback='';
let rejectedUpload=null;
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
let savedGeminiKey='', geminiConnection=null, settingGemini=false;

function geminiAvailable(){
  return deskMode!=='complete-ai' || (deskConnected && geminiConnection!==null && geminiConnection===deskSocket.id);
}
function updateGeminiControls(){
  const input=$('gemini-key');
  const available=deskConnected && deskMode==='complete-ai' && !settingGemini;
  input.disabled=!available;
  $('enable-gemini').disabled=!available || !(input.value.trim() || (savedGeminiKey && !geminiAvailable()));
}
async function enableGemini(reconnect=false){
  if(!deskConnected || deskMode!=='complete-ai' || settingGemini)return;
  const input=$('gemini-key'),notice=$('gemini-key-status');
  const key=reconnect?savedGeminiKey:(input.value.trim() || savedGeminiKey);
  if(!key)return;
  const connection=deskSocket.id;
  settingGemini=true;
  updateGeminiControls();
  notice.textContent=reconnect?'Geminiに再接続中…':'Geminiキーを設定中…';
  try{
    const reply=await deskSocket.timeout(45000).emitWithAck('setGeminiKey',{key});
    if(!deskConnected || deskSocket.id!==connection)return;
    if(!reply?.ok){
      let error=String(reply?.error || 'Geminiキーを設定できませんでした。');
      for(const secret of [key,savedGeminiKey])if(secret)error=error.split(secret).join('［キー］');
      notice.textContent=error+(geminiAvailable()?' 直前の設定を使用中です。':'');
      return;
    }
    geminiConnection=connection;
    savedGeminiKey=key;
    if(!reconnect)input.value='';
    input.placeholder='設定済み（変更は再入力）';
    notice.textContent='Geminiは有効です。';
    uploadBoxes();
  }catch{
    if(deskSocket.id===connection)notice.textContent='Geminiキー設定の応答を確認できません。もう一度お試しください。';
  }finally{
    if(deskSocket.id===connection){settingGemini=false;updateGeminiControls();updateDeskControls();}
  }
}
function syncGeminiConnection(){
  if(!deskConnected){
    geminiConnection=null;settingGemini=false;
    if(deskMode==='complete-ai')$('gemini-key-status').textContent='デスクの接続を待っています。';
  }else if(deskMode==='complete-ai' && !geminiAvailable()){
    if(savedGeminiKey)enableGemini(true);
    else $('gemini-key-status').textContent='認識開始前にGeminiキーを設定してください。';
  }
  updateGeminiControls();
}
$('gemini-key').oninput=updateGeminiControls;
$('enable-gemini').onclick=()=>enableGemini();
$('gemini-key').onkeydown=event=>{
  if(event.key==='Enter' && !event.isComposing){event.preventDefault();$('enable-gemini').click();}
};
addEventListener('pagehide',()=>{
  savedGeminiKey='';geminiConnection=null;
  $('gemini-key').value='';$('gemini-key').placeholder='';
});

function showDelivery(){
  $('delivery').textContent = deskConnectionMessage || retryError || deskFeedback || (pendingBoxes.size?'音声認識テキストに送信中':'');
  if(rejectedUpload){
    const {box,message}=rejectedUpload;
    $('delivery').textContent='サーバー未受付「'+box.text.slice(0,28)+'」 '+message+' ';
    for(const retry of [true,false]){
      const button=document.createElement('button');
      button.type='button';button.textContent=retry?'送信を再試行':'送信待ちから外す';
      button.onclick=()=>{
        if(!retry){
          if(!confirm('この原稿と録音はサーバーに届いていません。送信待ちから外し、後続の原稿へ進みますか？'))return;
          pendingBoxes.delete(box.key);
        }
        rejectedUpload=null;
        deskFeedback=retry?'':'未受付の原稿を送信待ちから外しました。';
        showDelivery();uploadBoxes();
      };
      $('delivery').append(button);
    }
  }
}
function publishBox(box) {
  if (deskMode==='complete-ai') {
    if (!box.audio || box.audio.size<=44) {
      deskFeedback='この行に対応する録音がありません。音声が届いてから送るか、行の区切りを修正してください。';
      showDelivery();
      return false;
    }
    if (box.audio.size>8*1024*1024 || box.text.length>16000) {
      deskFeedback='原稿または録音が1箱の上限を超えました。短い行に区切ってから送ってください。';
      showDelivery();
      return false;
    }
    box.forReview=true;
  }
  deskFeedback='';
  if (!box.key) box.key=recordingKey+'/'+box.id;
  box.version=(box.version||0)+1;
  pendingBoxes.set(box.key,box);
  uploadBoxes();
  return true;
}
async function uploadBoxes(){
  if(uploading || rejectedUpload)return;
  uploading=true;
  while(pendingBoxes.size){
    const [key,box]=pendingBoxes.entries().next().value;
    if(box.forReview && !geminiAvailable())break;
    const connection=deskSocket.id;
    const {version,text,approx}=box;
    const meta={key,version,text,approx:!!approx};
    if(box.forReview)meta.forReview=true;
    const clip=box.audio;
    showDelivery();
    try {
      await roomUpload(meta,clip);
      if(box.version===version)pendingBoxes.delete(key);
      else {pendingBoxes.delete(key);pendingBoxes.set(key,box)}
      retryError='';
    }catch(error){
      if(box.forReview && (!geminiAvailable() || connection!==deskSocket.id))continue;
      if(box.forReview && error.retryable===false){
        rejectedUpload={box,message:error.message};
        retryError='';
        break;
      }
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
  const state=row.children[2];
  if(deskMode!=='complete-ai'){
    state.textContent=box.sent?'送信済み':box.owner?box.owner+' 取得中':'未取得';
    return;
  }
  if(box.aiStatus==='ready' || box.aiStatus==='audio-only'){
    const result=box.aiStatus==='ready'?'校正済み':'音声のみ';
    const receipt=box.acquired?'校閲で取得済み':box.delivered?'校閲で取得可':'先行の箱を待機中';
    state.textContent=result+'・'+receipt;
  }else if(box.aiStatus==='retrying'){
    state.textContent='同じ録音でAIが再試行中（2回目）';
  }else if(box.aiStatus==='processing' || box.aiStatus==='queued'){
    const second=box.attempt===2;
    if(box.aiStatus==='processing')state.textContent=second?'AIが再試行中（2回目）':'AI校閲中（1回目）';
    else state.textContent=second?'自動再試行待ち（2回目）':'AI校閲待ち';
  }else{
    state.textContent='送信済み';
  }
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
    syncGeminiConnection();
    updateDeskControls();showDelivery();
    if(deskConnected){configureDeskLinks();deskDictionary.join(deskMode);}
  }
}
function draw(){
  $('cut').disabled=!deskConnected||!geminiAvailable()||composing||!editor.value.trim();
}
function updateDeskControls(){
  $('engine').disabled=!deskConnected||deskRecognitionBusy;
  $('start').disabled=$('engine').disabled||!geminiAvailable();
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
let displayedMode;
function configureDeskLinks(){
 if(displayedMode===deskMode)return;
 displayedMode=deskMode;
 if(SubtitleConnection.roomId==='practice')$('end-room').textContent='ルームを退出';
 const ai=deskMode==='complete-ai';
 $('gemini-key-row').hidden=!ai;
 $('roles').replaceChildren();$('invitations').replaceChildren();
 $('distributed').classList.toggle('ai-distribution',ai);
 $('boxes-title').textContent=ai?'AI校閲の進行':'音声認識テキスト';
 $('edit-help').textContent=ai?'Enterで区切り、F12で先頭行とその録音をGeminiに送ります。赤線は全角30文字の目安です。':'Enterで区切り、F12で先頭行を送ります。赤線は全角30文字の目安です。';
 const roles=ai?[['reviewer','校閲']]:[['A','入力 A'],['B','入力 B'],['reviewer','校閲']];
 for(const [key,label] of roles){
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
function watchDesk(onSnapshot){
 subscribeRoom(change=>{
   if(change.type==='snapshot')onSnapshot?.(change.state);
   applyDeskState(change);
 });
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
