'use strict';

/**
 * ============================================================================
 * preload（设置窗口）—— 设置页与主进程之间唯一的、最小化的桥梁
 * ============================================================================
 *
 * 与桌宠窗口的 main/preload.js 是**两个独立文件、两套独立通道**：
 *   - 这里只暴露设置相关的 3 个方法，没有任何 pet:* 通道；
 *   - 桌宠窗口的 preload 里也没有任何 settings:* 通道；
 *   - 因此即使某一侧的页面被注入脚本，也拿不到另一侧的能力。
 *
 * 安全约定（务必保持）：
 *   1. 只往渲染层暴露 `window.blueFatFishSettings` 一个对象，并 `Object.freeze`；
 *   2. 绝不暴露 ipcRenderer 本体，也绝不暴露 require / process / fs；
 *   3. 通道名与 main/ipc-channels.js 的 SETTINGS_CHANNELS 完全一致
 *      （一致性由 tests/smoke.test.js 逐项比对，漂移即失败）；
 *   4. 参数在这里先做一次"窄化 + 严格校验"，主进程里还会再校验一次
 *      —— 纵深防御，任一层被绕过都不会让脏数据到达设置存储或云 API；
 *   5. **非空但不合法的草稿 Key / 模型名一律在本地直接报错**（缺陷修复 C）：
 *      绝不"静默略过再调用主进程"，否则主进程会回落到已保存的 Key / 环境变量，
 *      用户看到"保存成功 / 测试成功"，实际用的却完全是另一个 Key。
 *   6. **精确匹配哨兵才当作"清除 Key"**（缺陷修复 B）：哨兵里含 NUL，
 *      必须先判定哨兵、再做通用控制字符过滤，否则 NUL 会被丢弃、清除命令丢失；
 *      其它任何含控制字符的字符串（哪怕只多一个字符）仍然被拒绝。
 *   7. **不接受任何 URL / endpoint 覆盖**：请求地址写死在主进程，渲染层连
 *      "想换地址"的入口都没有；阶段 3 的设置页也**没有任何文字聊天通道**。
 *
 * 关于 sandbox（与桌宠窗口同样重要）：
 *   设置窗口也是 `sandbox: true`，preload 运行在受限沙箱里，`require` 只能加载
 *   electron，无法加载本地相对模块。所以本文件顶层只 `require('electron')`，
 *   通道常量在文件内部冻结定义一份副本。绝不要为了"能 require 本地文件"而关沙箱。
 */

const { contextBridge, ipcRenderer } = require('electron');

/* -------------------------------------------------------------------------- */
/* 通道常量（沙箱内无法 require 本地模块，故在此冻结定义）                       */
/* 必须与 main/ipc-channels.js 的 SETTINGS_CHANNELS / SETTINGS_EVENTS 逐项一致   */
/* -------------------------------------------------------------------------- */

const SETTINGS_CHANNELS = Object.freeze({
  GET_SETTINGS: 'settings:get',
  SAVE_SETTINGS: 'settings:save',
  TEST_CONNECTION: 'settings:test-connection',
  // 阶段 4：只改语音设置（不经过 Key，也不接受 apiKey 字段）
  SET_VOICE_SETTINGS: 'settings:set-voice'
});

const SETTINGS_EVENTS = Object.freeze({
  CHANGED: 'settings:changed'
});

/* -------------------------------------------------------------------------- */
/* 参数窄化（第一道防线）                                                       */
/* -------------------------------------------------------------------------- */

/** 与主进程一致的边界（这里只做粗筛，主进程才是权威校验） */
const API_KEY_MIN_LENGTH = 8;
const API_KEY_MAX_LENGTH = 512;
const MODEL_MAX_LENGTH = 64;

/** 阶段 4：语音设置边界（与 main/settings-store.js 的常量逐项一致，烟测比对） */
const VAD_SILENCE_MIN = 400;
const VAD_SILENCE_MAX = 1500;
const TTS_VOICES = Object.freeze(['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']);
/** 桌宠大小缩放范围（与 main/settings-store.js 的 PET_SCALE_RANGE 一致） */
const PET_SCALE_MIN = 0.5;
const PET_SCALE_MAX = 2;

