// Credentials live only in this closure. No token is placed in storage or URLs.
export const isActiveJob = job => ['queued', 'running'].includes(job?.status);

// Stage every file before the caller changes displayed data. A publication can
// happen between HTTP requests, so server mode checks the release on both sides.
export async function readPublishedAssets(game, {readJSON, server = false, attempts = 3}) {
  if (!['kpl', 'lol'].includes(game)) throw new Error('请选择有效的游戏。');
  const version = async () => {
    const value = await readJSON('/api/snapshot');
    if (typeof value?.version !== 'string' || !value.version) throw new Error('无法确认服务器快照版本，请稍后重试。');
    return value.version;
  };
  for (let index = 0; index < attempts; index++) {
    const before = server ? await version() : null;
    const [data, events, champions] = game === 'lol'
      ? await Promise.all([readJSON('./lol-data.json'), readJSON('./lol-events.json'), readJSON('./champions.json')])
      : [await readJSON('./data.json'), null, null];
    const after = server ? await version() : null;
    if (before === after) return {data, events, champions, version: after};
  }
  throw new Error('读取期间服务器快照发生切换，请稍后重新载入。已有数据已保留。');
}

export function createServerUpdates({
  fetchImpl = (...args) => fetch(...args),
  onChange = () => {},
  onSuccess = async () => {},
  timeoutMs = 12000,
  pollDelay = 2000,
  retryDelay = 4000,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
} = {}) {
  let token = '', timer, generation = 0, stopped = false;
  const completed = new Set();
  const state = {enabled: false, detected: false, requesting: false, busy: false,
    job: null, error: '', needsToken: false, refreshing: false};
  const notify = () => onChange({...state});
  const error = (message, status = 0) => Object.assign(new Error(message), {status});

  async function request(path, options = {}, authenticated = true) {
    const controller = new AbortController();
    const timeout = schedule(() => controller.abort(), timeoutMs);
    try {
      const headers = {Accept: 'application/json', ...options.headers};
      if (authenticated) {
        if (!token) throw error('请输入服务器更新口令。', 401);
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetchImpl(path, {...options, headers, cache: 'no-store', signal: controller.signal});
      if (response.status === 401 && authenticated) {
        token = ''; state.needsToken = true;
        throw error('更新口令不正确或已失效，请重新输入。', 401);
      }
      const body = await response.json().catch(() => null);
      if (response.status === 409 && body?.job) return body;
      if (!response.ok) throw error(body?.error || body?.message || `服务器请求失败（${response.status}）。`, response.status);
      if (!body || typeof body !== 'object') throw error('服务器返回了无法识别的内容，请稍后重试。');
      return body;
    } catch (failure) {
      if (failure.name === 'AbortError') throw error('连接服务器超时，任务可能仍在后台运行。');
      throw failure;
    } finally { cancel(timeout); }
  }

  async function detect() {
    try {
      const result = await request('/api/health', {}, false);
      state.enabled = result.ok === true && result.serverUpdates === true;
    } catch { /* A static deployment normally responds with 404. */ }
    state.detected = true; notify();
    return state.enabled;
  }

  function later(delay = pollDelay) {
    cancel(timer);
    if (!stopped && token && isActiveJob(state.job)) timer = schedule(poll, delay);
  }

  async function accept(job) {
    if (job && (!['kpl', 'lol'].includes(job.game) || !['queued', 'running', 'succeeded', 'failed'].includes(job.status) || !job.id)) {
      throw error('服务器任务格式不正确，请稍后重试。');
    }
    state.job = job; state.busy = isActiveJob(job); state.error = ''; notify();
    if (job?.status === 'succeeded' && !completed.has(job.id)) {
      state.refreshing = true; notify();
      try {
        await onSuccess(job);
        completed.add(job.id);
      } catch {
        state.error = '服务器已发布新数据，但当前页面读取失败；可点击“重新载入已发布数据”。';
      } finally { state.refreshing = false; notify(); }
    }
    later();
  }

  async function poll() {
    const run = generation;
    state.requesting = true; notify();
    try {
      const result = await request('/api/updates');
      if (run !== generation || stopped) return;
      if (!result.job && isActiveJob(state.job)) {
        state.busy = false; state.job = null;
        state.error = '服务器未找到之前的任务，请检查服务器状态后重试。';
      } else await accept(result.job ?? null);
    } catch (failure) {
      if (run !== generation || stopped) return;
      state.error = failure.message;
      if (failure.status === 401) state.busy = false;
      else later(retryDelay);
    } finally {
      if (run === generation) { state.requesting = false; notify(); }
    }
  }

  async function start(game) {
    if (!['kpl', 'lol'].includes(game)) throw error('请选择有效的游戏。');
    if (state.requesting || state.refreshing) return;
    stopped = false; generation++; cancel(timer);
    state.requesting = true; state.error = ''; notify();
    try {
      // A reload or a lost POST response must not start a duplicate collection.
      const previous = await request('/api/updates');
      if (isActiveJob(previous.job)) { await accept(previous.job); return; }
      const result = await request('/api/updates', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({game})});
      if (!result.job) throw error('服务器未返回更新任务，请重试以查询是否已经启动。');
      await accept(result.job);
    } catch (failure) {
      state.error = failure.message; state.busy = false;
      throw failure;
    } finally { state.requesting = false; notify(); }
  }

  return {
    detect, start,
    retry: async () => {
      if (state.requesting || state.refreshing) return;
      if (state.job?.status === 'succeeded') await accept(state.job);
      else { stopped = false; await poll(); }
    },
    setToken(value) { token = String(value); state.needsToken = !token; notify(); },
    hasToken: () => Boolean(token),
    getState: () => ({...state}),
    stop() { stopped = true; generation++; cancel(timer); },
  };
}
