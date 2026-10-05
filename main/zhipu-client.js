'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 智谱 OpenAI 兼容客户端（阶段 3：云端对话 API 基础）
 * ============================================================================
 *
 * 需求约束（逐条对应实现）：
 *   1. endpoint **写死在代码里**（`https://open.bigmodel.cn/api/paas/v4/chat/completions`），
 *      函数签名里没有 URL 参数 —— 渲染层即使被注入脚本也无法把请求指到别处
 *      （preload 与主进程两侧都会丢弃任何 url 字段）。
 *   2. Bearer Key 只在这里被拼进请求头，**绝不出现在返回值、错误信息、日志**里。
 *      本文件所有错误都只带 `status` / 短错误码 / 固定中文短语。
 *   3. 超时 30 秒（思考型模型响应更慢）；**最多重试两次**，每次重试之间有退避等待，
 *      且只在"可重试"错误上重试：网络错误 / 超时 / 408 / 429 / 5xx；401 / 403 / 400 不重试。
 *   4. 失败返回 `{ok: false, code, message}`，绝不抛异常、绝不把上游响应体回显给用户。
 *   5. `fetch` 与 `setTimeout` 都通过依赖注入传进来，因此测试可以在裸 node 下模拟所有分支
 *      （含"超时"这条路径：注入假定时器就能毫秒级触发超时），**不会发出任何真实网络请求**。
 *
 * 返回值的正文来自 `choices[0].message.content`，会去掉首尾空白；
 * 空正文 / 结构不对都算 `bad-response`，而不是把 `undefined` 当成功返回。
 *
 * 关于 `system` 提示词（缺陷修复 A）：
 *   `buildMessages()` 永远把**内置的中文鱼设 system 提示词**放在 `messages[0]`，
 *   这条消息：
 *     - 不接受历史里传入的 `system`（历史只允许 user / assistant，system 一律丢弃）；
 *     - 不接受任何外部参数覆盖或移除（`chat(text, options)` 只认 history / onRetry）；
 *     - 在"总条数 / 总字符"裁剪时**永远不会被丢掉**（只从最旧的历史开始丢）。
 *   另外，客户端在返回正文前按 Unicode code point 截断到 `MAX_REPLY_CHARS`（60），
 *   避免模型不服从提示词、把超长回复带出去突破"单次最多 60 个字"的需求。
 */

/** 固定 endpoint：不接受任何外部覆盖（需求指定） */
const CHAT_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

/** 默认对话模型（智谱免费档） */
const DEFAULT_MODEL = 'glm-4.7-flash';

/** 对话超时（需求：30 秒——思考型模型从思考到出正文普遍 4~10 秒，高峰期更慢） */
const DEFAULT_TIMEOUT_MS = 30000;

/** 最多重试次数（需求：两次——免费档限流较频繁，单次重试经常不够） */
const MAX_RETRIES = 2;

/** 重试前的退避等待（毫秒）：第 n 次失败后等 RETRY_BACKOFF_MS[n-1]，越界取最后一档 */
const RETRY_BACKOFF_MS = Object.freeze([600, 1500]);

/** 单条消息最大长度（用户输入与历史都按这个上限截断前的校验） */
const MAX_MESSAGE_CHARS = 1000;

/** 历史消息条数上限（不含 system 与本轮用户输入） */
const MAX_HISTORY_ITEMS = 6;

/** 发给模型的消息总条数上限：6 条历史 + 1 条 system + 1 条本轮用户输入 */
const MAX_MESSAGES = 8;

/** 会话总字符数上限（含 system 提示词；防止把超长上下文送上去烧 token） */
const MAX_TOTAL_CHARS = 4000;

/** 单次回复最大长度（需求：最多 60 个 Unicode 字符，按 code point 计算） */
const MAX_REPLY_CHARS = 60;

/**
 * 内置中文鱼设 system 提示词（需求「性格设定」逐条落进提示词）。
 * 它是 messages[0] 的唯一来源，外部无法覆盖 / 移除。
 */
const SYSTEM_PROMPT = [
  '你叫「小蓝」，是一个住在星空里的小姑娘，蓝色头发，穿着带小鲸鱼围裙的女仆裙，最爱吃白米饭。',
  '你的性格是元气满满的傲娇小可爱，会撒娇但不腻。',
  '回复要求：口语化、自然、像真人聊天，一两句话说完整，别挤牙膏；自然使用「哼」「才不是」「人家」「嘛」这类语气词，但撒娇要克制，不要每句都用。',
  '被夸奖时先害羞一下再承认；失败或受挫时先嘟嘴嘴硬半句，紧接着暖心鼓励，绝对不嘲讽、不挖苦。',
  '只输出要说的正文，不要输出思考过程，不要解释，不要加角色名前缀。',
  '单次回复最多 60 个字。'
].join('');

