'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：带超时与一次重试的 HTTP 执行器（阶段 4）
 * ============================================================================
 *
 * 阶段 4 的 ASR / TTS 云调用与阶段 3 的对话共用同一套策略（需求原文）：
 *   - **超时 10 秒**（对话是 15 秒）；
 *   - **最多重试一次**，且只重试：网络错误 / 超时 / 408 / 425 / 429 / 5xx；
 *     401 / 403 / 400 这类永久错误绝不重试（重试只会浪费用户时间）；
 *   - 失败只返回**短错误码 + 固定中文短语**，绝不回显上游响应体、请求头或 API Key；
 *   - `fetch` 与定时器全部依赖注入，单元测试可以毫秒级跑完所有分支、**不发真实请求**。
 *
 * 为什么单独成模块：ASR（multipart 上传音频）与 TTS（JSON + 音频响应）的
 * 请求体形态完全不同，但超时 / 重试 / 错误归类必须**逐字一致**。把这一层抽出来，
 * 两个客户端各自只关心"怎么构造请求、怎么解析响应"。
 *
 * 关于请求体：body 必须用**工厂函数**而不是现成对象。
 * FormData / Blob 一旦被发送过就可能被消费掉，重试时再发同一个实例会失败；
 * 每次重试都调用一次 `bodyFactory()` 才能保证两次请求完全等价。
 */

/** ASR / TTS 的超时（需求：10 秒） */
const VOICE_TIMEOUT_MS = 10000;
/** 最多重试次数（需求：一次） */
const MAX_RETRIES = 1;
/** 允许重试的 HTTP 状态码 */
const RETRYABLE_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504]);

/** 错误码 → 简短中文提示（直接给用户看，不带任何上游细节） */
const HTTP_ERROR_MESSAGES = Object.freeze({
  'no-api-key': '还没有配置 API Key，去 open.bigmodel.cn 领一个再填进设置里吧。',
  'auth-failed': 'API Key 无效或已过期，去 open.bigmodel.cn 重新申请一个吧。',
  forbidden: '这个 Key 没有调用该模型的权限，请检查账户权限。',
  'bad-request': '请求参数不对，这次没能发出去。',
  'rate-limited': '请求太频繁了，等一会儿再试。',
  'server-error': '智谱服务端有点问题，稍后再试。',
  'http-error': '云端返回了异常状态，稍后再试。',
  timeout: '网有点卡…请求超时了。',
  network: '网有点卡…没能连上云端。',
  'bad-response': '云端返回的内容看不懂，等会儿再试一次吧。',
  aborted: '请求已取消。',
  'too-large': '这段音频太大了，没法上传。',
  'too-long': '这段音频太长了（最多 30 秒）。',
  'internal-error': '内部出错了，稍后再试。'
});

/**
 * 把 HTTP 状态码映射成错误码。
 * @param {number} status
 * @returns {string}
 */
function codeForStatus(status) {
  if (status === 401) return 'auth-failed';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'http-error';
  return 'http-error';
}

/**
 * 判断某个错误码是否值得重试。
 * @param {string} code
 * @param {number} [status]
 * @returns {boolean}
 */
function isRetryableCode(code, status) {
  if (code === 'network' || code === 'timeout') return true;
  if (Number.isFinite(status) && RETRYABLE_STATUS.includes(status)) return true;
  return false;
}

/**
 * 构造标准失败结果（永远不含上游正文、永远不含 Key）。
 * @param {string} code
 * @param {number} status
 * @param {number} attempts
 * @returns {{ok: false, code: string, message: string, status: number, attempts: number}}
 */
function fail(code, status, attempts) {
  return {
    ok: false,
    code,
    message: HTTP_ERROR_MESSAGES[code] || HTTP_ERROR_MESSAGES['internal-error'],
    status: Number.isFinite(status) ? status : 0,
    attempts: Number.isFinite(attempts) ? attempts : 0
  };
}

/**
 * 创建一个 HTTP 执行器。
 *
 * @param {{
 *   fetchImpl?: Function,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   logger?: {warn?: Function}
 * }} [deps]
 */
