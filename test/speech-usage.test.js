'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const express = require('express');
const install = require('../speech-usage');

const vercel = 'https://subtitle-ai-mirrors.vercel.app';
const azure = 'https://subtitle-ai-mirrors-th6k36zl5ltja.azurewebsites.net';
const proof = value => createHash('sha256').update('subtitle-mirror-usage:v1:' + value.trim()).digest('hex');
const auth = value => ({Authorization:'Bearer ' + proof(value)});
const resourceBase = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/字幕グループ/providers/Microsoft.CognitiveServices/accounts/';
const now = Date.parse('2026-03-31T14:59:58.000Z');
const metricName = 'AudioSecondsTranscribed';

function metricResponse(...totals) {
  return {
    value:[{
      name:{value:metricName}, unit:'Count',
      timeseries:[{data:totals.map(total=>({total}))}],
    }],
  };
}

async function fixture(t, overrides={}, arm=()=>metricResponse(543.75)) {
  const env = {
    SPEECH_F0_RESOURCE_ID:resourceBase+'speech-free', SPEECH_S0_RESOURCE_ID:resourceBase+'speech-paid',
    SPEECH_F0_KEY_HASHES:proof('f1')+','+proof('f2'), SPEECH_S0_KEY_HASHES:proof('s0'),
    IDENTITY_ENDPOINT:'http://identity.local/token',
    IDENTITY_HEADER:'test-identity', ...overrides,
  };
  let at = now;
  const calls=[];
  const fetchImpl = async (uri, opts) => {
    const url = new URL(uri);
    calls.push(url);
    assert.equal(opts.redirect,'error');
    assert.ok(opts.signal instanceof AbortSignal);
    if (url.hostname === 'identity.local') {
      assert.equal(opts.headers['X-IDENTITY-HEADER'], 'test-identity');
      assert.equal(url.searchParams.get('resource'), 'https://management.azure.com/');
      assert.equal(url.searchParams.get('api-version'), '2019-08-01');
      return Response.json({access_token:'mock-arm-token'});
    }
    assert.equal(url.origin, 'https://management.azure.com');
    assert.equal(opts.headers.Authorization, 'Bearer mock-arm-token');
    return Response.json(await arm(url));
  };
  const app = express();
  const readSpeechRegions=install(app, {env, fetchImpl, clock:()=>at});
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>{server.close(resolve); server.closeAllConnections();}));
  await once(server,'listening');
  return {
    calls, readSpeechRegions, setTime(ms){at=ms;},
    get(tier, headers={}, method='GET'){
      return fetch('http://127.0.0.1:'+server.address().port+'/ai/api/speech-usage/'+tier,{headers,method});
    },
  };
}

test('speech usage protects credentials, cross-origin preflight and cached values before calling Azure',async t=>{
  const app=await fixture(t);
  for(const origin of [azure,vercel]){
    const r=await app.get('F0',{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'},'OPTIONS');
    assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);
    assert.match(r.headers.get('Access-Control-Allow-Headers'),/Authorization/i);
    assert.match(r.headers.get('Vary'),/Origin/);
  }
  const forbidden=await app.get('F0',{...auth('f1'),Origin:'https://unrelated.example'});
  assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'),null);
  for(const token of ['', 's0', 'unregistered']){
    const r=await app.get('F0',token ? auth(token) : {});
    assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'invalid_key'});
  }
  assert.equal((await app.get('S0',auth('f2'))).status,401);
  assert.equal((await app.get('F0',auth('f1'),'POST')).status,405);
  assert.equal(app.calls.length,0);
  const granted=await app.get('F0',{...auth('f2'),Origin:vercel});
  assert.equal(granted.status,200);assert.match(granted.headers.get('Cache-Control'),/no-store/);
  assert.equal((await app.get('F0',auth('s0'))).status,401);
  assert.equal(app.calls.length,2);
});

test('concurrent authorized requests coalesce for the same tier', async t=>{
  const app=await fixture(t);
  const [first,second]=await Promise.all([app.get('F0',auth('f1')),app.get('F0',auth('f2'))]);
  assert.equal(first.status,200);
  assert.equal(second.status,200);
  assert.deepEqual(await first.json(),await second.json());
  assert.equal(app.calls.length,2);
});

test('an unconfigured tier does not call Azure', async t=>{
  const app=await fixture(t,{SPEECH_F0_RESOURCE_ID:''});
  const response=await app.get('F0',auth('f1'));
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'not_configured'});
  assert.equal(app.calls.length,0);
});

test('Speech locations resolve independently and retain configured overrides', async t=>{
  let location = 'japaneast';
  const app = await fixture(t, {AZURE_SPEECH_F0_REGION:' JapanWest '}, url=>{
    assert.equal(decodeURIComponent(url.pathname),resourceBase+'speech-paid');
    assert.equal(url.searchParams.get('api-version'),'2024-10-01');
    return {location, sku:{name:'S0'}};
  });
  const expected = {F0:'japanwest', S0:'japaneast'};
  assert.deepEqual(await Promise.all([app.readSpeechRegions(),app.readSpeechRegions()]),[expected,expected]);
  assert.equal(app.calls.length,2);
  location = 'westus';
  app.setTime(now+300_001);
  assert.deepEqual(await app.readSpeechRegions(),{...expected, S0:'westus'});
  assert.equal(app.calls.length,4);
});

for (const [tier, key, resource, seconds] of [
  ['F0','f1','speech-free',18005.75],
  ['S0','s0','speech-paid',543.75],
]) {
  test(tier + ' reads transcription time for its own resource and expires the cache at the JST month boundary', async t=>{
    const spans=[];
    let totals=[seconds - 5, null, 5];
    const app=await fixture(t,{},url=>{
      assert.equal(decodeURIComponent(url.pathname),resourceBase+resource+'/providers/Microsoft.Insights/metrics');
      assert.equal(url.searchParams.get('aggregation'),'Total');
      assert.equal(url.searchParams.get('metricnames'),metricName);
      assert.equal(url.searchParams.get('interval'),'FULL');
      assert.equal(url.searchParams.has('$filter'),false);
      spans.push(url.searchParams.get('timespan'));
      return metricResponse(...totals);
    });
    const first=await app.get(tier,auth(key));
    assert.equal(first.status,200);
    assert.deepEqual(await first.json(),{usedSeconds:seconds,periodStart:'2026-02-28T15:00:00.000Z',checkedAt:new Date(now).toISOString()});
    totals=[0];
    const next=now+4000;
    app.setTime(next);
    assert.deepEqual(await (await app.get(tier,auth(key))).json(),{usedSeconds:0,periodStart:'2026-03-31T15:00:00.000Z',checkedAt:new Date(next).toISOString()});
    assert.deepEqual(spans,['2026-02-28T15:00:00.000Z/'+new Date(now).toISOString(),'2026-03-31T15:00:00.000Z/'+new Date(next).toISOString()]);
  });
}

test('upstream errors and missing measurements are never presented as zero usage', async t=>{
  for(const response of [{value:[]},{value:[{name:{value:metricName},errorCode:'InvalidSamplingType'}]},
      metricResponse(null),metricResponse(-1)]) {
    const app=await fixture(t,{},()=>response);
    for(const [tier,key] of [['F0','f1'],['S0','s0']]){
      const result=await app.get(tier,auth(key));
      assert.equal(result.status,502);
      assert.deepEqual(await result.json(),{error:'unavailable'});
    }
  }
  const broken=await fixture(t,{},()=>{throw new Error('private ARM diagnostics');});
  assert.deepEqual(await (await broken.get('F0',auth('f1'))).json(),{error:'unavailable'});
});