/** 模型名允许的字符（与 settings-store 的 MODEL_PATTERN 一致） */
const MODEL_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** 控制字符检查：Key / 模型名里都不允许出现换行、制表、NUL */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * 显式清除 Key 的哨兵值，与 main/settings-store.js 的 CLEAR_KEY_SENTINEL 完全一致。
 * 沙箱下无法 require 本地模块，所以这里冻结一份副本（一致性由烟测单独断言）。
 */
const CLEAR_KEY_SENTINEL = '\u0000CLEAR\u0000';

/** 本地校验失败时的简短中文提示（绝不回显用户输入的内容） */
const LOCAL_ERROR_MESSAGES = Object.freeze({
  'invalid-api-key': 'API Key 格式不对：长度需在 8~512 之间，且不能含换行或控制字符。',
  'invalid-model': '模型名不合法：只允许字母、数字、点、下划线、冒号和连字符，最长 64 个字符。'
});

/** 语音设置本地校验失败的提示（同样不回显输入） */
const LOCAL_VOICE_ERROR_MESSAGES = Object.freeze({
  'invalid-mic-enabled': '麦克风开关只能是开或关。',
  'invalid-vad-sensitivity': 'VAD 灵敏度需要在 0~1 之间。',
  'invalid-vad-silence': `静音判定需要在 ${VAD_SILENCE_MIN}~${VAD_SILENCE_MAX} 毫秒之间。`,
  'invalid-tts-voice': '这个音色不在 GLM-TTS 的系统音色列表里。',
  'invalid-volume': '音量需要在 0~1 之间。',
  'invalid-subtitle-mode': '字幕模式只能是开或关。',
  'invalid-pet-scale': `桌宠大小需要在 ${PET_SCALE_MIN * 100}%~${PET_SCALE_MAX * 100}% 之间。`
});

/**
 * 构造一个"语音设置本地校验失败"的返回值（不调用主进程）。
 * @param {string} code
 * @returns {{ok: false, settings: null, error: string, message: string}}
 */
function localVoiceError(code) {
  return {
    ok: false,
    settings: null,
    error: code,
    message: LOCAL_VOICE_ERROR_MESSAGES[code] || '语音设置不合法。'
  };
}

/**
 * 判断字符串里是否含控制字符。
 * @param {string} text
 * @returns {boolean}
 */
function hasControlChar(text) {
  return CONTROL_CHAR_PATTERN.test(text);
}

/**
 * 把"草稿 Key"归类。语义（这是修复静默 fallback 的关键）：
 *   - 'absent' ：字段缺失 / 空字符串 / 纯空白 → "不改动 Key"（保持现状）；
 *   - 'clear'  ：**精确等于**哨兵 → 清除命令（只有 saveSettings 会透传）；
 *   - 'invalid'：非空但不合法 → 本地立即报错，绝不透传、绝不让主进程回落到旧 Key；
 *   - 'valid'  ：合法 Key。
 * @param {unknown} value
 * @returns {{kind: 'absent'|'clear'|'invalid'|'valid', value?: string}}
 */
function classifyApiKey(value) {
  if (typeof value !== 'string') return { kind: 'absent' };
  // 必须先判哨兵：哨兵里含 NUL，先做通用控制字符过滤会把 NUL 丢掉，清除命令就丢了
  if (value === CLEAR_KEY_SENTINEL) return { kind: 'clear' };
  if (value.trim().length === 0) return { kind: 'absent' };
  // 控制字符在 trim 之前查：粘贴时带进的换行 / 制表符不能被 trim 掩盖
  if (hasControlChar(value)) return { kind: 'invalid' };
  const trimmed = value.trim();
  if (trimmed.length < API_KEY_MIN_LENGTH || trimmed.length > API_KEY_MAX_LENGTH) return { kind: 'invalid' };
  return { kind: 'valid', value: trimmed };
}

/**
 * 把"模型名草稿"归类：
 *   - 'absent' ：字段缺失 / 空字符串 → "不改动模型"；
 *   - 'invalid'：非空但不合法 → 本地报 invalid-model；
 *   - 'valid'  ：合法模型名。
 * @param {unknown} value
 * @returns {{kind: 'absent'|'invalid'|'valid', value?: string}}
 */
