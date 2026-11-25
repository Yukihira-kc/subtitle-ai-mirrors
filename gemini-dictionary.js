'use strict';

const maxFileBytes = 8 * 1024 * 1024;

function decodeFile(file) {
  if (file[0] === 0xff && file[1] === 0xfe) {
    return new TextDecoder('utf-16le', {fatal:true}).decode(file);
  }
  if (file[0] === 0xfe && file[1] === 0xff) {
    return new TextDecoder('utf-16be', {fatal:true}).decode(file);
  }
  try {
    return new TextDecoder('utf-8', {fatal:true}).decode(file);
  } catch (error) {
    if (file[0] === 0xef && file[1] === 0xbb && file[2] === 0xbf) throw error;
    return new TextDecoder('shift_jis', {fatal:true}).decode(file);
  }
}

function parseDictionary(file) {
  if (!Buffer.isBuffer(file) || file.length === 0 || file.length > maxFileBytes) {
    throw new Error('8 MiB以下の辞書ファイルを選んでください。');
  }

  let contents;
  try {
    contents = decodeFile(file);
  } catch {
    throw new Error('辞書の文字コードを読み取れません。UTF-8、UTF-16（BOM付き）、Shift_JISのテキストを選んでください。');
  }

  const pairs = new Set();
  let lineNumber = 0;
  for (const line of contents.split(/\r\n|\n|\r/)) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) continue;
    const [reading, term] = line.split('\t', 2).map(value => value.trim());
    if (/^(よみ|読み|読み方)$/.test(reading) && /^(語句|単語|表記)$/.test(term)) continue;
    if (!reading || !term || /[\x00-\x1f\x7f]/.test(reading + term)) {
      throw new Error(lineNumber + '行目のよみと語句を確認してください。2つの項目はタブで区切ります。');
    }
    // IME exports may append a part of speech and a comment. Only pass the pair.
    pairs.add(reading + '\t' + term);
  }
  if (!pairs.size) throw new Error('辞書によみと語句がありません。');
  return {text:[...pairs].join('\n'),count:pairs.size};
}

module.exports = {parseDictionary};
