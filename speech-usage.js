'use strict';

const {timingSafeEqual} = require('node:crypto');

const origins = new Set([
  'https://subtitle-ai-mirrors.vercel.app',
  'https://subtitle-ai-mirrors-th6k36zl5ltja.azurewebsites.net',
]);
const management = 'https://management.azure.com';
const metricName = 'AudioSecondsTranscribed';
const tiers = ['F0', 'S0'];
const hexHash = /^[a-f0-9]{64}$/;
const idPattern = /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([\p{L}\p{M}\p{N}_.()-]{1,90})\/providers\/Microsoft\.CognitiveServices\/accounts\/([a-z0-9][a-z0-9_.-]{1,63})$/iu;

function resourcePath(env, tier) {
  const parts = idPattern.exec(env['SPEECH_' + tier + '_RESOURCE_ID'] || '');
  if (!parts || parts[2].endsWith('.')) return null;
  return '/subscriptions/' + parts[1] + '/resourceGroups/' + encodeURIComponent(parts[2]) +
    '/providers/Microsoft.CognitiveServices/accounts/' + parts[3];
}

function configuration(env, tier) {
  const resource = resourcePath(env, tier);
  const hashes = (env['SPEECH_' + tier + '_KEY_HASHES'] || '').split(',').map(s => s.trim());
  if (!resource || !hashes.every(hash => hexHash.test(hash))) return null;
  return {resource, hashes: hashes.map(hash => Buffer.from(hash, 'hex'))};
}

function authorized(header, hashes) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(header || '');
  if (!match) return false;
  const value = Buffer.from(match[1], 'hex');
  let matched = 0;
  for (const hash of hashes) matched |= Number(timingSafeEqual(value, hash));
  return matched !== 0;
}

function monthStartInJapan(time) {
  const shifted = new Date(time + 9 * 60 * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1, -9);
}

function secondsUsed(response) {
  const metrics = response.value?.filter(metric => metric?.name?.value === metricName);
  if (metrics?.length !== 1) throw new Error('metric missing');
  const metric = metrics[0];
  if ((metric.errorCode && metric.errorCode !== 'Success') || metric.timeseries?.length !== 1) {
    throw new Error('no aggregate time series');
  }
  let used = null;
  for (const point of metric.timeseries[0].data || []) {
    if (point.total == null) continue;
    if (!Number.isFinite(point.total) || point.total < 0) throw new Error('invalid total');
    used = (used ?? 0) + point.total;
  }
  if (used === null || !Number.isFinite(used)) throw new Error('no measured total');
  return used;
}

module.exports = function installSpeechUsage(app, {env=process.env, fetchImpl=globalThis.fetch, clock=Date.now} = {}) {
  const usage = {F0:configuration(env, 'F0'), S0:configuration(env, 'S0')};
  const endpoint = env.IDENTITY_ENDPOINT, identityHeader = env.IDENTITY_HEADER;
  const cache = new Map();
  const regionLookups = new Map();

  async function readJSON(url, headers, signal) {
    const res = await fetchImpl(url, {headers, signal, redirect:'error'});
    if (!res.ok) throw new Error('Azure request failed');
    return res.json();
  }

  async function managementHeaders(signal) {
    const identity = new URL(endpoint);
    identity.searchParams.set('api-version', '2019-08-01');
    identity.searchParams.set('resource', management + '/');
    const token = await readJSON(identity, {'X-IDENTITY-HEADER':identityHeader}, signal);
    if (!token.access_token) throw new Error('no management token');
    return {Authorization:'Bearer ' + token.access_token};
  }

  async function query(tier, now, period) {
    const signal = AbortSignal.timeout(9000);
    const headers = await managementHeaders(signal);
    const resource = management + usage[tier].resource;
    const checkedAt = new Date(now).toISOString();
    const periodStart = new Date(period).toISOString();
    const metrics = new URL(resource + '/providers/Microsoft.Insights/metrics');
    metrics.search = new URLSearchParams({
      'api-version':'2023-10-01', metricnames:metricName, interval:'FULL', aggregation:'Total',
      timespan:periodStart + '/' + checkedAt,
    });
    const usedSeconds = secondsUsed(await readJSON(metrics, headers, signal));
    return {status:200, body:{usedSeconds, periodStart, checkedAt}};
  }

  async function readRegion(tier, resource) {
    const signal = AbortSignal.timeout(3000);
    const headers = await managementHeaders(signal);
    const account = await readJSON(management + resource + '?api-version=2024-10-01', headers, signal);
    if (account.sku?.name !== tier || typeof account.location !== 'string' || !/^[a-z][a-z0-9]+$/.test(account.location)) {
      throw new Error('Invalid Speech account location');
    }
    return account.location;
  }

  function speechRegion(tier) {
    const override = env['AZURE_SPEECH_' + tier + '_REGION']?.trim().toLowerCase();
    if (override) return override;
    const resource = resourcePath(env, tier);
    if (!resource || !endpoint || !identityHeader) return null;
    const stored = regionLookups.get(tier);
    if (stored && clock() < stored.expires) return stored.result;
    const entry = {expires:Infinity};
    entry.result = readRegion(tier, resource).catch(() => null).then(region => {
      entry.expires = clock() + (region ? 300_000 : 10_000);
      return region;
    });
    regionLookups.set(tier, entry);
    return entry.result;
  }

  function resultFor(tier) {
    const now = clock(), period = monthStartInJapan(now);
    const stored = cache.get(tier);
    if (stored && stored.period === period && now < stored.expires) return stored.result;
    const entry = {period, expires:Infinity};
    entry.result = query(tier, now, period)
      .catch(() => ({status:502, body:{error:'unavailable'}}))
      .then(result => {
        entry.expires = clock() + (result.status === 200 ? 60_000 : 10_000);
        return result;
      });
    cache.set(tier, entry);
    return entry.result;
  }

  // Register before the general room API, whose CORS policy allows any origin.
  app.all('/ai/api/speech-usage/:tier', async (req, res) => {
    res.set('Cache-Control', 'private, no-store').vary('Origin');
    const origin = req.get('Origin');
    if (origin && !origins.has(origin)) return res.status(403).json({error:'invalid_key'});
    if (origin) res.set('Access-Control-Allow-Origin', origin);
    res.set('Allow', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.set({'Access-Control-Allow-Headers':'Authorization', 'Access-Control-Allow-Methods':'GET, OPTIONS'});
      return res.status(204).end();
    }
    if (req.method !== 'GET') return res.status(405).json({error:'unavailable'});
    const tier = req.params.tier;
    if (tier !== 'F0' && tier !== 'S0') return res.status(404).json({error:'not_configured'});
    if (!usage[tier] || !endpoint || !identityHeader) return res.status(503).json({error:'not_configured'});
    if (!authorized(req.get('Authorization'), usage[tier].hashes)) return res.status(401).json({error:'invalid_key'});
    const result = await resultFor(tier);
    return res.status(result.status).json(result.body);
  });
  return async () => Object.fromEntries(await Promise.all(tiers.map(async tier => [tier, await speechRegion(tier)])));
};

module.exports.portalKeysUrl = function portalKeysUrl(env, tier) {
  const resource = resourcePath(env, tier);
  return resource ? 'https://portal.azure.com/#resource' + resource + '/cskeys' : null;
};
