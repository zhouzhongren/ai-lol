import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../dist/server-updates.js', import.meta.url), 'utf8');
const {createServerUpdates,readPublishedAssets} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const job = (status = 'running', game = 'kpl', id = 'job-1') => ({id, game, status, stage: status, logs: []});
const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});
function harness(responses, options = {}) {
  const requests = [], timers = [], updates = [], published = [];
  const client = createServerUpdates({
    fetchImpl: async (path, init) => {
      requests.push({path, ...init});
      const result = responses.shift();
      if (result instanceof Error) throw result;
      if (typeof result === 'function') return result(init);
      assert.ok(result, `Unexpected request: ${path}`);
      return result;
    },
    schedule: (callback, delay) => {const timer = {callback, delay}; timers.push(timer); return timer;},
    cancel: timer => {if (timer) timer.cancelled = true;},
    onChange: state => updates.push(state),
    onSuccess: async value => published.push(value),
    ...options,
  });
  return {client, requests, updates, published, async fire(delay) {
    const timer = timers.find(value => !value.cancelled && value.delay === delay);
    assert.ok(timer, `No active timer at ${delay}ms`); timer.cancelled = true;
    await timer.callback();
  }};
}

test('static deployments retain the fallback; health checks never include a token', async () => {
  const h = harness([response(null, 404), response({ok: true, serverUpdates: true})]);
  h.client.setToken('page-only-secret');
  assert.equal(await h.client.detect(), false);
  assert.equal(await h.client.detect(), true);
  assert.ok(h.requests.every(request => !request.headers.Authorization && !request.path.includes('secret')));
});

test('an upstream health authentication error does not open a password prompt on page load', async () => {
  const h = harness([response({error: 'Gateway login required'}, 401)]);
  await h.client.detect();
  assert.equal(h.client.getState().enabled, false);
  assert.equal(h.client.getState().needsToken, false);
});

test('starts the selected game with JSON and a memory-only Bearer, then refreshes once', async () => {
  const h = harness([response({job: null}), response({job: job('queued', 'lol')}, 202),
    response({job: job('running', 'lol')}), response({job: job('succeeded', 'lol')})]);
  h.client.setToken('page-only-secret');
  await h.client.start('lol');
  assert.deepEqual(JSON.parse(h.requests[1].body), {game: 'lol'});
  assert.equal(h.requests[1].method, 'POST');
  assert.equal(h.requests[1].headers['Content-Type'], 'application/json');
  assert.ok(h.requests.every(request => request.headers.Authorization === 'Bearer page-only-secret'));
  assert.equal(h.client.getState().busy, true);
  await h.fire(2000); await h.fire(2000);
  assert.equal(h.client.getState().busy, false);
  assert.equal(h.published[0].game, 'lol');
  await h.client.retry();
  assert.equal(h.published.length, 1);
  assert.equal(JSON.stringify(h.updates).includes('page-only-secret'), false);
});

test('restores an active job after a reload without POST, even for the other game', async () => {
  const h = harness([response({job: job('running', 'lol')})]);
  h.client.setToken('secret'); await h.client.start('kpl');
  assert.equal(h.requests.length, 1);
  assert.equal(h.client.getState().job.game, 'lol');
});

test('409 follows the existing task instead of starting another collection', async () => {
  const h = harness([response({job: null}), response({job: job('running', 'lol')}, 409)]);
  h.client.setToken('secret'); await h.client.start('kpl');
  assert.equal(h.client.getState().job.game, 'lol');
  assert.equal(h.client.getState().busy, true);
});

test('a lost POST response is recovered by checking status before sending a new request', async () => {
  const h = harness([response({job: null}), new Error('Network offline'), response({job: job()})]);
  h.client.setToken('secret');
  await assert.rejects(h.client.start('kpl'), /Network offline/);
  await h.client.start('kpl');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.client.getState().busy, true);
});

test('a transient polling failure backs off and recovers without losing the job', async () => {
  const h = harness([response({job: job()}), new Error('offline'), response({job: job('succeeded')})]);
  h.client.setToken('secret'); await h.client.start('kpl'); await h.fire(2000);
  assert.equal(h.client.getState().error, 'offline');
  assert.equal(h.client.getState().job.id, 'job-1');
  await h.fire(4000);
  assert.equal(h.client.getState().error, ''); assert.equal(h.published.length, 1);
});

test('401 clears credentials and permits a new password to resume the task', async () => {
  const h = harness([response({job: job()}), response({error: 'Unauthorized'}, 401), response({job: job()})]);
  h.client.setToken('old'); await h.client.start('kpl'); await h.fire(2000);
  assert.equal(h.client.hasToken(), false); assert.equal(h.client.getState().needsToken, true);
  assert.equal(h.client.getState().busy, false);
  h.client.setToken('new'); await h.client.start('kpl');
  assert.equal(h.requests.at(-1).headers.Authorization, 'Bearer new');
  assert.equal(h.client.getState().busy, true);
});

test('failed jobs keep the old data; publication reload failures are retryable', async () => {
  let attempts = 0;
  const h = harness([response({job: job()}), response({job: job('failed')}),
    response({job: null}), response({job: job('succeeded', 'lol', 'job-2')}, 202)], {
    onSuccess: async () => {attempts++; if (attempts === 1) throw Error('Snapshot unavailable');},
  });
  h.client.setToken('secret'); await h.client.start('kpl'); await h.fire(2000);
  assert.equal(attempts, 0); assert.equal(h.client.getState().busy, false);
  await h.client.start('lol');
  assert.match(h.client.getState().error, /当前页面读取失败/);
  await h.client.retry();
  assert.equal(attempts, 2); assert.equal(h.client.getState().error, '');
});

test('fetch timeouts abort the request and release the action for retry', async () => {
  const h = harness([init => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})));
  })]);
  h.client.setToken('secret');
  const pending = h.client.start('kpl');
  const rejected = assert.rejects(pending, /超时/);
  await h.fire(12000); await rejected;
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.client.getState().requesting, false);
});

test('a publication between LoL file requests retries the whole set before returning assets', async () => {
  const versions = ['release-a', 'release-b', 'release-b', 'release-b'];
  let reads = 0;
  const result = await readPublishedAssets('lol', {server: true, readJSON: async path => {
    if (path === '/api/snapshot') return {version: versions.shift()};
    reads++;
    return {file: path, generation: Math.ceil(reads / 3)};
  }});
  assert.equal(reads, 6);
  assert.equal(result.version, 'release-b');
  assert.deepEqual([result.data.generation, result.events.generation, result.champions.generation], [2, 2, 2]);
});

test('repeated publication changes have a bounded retry count and never return a mixed snapshot', async () => {
  let versionReads = 0;
  await assert.rejects(readPublishedAssets('lol', {server: true, readJSON: async path => {
    if (path === '/api/snapshot') return {version: String(++versionReads)};
    return {};
  }}), /快照发生切换/);
  assert.equal(versionReads, 6);
});

test('a missing champion catalog rejects the staged set without delivering partial data', async () => {
  let returned = false;
  await assert.rejects(readPublishedAssets('lol', {readJSON: async path => {
    if (path === './champions.json') throw Error('catalog unavailable');
    return {rows: []};
  }}).then(() => {returned = true;}), /catalog unavailable/);
  assert.equal(returned, false);
});

test('static KPL reads only its own file and needs no version endpoint', async () => {
  const paths = [];
  const result = await readPublishedAssets('kpl', {readJSON: async path => {paths.push(path); return {rows: []};}});
  assert.deepEqual(paths, ['./data.json']);
  assert.equal(result.events, null);
  assert.equal(result.champions, null);
});
