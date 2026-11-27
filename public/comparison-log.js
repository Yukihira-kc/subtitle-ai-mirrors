(function (root) {
  'use strict';

  const graphemes = new Intl.Segmenter('ja', {granularity:'grapheme'});
  const split = text => Array.from(graphemes.segment(text), item => item.segment);
  const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[char]);
  const counts = () => ({added:0, removed:0, replaced:0});
  const boxNumber = id => '箱 '+String(id).padStart(3,'0');
  const engineNames = {F0:'Azure Speech F0', S0:'Azure Speech S0', vosk:'Vosk'};
  const stateNames = {
    'awaiting-audio':'音声待ち', queued:'校正待ち', processing:'校正中',
    retrying:'再試行中', 'audio-only':'音声のみ',
  };
  const clock = new Intl.DateTimeFormat('ja-JP', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const at = time => Number.isFinite(time) && Math.abs(time)<=8.64e15 ? clock.format(time) : '';
  const comparable = value => value.replace(/\r\n?|\n/g,'');

  function boundedDiff(before, after) {
    const source = split(comparable(before));
    const target = split(comparable(after));
    let head = 0, tail = 0;
    while (head < source.length && source[head] === target[head]) head++;
    while (tail < Math.min(source.length, target.length)-head &&
           source[source.length-1-tail] === target[target.length-1-tail]) tail++;

    const left = source.slice(head,source.length-tail), right = target.slice(head,target.length-tail);
    const width = right.length+1;
    const total = counts();
    const prefix = escape(source.slice(0,head).join(''));
    const suffix = escape(source.slice(source.length-tail).join(''));
    const mark = (name, characters) => '<'+name+'>'+escape(characters.join(''))+'</'+name+'>';
    if (!left.length || !right.length) {
      total.removed = left.length;
      total.added = right.length;
      return {total, markup:prefix+(left.length ? mark('del',left) : '')+
        (right.length ? mark('ins',right) : '')+suffix};
    }

    // Bound the edit matrix so exporting a long combined draft does not freeze the reviewer.
    if ((left.length+1)*width > 2000000) return null;
    const distance = new Uint32Array((left.length+1)*width);
    for (let j=0;j<width;j++) distance[j] = j;
    for (let i=1;i<=left.length;i++) {
      const row = i*width;
      distance[row] = i;
      for (let j=1;j<width;j++) {
        distance[row+j] = Math.min(
          distance[row-width+j-1]+Number(left[i-1]!==right[j-1]),
          distance[row-width+j]+1,
          distance[row+j-1]+1,
        );
      }
    }

    const steps = [];
    let i = left.length, j = right.length;
    while (i || j) {
      const current = distance[i*width+j];
      if (i && j && current === distance[(i-1)*width+j-1]+Number(left[i-1]!==right[j-1])) {
        const old = left[--i], next = right[--j];
        if (old === next) steps.push(escape(old));
        else {
          total.replaced++;
          steps.push(mark('del',[old])+mark('ins',[next]));
        }
      } else if (i && current === distance[(i-1)*width+j]+1) {
        total.removed++;
        steps.push(mark('del',[left[--i]]));
      } else {
        total.added++;
        steps.push(mark('ins',[right[--j]]));
      }
    }
    return {total, markup:prefix+steps.reverse().join('')+suffix};
  }

  function uniqueSentences(parts) {
    const locations = new Map();
    parts.forEach((text,index)=>locations.set(text,locations.has(text) ? -1 : index));
    return locations;
  }
  function diff(before, after) {
    const direct = boundedDiff(before,after);
    if (direct) return direct;

    // Unchanged sentences let long batches be compared in smaller ranges.
    const sentences = text => comparable(text).match(/[^。！？!?]+[。！？!?]*|[。！？!?]+/gu) || [];
    const left = sentences(before), right = sentences(after);
    const leftLocations = uniqueSentences(left), rightLocations = uniqueSentences(right);
    const total = counts(), output = [];
    let startLeft = 0, startRight = 0;
    function section(endLeft,endRight) {
      const result = boundedDiff(left.slice(startLeft,endLeft).join(''),right.slice(startRight,endRight).join(''));
      if (!result) return false;
      for (const key of Object.keys(total)) total[key] += result.total[key];
      output.push(result.markup);
      return true;
    }
    for (const [text,index] of leftLocations) {
      const target = rightLocations.get(text);
      if (index < startLeft || target === undefined || target < startRight) continue;
      if (!section(index,target)) return null;
      output.push(escape(text));
      startLeft = index+1;
      startRight = target+1;
    }
    if (!startLeft || !section(left.length,right.length)) return null;
    return {total,markup:output.join('')};
  }

  const changeCount = count => {
    const parts = [];
    if (count.removed) parts.push('削除 '+count.removed+'文字');
    if (count.added) parts.push('追加 '+count.added+'文字');
    if (count.replaced) parts.push('置換 '+count.replaced+'文字');
    return parts.join('・') || '変更なし';
  };
  function tally(total, change) {
    total.compared++;
    for (const key of Object.keys(change)) total[key] += change[key];
  }
  const note = text => '<p class="note">'+escape(text)+'</p>';
  const sentence = markup => '<p class="sentence">'+markup+'</p>';
  function compare(before, after, total) {
    const result = diff(before,after);
    if (!result) return sentence(escape(after))+note('長い範囲のため文字数の集計を省略');
    tally(total,result.total);
    return sentence(result.markup)+note(changeCount(result.total));
  }
  function originalBox(box) {
    const source = box.recognition;
    if (!source?.text) return note('Geminiに渡した文')+sentence(escape(box.original));
    const flags = [source.partial&&'途中結果',source.approximate&&'対応する範囲は目安'].filter(Boolean);
    const metadata = flags.length ? note(flags.join('・')) : '';
    const input = source.text !== box.original
      ? '<details><summary>Geminiに渡した文</summary>'+sentence(escape(box.original))+'</details>' : '';
    return metadata+sentence(escape(source.text))+input;
  }
  function correctedBox(box, total) {
    if (box.corrected === null) return note(stateNames[box.state] || '校正待ち');
    return compare(box.original,box.corrected,total);
  }
  const boxEntries = (boxes,render) => boxes.map(box=>'<div class="box-entry">'+render(box)+'</div>').join('');
  function row({boxes, sends, complete, unacquired}, totals) {
    const number = boxes.length ? boxNumber(boxes[0].id)+(boxes.length>1 ?
      '〜'+String(boxes.at(-1).id).padStart(3,'0') : '') : '手入力';
    const sent = sends.map(send=>send.text).join('\n');
    let reviewed;
    if (!sent) reviewed = note(unacquired ? '未取得' : '未送出');
    else if (!complete) reviewed = sentence(escape(sent))+note('一部送出・差分集計は保留');
    else if (!boxes.length) reviewed = sentence(escape(sent))+note('手入力');
    else if (boxes.some(box=>box.corrected===null)) reviewed = sentence(escape(sent))+note('音声のみの箱を含むため、AIとの比較対象外');
    else reviewed = compare(boxes.map(box=>box.corrected).join('\n'),sent,totals.human);
    if (sends.some(send=>send.automatic)) reviewed += note('スルーモードの自動送出を含む');
    return `<article class="row">
      <section><h2><span>${escape(number)}</span>① 音声認識</h2>${boxEntries(boxes,originalBox) || note('音声認識文なし')}</section>
      <section><h2>② AI校正</h2>${boxEntries(boxes,box=>correctedBox(box,totals.ai)) || note('AI校正文なし')}</section>
      <section><h2>③ 人間校閲</h2>${reviewed}</section>
    </article>`;
  }
  function txtLink(filename, records) {
    const bytes = new TextEncoder().encode('\ufeff'+records.join('\r\n\r\n'));
    let binary = '';
    for (let start=0;start<bytes.length;start+=8192) {
      binary += String.fromCharCode(...bytes.subarray(start,start+8192));
    }
    return '<a download="'+filename+'" href="data:text/plain;charset=utf-8;base64,'+btoa(binary)+'">'+filename+'</a>';
  }
  function records(log) {
    const textLine = (label,text) => label+'\r\n'+String(text).replace(/\r\n?|\n/g,'\r\n');
    const recognition = log.recognition.map((item,index)=>textLine(
      '［音声認識 '+(index+1)+' '+(engineNames[item.engine]||'')+' '+at(item.at)+'］',item.text,
    ));
    for (const box of log.boxes) {
      if (box.recognition?.text) recognition.push(textLine(
        '［'+boxNumber(box.id)+' 対応する認識文'+(box.recognition.partial?'・途中結果':'')+
        (box.recognition.approximate?'・範囲は目安':'')+'］',box.recognition.text,
      ));
      recognition.push(textLine('［'+boxNumber(box.id)+' Geminiに渡した文］',box.original));
    }
    const corrected = log.boxes.map(box=>textLine('［'+boxNumber(box.id)+'］',
      box.corrected ?? ('（'+(stateNames[box.state]||'校正待ち')+'）'),
    ));
    const reviewed = log.groups.flatMap(group=>group.sends.map(send=>textLine(
      '［'+at(send.at)+(send.automatic?' スルーモード':' 手動送出')+'］',send.text,
    )));
    if (log.pendingText?.trim()) reviewed.push(textLine('［未送出・集計対象外］',log.pendingText));
    return {recognition,corrected,reviewed};
  }

  const style = `
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#17283a;font:15px/1.6 Meiryo,system-ui,sans-serif}
    main{max-width:1250px;margin:24px auto;padding:0 16px}h1{font-size:24px;margin:0 0 10px}
    nav,.legend,.stats{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 12px}a{color:#174e86}h2{font-size:14px;margin:0 0 6px}
    h2 span{margin-right:10px;color:#4c6073;white-space:normal}
    .report{background:#fff;border:1px solid #ccd7e2;border-radius:8px;overflow:hidden}
    .row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
    .row+.row{border-top:1px solid #ccd7e2}.row section{min-width:0;padding:10px 14px 12px}
    .row section+section{border-left:1px solid #e2e8ef}.sentence{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
    .box-entry+.box-entry{border-top:1px solid #e2e8ef;margin-top:8px;padding-top:4px}
    .note,.legend,.stats,details{font-size:13px;color:#43596c}.note{margin:4px 0 0}details{margin-top:6px}
    del{color:#941d31;background:#fde9ed;text-decoration:line-through}ins{color:#19532d;background:#def4e7;text-underline-offset:2px}
    @media(max-width:600px){.row{grid-template-columns:1fr}.row section+section{border-left:0;border-top:1px solid #e2e8ef}}
    @media print{body{background:#fff}nav{display:none}.row{break-inside:avoid}del,ins{print-color-adjust:exact}}
  `;
  function html(log) {
    const totals = {ai:{...counts(),compared:0},human:{...counts(),compared:0}};
    const byId = new Map(log.boxes.map(box=>[box.id,box]));
    const assigned = new Set(log.groups.flatMap(group=>group.boxIds));
    const groups = log.groups.map(group=>({...group,boxes:group.boxIds.map(id=>byId.get(id)).filter(Boolean)}));
    for (const box of log.boxes) {
      if (!assigned.has(box.id)) groups.push({boxes:[box],sends:[],complete:false,unacquired:true});
    }
    const rows = groups.map(group=>row(group,totals)).join('');
    const files = records(log);
    const stat = (label,total) => '<span>'+label+'　'+(total.compared ?
      changeCount(total)+'（比較 '+total.compared+'件）' : '比較できる原稿なし')+'</span>';
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <title>字幕の比較ログ</title><style>${style}</style></head><body><main>
      <h1>字幕の比較ログ</h1>
      <nav aria-label="個別TXTを保存">${txtLink('01_音声認識.txt',files.recognition)}${txtLink('02_AI校正.txt',files.corrected)}${txtLink('03_人間校閲.txt',files.reviewed)}</nav>
      <p class="legend"><del>削除・置換前</del><ins>追加・置換後</ins><span>②はGeminiに渡した文、③はAI校正文との差分。改行は集計対象外。</span></p>
      <p class="stats">${stat('Gemini入力 → AI校正',totals.ai)}${stat('AI校正 → 人間校閲',totals.human)}</p>
      ${rows ? '<div class="report">'+rows+'</div>' : note('比較できる箱がありません')}
      ${log.pendingText?.trim() ? '<section><h2>編集欄の未送出テキスト</h2>'+sentence(escape(log.pendingText))+'</section>' : ''}
      </main></body></html>`;
  }
  const api = {diff,html};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComparisonLog = api;
})(typeof window === 'object' ? window : globalThis);
