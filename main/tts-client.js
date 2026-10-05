'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：智谱 GLM-TTS 语音合成客户端（阶段 4）
 * ============================================================================
 *
 * 官方接口（固定事实）：
 *   - POST https://open.bigmodel.cn/api/paas/v4/audio/speech
 *   - JSON body：{ model: 'glm-tts', input: <文本>, voice: <音色 id>, response_format: 'wav' }
 *   - 响应是 **audio/wav 文件字节**（建议采样率 24kHz）
 *   - 文本最大 **1024 字**；系统音色：
 *     tongtong(默认彤彤) / chuichui / xiaochen / jam / kazi / douji / luodo
 *
 * 三级兜底（需求）：
 *   1. GLM-TTS（云端，10 秒超时 + 最多一次重试）
 *   2. edge-tts（免费；**用 execFile 固定可执行文件 + argv，绝不设置 shell**，
 *      不拼接任何用户文本到命令行 —— 用户文本只通过 stdin 或临时文件传递）
 *   3. Windows SAPI / Chromium speechSynthesis（最后一级在渲染层播放）
 *
 * 产物管理：合成出来的音频写进 `app.getPath('userData')/temp`（可用 tempDir 覆盖），
 *   由调用方（main.js）在播放结束后删除；`cleanupTemp()` 兜底清理。
 *
 * 安全：API Key 只在主进程拼进 Authorization 头，绝不进返回值 / 日志 / 渲染层。
 */

const nodePath = require('node:path');
const { createHttpRunner, VOICE_TIMEOUT_MS } = require('./net-retry');

/** 固定 endpoint（官方文档；不接受任何外部覆盖） */
const TTS_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/audio/speech';
/** 官方模型名 */
const TTS_MODEL = 'glm-tts';
/** 官方要求的音频格式 */
const TTS_RESPONSE_FORMAT = 'wav';
/** 官方建议采样率 24kHz */
const TTS_SAMPLE_RATE = 24000;
/** 文本最大 1024 字（官方限制） */
const TTS_MAX_INPUT_CHARS = 1024;
/** 官方系统音色白名单（默认 tongtong） */
const TTS_VOICES = Object.freeze(['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']);
/** 默认音色：彤彤 */
const TTS_DEFAULT_VOICE = 'tongtong';
/** 产物子目录名（位于 app.getPath('userData') 下） */
const TEMP_DIR_NAME = 'temp';
/** 临时产物保留上限：超过就顺手清掉更老的（避免异常退出后堆积） */
const MAX_TEMP_FILES = 50;
/** edge-tts / SAPI 的一次性最大时长（命令行兜底用） */
const TTS_SUBPROCESS_TIMEOUT_MS = 15000;

const TTS_ERROR_MESSAGES = Object.freeze({
  'no-api-key': '还没有配置 API Key，这次先用本机嗓音。',
  'too-long': '这段话太长了（最多 1024 字）。',
  'empty-text': '没有要说的内容。',
  'auth-failed': 'API Key 无效或已过期，去 open.bigmodel.cn 重新申请一个吧。',
  forbidden: '这个 Key 没有调用语音合成的权限。',
  'rate-limited': '请求太频繁了，等一会儿再试。',
  'server-error': '智谱服务端有点问题，稍后再试。',
  'http-error': '云端返回了异常状态，稍后再试。',
  timeout: '网有点卡…语音合成超时了。',
  network: '网有点卡…没能连上云端。',
  'bad-response': '云端返回的音频看不懂，等会儿再试一次吧。',
  aborted: '请求已取消。',
  'too-large': '合成的音频太大了，没法播放。',
  'subprocess-failed': '本机语音合成失败了。',
  'not-available': '本机语音合成不可用。',
  unavailable: '本机语音合成不可用。',
  'internal-error': '内部出错了，稍后再试。'
});

/** 云端失败后值得继续降级的错误码（参数类错误降级也没意义） */
const FALLBACK_CODES = Object.freeze(['no-api-key', 'network', 'timeout', 'rate-limited', 'server-error', 'http-error', 'auth-failed', 'forbidden', 'bad-response']);

/**
 * 校验文本：类型 / 空白 / 1024 字上限。
 * @param {unknown} text
 * @returns {{ok: true, value: string} | {ok: false, code: string}}
 */
function validateText(text) {
  if (typeof text !== 'string') return { ok: false, code: 'empty-text' };
  const value = text.trim();
  if (value.length === 0) return { ok: false, code: 'empty-text' };
  if (Array.from(value).length > TTS_MAX_INPUT_CHARS) return { ok: false, code: 'too-long' };
  return { ok: true, value };
}

/**
 * 校验 / 归一化音色 id：不在官方白名单里就回落到默认音色。
 * @param {unknown} voice
 * @returns {string}
 */
function normalizeVoice(voice) {
  if (typeof voice === 'string' && TTS_VOICES.includes(voice)) return voice;
  return TTS_DEFAULT_VOICE;
}

