'use strict';

const maxClipBytes = 8 * 1024 * 1024;
const totalLimit = 96 * 1024 * 1024;
let bytesInUse = 0;

module.exports = function createBoxes(broadcast) {
  const byId = new Map(), byKey = new Map();
  let desk = null;
  function metadata(box) {
    const { clip, ...data } = box;
    return { ...data, audio: !!clip };
  }
  function update(box) { broadcast().emit('box', metadata(box)); }
  function release(box) {
    bytesInUse -= box.clip?.length || 0;
    box.clip = null;
  }
  function held(role) {
    return [...byId.values()].find(box => box.owner === role && !box.sent);
  }
  return {
    list() { return [...byId.values()].map(metadata); },
    held,
    finish(box) { if (box) { box.sent = true; release(box); update(box); } },
    clip(id, version) {
      const box = byId.get(id);
      return box?.version === version ? box.clip : null;
    },
    dispose() { for (const box of byId.values()) release(box); byId.clear(); byKey.clear(); },
    connect(socket) {
      socket.on('joinDesk', (_, reply) => {
        if (typeof reply !== 'function') return;
        if (desk && desk !== socket.id) return reply({ok:false,error:'デスクは接続中です'});
        desk = socket.id;
        reply({ok:true});
      });
      socket.on('disconnect', () => { if (desk === socket.id) desk = null; });
      socket.on('publishBox', (data, reply) => {
        if (typeof reply !== 'function') return;
        if (desk !== socket.id) return reply({ok:false,error:'デスクの接続を確認してください'});
        const {key, text, version, approx, clip} = data || {};
        if (typeof key !== 'string' || !key || key.length > 128 || typeof text !== 'string' ||
          text.length > 16000 || !Number.isSafeInteger(version) || version < 1 ||
          (clip != null && (!Buffer.isBuffer(clip) || clip.length < 44 || clip.length > maxClipBytes))) {
          return reply({ok:false,error:'ボックスの内容または音声サイズを確認してください'});
        }
        let box = byKey.get(key);
        if (box && (box.sent || version <= box.version)) return reply({ok:true});
        if (bytesInUse - (box?.clip?.length || 0) + (clip?.length || 0) > totalLimit)
          return reply({ok:false,error:'共有音声の空き待ちです。取得済みの原稿を送信してください'});
        if (!box) {
          box = {id:byId.size+1, owner:null, sent:false};
          byId.set(box.id, box); byKey.set(key, box);
        }
        release(box);
        Object.assign(box, {text, version, approx:!!approx, clip});
        bytesInUse += clip?.length || 0;
        update(box); reply({ok:true});
      });
      socket.on('claim', (data, reply) => {
        if (typeof reply !== 'function') return;
        const box = byId.get(data?.id), role = socket.data.role;
        if (!role || !box || box.sent || (box.owner && box.owner !== role) || (held(role) && held(role) !== box))
          return reply({ok:false,error:'このボックスは取得できません'});
        box.owner = role;
        update(box); reply({ok:true,acquired:box.text});
      });
    }
  };
};
