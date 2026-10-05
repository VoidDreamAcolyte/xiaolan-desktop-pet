'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：智谱 GLM-ASR 语音转文本客户端（阶段 4）
 * ============================================================================
 *
 * 官方接口（固定事实，不接受任何外部覆盖）：
 *   - POST https://open.bigmodel.cn/api/paas/v4/audio/transcriptions
 *   - multipart/form-data：model=glm-asr-2512、stream=false、file=音频文件
 *   - 成功 JSON 里有 `text` 字段
 *   - **只支持 wav / mp3**；单段最长 30 秒；单文件 ≤25MB
 *   - 用 Node 内置 FormData 上传时**不要手动设置 Content-Type**，
 *     必须让 fetch 自己补上带 boundary 的 multipart 头（手写会导致服务端解析失败）
 *
 * 安全约束：
 *   - endpoint 写死在代码里，函数签名里没有 URL 参数；
 *   - API Key 只在这里被拼进 `Authorization`，绝不进返回值 / 日志 / 错误信息；
 *   - 音频只暂存在 app.getPath('temp') 下的子目录，**成功或失败都删除**；
 *   - 超时 10 秒 + 最多一次重试（网络 / 超时 / 408 / 425 / 429 / 5xx）。
 *
 * 降级链（需求）：云端 GLM-ASR 优先 → 失败时本地 faster-whisper（仅 CPU / GPU 空闲）
 *   → 没装 Python 包或模型时优雅返回 unavailable。
 *   **无 Key 时直接走本地 ASR，不向聊天模型发送任何内容。**
 *
 * 依赖注入：fetch / fs / FormData / Blob / 本地 ASR / 临时目录全部可注入，
 * 因此单元测试能完整覆盖 endpoint、model、体积、状态码、超时、重试与"不泄密"，
 * 而**不会发出任何真实请求、也不会写真实文件**。
 */

const nodePath = require('node:path');
const { createHttpRunner, VOICE_TIMEOUT_MS } = require('./net-retry');

/** 固定 endpoint（官方文档；不接受任何外部覆盖） */
const ASR_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
/** 官方要求的模型名 */
const ASR_MODEL = 'glm-asr-2512';
/** 单段音频最长 30 秒（官方限制） */
const ASR_MAX_DURATION_MS = 30000;
/** 单文件上限 25MB（官方限制） */
const ASR_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** 只支持 wav / mp3（官方限制）—— **webm 绝不允许直接上传** */
const ASR_ALLOWED_FORMATS = Object.freeze(['wav', 'mp3']);

/** 临时 WAV 子目录名（位于 app.getPath('temp') 下） */
const TEMP_DIR_NAME = 'blue-fat-fish-voice';

/**
 * 错误码 → 用户提示。
 *
 * 原则：网络 / 超时统一说"网有点卡…"；401 / 无效 Key 明确引导去
 * open.bigmodel.cn；**400 等参数错误绝不提示成 Key 失效**；未知错误用通用提示。
 * 提示里永远不含 API Key、上游响应体或原始 error.message。
 */
const ASR_ERROR_MESSAGES = Object.freeze({
  'no-audio': '这段音频是空的，没听清。',
  'too-large': '这段音频太大了（超过 25MB），没法上传。',
  'too-long': '这段音频太长了（最多 30 秒）。',
  'bad-format': '音频格式不支持，只能上传 wav 或 mp3。',
  'empty-transcript': '没听出内容，再说一遍嘛。',
  'bad-response': '云端返回的内容看不懂，等会儿再试一次吧。',
  'no-api-key': '还没有配置 API Key，去 open.bigmodel.cn 领一个再填进设置里吧。',
  'auth-failed': 'API Key 无效或已过期，去 open.bigmodel.cn 重新申请一个吧。',
  forbidden: '这个 Key 没有调用语音识别的权限。',
  'rate-limited': '请求太频繁了，等一会儿再试。',
  'server-error': '智谱服务端有点问题，稍后再试。',
  // 400 等参数类错误：只提示参数问题，**绝不误导成 Key 失效**
  'http-error': '请求参数不对，这次没能发出去，检查一下再试。',
  timeout: '网有点卡…识别超时了，再试一次吧。',
  network: '网有点卡…没能连上云端。',
  unavailable: '本地语音识别暂时用不了。',
  'internal-error': '内部出错了，稍后再试。'
});