/**
 * 创建一个 TTS 客户端。
 *
 * @param {{
 *   fetchImpl?: Function,
 *   fs?: object,
 *   getApiKey?: () => string,
 *   getVoice?: () => string,
 *   tempDir?: string,
 *   runEdgeTts?: (text: string, targetFile: string) => Promise<object>,
 *   runNativeTts?: (text: string, targetFile: string) => Promise<object>,
 *   timers?: object,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   logger?: {warn?: Function}
 * }} [deps]
 */
function createTtsClient(deps) {
  const options = deps || {};
  const fs = options.fs || require('node:fs');
  const getApiKey = typeof options.getApiKey === 'function' ? options.getApiKey : () => '';
  const getVoice = typeof options.getVoice === 'function' ? options.getVoice : () => TTS_DEFAULT_VOICE;
  const runEdgeTts = typeof options.runEdgeTts === 'function' ? options.runEdgeTts : null;
  const runNativeTts = typeof options.runNativeTts === 'function' ? options.runNativeTts : null;

  const runner = createHttpRunner({
    fetchImpl: options.fetchImpl,
    timers: options.timers,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : VOICE_TIMEOUT_MS,
    maxRetries: Number.isFinite(options.maxRetries) ? options.maxRetries : 1,
    logger: options.logger
  });

  const tempDir = typeof options.tempDir === 'string' && options.tempDir.length > 0
    ? options.tempDir
    : nodePath.join(require('node:os').tmpdir(), 'blue-fat-fish-voice');

  let tempSeq = 0;

  function hasApiKey() {
    try {
      const key = getApiKey();
      return typeof key === 'string' && key.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** 生成一个新的产物路径（绝不覆盖上一份） */
  function nextTempFile(tag) {
    tempSeq += 1;
    const safeTag = typeof tag === 'string' && /^[a-z0-9-]+$/.test(tag) ? tag : 'tts';
    return nodePath.join(tempDir, `${safeTag}-${Date.now()}-${tempSeq}.wav`);
  }

  /** 确保目录存在 */
  function ensureTempDir() {
    try {
      if (fs && typeof fs.mkdirSync === 'function') {
        fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 写文件；失败返回 false */
  function writeFile(file, bytes) {
    try {
      fs.writeFileSync(file, Buffer.from(bytes), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 删除一个产物。
   * @param {string} file
   */
  function removeTemp(file) {
    if (typeof file !== 'string' || file.length === 0) return;
    try {
      if (fs && typeof fs.unlinkSync === 'function') fs.unlinkSync(file);
    } catch {
      // 忽略
    }
  }

  /** 兜底清理：把 temp 目录里本应用的产物清掉（异常退出后残留） */
  function cleanupTemp() {
    try {
      if (!fs || typeof fs.readdirSync !== 'function') return 0;
      const names = fs.readdirSync(tempDir);
      let removed = 0;
      for (const name of names) {
        if (!/^(tts|edge|sapi)-[0-9]+-[0-9]+\.wav$/.test(name)) continue;
        removeTemp(nodePath.join(tempDir, name));
        removed += 1;
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /** 产物数量超过上限时清掉最旧的（best-effort） */
  function pruneTemp() {
    try {
      if (!fs || typeof fs.readdirSync !== 'function' || typeof fs.statSync !== 'function') return;
      const entries = fs
        .readdirSync(tempDir)
        .filter((name) => /\.wav$/.test(name))
        .map((name) => {
          const file = nodePath.join(tempDir, name);
          let mtime = 0;
          try {
            mtime = fs.statSync(file).mtimeMs || 0;
          } catch {
            mtime = 0;
          }
          return { file, mtime };
        })
        .sort((a, b) => a.mtime - b.mtime);
      while (entries.length > MAX_TEMP_FILES) {
        const oldest = entries.shift();
        removeTemp(oldest.file);
      }
    } catch {
      // 忽略
    }
  }

  /**
   * 云端 GLM-TTS。
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function synthesizeCloud(text) {
    const key = hasApiKey() ? getApiKey().trim() : '';
    if (!key) return { ok: false, code: 'no-api-key', attempts: 0 };

    const body = {
      model: TTS_MODEL,
      input: text,
      voice: normalizeVoice(getVoice()),
      response_format: TTS_RESPONSE_FORMAT
    };

    const response = await runner.run({
      url: TTS_ENDPOINT,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      apiKey: key,
      bodyFactory: () => JSON.stringify(body),
      readBody: 'arrayBuffer'
    });

    if (!response.ok) {
      return { ok: false, code: response.code, status: response.status, attempts: response.attempts };
    }

    const bytes = response.data instanceof Uint8Array ? response.data : new Uint8Array(0);
    // 空音频 / 明显不是音频（云端返回 JSON 错误体）都算 bad-response
    if (bytes.byteLength === 0) {
      return { ok: false, code: 'bad-response', status: response.status, attempts: response.attempts };
    }
    // WAV 头校验：RIFF....WAVE
    const looksWav =
      bytes.byteLength >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    if (!looksWav) {
      return { ok: false, code: 'bad-response', status: response.status, attempts: response.attempts };
    }

    if (!ensureTempDir()) {
      return { ok: false, code: 'internal-error', attempts: response.attempts };
    }
    const file = nextTempFile('tts');
    if (!writeFile(file, bytes)) {
      return { ok: false, code: 'internal-error', attempts: response.attempts };
    }
    pruneTemp();
    return {
      ok: true,
      provider: 'glm-tts',
      file,
      bytes: bytes.byteLength,
      sampleRate: TTS_SAMPLE_RATE,
      attempts: response.attempts
    };
  }

  /**
   * edge-tts 降级。
   * 由 `runEdgeTts` 注入（主进程那侧用 execFile 固定可执行文件 + argv，**不设置 shell**）。
   * 没注入时直接返回 unavailable。
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function synthesizeEdge(text) {
    if (!runEdgeTts) return { ok: false, code: 'not-available', attempts: 0 };
    if (!ensureTempDir()) return { ok: false, code: 'internal-error', attempts: 0 };
    const file = nextTempFile('edge');
    let result = null;
    try {
      result = await runEdgeTts(text, file);
    } catch {
      result = { ok: false, code: 'subprocess-failed' };
    }
    if (!result || result.ok !== true) {
      removeTemp(file);
      return { ok: false, code: (result && result.code) || 'subprocess-failed', attempts: 1 };
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (!size) {
      removeTemp(file);
      return { ok: false, code: 'subprocess-failed', attempts: 1 };
    }
    return { ok: true, provider: 'edge-tts', file, bytes: size, attempts: 1 };
  }

  /**
   * Windows SAPI 降级（主进程侧，用 execFile 调 PowerShell 脚本）。
   * @param {string} text
   * @returns {Promise<object>}
   */
  async function synthesizeNative(text) {
    if (!runNativeTts) return { ok: false, code: 'not-available', attempts: 0 };
    if (!ensureTempDir()) return { ok: false, code: 'internal-error', attempts: 0 };
    const file = nextTempFile('sapi');
    let result = null;
    try {
      result = await runNativeTts(text, file);
    } catch {
      result = { ok: false, code: 'subprocess-failed' };
    }
    if (!result || result.ok !== true) {
      removeTemp(file);
      return { ok: false, code: (result && result.code) || 'subprocess-failed', attempts: 1 };
    }
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (!size) {
      removeTemp(file);
      return { ok: false, code: 'subprocess-failed', attempts: 1 };
    }
    return { ok: true, provider: 'sapi', file, bytes: size, attempts: 1 };
  }

  /**
   * 对外唯一入口：按 GLM-TTS → edge-tts → SAPI 的顺序合成。
   *
   * 全部失败时返回 `{ok:false, code, fallback:'speechSynthesis'}`，
   * 由渲染层用 Chromium 内置 speechSynthesis 兜底播报（设置音量 + onstart/onend/onerror）。
   *
   * @param {unknown} rawText
   * @param {{allowFallback?: boolean}} [meta]
   * @returns {Promise<object>}
   */
  async function synthesize(rawText, meta) {
    const info = meta && typeof meta === 'object' ? meta : {};
    const checked = validateText(rawText);
    if (!checked.ok) {
      return { ok: false, code: checked.code, message: TTS_ERROR_MESSAGES[checked.code], fallback: 'speechSynthesis' };
    }
    const text = checked.value;
    const allowFallback = info.allowFallback !== false;

    const cloud = await synthesizeCloud(text);
    if (cloud.ok) return { ok: true, text, ...cloud };

    if (!allowFallback) {
      return { ok: false, code: cloud.code, message: TTS_ERROR_MESSAGES[cloud.code] || TTS_ERROR_MESSAGES['internal-error'], fallback: 'speechSynthesis' };
    }

    // 云端失败 → edge-tts（免费）
    if (FALLBACK_CODES.includes(cloud.code) || cloud.code === 'internal-error') {
      const edge = await synthesizeEdge(text);
      if (edge.ok) return { ok: true, text, ...edge, cloudCode: cloud.code };

      const native = await synthesizeNative(text);
      if (native.ok) return { ok: true, text, ...native, cloudCode: cloud.code, edgeCode: edge.code };
    }

    // 三级都失败：交给渲染层的 speechSynthesis 兜底
    return {
      ok: false,
      code: cloud.code,
      message: TTS_ERROR_MESSAGES[cloud.code] || TTS_ERROR_MESSAGES['internal-error'],
      attempts: cloud.attempts,
      fallback: 'speechSynthesis'
    };
  }

  return {
    synthesize,
    hasApiKey,
    cleanupTemp,
    removeTemp,
    endpoint: TTS_ENDPOINT,
    model: TTS_MODEL,
    getTempDir: () => tempDir,
    timeoutMs: runner.timeoutMs,
    maxRetries: runner.maxRetries
  };
}

module.exports = {
  TTS_ENDPOINT,
  TTS_MODEL,
  TTS_RESPONSE_FORMAT,
  TTS_SAMPLE_RATE,
  TTS_MAX_INPUT_CHARS,
  TTS_VOICES,
  TTS_DEFAULT_VOICE,
  TEMP_DIR_NAME,
  TTS_SUBPROCESS_TIMEOUT_MS,
  TTS_ERROR_MESSAGES,
  FALLBACK_CODES,
  validateText,
  normalizeVoice,
  createTtsClient
};