function classifyModel(value) {
  if (typeof value !== 'string') return { kind: 'invalid' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  if (trimmed.length > MODEL_MAX_LENGTH) return { kind: 'invalid' };
  if (!MODEL_PATTERN.test(trimmed)) return { kind: 'invalid' };
  return { kind: 'valid', value: trimmed };
}

/**
 * 构造一个本地校验失败的保存结果（不回显输入内容）。
 * @param {'invalid-api-key'|'invalid-model'} code
 * @returns {{ok: false, settings: null, error: string, message: string}}
 */
function localSaveError(code) {
  return {
    ok: false,
    settings: null,
    error: code,
    message: LOCAL_ERROR_MESSAGES[code]
  };
}

/* -------------------------------------------------------------------------- */
/* 暴露给设置页的最小 API                                                       */
/* -------------------------------------------------------------------------- */

const api = {
  /** 标记：便于设置页做特性探测 / 调试（4 = 已接入连续语音对话） */
  phase: 4,

  /**
   * 读取非敏感设置。
   * @returns {Promise<object>} 只含 model / hasApiKey / keySource / persistence 等状态，绝不含 Key
   */
  getSettings() {
    return ipcRenderer.invoke(SETTINGS_CHANNELS.GET_SETTINGS);
  },

  /**
   * 保存设置。
   * @param {{apiKey?: string, model?: string}} [patch]
   *   - apiKey 省略或空字符串 = 不改动已有 Key；
   *   - apiKey **精确等于哨兵** = 清除本机保存的 Key（磁盘密文一并抹掉）；
   *   - apiKey 非空但不合法 = 本地直接返回 invalid-api-key，**不调用主进程**，
   *     因此绝不会出现"保存成功、实际还在用旧 Key"的假象；
   *   - model 省略 = 不改动；非空但不合法 = 本地返回 invalid-model。
   *   其它字段（url / endpoint / keySource / hasApiKey …）一律丢弃。
   * @returns {Promise<{ok: boolean, settings: object|null, error: string|null, message: string}>}
   */
  saveSettings(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    const payload = {};

    if (Object.prototype.hasOwnProperty.call(source, 'model')) {
      const model = classifyModel(source.model);
      if (model.kind === 'invalid') {
        return Promise.resolve(localSaveError('invalid-model'));
      }
      if (model.kind === 'valid') payload.model = model.value;
    }

    if (Object.prototype.hasOwnProperty.call(source, 'apiKey')) {
      const key = classifyApiKey(source.apiKey);
      if (key.kind === 'invalid') {
        return Promise.resolve(localSaveError('invalid-api-key'));
      }
      if (key.kind === 'clear') {
        // 只有精确匹配哨兵才当作清除命令；主进程 settings-store 再确认一次
        payload.apiKey = CLEAR_KEY_SENTINEL;
      } else if (key.kind === 'valid') {
        payload.apiKey = key.value;
      }
      // 'absent'：空 / 没填 = 不改动，不透传给主进程
    }

    return ipcRenderer.invoke(SETTINGS_CHANNELS.SAVE_SETTINGS, payload);
  },

  /**
   * 显式测试连接：由用户点按钮触发一次**最小对话请求**。
   * 启动、打开桌宠、打开设置页都不会调用它。
   * @param {{apiKey?: string}} [options] 允许测试尚未保存的 Key（可选）
   * @returns {Promise<{ok: boolean, code: string, message: string, model: string, latencyMs: number}>}
   */
  testConnection(options) {
    const payload = {};
    if (options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'apiKey')) {
      const key = classifyApiKey(options.apiKey);
      // 非空但不合法的草稿 Key：本地直接失败，**绝不退回到已保存的 Key / 环境变量**
      // （否则用户测的是另一个 Key，却被告知"连接成功"，属于误测）
      if (key.kind === 'invalid' || key.kind === 'clear') {
        return Promise.resolve({
          ok: false,
          code: 'invalid-api-key',
          message: LOCAL_ERROR_MESSAGES['invalid-api-key'],
          model: '',
          latencyMs: 0
        });
      }
      if (key.kind === 'valid') payload.apiKey = key.value;
    }
    return ipcRenderer.invoke(SETTINGS_CHANNELS.TEST_CONNECTION, payload);
  },

  /**
   * 订阅设置变更（主进程保存成功后广播）。
   * 回调只收到非敏感快照，收不到原始 IPC 事件对象。
   * @param {(settings: object) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onSettingsChanged(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => {
      if (!payload || typeof payload !== 'object') return;
      // 只转发字段白名单，避免主进程侧将来多塞了东西被渲染层拿到
      handler({
        model: typeof payload.model === 'string' ? payload.model : '',
        hasApiKey: payload.hasApiKey === true,
        keySource: typeof payload.keySource === 'string' ? payload.keySource : 'none',
        persistence: typeof payload.persistence === 'string' ? payload.persistence : 'none'
      });
    };
    ipcRenderer.on(SETTINGS_EVENTS.CHANGED, listener);
    return () => ipcRenderer.removeListener(SETTINGS_EVENTS.CHANGED, listener);
  },

  /**
   * 保存**语音设置**（阶段 4）。
   *
   * 与 saveSettings 分开，是为了让"改音量 / 开关麦克风"这条路径**完全不碰 Key**：
   * 这里连 `apiKey` 字段都不会构造，主进程也只接受语音白名单字段。
   * 非法值（超出范围 / 不在音色白名单）在本地直接报错，不调用主进程。
   *
   * @param {{micEnabled?: boolean, vadSensitivity?: number, vadSilenceMs?: number, ttsVoice?: string, volume?: number, subtitleMode?: boolean}} [patch]
   * @returns {Promise<{ok: boolean, settings: object|null, error: string|null, message: string}>}
   */
  setVoiceSettings(patch) {
    const source = patch && typeof patch === 'object' ? patch : {};
    const payload = {};

    if (Object.prototype.hasOwnProperty.call(source, 'micEnabled')) {
      if (typeof source.micEnabled !== 'boolean') return Promise.resolve(localVoiceError('invalid-mic-enabled'));
      payload.micEnabled = source.micEnabled;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'vadSensitivity')) {
      const value = Number(source.vadSensitivity);
      if (!Number.isFinite(value) || value < 0 || value > 1) return Promise.resolve(localVoiceError('invalid-vad-sensitivity'));
      payload.vadSensitivity = Number(value.toFixed(3));
    }
    if (Object.prototype.hasOwnProperty.call(source, 'vadSilenceMs')) {
      const value = Number(source.vadSilenceMs);
      if (!Number.isFinite(value)) return Promise.resolve(localVoiceError('invalid-vad-silence'));
      const rounded = Math.round(value);
      if (rounded < VAD_SILENCE_MIN || rounded > VAD_SILENCE_MAX) return Promise.resolve(localVoiceError('invalid-vad-silence'));
      payload.vadSilenceMs = rounded;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'ttsVoice')) {
      if (typeof source.ttsVoice !== 'string' || !TTS_VOICES.includes(source.ttsVoice)) {
        return Promise.resolve(localVoiceError('invalid-tts-voice'));
      }
      payload.ttsVoice = source.ttsVoice;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'volume')) {
      const value = Number(source.volume);
      if (!Number.isFinite(value) || value < 0 || value > 1) return Promise.resolve(localVoiceError('invalid-volume'));
      payload.volume = Number(value.toFixed(3));
    }
    if (Object.prototype.hasOwnProperty.call(source, 'subtitleMode')) {
      if (typeof source.subtitleMode !== 'boolean') return Promise.resolve(localVoiceError('invalid-subtitle-mode'));
      payload.subtitleMode = source.subtitleMode;
    }
    if (Object.prototype.hasOwnProperty.call(source, 'petScale')) {
      const value = Number(source.petScale);
      if (!Number.isFinite(value) || value < PET_SCALE_MIN || value > PET_SCALE_MAX) {
        return Promise.resolve(localVoiceError('invalid-pet-scale'));
      }
      payload.petScale = Number(value.toFixed(2));
    }

    return ipcRenderer.invoke(SETTINGS_CHANNELS.SET_VOICE_SETTINGS, payload);
  }
};

contextBridge.exposeInMainWorld('blueFatFishSettings', Object.freeze(api));
