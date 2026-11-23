'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGeminiReview } = require('../gemini-review');

function wav(rate, samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (const [index, value] of samples.entries()) buffer.writeInt16LE(value, 44 + index * 2);
  return buffer;
}

function fixture(chunks) {
  const requests = [];
  const client = { models: { async *generateContentStream(options) {
    requests.push(options);
    yield *chunks;
  } } };
  return { requests, review: createGeminiReview('fixture-key', { client }) };
}

test('Gemini receives one streamed review with the exact system instruction, source text and original 16 kHz WAV', async () => {
  const { review, requests } = fixture([
    { text: 'ここは' }, {}, { text: '校正済み\n字幕です。', candidates: [{ finishReason: 'STOP' }] },
  ]);
  const audio = wav(16000, [50, -100, 100]);
  const signal = new AbortController().signal;
  assert.equal(await review({audio, text: 'ここは\n認識文です。', signal}), 'ここは校正済み\n字幕です。');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.model, 'gemini-3.1-flash-lite');
  assert.deepEqual(request.contents, [{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'audio/wav', data: audio.toString('base64') } },
      { text: 'Azure音声認識文:\nここは\n認識文です。' },
    ],
  }]);
  assert.equal(request.config.systemInstruction, 'あなたはリアルタイム字幕の高速校閲担当です。添付音声を直接聞き、提示されたAzure音声認識文の聞き違い・聞き落とし・誤変換だけを修正してください。聞き取れない箇所は推測せず［聞き取り不明］としてください。出力ルール: 修正後の字幕テキストのみをそのまま出力してください。前置き・見出し・解説・変更点の説明・Markdown装飾は一切出力禁止です。');
  assert.equal(request.config.abortSignal, signal);
  assert.equal(request.config.responseMimeType, 'text/plain');
  assert.equal(request.config.maxOutputTokens, 2048);
});

test('48 kHz and 44.1 kHz desk recordings are normalized to 16 kHz mono without changing the stored clip', async () => {
  const { review, requests } = fixture([{ text: '字幕' }]);
  for (const [rate, samples, expected] of [
    [48000, [100, -100, 300, 900, 600, -300], [100, 400]],
    [44100, Array(441).fill(-432), Array(160).fill(-432)],
  ]) {
    const audio = wav(rate, samples);
    const original = Buffer.from(audio);
    await review({ audio, text: '字幕' });
    assert.deepEqual(audio, original);
    const normalized = Buffer.from(requests.at(-1).contents[0].parts[0].inlineData.data, 'base64');
    assert.deepEqual(normalized, wav(16000, expected));
  }
});

test('Invalid input and abort are rejected before starting the Gemini request', async () => {
  const { review, requests } = fixture([{ text: '字幕' }]);
  const audio = wav(16000, [50, -100]);
  const stereo = Buffer.from(audio);
  stereo.writeUInt16LE(2, 22);
  await assert.rejects(review({audio: stereo, text: '字幕'}), /音声形式/);
  await assert.rejects(review({audio: audio.subarray(0, -2), text: '字幕'}), /音声形式/);
  await assert.rejects(review({audio, text: '  '}), /認識文/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(review({audio, text: '字幕', signal: controller.signal}), {name: 'AbortError'});
  assert.equal(requests.length, 0);
});

test('Gemini output that is empty, blocked, stopped early or too long is never returned as a correction', async () => {
  const request = { audio: wav(16000, [50, -100]), text: '字幕' };
  await assert.rejects(fixture([{ text: ' ' }]).review(request), /空/);
  await assert.rejects(fixture([{ promptFeedback: { blockReason: 'SAFETY' } }]).review(request), /完了/);
  await assert.rejects(fixture([
    { text: '途中の' }, { text: '校正', candidates: [{ finishReason: 'MAX_TOKENS' }] },
  ]).review(request), /完了/);
  await assert.rejects(fixture([{ text: 'あ'.repeat(16001) }]).review(request), /長すぎ/);
});
