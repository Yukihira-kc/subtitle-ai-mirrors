'use strict';
const {boxRecognition} = require('./comparison-log');

const maxClipBytes = 8 * 1024 * 1024;
const totalLimit = 96 * 1024 * 1024;
let bytesInUse = 0;
const replayClips = new Map();

module.exports = function createBoxes(broadcast, {mode='standard', ai, canJoinDesk, onLeaveDesk}={}) {
  const byId = new Map(), byKey = new Map();
  let desk = null;
  function metadata(box) {
    const { clip, ...data } = box;
    return { ...data, audio: !!clip, ...ai?.status(box.id) };
  }
  function update(box) { broadcast().emit('box', metadata(box)); }
  function release(box) {
    replayClips.delete(box);
    bytesInUse -= box.clip?.length || 0;
    box.clip = null;
  }
  function leaveDesk(socket) {
    if (desk !== socket.id) return false;
    desk = null;
    onLeaveDesk?.();
    return true;
  }
  function held(role) {
    return [...byId.values()].find(box => box.owner === role && !box.sent);
  }
  return {
    list() { return [...byId.values()].map(metadata); },
    held,
    get deskId() { return desk; },
    isDesk(socketId) { return desk === socketId; },
    finish(box) { if (box) { box.sent = true; release(box); update(box); } },
    refresh(id) { const box=byId.get(id);if(box)update(box); },
    retainReplay(id) {
      const box=byId.get(id);
      if(box?.clip)replayClips.set(box,()=>{release(box);update(box);ai.refresh(id);});
    },
    clip(id, version) {
      const box = byId.get(id);
      return box?.version === version ? box.clip : null;
    },
    dispose() { for (const box of byId.values()) release(box); byId.clear(); byKey.clear(); },
    connect(socket) {
      socket.on('joinDesk', (_, reply) => {
        if (typeof reply !== 'function') return;
        if (canJoinDesk && !canJoinDesk(socket)) return reply({ok:false,error:'校閲担当として接続中です。'});
        if (desk && desk !== socket.id) return reply({ok:false,error:'デスクは接続中です'});
        desk = socket.id;
        reply({ok:true,mode,comparisonLogAvailable:!!ai});
      });
      socket.on('leaveDesk', (_, reply) => {
        if (typeof reply === 'function') reply({ok:leaveDesk(socket)});
      });
      socket.on('disconnect', () => leaveDesk(socket));
      socket.on('publishBox', (data, reply) => {
        if (typeof reply !== 'function') return;
        if (desk !== socket.id) return reply({ok:false,error:'デスクの接続を確認してください'});
        const {key, text, version, approx, clip, forReview} = data || {};
        if (typeof key !== 'string' || !key || key.length > 128 || typeof text !== 'string' ||
          text.length > 16000 || !Number.isSafeInteger(version) || version < 1 ||
          (clip != null && (!Buffer.isBuffer(clip) || clip.length < 44 || clip.length > maxClipBytes))) {
          return reply({ok:false,...(ai&&{retryable:false}),error:'ボックスの内容または音声サイズを確認してください'});
        }
        let box = byKey.get(key);
        if (ai) {
          // A retry of the same desk action must not order a second inference.
          if (box) return reply({ok:true});
          if (!ai.available) return reply({ok:false,retryable:false,error:'デスクでGemini APIキーを設定してください。'});
          if (forReview!==true || !clip || !text.trim())
            return reply({ok:false,retryable:false,error:'箱の原稿と対応する録音が必要です。'});
        }
        if (box && (box.sent || version <= box.version)) return reply({ok:true});
        const additional = (clip?.length || 0) - (box?.clip?.length || 0);
        while (bytesInUse + additional > totalLimit && replayClips.size) replayClips.values().next().value();
        if (bytesInUse + additional > totalLimit)
          return reply({ok:false,error:ai?'共有音声に空きがありません。校閲で次の箱を取得すると、以前の箱の音声を解放できます。':'共有音声の空き待ちです。取得済みの原稿を送信してください'});
        if (!box) {
          box = {id:byId.size+1, owner:null, sent:false};
          byId.set(box.id, box); byKey.set(key, box);
        }
        release(box);
        Object.assign(box, {text, version, approx:!!approx, clip});
        bytesInUse += clip?.length || 0;
        if (ai) ai.accept({id:box.id,version,text,approx:box.approx,recognition:boxRecognition(data.recognition)});
        else update(box);
        reply({ok:true});
      });
      socket.on('claim', (data, reply) => {
        if (typeof reply !== 'function') return;
        const box = byId.get(data?.id), role = socket.data.role;
        if (ai || !role || !box || box.sent || (box.owner && box.owner !== role) || (held(role) && held(role) !== box))
          return reply({ok:false,error:'このボックスは取得できません'});
        box.owner = role;
        update(box); reply({ok:true,acquired:box.text});
      });
    }
  };
};
