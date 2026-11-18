import {cp, writeFile} from 'node:fs/promises';
const backend = new URL(process.env.AI_RENDER_ORIGIN);
if (!/^subtitle-ai-mirror[a-z0-9-]*\.onrender\.com$/.test(backend.hostname) ||
    backend.protocol !== 'https:' || backend.href !== backend.origin+'/') {
  throw new Error('Set AI_RENDER_ORIGIN to the dedicated subtitle-ai-mirror Render service origin.');
}
await cp('public','dist',{recursive:true});
await writeFile('dist/mirror-config.js','window.MIRROR_BACKEND = '+JSON.stringify(backend.origin)+';\n');