/**
 * 云端失败后**值得再试本地**的错误码（只含瞬时 / 基础设施失败）。
 *
 * 注意这里**故意不含通用的 `http-error`**：net-retry 会把 400 / 404 这类
 * 非重试客户端错误统一归到 `http-error`，参数错误降级到本地识别也没用，
 * 只会白白浪费一次本地模型加载。空响应（empty-transcript）、格式 / 体积 /
 * 时长预检失败同样不在此列。
 */
const LOCAL_FALLBACK_CODES = Object.freeze(['network', 'timeout', 'rate-limited', 'server-error', 'auth-failed', 'forbidden', 'invalid-key', 'no-api-key']);

/**
 * 创建一个 ASR 客户端。
 *
 * @param {{
 *   fetchImpl?: Function,
 *   fs?: object,
 *   os?: object,
 *   FormDataImpl?: Function,
 *   BlobImpl?: Function,
 *   getApiKey?: () => string,
 *   localTranscriber?: {transcribe: (bytes: Uint8Array, meta: object) => Promise<object>, isAvailable?: Function},
 *   tempDir?: string,
 *   timers?: object,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   logger?: {warn?: Function}
 * }} [deps]
 */
function createAsrClient(deps) {
  const options = deps || {};
  const fs = options.fs || require('node:fs');
  const os = options.os || require('node:os');
  const getApiKey = typeof options.getApiKey === 'function' ? options.getApiKey : () => '';
  const localTranscriber = options.localTranscriber && typeof options.localTranscriber === 'object'
    ? options.localTranscriber
    : null;
  const FormDataImpl = typeof options.FormDataImpl === 'function'
    ? options.FormDataImpl
    : typeof FormData === 'function' ? FormData : null;
  const BlobImpl = typeof options.BlobImpl === 'function'
    ? options.BlobImpl
    : typeof Blob === 'function' ? Blob : null;

  const runner = createHttpRunner({
    fetchImpl: options.fetchImpl,
    timers: options.timers,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : VOICE_TIMEOUT_MS,
    maxRetries: Number.isFinite(options.maxRetries) ? options.maxRetries : 1,
    logger: options.logger
  });

  /** 临时目录：app.getPath('temp')/blue-fat-fish-voice（测试可注入） */
  const tempDir = typeof options.tempDir === 'string' && options.tempDir.length > 0
    ? options.tempDir
    : nodePath.join(os.tmpdir(), TEMP_DIR_NAME);

  /** 单调递增的临时文件名序号（避免同一毫秒内覆盖） */
  let tempSeq = 0;

  /** 当前是否有可用的 Key —— **只返回布尔，绝不返回 Key 本身** */
  function hasApiKey() {
    try {
      const key = getApiKey();
      return typeof key === 'string' && key.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 归一化输入音频：只接受 Uint8Array / ArrayBuffer / Buffer，其它一律视为空。
   * @param {unknown} bytes
   * @returns {Uint8Array | null}
   */
  function toBytes(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(bytes)) return new Uint8Array(bytes);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer && typeof bytes.byteLength === 'number') {
      return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    }
    return null;
  }

  /**
   * 把音频字节写进临时目录，返回文件路径（供本地 whisper 子进程读取）。
   * 写失败返回 null（调用方据此直接报错，绝不静默继续）。
   * @param {Uint8Array} bytes
   * @returns {string | null}
   */
  function writeTempWav(bytes) {
    try {
      if (fs && typeof fs.mkdirSync === 'function') {
        fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      }
      tempSeq += 1;
      const file = nodePath.join(tempDir, `asr-${Date.now()}-${tempSeq}.wav`);
      fs.writeFileSync(file, Buffer.from(bytes), { mode: 0o600 });
      return file;
    } catch {
      // 只记类别，不记内容（内容是用户语音）
      if (options.logger && typeof options.logger.warn === 'function') {
        options.logger.warn('[ASR] 写入临时音频失败。');
      }
      return null;
    }
  }

  /**
   * 删除临时音频。**成功或失败都必须调用**（需求：完成 / 失败均删除）。
   * @param {string | null} file
   */
  function removeTemp(file) {
    if (typeof file !== 'string' || file.length === 0) return;
    try {
      if (fs && typeof fs.unlinkSync === 'function') fs.unlinkSync(file);
    } catch {
      // 删除失败不影响主流程（临时目录由系统清理）
    }
  }

  /**
   * 构造 multipart 请求体。
   *
   * 关键：**只设置 Authorization，绝不设置 Content-Type** ——
   * fetch 会自动生成 `multipart/form-data; boundary=...`，
   * 手动写死 Content-Type 会让 boundary 丢失、服务端解析失败。
   *
   * @param {Uint8Array} bytes
   * @returns {unknown}
   */
  function buildFormBody(bytes) {
    const form = new FormDataImpl();
    form.append('model', ASR_MODEL);
    form.append('stream', 'false');
    const blob = new BlobImpl([bytes], { type: 'audio/wav' });
    // 用 File 语义（第三参数给文件名），兼容 Node 内置 Blob
    form.append('file', blob, 'speech.wav');
    return form;
  }

  /**
   * 调一次云端 GLM-ASR。
   * @param {Uint8Array} bytes
   * @returns {Promise<object>}
   */
  async function transcribeCloud(bytes) {
    const apiKey = hasApiKey() ? getApiKey().trim() : '';
    if (!apiKey) return { ok: false, code: 'no-api-key', attempts: 0 };

    if (!FormDataImpl || !BlobImpl) {
      return { ok: false, code: 'internal-error', attempts: 0 };
    }

    const response = await runner.run({
      url: ASR_ENDPOINT,
      method: 'POST',
      // 注意：这里没有 Content-Type —— 交给 fetch 自动补 boundary
      headers: { Accept: 'application/json' },
      apiKey,
      bodyFactory: () => buildFormBody(bytes),
      readBody: 'json'
    });

    if (!response.ok) {
      return { ok: false, code: response.code, status: response.status, attempts: response.attempts };
    }

    const text = response.data && typeof response.data.text === 'string' ? response.data.text.trim() : '';
    if (text.length === 0) {
      return { ok: false, code: 'empty-transcript', status: response.status, attempts: response.attempts };
    }
    return { ok: true, text, provider: 'cloud', model: ASR_MODEL, attempts: response.attempts };
  }

  /**
   * 调一次本地 faster-whisper（主进程只负责把 WAV 落到临时文件再交给子进程）。
   * 没装 Python 包 / 模型 / 显存不够时，本地实现会返回 `{ok:false, code:'unavailable'}`。
   * @param {Uint8Array} bytes
   * @param {object} meta
   * @returns {Promise<object>}
   */
  async function transcribeLocal(bytes, meta) {
    if (!localTranscriber || typeof localTranscriber.transcribe !== 'function') {
      return { ok: false, code: 'unavailable', attempts: 0 };
    }
    const file = writeTempWav(bytes);
    if (!file) return { ok: false, code: 'internal-error', attempts: 0 };
    try {
      const result = await localTranscriber.transcribe(file, meta || {});
      if (result && result.ok === true && typeof result.text === 'string' && result.text.trim().length > 0) {
        return {
          ok: true,
          text: result.text.trim(),
          provider: 'local',
          model: result.model || 'faster-whisper',
          attempts: 1
        };
      }
      return { ok: false, code: (result && result.code) || 'unavailable', attempts: 1 };
    } catch {
      // 本地识别实现抛异常时也要优雅返回短错误码：
      // 绝不把原始异常（可能含路径 / 内部细节）或 Key 抛给上层
      return { ok: false, code: 'internal-error', attempts: 1 };
    } finally {
      // 成功 / 失败都删除临时音频
      removeTemp(file);
    }
  }

  /**
   * 对外唯一入口：识别一段 WAV。
   *
   * 决策顺序（与需求一致）：
   *   1. 先做体积 / 时长 / 格式预检（超限直接拒绝，绝不发出去）；
   *   2. **有 Key → 云端 GLM-ASR 优先**；云端可重试错误失败后 → 本地 faster-whisper；
   *   3. **无 Key → 不联网**，直接尝试本地 ASR（返回 `chat:false` 让上层不要发对话）；
   *   4. 本地不可用 → `{ok:false, code:'unavailable', chat:false}`，上层只气泡提示。
   *
   * 返回值里的 `chat` 表示"识别结果能不能送给聊天模型"（无 Key 时恒为 false）。
   *
   * @param {unknown} audioBytes
   * @param {{durationMs?: number, format?: string, allowLocal?: boolean}} [meta]
   * @returns {Promise<object>}
   */
  async function transcribe(audioBytes, meta) {
    const info = meta && typeof meta === 'object' ? meta : {};
    const bytes = toBytes(audioBytes);
    if (!bytes || bytes.byteLength === 0) {
      return { ok: false, code: 'no-audio', message: ASR_ERROR_MESSAGES['no-audio'], chat: hasApiKey() };
    }
    if (bytes.byteLength > ASR_MAX_FILE_BYTES) {
      return { ok: false, code: 'too-large', message: ASR_ERROR_MESSAGES['too-large'], chat: hasApiKey() };
    }
    const durationMs = Number(info.durationMs);
    // 严格按"最多 30 秒"：等于 30 秒放行，301 毫秒起直接拒绝
    if (Number.isFinite(durationMs) && durationMs > ASR_MAX_DURATION_MS) {
      return { ok: false, code: 'too-long', message: ASR_ERROR_MESSAGES['too-long'], chat: hasApiKey() };
    }
    const format = typeof info.format === 'string' ? info.format.toLowerCase() : 'wav';
    if (!ASR_ALLOWED_FORMATS.includes(format)) {
      // webm 之类的格式绝不直接上传（官方只支持 wav / mp3）
      return { ok: false, code: 'bad-format', message: ASR_ERROR_MESSAGES['bad-format'], chat: hasApiKey() };
    }

    const keyPresent = hasApiKey();
    const allowLocal = info.allowLocal !== false;

    if (keyPresent) {
      const cloud = await transcribeCloud(bytes);
      if (cloud.ok) return { ok: true, ...cloud, chat: true };
      // 只有"值得再试本地"的错误才降级（400 参数错误降级也没用）
      if (allowLocal && LOCAL_FALLBACK_CODES.includes(cloud.code)) {
        const local = await transcribeLocal(bytes, info);
        if (local.ok) return { ok: true, ...local, chat: true, cloudCode: cloud.code };
        return {
          ok: false,
          code: cloud.code,
          message: local.code === 'unavailable'
            ? (ASR_ERROR_MESSAGES[cloud.code] || ASR_ERROR_MESSAGES['internal-error'])
            : ASR_ERROR_MESSAGES['internal-error'],
          attempts: cloud.attempts,
          localCode: local.code,
          chat: true
        };
      }
      return { ok: false, code: cloud.code, message: ASR_ERROR_MESSAGES[cloud.code] || ASR_ERROR_MESSAGES['internal-error'], status: cloud.status, attempts: cloud.attempts, chat: true };
    }

    // 没有 Key：**不向云端发任何东西**，直接本地识别
    if (!allowLocal) {
      return { ok: false, code: 'unavailable', message: ASR_ERROR_MESSAGES.unavailable, chat: false };
    }
    const local = await transcribeLocal(bytes, info);
    if (local.ok) return { ok: true, ...local, chat: false };
    return {
      ok: false,
      code: local.code === 'unavailable' ? 'unavailable' : 'internal-error',
      message: ASR_ERROR_MESSAGES[local.code] || ASR_ERROR_MESSAGES.unavailable,
      localCode: local.code,
      chat: false
    };
  }

  return {
    transcribe,
    hasApiKey,
    endpoint: ASR_ENDPOINT,
    model: ASR_MODEL,
    getTempDir: () => tempDir,
    maxRetries: runner.maxRetries,
    timeoutMs: runner.timeoutMs
  };
}

module.exports = {
  ASR_ENDPOINT,
  ASR_MODEL,
  ASR_MAX_DURATION_MS,
  ASR_MAX_FILE_BYTES,
  ASR_ALLOWED_FORMATS,
  TEMP_DIR_NAME,
  ASR_ERROR_MESSAGES,
  LOCAL_FALLBACK_CODES,
  createAsrClient
};