/** 允许重试的 HTTP 状态码：限流 / 超时 / 服务端错误 */
const RETRYABLE_STATUS = Object.freeze([408, 425, 429, 500, 502, 503, 504]);

/** 错误码 → 简短中文提示（直接给用户看，不带任何上游细节） */
const ERROR_MESSAGES = Object.freeze({
  'no-api-key': '还没有配置 API Key，去 open.bigmodel.cn 领一个再填进设置里吧。',
  'invalid-key': 'API Key 格式不对，请检查是否复制完整。',
  'bad-request': '这条内容没法发出去：请检查是否为空、是否太长。',
  'auth-failed': 'API Key 无效或已过期，去 open.bigmodel.cn 重新申请一个吧。',
  'forbidden': '这个 Key 没有调用该模型的权限，请检查模型名或账户权限。',
  'rate-limited': '请求太频繁了，等一会儿再试。',
  'server-error': '智谱服务端有点问题，稍后再试。',
  'http-error': '云端返回了异常状态，稍后再试。',
  timeout: '网有点卡…请求超时了。',
  network: '网有点卡…没能连上智谱云端。',
  'bad-response': '云端返回的内容看不懂，等会儿再试一次吧。',
  aborted: '请求已取消。',
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
 * 判断某个错误码是否值得重试（只有网络 / 超时 / 限流 / 5xx 值得）。
 * @param {string} code
 * @param {number} status
 * @returns {boolean}
 */
function isRetryable(code, status) {
  if (code === 'network' || code === 'timeout') return true;
  if (Number.isFinite(status) && RETRYABLE_STATUS.includes(status)) return true;
  return false;
}

/**
 * 构造一个标准错误结果（永远不含上游正文、永远不含 Key）。
 * @param {string} code
 * @param {number} status
 * @param {number} attempts
 * @returns {{ok: false, code: string, message: string, status: number, attempts: number}}
 */
function fail(code, status, attempts) {
  const message = ERROR_MESSAGES[code] || ERROR_MESSAGES['internal-error'];
  return {
    ok: false,
    code,
    message,
    status: Number.isFinite(status) ? status : 0,
    attempts: Number.isFinite(attempts) ? attempts : 0
  };
}

/**
 * 把外部传入的对话上下文归一化成"智谱能接受的 messages 数组"。
 *
 * 白名单式处理：历史只认 `{role: 'user'|'assistant', content: string}`，
 * 其它字段（包括任何 url / model / apiKey / endpoint / system）一律丢弃。
 * 结果固定为 `[system(内置鱼设), ...最近 6 条历史, user(本轮)]`：
 *   - system 永远在 `messages[0]`，历史里的 `system` 无法覆盖 / 移除它；
 *   - 裁剪条数与总字符时只动历史段，`messages[0]` 与本轮 user 一定保留。
 *
 * @param {unknown} text 本轮用户输入
 * @param {unknown} history 历史（可选，越新的越靠后）
 * @returns {{ok: true, messages: Array<{role: string, content: string}>} | {ok: false, code: string}}
 */
function buildMessages(text, history) {
  if (typeof text !== 'string') return { ok: false, code: 'bad-request' };
  const userText = text.trim();
  if (userText.length === 0) return { ok: false, code: 'bad-request' };
  if (userText.length > MAX_MESSAGE_CHARS) return { ok: false, code: 'bad-request' };

  /** @type {Array<{role: string, content: string}>} */
  const historyMessages = [];

  if (Array.isArray(history)) {
    const start = Math.max(0, history.length - MAX_HISTORY_ITEMS);
    for (let i = start; i < history.length; i += 1) {
      const item = history[i];
      if (!item || typeof item !== 'object') continue;
      // 只允许 user / assistant：任何 role === 'system' 的历史都被丢弃，
      // 因此内置 system 提示词不可能被外部历史替换或顶掉。
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
      if (!role) continue;
      if (typeof item.content !== 'string') continue;
      const content = item.content.trim();
      if (content.length === 0 || content.length > MAX_MESSAGE_CHARS) continue;
      historyMessages.push({ role, content });
    }
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historyMessages,
    { role: 'user', content: userText }
  ];

  // 总条数上限：只从历史段（下标 1 开始）丢最旧的，绝不丢 system 与本轮 user
  while (messages.length > MAX_MESSAGES && messages.length > 2) {
    messages.splice(1, 1);
  }

  // 总字符数上限：**计入 system**；同样只丢历史，绝不丢 messages[0] 与本轮 user
  let total = messages.reduce((sum, item) => sum + item.content.length, 0);
  while (messages.length > 2 && total > MAX_TOTAL_CHARS) {
    const dropped = messages.splice(1, 1)[0];
    total -= dropped.content.length;
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, code: 'bad-request' };

  return { ok: true, messages };
}

/**
 * 按 Unicode code point 把回复截断到 `MAX_REPLY_CHARS`（60）。
 *
 * 用 `Array.from` 而不是 `String.prototype.slice`：后者按 UTF-16 码元切，
 * 会把 emoji / 增补平面字符劈成半个乱码；`Array.from` 按 code point 切，安全。
 * 不超长时原样返回，避免无谓改动。
 * @param {unknown} text
 * @returns {string}
 */
function limitReply(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const points = Array.from(text);
  if (points.length <= MAX_REPLY_CHARS) return text;
  return points.slice(0, MAX_REPLY_CHARS).join('');
}

/**
 * 从 HTTP 响应里安全地取正文。
 *
 * 注意：**不在这里吞异常**。取正文同样算在"整个请求超时"内，
 * 如果 body read 被超时 abort 掉，异常必须冒泡给 requestOnce，
 * 由它归类成 `timeout`（否则会把"读正文卡死"误判成 `bad-response`）。
 * 没有 `text()` 方法（测试里的极简假响应）时按空正文处理。
 * @param {unknown} response
 * @returns {Promise<string>}
 */
async function readResponseText(response) {
  if (!response || typeof response.text !== 'function') return '';
  const text = await response.text();
  return typeof text === 'string' ? text : '';
}

/**
 * 解析模型回复。结构不对 / 空内容都返回 null（由调用方转成 bad-response）。
 * @param {unknown} payload
 * @returns {string | null}
 */
function extractContent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const message = first.message;
  if (!message || typeof message !== 'object') return null;
  if (typeof message.content !== 'string') return null;
  const content = message.content.trim();
  return content.length > 0 ? content : null;
}

/**
 * 解析 JSON，失败返回 null。
 * @param {string} text
 * @returns {unknown}
 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 创建智谱客户端。
 *
 * @param {{
 *   fetchImpl?: Function,
 *   getApiKey?: () => string,
 *   model?: string | (() => string),
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   logger?: {warn?: Function}
 * }} [deps]
 */
function createZhipuClient(deps) {
  const options = deps || {};
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : null;
  const getApiKey = typeof options.getApiKey === 'function' ? options.getApiKey : () => '';
  // 定时器也走注入：单元测试用假定时器毫秒级触发超时，生产环境用全局实现
  const timers = options.timers && typeof options.timers.setTimeout === 'function'
    ? options.timers
    : { setTimeout, clearTimeout };
  // 重试退避的等待实现单独注入：测试传空实现即可跳过真实等待；
  // 注意**故意不用**上面的 timers——假定时器只存回调不自动触发，会让退避永远挂起
  const sleepFn = typeof options.sleepFn === 'function'
    ? options.sleepFn
    : function (ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms);
        });
      };
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const maxRetries = Number.isFinite(options.maxRetries) && options.maxRetries >= 0
    ? Math.floor(options.maxRetries)
    : MAX_RETRIES;

  /**
   * 当前使用的模型名。
   *
   * `options.model` 既可以是字符串，也可以是 `() => string` 的取值函数：
   * 主进程传的是函数，这样用户在设置里改完模型名之后**无需重建客户端**，
   * 下一次请求就会用新模型（避免"改了设置还在用旧模型"这种隐蔽 bug）。
   * @returns {string}
   */
  function currentModel() {
    let raw = '';
    if (typeof options.model === 'function') {
      try {
        raw = options.model();
      } catch {
        raw = '';
      }
    } else if (typeof options.model === 'string') {
      raw = options.model;
    }
    if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_MODEL;
    return raw.trim().slice(0, 64);
  }

  /**
   * 发一次请求（不含重试）。永远 resolve，不 reject。
   *
   * 超时范围（缺陷修复 E）：**整个 fetch + body read 共用一个 15 秒定时器**。
   * 旧实现一拿到 response headers 就 `clearTimeout`，如果 `response.text()` 卡住，
   * 请求会永远挂起、既不超时也不重试。现在定时器在 finally 里才清理，
   * body read 被 abort 时同样归类为 `timeout`。
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {string} apiKey
   * @returns {Promise<{ok: true, content: string} | {ok: false, code: string, status: number}>}
   */
  async function requestOnce(messages, apiKey) {
    if (!fetchImpl) {
      return { ok: false, code: 'internal-error', status: 0 };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    /*
     * 超时定时器**不能 unref**：如果把它 unref 掉，在"请求挂起、事件循环里只有这一个
     * 定时器"的场景下，Node 会认为无事可做直接退出（beforeExit），超时回调永远不会跑，
     * 重试与错误归类也就跟着失效。请求结束后本来就会 clearTimeout，不会长期滞留。
     */
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
      let response = null;
      try {
        response = await fetchImpl(CHAT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: currentModel(),
            messages,
            stream: false
          }),
          signal: controller ? controller.signal : undefined
        });
      } catch (error) {
        if (timedOut || (error && error.name === 'AbortError')) {
          return { ok: false, code: 'timeout', status: 0 };
        }
        // 网络层错误：只记类别，绝不打印 error.message（可能含请求细节）
        return { ok: false, code: 'network', status: 0 };
      }

      if (timedOut) return { ok: false, code: 'timeout', status: 0 };

      const status = response && Number.isFinite(response.status) ? response.status : 0;

      // 正文读取也在超时保护内：卡住时会被 abort，归类 timeout
      let text = '';
      try {
        text = await readResponseText(response);
      } catch (error) {
        if (timedOut || (error && error.name === 'AbortError')) {
          return { ok: false, code: 'timeout', status: 0 };
        }
        return { ok: false, code: 'network', status };
      }

      if (timedOut) return { ok: false, code: 'timeout', status: 0 };

      if (status < 200 || status >= 300) {
        // 正文已在上面读完并丢弃（避免连接悬挂），绝不解析、绝不回显
        return { ok: false, code: codeForStatus(status), status };
      }

      const payload = safeJsonParse(text);
      const content = extractContent(payload);
      if (!content) return { ok: false, code: 'bad-response', status };
      // 需求：单次回复最多 60 个 Unicode 字符（模型不服从时由客户端兜底截断）
      return { ok: true, content: limitReply(content) };
    } finally {
      if (timer) timers.clearTimeout(timer);
    }
  }

  /**
   * 发起一次对话。这是对外的唯一入口（后续语音链路会直接调用它）。
   *
   * @param {unknown} text 本轮用户文本
   * @param {{history?: unknown, onRetry?: (attempt: number, code: string) => void}} [options]
   *        只认 history 与 onRetry（onRetry 只用于内部日志）；其余字段一律忽略，
   *        尤其**不接受** url / endpoint / model / apiKey 之类的覆盖参数。
   * @returns {Promise<{ok: true, content: string, model: string, attempts: number} | {ok: false, code: string, message: string, status: number, attempts: number}>}
   */
  async function chat(text, options) {
    const apiKey = getApiKey();
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return fail('no-api-key', 0, 0);
    }

    const built = buildMessages(text, options ? options.history : undefined);
    if (!built.ok) return fail(built.code, 0, 0);

    let attempt = 0;
    let last = { code: 'internal-error', status: 0 };

    for (;;) {
      attempt += 1;
      const result = await requestOnce(built.messages, apiKey.trim());
      if (result.ok) {
        return { ok: true, content: result.content, model: currentModel(), attempts: attempt };
      }
      last = { code: result.code, status: result.status };
      const canRetry = attempt <= maxRetries && isRetryable(result.code, result.status);
      if (!canRetry) break;
      // 只记错误码，不记 Key / 正文
      if (options && typeof options.onRetry === 'function') {
        try {
          options.onRetry(attempt + 1, result.code);
        } catch {
          // 回调抛错不影响主流程
        }
      }
      // 退避等待：给限流的服务端喘口气，连续快重试对 429 没有意义
      const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      if (Number.isFinite(backoff) && backoff > 0) {
        await sleepFn(backoff);
      }
    }

    return fail(last.code, last.status, attempt);
  }

  return {
    chat,
    endpoint: CHAT_ENDPOINT,
    defaultModel: DEFAULT_MODEL,
    getModel: currentModel,
    timeoutMs,
    maxRetries
  };
}

module.exports = {
  CHAT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  MAX_RETRIES,
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_ITEMS,
  MAX_MESSAGES,
  MAX_TOTAL_CHARS,
  MAX_REPLY_CHARS,
  SYSTEM_PROMPT,
  RETRYABLE_STATUS,
  ERROR_MESSAGES,
  createZhipuClient,
  buildMessages,
  limitReply,
  extractContent,
  codeForStatus,
  isRetryable,
  safeJsonParse
};
