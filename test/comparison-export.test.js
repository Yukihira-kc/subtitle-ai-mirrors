'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {diff,html} = require('../public/comparison-log');

test('色付き差分は削除・置換を区別し、改行は集計しない', () => {
  const ai = diff('えー、説明会は午後に時からです。','説明会は午後二時からです。');
  assert.deepEqual(ai.total,{removed:3,added:0,replaced:1});
  assert.match(ai.markup,/<del>に<\/del><ins>二<\/ins>/);
  assert.deepEqual(diff('午後二時。\n受付です。','午後2時。受付です。').total,
    {removed:0,added:0,replaced:1});
  assert.deepEqual(diff('か\u3099','が').total,{removed:0,added:0,replaced:1});
});

test('長い比較範囲は同じ文を区切りに集計し、対応のない大きな範囲は保留する', () => {
  const long = Array.from({length:150},(_,index)=>`第${index}項の内容を説明します。`).join('');
  const result = diff('あ。'+long+'終。','い。'+long+'完。');
  assert.deepEqual(result.total,{removed:0,added:0,replaced:2});
  assert.match(result.markup,/<del>あ<\/del><ins>い<\/ins>/);
  assert.equal(diff('あ'.repeat(2000),'い'.repeat(2000)),null);
});

test('比較HTMLは3種のTXTを含み、投入文の差分と未送出を区別する', () => {
  const original = '説明会は午後に時からです。';
  const first = {id:1,original,corrected:'説明会は午後二時からです。',state:'ready',
    recognition:{text:'えー、'+original,engine:'F0',partial:false,approximate:false}};
  const audioOnly = {id:2,original:'音声のみの原文',corrected:null,state:'audio-only'};
  const markup = html({
    recognition:[{id:'r1',text:'えー、'+original,engine:'F0',at:0}],boxes:[first,audioOnly],
    groups:[
      {boxIds:[1],sends:[{id:'send1',text:'説明会は午後2時からです。',at:0}],complete:true},
      {boxIds:[2],sends:[],complete:false},
    ],
    pendingText:'<&未送出>',
  });
  assert.match(markup,/<h2><span>箱 001<\/span>① 音声認識<\/h2>/);
  assert.match(markup,/Geminiに渡した文<\/summary>/);
  assert.match(markup,/Gemini入力 → AI校正　置換 1文字（比較 1件）/);
  assert.match(markup,/AI校正 → 人間校閲　置換 1文字（比較 1件）/);
  assert.match(markup,/&lt;&amp;未送出&gt;/);
  assert.doesNotMatch(markup,/<&未送出>/);
  const exports = [...markup.matchAll(/download="([^"]+)" href="data:text\/plain;charset=utf-8;base64,([^"]+)"/g)]
    .map(([,name,body])=>[name,Buffer.from(body,'base64').toString('utf8')]);
  assert.deepEqual(exports.map(([name])=>name),['01_音声認識.txt','02_AI校正.txt','03_人間校閲.txt']);
  assert.match(exports[0][1],/えー、説明会は午後に時からです。/);
  assert.match(exports[1][1],/説明会は午後二時からです。/);
  assert.match(exports[2][1],/説明会は午後2時からです。/);
  assert.match(exports[2][1],/未送出・集計対象外/);
});
