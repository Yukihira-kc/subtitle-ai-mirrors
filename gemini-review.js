'use strict';

const { GoogleGenAI } = require('@google/genai');

const model = 'gemini-3.1-flash-lite';
const systemInstruction = 'あなたはリアルタイム字幕の高速校閲担当です。添付音声を直接聞き、提示されたAzure音声認識文の聞き違い・聞き落とし・誤変換だけを修正してください。聞き取れない箇所は推測せず［聞き取り不明］としてください。出力ルール: 修正後の字幕テキストのみをそのまま出力してください。前置き・見出し・解説・変更点の説明・Markdown装飾は一切出力禁止です。';
const sampleRate = 16000;
const headerBytes = 44;
const bytesPerSample = 2;
const maxAudioBytes = 8 * 1024 * 1024;
const maxTextLength = 16000;

function normalizeWav(wav) {
  // Both desk recorders emit this canonical mono PCM16 header.
  if (!Buffer.isBuffer(wav) || wav.length < headerBytes + bytesPerSample || wav.length > maxAudioBytes ||
      wav.length % bytesPerSample !== 0 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.toString('ascii', 36, 40) !== 'data' ||
      wav.readUInt32LE(4) !== wav.length - 8 || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt16LE(32) !== bytesPerSample || wav.readUInt16LE(34) !== 16 ||
      wav.readUInt32LE(40) !== wav.length - headerBytes) {
    throw new TypeError('校閲用の音声形式が正しくありません。');
  }
  const sourceRate = wav.readUInt32LE(24);
  if (sourceRate < 8000 || sourceRate > 192000 || wav.readUInt32LE(28) !== sourceRate * bytesPerSample) {
    throw new TypeError('校閲用の音声形式が正しくありません。');
  }
  if (sourceRate === sampleRate) return wav;

  const sourceFrames = (wav.length - headerBytes) / bytesPerSample;
  const step = sourceRate / sampleRate;
  const frames = Math.max(1, Math.round(sourceFrames / step));
  const dataSize = frames * bytesPerSample;
  if (headerBytes + dataSize > maxAudioBytes) throw new RangeError('校閲用の音声が長すぎます。');

  const result = Buffer.allocUnsafe(headerBytes + dataSize);
  wav.copy(result, 0, 0, headerBytes);
  result.writeUInt32LE(result.length - 8, 4);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * bytesPerSample, 28);
  result.writeUInt32LE(dataSize, 40);
  // Average the source interval for each sample to preserve duration when downsizing.
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * step;
    const end = Math.min(sourceFrames, (frame + 1) * step);
    let sum = 0;
    for (let index = Math.floor(start); index < end; index++) {
      const weight = Math.min(end, index + 1) - Math.max(start, index);
      sum += wav.readInt16LE(headerBytes + index * bytesPerSample) * weight;
    }
    result.writeInt16LE(Math.round(sum / (end - start)), headerBytes + frame * bytesPerSample);
  }
  return result;
}

function createGeminiReview(apiKey, { client } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('GEMINI_API_KEY が設定されていません。');
  const ai = client ?? new GoogleGenAI({ apiKey: apiKey.trim(), vertexai: false });

  return async function review({ audio, text, signal }) {
    signal?.throwIfAborted();
    if (typeof text !== 'string' || !text.trim() || text.length > maxTextLength) {
      throw new TypeError('校閲用の認識文が正しくありません。');
    }
    const wav = normalizeWav(audio);
    const stream = await ai.models.generateContentStream({
      model,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { data: wav.toString('base64'), mimeType: 'audio/wav' } },
          { text: 'Azure音声認識文:\n' + text },
        ],
      }],
      config: {
        systemInstruction,
        responseMimeType: 'text/plain',
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        maxOutputTokens: 2048,
        abortSignal: signal,
      },
    });
    let corrected = '';
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const block = chunk.promptFeedback?.blockReason;
      const finish = chunk.candidates?.[0]?.finishReason;
      if ((block && block !== 'BLOCK_REASON_UNSPECIFIED') ||
          (finish && finish !== 'STOP' && finish !== 'FINISH_REASON_UNSPECIFIED')) {
        throw new Error('Geminiの校閲が正常に完了しませんでした。');
      }
      const part = chunk.text;
      if (typeof part === 'string') corrected += part;
      if (corrected.length > maxTextLength) throw new RangeError('Geminiの校閲結果が長すぎます。');
    }
    signal?.throwIfAborted();
    if (!corrected.trim()) throw new Error('Geminiの校閲結果が空です。');
    return corrected.trim();
  };
}

module.exports = { createGeminiReview };