function createHttpRunner(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
  const timers = options.timers && typeof options.timers.setTimeout === 'function'
    ? options.timers
    : { setTimeout, clearTimeout };
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : VOICE_TIMEOUT_MS;
  const maxRetries = Number.isFinite(options.maxRetries) && options.maxRetries >= 0
    ? Math.floor(options.maxRetries)
    : MAX_RETRIES;

  /**
   * 发一次请求（不含重试）。永远 resolve，绝不 reject。
   *
   * 超时覆盖**整个 fetch + 响应体读取**：读 body 时同样可能挂住，
   * 所以定时器只在 finally 里清理（阶段 3 缺陷 E 的同一套做法）。
   *
   * `readBody` 决定怎么读响应（'json' / 'arrayBuffer' / 'text' / 'none'）；
   * 非 2xx 时一律按 readBody 读完并**丢弃**，避免连接悬挂。
   *
   * @param {{
   *   url: string,
   *   method?: string,
   *   headers?: Record<string, string>,
   *   bodyFactory?: () => unknown,
   *   readBody?: 'json'|'arrayBuffer'|'text'|'none',
   *   apiKey?: string
   * }} request
   * @returns {Promise<{ok: true, status: number, data: unknown, bytes: number} | {ok: false, code: string, status: number}>}
   */
  async function requestOnce(request) {
    if (!fetchImpl) return { ok: false, code: 'internal-error', status: 0 };

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller
      ? timers.setTimeout(() => {
          timedOut = true;
          try {
            controller.abort();
          } catch {
            // abort 失败也无所谓，下面的超时分支会兜住
          }
        }, timeoutMs)
      : null;

    try {
      // 只有显式给了 Key 才拼 Authorization 头；Key 绝不进日志
      const headers = Object.assign({}, request.headers || {});
      if (typeof request.apiKey === 'string' && request.apiKey.length > 0) {
        headers.Authorization = `Bearer ${request.apiKey}`;
      }

      const init = {
        method: request.method || 'POST',
        headers,
        signal: controller ? controller.signal : undefined
      };
      if (typeof request.bodyFactory === 'function') {
        init.body = request.bodyFactory();
      }

      let response = null;
      try {
        response = await fetchImpl(request.url, init);
      } catch (error) {
        if (timedOut || (error && error.name === 'AbortError')) {
          return { ok: false, code: 'timeout', status: 0 };
        }
        // 只记类别，不打印 error.message（可能含请求细节）
        return { ok: false, code: 'network', status: 0 };
      }

      if (timedOut) return { ok: false, code: 'timeout', status: 0 };

      const status = response && Number.isFinite(response.status) ? response.status : 0;
      const mode = request.readBody || 'text';

      let data = null;
      let bytes = 0;
      try {
        if (mode === 'json') {
          const text = typeof response.text === 'function' ? await response.text() : '';
          bytes = typeof text === 'string' ? text.length : 0;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        } else if (mode === 'arrayBuffer') {
          const buffer = typeof response.arrayBuffer === 'function' ? await response.arrayBuffer() : null;
          data = buffer ? new Uint8Array(buffer) : new Uint8Array(0);
          bytes = data.byteLength;
        } else if (mode === 'text') {
          const text = typeof response.text === 'function' ? await response.text() : '';
          data = typeof text === 'string' ? text : '';
          bytes = data.length;
        } else {
          data = null;
        }
      } catch (error) {
        if (timedOut || (error && error.name === 'AbortError')) {
          return { ok: false, code: 'timeout', status: 0 };
        }
        return { ok: false, code: 'network', status };
      }

      if (timedOut) return { ok: false, code: 'timeout', status: 0 };

      if (status < 200 || status >= 300) {
        // 正文已读完并丢弃：绝不解析、绝不回显
        return { ok: false, code: codeForStatus(status), status };
      }

      return { ok: true, status, data, bytes };
    } finally {
      if (timer) timers.clearTimeout(timer);
    }
  }

  /**
   * 带重试的请求：只在可重试错误上重试，最多 `maxRetries` 次。
   * @param {object} request 同 requestOnce
   * @returns {Promise<object>}
   */
  async function run(request) {
    let attempt = 0;
    let last = { code: 'internal-error', status: 0 };
    for (;;) {
      attempt += 1;
      const result = await requestOnce(request);
      if (result.ok) return Object.assign({ attempts: attempt }, result);
      last = result;
      if (attempt > maxRetries || !isRetryableCode(result.code, result.status)) break;
    }
    return fail(last.code, last.status, attempt);
  }

  return {
    run,
    requestOnce,
    timeoutMs,
    maxRetries
  };
}

module.exports = {
  VOICE_TIMEOUT_MS,
  MAX_RETRIES,
  RETRYABLE_STATUS,
  HTTP_ERROR_MESSAGES,
  codeForStatus,
  isRetryableCode,
  fail,
  createHttpRunner
};
