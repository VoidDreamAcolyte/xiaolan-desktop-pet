'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 本地设置存储（阶段 3：安全设置 + 智谱云端对话 API 基础）
 * ============================================================================
 *
 * 这个模块只做一件事：把**非敏感的设置**和**加密后的 API Key**落到
 * app.getPath('userData') 下的配置文件里，并保证：
 *
 *   1. **绝不明文落盘**：Key 只以 Electron `safeStorage` 加密后的 base64 密文
 *      （字段 `keyEncrypted`）写入磁盘。safeStorage 不可用时**宁可只在本次会话内
 *      临时保存**（并把 `persistence: 'session-only'` 报给界面），也绝不退回明文。
 *   2. **绝不把 Key 交回渲染层**：对外只提供 `getPublicSettings()`，
 *      里面只有 `hasApiKey` / `keySource` 这类状态位，没有 Key 本身，也没有任何
 *      可以还原 Key 的派生值（连前缀都不给）。
 *   3. **绝不把 Key 写进日志 / 异常信息**：本文件所有 `console.warn` 只打印文件路径
 *      与错误类别，不打印 Key、密文或文件内容。
 *   4. **环境变量优先**：`ZHIPU_API_KEY` 存在且合法时，它永远压过配置文件里的 Key
 *      （keySource === 'env'），界面上也要能看出"当前用的是环境变量"。
 *   5. **原子写入 + 损坏兜底**：写盘走"临时文件 + rename"，崩在中间也不会留下半个
 *      JSON；读到损坏 JSON / 类型不对 / 超长文件时整体回落到默认值，绝不抛异常。
 *
 * 为什么单独成模块：它所需的 Electron 能力（safeStorage）与文件系统全部通过
 * **依赖注入**传进来，因此 `tests/settings-store.test.js` 可以用假 safeStorage +
 * 假 fs 在裸 node 下把加解密、环境变量优先、损坏 JSON、加密不可用等路径全部跑一遍。
 */

const nodePath = require('node:path');
// endpoint 的唯一定义在 zhipu-client 里；这里只引用常量做"只读展示"，不参与请求
const { CHAT_ENDPOINT } = require('./zhipu-client');

/** 配置文件名（位于 app.getPath('userData') 下） */
const CONFIG_FILE_NAME = 'settings.json';

/** 配置文件格式版本 */
const CONFIG_VERSION = 1;

/** 默认对话模型（需求指定的免费档） */
const DEFAULT_MODEL = 'glm-4.7-flash';

/** 读取配置文件的大小上限：超过就当成损坏，避免被塞进超大文件拖死启动 */
const MAX_CONFIG_BYTES = 4096;

/** API Key 长度边界（智谱 Key 形如 `id.secret`，这里只做保守边界检查） */
const API_KEY_MIN_LENGTH = 8;
const API_KEY_MAX_LENGTH = 512;

/** 模型名长度边界 */
const MODEL_MAX_LENGTH = 64;

/** 模型名允许的字符：字母 / 数字 / 点 / 下划线 / 冒号 / 连字符 */
const MODEL_PATTERN = /^[A-Za-z0-9._:-]+$/;

/* -------------------------------------------------------------------------- */
/* 阶段 4：语音相关设置（全部是非敏感项，可以明文落盘）                          */
/* -------------------------------------------------------------------------- */

/** GLM-TTS 官方系统音色白名单（默认 tongtong 彤彤） */
const TTS_VOICES = Object.freeze(['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']);
/** 默认音色 */
const DEFAULT_TTS_VOICE = 'tongtong';

/** 语音设置的默认值 */
const VOICE_DEFAULTS = Object.freeze({
  micEnabled: true,
  vadSensitivity: 0.5,
  vadSilenceMs: 800,
  ttsVoice: DEFAULT_TTS_VOICE,
  volume: 0.8,
  subtitleMode: false,
  petScale: 1
});

/** 静音判定毫秒的可调范围（需求：可限 400~1500，默认 800） */
const VAD_SILENCE_RANGE = Object.freeze({ min: 400, max: 1500 });
/** 音量范围 */
const VOLUME_RANGE = Object.freeze({ min: 0, max: 1 });
/** 桌宠大小（缩放倍率）：50%~200%，默认 100% */
const PET_SCALE_RANGE = Object.freeze({ min: 0.5, max: 2 });

/** 语音设置的错误码与中文提示 */
const VOICE_ERROR_CODES = Object.freeze({
  INVALID_MIC: 'invalid-mic-enabled',
  INVALID_SENSITIVITY: 'invalid-vad-sensitivity',
  INVALID_SILENCE: 'invalid-vad-silence',
  INVALID_VOICE: 'invalid-tts-voice',
  INVALID_VOLUME: 'invalid-volume',
  INVALID_SUBTITLE: 'invalid-subtitle-mode',
  INVALID_PET_SCALE: 'invalid-pet-scale'
});

/** 校验一个 0~1 的数值（音量 / 灵敏度） */
function validateUnitNumber(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, code };
  if (value < 0 || value > 1) return { ok: false, code };
  return { ok: true, value: Number(value.toFixed(3)) };
}

/**
 * 校验"麦克风启用"。
 * @param {unknown} value
 * @returns {{ok: true, value: boolean} | {ok: false, code: string}}
 */
function validateMicEnabled(value) {
  if (typeof value !== 'boolean') return { ok: false, code: VOICE_ERROR_CODES.INVALID_MIC };
  return { ok: true, value };
}

/**
 * 校验 VAD 灵敏度（0~1，越大越灵敏）。
 * @param {unknown} value
 */
function validateVadSensitivity(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, code: VOICE_ERROR_CODES.INVALID_SENSITIVITY };
  }
  if (value < 0 || value > 1) return { ok: false, code: VOICE_ERROR_CODES.INVALID_SENSITIVITY };
  return { ok: true, value: Number(value.toFixed(3)) };
}

/**
 * 校验静音判定毫秒（400~1500，整数）。
 * @param {unknown} value
 */
function validateVadSilenceMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, code: VOICE_ERROR_CODES.INVALID_SILENCE };
  }
  const rounded = Math.round(value);
  if (rounded < VAD_SILENCE_RANGE.min || rounded > VAD_SILENCE_RANGE.max) {
    return { ok: false, code: VOICE_ERROR_CODES.INVALID_SILENCE };
  }
  return { ok: true, value: rounded };
}

/**
 * 校验 GLM-TTS 音色（必须在官方系统音色白名单里）。
 * @param {unknown} value
 */
function validateTtsVoice(value) {
  if (typeof value !== 'string' || !TTS_VOICES.includes(value)) {
    return { ok: false, code: VOICE_ERROR_CODES.INVALID_VOICE };
  }
  return { ok: true, value };
}

/**
 * 校验音量（0~1）。
 * @param {unknown} value
 */
function validateVolume(value) {
  const checked = validateUnitNumber(value, VOICE_ERROR_CODES.INVALID_VOLUME);
  if (!checked.ok) return checked;
  return { ok: true, value: Math.min(VOLUME_RANGE.max, Math.max(VOLUME_RANGE.min, checked.value)) };
}

/**
 * 校验字幕模式开关。
 * @param {unknown} value
 */
function validateSubtitleMode(value) {
  if (typeof value !== 'boolean') return { ok: false, code: VOICE_ERROR_CODES.INVALID_SUBTITLE };
  return { ok: true, value };
}

/**
 * 校验桌宠大小（缩放倍率，0.5~2，保留两位小数）。
 * @param {unknown} value
 */
function validatePetScale(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, code: VOICE_ERROR_CODES.INVALID_PET_SCALE };
  }
  if (value < PET_SCALE_RANGE.min || value > PET_SCALE_RANGE.max) {
    return { ok: false, code: VOICE_ERROR_CODES.INVALID_PET_SCALE };
  }
  return { ok: true, value: Number(value.toFixed(2)) };
}

/** 语音设置的错误提示（渲染层直接显示，不弹窗） */
const VOICE_ERROR_MESSAGES = Object.freeze({
  'invalid-mic-enabled': '麦克风开关只能是开或关。',
  'invalid-vad-sensitivity': 'VAD 灵敏度需要在 0~1 之间。',
  'invalid-vad-silence': `静音判定需要在 ${VAD_SILENCE_RANGE.min}~${VAD_SILENCE_RANGE.max} 毫秒之间。`,
  'invalid-tts-voice': '这个音色不在 GLM-TTS 的系统音色列表里。',
  'invalid-volume': '音量需要在 0~1 之间。',
  'invalid-subtitle-mode': '字幕模式只能是开或关。',
  'invalid-pet-scale': `桌宠大小需要在 ${PET_SCALE_RANGE.min * 100}%~${PET_SCALE_RANGE.max * 100}% 之间。`
});

/**
 * 把语音设置字段逐项归一化（白名单 + 范围校验，非法项回落默认值）。
 * 注意：**这里只处理非敏感字段**；任何 Key 相关字段都不会进来。
 * @param {unknown} raw
 * @returns {{micEnabled: boolean, vadSensitivity: number, vadSilenceMs: number, ttsVoice: string, volume: number, subtitleMode: boolean}}
 */
function normalizeVoiceSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const mic = validateMicEnabled(input.micEnabled);
  const sensitivity = validateVadSensitivity(input.vadSensitivity);
  const silence = validateVadSilenceMs(input.vadSilenceMs);
  const voice = validateTtsVoice(input.ttsVoice);
  const volume = validateVolume(input.volume);
  const subtitle = validateSubtitleMode(input.subtitleMode);
  const petScale = validatePetScale(input.petScale);
  return {
    micEnabled: mic.ok ? mic.value : VOICE_DEFAULTS.micEnabled,
    vadSensitivity: sensitivity.ok ? sensitivity.value : VOICE_DEFAULTS.vadSensitivity,
    vadSilenceMs: silence.ok ? silence.value : VOICE_DEFAULTS.vadSilenceMs,
    ttsVoice: voice.ok ? voice.value : VOICE_DEFAULTS.ttsVoice,
    volume: volume.ok ? volume.value : VOICE_DEFAULTS.volume,
    subtitleMode: subtitle.ok ? subtitle.value : VOICE_DEFAULTS.subtitleMode,
    petScale: petScale.ok ? petScale.value : VOICE_DEFAULTS.petScale
  };
}

/**
 * 把外部传入的语音设置补丁逐项校验。
 *
 * 与 `normalizeVoiceSettings` 的区别（重要）：
 *   - `normalizeVoiceSettings` 用于"读盘 / 容错"：非法项**静默回落默认值**；
 *   - 本函数用于"用户显式保存"：非法项**返回明确错误码**，绝不静默改写用户意图
 *     （否则用户以为改成了 1500ms，实际仍是 800ms）。
 *
 * @param {unknown} patch
 * @returns {{ok: true, patch: object} | {ok: false, code: string, message: string}}
 */
function validateVoicePatch(patch) {
  const input = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  const rules = [
    ['micEnabled', validateMicEnabled],
    ['vadSensitivity', validateVadSensitivity],
    ['vadSilenceMs', validateVadSilenceMs],
    ['ttsVoice', validateTtsVoice],
    ['volume', validateVolume],
    ['subtitleMode', validateSubtitleMode],
    ['petScale', validatePetScale]
  ];
  for (const [key, validate] of rules) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const checked = validate(input[key]);
    if (!checked.ok) {
      return {
        ok: false,
        code: checked.code,
        message: VOICE_ERROR_MESSAGES[checked.code] || '语音设置不合法。'
      };
    }
    out[key] = checked.value;
  }
  return { ok: true, patch: out };
}

/**
 * 显式清除 Key 的哨兵值。
 * 用哨兵而不是空字符串，是为了区分"用户没填（保持原样）"与"用户要删掉 Key"
 * —— 空字符串在表单里两个含义是重叠的，必须用显式值。
 */
const CLEAR_KEY_SENTINEL = '\u0000CLEAR\u0000';

/** 出错时对外返回的错误码（渲染层只拿到这些短码 + 中文短信息） */
const SETTINGS_ERRORS = Object.freeze({
  INVALID_KEY: 'invalid-api-key',
  INVALID_MODEL: 'invalid-model',
  WRITE_FAILED: 'write-failed'
});

/** 错误码 → 简短中文提示（渲染层直接显示，不弹窗） */
const SETTINGS_ERROR_MESSAGES = Object.freeze({
  'invalid-api-key': 'API Key 格式不对：长度需在 8~512 之间，且不能含换行或控制字符。',
  'invalid-model': '模型名不合法：只允许字母、数字、点、下划线、冒号和连字符，最长 64 个字符。',
  'write-failed': '设置已经在本次会话生效，但写入配置文件失败，重启后会丢失。'
});

/* -------------------------------------------------------------------------- */
/* 纯函数校验（无副作用，测试可直接调用）                                       */
/* -------------------------------------------------------------------------- */

/**
 * 判断字符串里是否含控制字符（含换行 / 制表符 / NUL）。
 * Key 里出现控制字符通常意味着粘贴错了，直接拒绝。
 * @param {string} text
 * @returns {boolean}
 */
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * 校验 API Key。
 *
 * 注意：**必须先查控制字符再 trim**。`trim()` 会把尾部的 `\t` / `\n` 直接吃掉，
 * 先 trim 就再也发现不了"粘贴时带进了换行/制表符"这种情况了。
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, code: string}}
 */
function validateApiKey(value) {
  if (typeof value !== 'string') return { ok: false, code: SETTINGS_ERRORS.INVALID_KEY };
  if (hasControlChar(value)) return { ok: false, code: SETTINGS_ERRORS.INVALID_KEY };
  const trimmed = value.trim();
  if (trimmed.length < API_KEY_MIN_LENGTH || trimmed.length > API_KEY_MAX_LENGTH) {
    return { ok: false, code: SETTINGS_ERRORS.INVALID_KEY };
  }
  return { ok: true, value: trimmed };
}

/**
 * 校验模型名。
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, code: string}}
 */
function validateModel(value) {
  if (typeof value !== 'string') return { ok: false, code: SETTINGS_ERRORS.INVALID_MODEL };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MODEL_MAX_LENGTH) {
    return { ok: false, code: SETTINGS_ERRORS.INVALID_MODEL };
  }
  if (!MODEL_PATTERN.test(trimmed)) return { ok: false, code: SETTINGS_ERRORS.INVALID_MODEL };
  return { ok: true, value: trimmed };
}

/**
 * 默认设置（没有任何配置文件 / 配置损坏时使用）。
 * @returns {{version: number, model: string, keyEncrypted: string, keyHash: string, updatedAt: number, micEnabled: boolean, vadSensitivity: number, vadSilenceMs: number, ttsVoice: string, volume: number, subtitleMode: boolean}}
 */
function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    model: DEFAULT_MODEL,
    keyEncrypted: '',
    keyHash: '',
    updatedAt: 0,
    ...VOICE_DEFAULTS
  };
}

/**
 * 把任意来源的 JSON 归一化成合法配置。任何一处不对都只回落该项，绝不抛异常。
 *
 * 安全要点：**加密失败留下的空密文一律视为"没有 Key"**。
 * 这样即便磁盘上出现半截数据，也不会出现"以为是明文"的分支。
 * @param {unknown} raw
 * @returns {object}
 */
function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const model = validateModel(raw.model);
  if (model.ok) base.model = model.value;

  if (typeof raw.keyEncrypted === 'string' && raw.keyEncrypted.length > 0) {
    // 密文只接受 base64 形态；不合法就当没配 Key
    if (/^[A-Za-z0-9+/=]+$/.test(raw.keyEncrypted)) {
      base.keyEncrypted = raw.keyEncrypted;
      base.keyHash = typeof raw.keyHash === 'string' ? raw.keyHash : '';
    }
  }

  if (Number.isFinite(raw.updatedAt) && raw.updatedAt > 0) {
    base.updatedAt = Math.floor(raw.updatedAt);
  }

  // 阶段 4：语音设置（非敏感）逐项归一化；损坏 / 越界只回落该项
  Object.assign(base, normalizeVoiceSettings(raw));

  return base;
}

/**
 * 解析配置文件文本。损坏 JSON / 空文件 / 非对象一律回落默认值，并标记 corrupted。
 * @param {unknown} text
 * @returns {{config: ReturnType<typeof defaultConfig>, corrupted: boolean}}
 */
function parseConfigText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { config: defaultConfig(), corrupted: false };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    return { config: defaultConfig(), corrupted: true };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: defaultConfig(), corrupted: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: defaultConfig(), corrupted: true };
  }
  return { config: normalizeConfig(parsed), corrupted: false };
}

/**
 * 对 Key 做一次不可逆摘要，仅用于"Key 是否变化过"的内部判断。
 * 说明：这不是安全边界（用的是 Node 内置 hash），绝不出现在对外返回值里。
 * @param {string} key
 * @returns {string}
 */
function hashKey(key) {
  try {
    // 延迟 require：只有真的用到时才加载
    const crypto = require('node:crypto');
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* 解析 safeStorage 适配器                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 把 Electron 的 safeStorage 包装成统一适配器。
 *
 * 关键约定：
 *   - `available` 为 false 时，**调用方绝对不允许写盘**（见 store.save）；
 *   - 加解密抛异常时一律降级为"不可用"，绝不把异常冒泡到主进程事件循环；
 *   - 适配器不缓存任何明文 Key。
 * @param {unknown} safeStorage Electron safeStorage 对象
 * @returns {{available: boolean, source: string, encrypt: (text: string) => string | null, decrypt: (payload: string) => string | null}}
 */
function resolveSafeStorage(safeStorage) {
  const usable =
    safeStorage &&
    typeof safeStorage.isEncryptionAvailable === 'function' &&
    typeof safeStorage.encryptString === 'function' &&
    typeof safeStorage.decryptString === 'function';

  if (!usable) {
    return { available: false, source: 'none', encrypt: () => null, decrypt: () => null };
  }

  let available = false;
  let source = 'none';
  try {
    available = safeStorage.isEncryptionAvailable() === true;
    // getSelectedStorageBackend 只在部分平台存在（Windows 上没有），这里做可选读取
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (typeof backend === 'string' && backend.length > 0) source = backend;
    }
    if (source === 'none' && available) source = 'os-encryption';
  } catch {
    return { available: false, source: 'none', encrypt: () => null, decrypt: () => null };
  }

  return {
    available,
    source,
    encrypt(text) {
      if (!available) return null;
      try {
        const encrypted = safeStorage.encryptString(String(text));
        if (!encrypted || typeof encrypted.toString !== 'function') return null;
        const base64 = encrypted.toString('base64');
        return typeof base64 === 'string' && base64.length > 0 ? base64 : null;
      } catch {
        // 只记类别，不记内容（内容里就是 Key）
        console.warn('[设置] safeStorage 加密失败，本次不会持久化 API Key。');
        return null;
      }
    },
    decrypt(payload) {
      if (!available || typeof payload !== 'string' || payload.length === 0) return null;
      try {
        const buffer = Buffer.from(payload, 'base64');
        const plain = safeStorage.decryptString(buffer);
        return typeof plain === 'string' && plain.length > 0 ? plain : null;
      } catch {
        // 换了 Windows 账户 / 系统密钥环变化时解密会失败：当作没配 Key 处理
        console.warn('[设置] safeStorage 解密失败，已按"未配置 API Key"处理。');
        return null;
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 工厂函数                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 创建一个设置存储。
 *
 * @param {{
 *   safeStorage?: unknown,
 *   fs?: {existsSync: Function, readFileSync: Function, writeFileSync: Function, renameSync: Function, unlinkSync: Function, mkdirSync: Function},
 *   filePath?: string,
 *   dirPath?: string,
 *   env?: Record<string, string | undefined>,
 *   clock?: () => number
 * }} [deps]
 * @returns {{
 *   getConfigPath: () => string,
 *   getPublicSettings: () => object,
 *   getApiKey: () => string,
 *   isPersistenceAvailable: () => boolean,
 *   getStorageInfo: () => {available: boolean, backend: string, persistence: string, configPath: string},
 *   load: () => {corrupted: boolean, config: object},
 *   save: (patch?: object) => {settings: object, ok: boolean, error: string | null, message: string}
 * }}
 */
function createSettingsStore(deps) {
  const options = deps || {};
  const fs = options.fs || require('node:fs');
  const env = options.env || process.env;
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const encryption = resolveSafeStorage(options.safeStorage);

  const dirPath = typeof options.dirPath === 'string' && options.dirPath.length > 0
    ? options.dirPath
    : nodePath.join(require('node:os').tmpdir(), 'blue-fat-fish-settings');
  const filePath = typeof options.filePath === 'string' && options.filePath.length > 0
    ? options.filePath
    : nodePath.join(dirPath, CONFIG_FILE_NAME);

  /** 内存中的当前配置（含密文；明文 Key 单独放，且只在内存里） */
  let config = defaultConfig();
  /** @type {string} 只在内存里的明文 Key —— 绝不写进 config，也绝不出现在返回值里 */
  let sessionKey = '';
  /** 本次会话里 Key 是从哪里来的 */
  let keyLoadedFromFile = false;
  /** 配置文件是否损坏过（仅用于启动日志与诊断） */
  let configCorrupted = false;

  /**
   * 读取环境变量里的 Key（环境变量优先）。
   * @returns {string}
   */
  function readEnvKey() {
    const raw = env ? env.ZHIPU_API_KEY : undefined;
    if (typeof raw !== 'string' || raw.trim().length === 0) return '';
    const checked = validateApiKey(raw);
    if (!checked.ok) {
      // 环境变量本身写错了：只提示这一句，绝不回显内容
      console.warn('[设置] 环境变量 ZHIPU_API_KEY 格式不合法，已忽略它。');
      return '';
    }
    return checked.value;
  }

  /**
   * 从磁盘加载配置（构造时已加载过一次；供测试与"重新读盘"使用）。
   * @returns {{corrupted: boolean, config: object}}
   */
  function load() {
    let text = null;
    let exists = false;
    try {
      exists = fs.existsSync(filePath);
    } catch {
      exists = false;
    }
    if (!exists) {
      // 文件还不存在是"首次运行"的正常状态，不算损坏
      config = defaultConfig();
      sessionKey = '';
      keyLoadedFromFile = false;
      configCorrupted = false;
      return { corrupted: false, config: { ...config } };
    }

    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      // 读不了（权限 / 文件被别人占着）→ 当成"还没有配置"，不崩
      console.warn('[设置] 读取配置文件失败，本次按"未配置"处理：', filePath);
      config = defaultConfig();
      sessionKey = '';
      keyLoadedFromFile = false;
      configCorrupted = true;
      return { corrupted: true, config: { ...config } };
    }

    const parsed = parseConfigText(text);
    config = parsed.config;
    configCorrupted = parsed.corrupted;

    if (parsed.corrupted) {
      console.warn('[设置] 配置文件损坏或非法，已重置为默认设置：', filePath);
      sessionKey = '';
      keyLoadedFromFile = false;
      return { corrupted: true, config: { ...config } };
    }

    // 解密磁盘上的 Key：解密失败 = 没配 Key（换了账户 / 文件被改过都走这条）
    if (config.keyEncrypted) {
      const plain = encryption.decrypt(config.keyEncrypted);
      if (plain && validateApiKey(plain).ok) {
        sessionKey = plain;
        keyLoadedFromFile = true;
      } else {
        sessionKey = '';
        keyLoadedFromFile = false;
      }
    } else {
      sessionKey = '';
      keyLoadedFromFile = false;
    }

    return { corrupted: false, config: { ...config } };
  }

  /**
   * 当前生效的 Key：环境变量优先，其次才是配置文件（解密后）的 Key。
   * @returns {string}
   */
  function getApiKey() {
    const fromEnv = readEnvKey();
    if (fromEnv) return fromEnv;
    return sessionKey;
  }

  /**
   * Key 的来源标记。
   * @returns {'env' | 'file' | 'session' | 'none'}
   */
  function getKeySource() {
    if (readEnvKey()) return 'env';
    if (!sessionKey) return 'none';
    return keyLoadedFromFile ? 'file' : 'session';
  }

  /**
   * 对外可见的设置快照 —— **不含 Key，也不含任何能还原 Key 的信息**。
   *
   * `persistence` 的三种取值：
   *   - 'encrypted'    Key 已用 safeStorage 加密写入配置文件
   *   - 'session-only' safeStorage 不可用（或显式要求不落盘）：只保存在本次会话内存里
   *   - 'none'         当前没有 Key
   * @returns {object} 只含非敏感项；**绝不含 Key、密文或任何派生值**
   */
  function getPublicSettings() {
    const source = getKeySource();
    let persistence = 'none';
    if (source === 'env') {
      // 环境变量在，就轮不到配置文件；此时是否落盘对行为没有影响
      persistence = 'env';
    } else if (source === 'file') {
      persistence = 'encrypted';
    } else if (source === 'session') {
      persistence = 'session-only';
    }

    return {
      model: config.model,
      defaultModel: DEFAULT_MODEL,
      // 固定 endpoint 只作为"只读展示"字段给设置页看，**不能**用来改请求地址
      // （真正发请求的地址写死在 main/zhipu-client.js 里，renderer 无法覆盖）
      endpoint: CHAT_ENDPOINT,
      hasApiKey: source !== 'none',
      keySource: source,
      persistence,
      storageAvailable: encryption.available,
      // 路径只用于让用户知道"配置存在哪"，不含任何敏感内容
      configPath: filePath,
      configCorrupted,
      updatedAt: config.updatedAt,
      // ---- 阶段 4：语音设置（全部非敏感，可以回给渲染层）----
      micEnabled: config.micEnabled,
      vadSensitivity: config.vadSensitivity,
      vadSilenceMs: config.vadSilenceMs,
      ttsVoice: config.ttsVoice,
      volume: config.volume,
      subtitleMode: config.subtitleMode,
      petScale: config.petScale,
      // 只读展示用的白名单 / 默认值 / 取值范围（渲染层据此渲染下拉与滑块）
      voiceOptions: TTS_VOICES.slice(),
      defaultVoice: DEFAULT_TTS_VOICE,
      vadSilenceRange: { min: VAD_SILENCE_RANGE.min, max: VAD_SILENCE_RANGE.max },
      petScaleRange: { min: PET_SCALE_RANGE.min, max: PET_SCALE_RANGE.max },
      voiceDefaults: {
        micEnabled: VOICE_DEFAULTS.micEnabled,
        vadSensitivity: VOICE_DEFAULTS.vadSensitivity,
        vadSilenceMs: VOICE_DEFAULTS.vadSilenceMs,
        ttsVoice: VOICE_DEFAULTS.ttsVoice,
        volume: VOICE_DEFAULTS.volume,
        subtitleMode: VOICE_DEFAULTS.subtitleMode
      }
    };
  }

  /**
   * 加密并原子写盘。任何一步失败都只返回 ok:false —— **绝不退回明文写入**。
   *
   * 说明：调用方在"清除 Key"时也会调用本函数（此时 keyEncrypted 为空字符串），
   * 目的是让磁盘上的旧密文被真正抹掉，而不是留着一份过期的密钥材料。
   * @param {{model: string, keyEncrypted: string, keyHash: string}} next
   * @returns {boolean}
   */
  function writeConfig(next) {
    const payload = JSON.stringify(
      {
        version: CONFIG_VERSION,
        model: next.model,
        keyEncrypted: next.keyEncrypted,
        keyHash: next.keyHash,
        updatedAt: Math.floor(clock()),
        // 阶段 4：语音设置（全部非敏感；**绝不含 Key**）
        micEnabled: next.micEnabled,
        vadSensitivity: next.vadSensitivity,
        vadSilenceMs: next.vadSilenceMs,
        ttsVoice: next.ttsVoice,
        volume: next.volume,
        subtitleMode: next.subtitleMode
      },
      null,
      2
    );

    if (Buffer.byteLength(payload, 'utf8') > MAX_CONFIG_BYTES) {
      console.warn('[设置] 待写入的配置超过大小上限，已放弃写入。');
      return false;
    }

    const tmpPath = `${filePath}.tmp`;
    try {
      if (typeof fs.mkdirSync === 'function') {
        fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      // 原子替换：先写临时文件再 rename，避免崩在中途留下半个 JSON
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch {
      console.warn('[设置] 写入配置文件失败（设置仍在本次会话生效）：', filePath);
      try {
        if (typeof fs.unlinkSync === 'function') fs.unlinkSync(tmpPath);
      } catch {
        // 清理临时文件失败也不重要，忽略
      }
      return false;
    }
  }

  /**
   * 保存设置。
   *
   * patch 字段（**白名单，多余字段一律忽略**）：
   *   - apiKey?: string            新 Key（空字符串 = 不改动；用 CLEAR_KEY_SENTINEL 清除）
   *   - model?: string             模型名
   *   - persist?: boolean          是否允许写盘（默认 true）
   *
   * 缺陷修复 F（旧密文不能"复活"）：换 Key 或清除 Key 时，如果新 Key 因为
   * safeStorage 不可用 / 加密失败而只能 session-only，**必须**尽量把磁盘上那份旧密文
   * 用"空 keyEncrypted"原子覆盖掉；否则下次重启（加密恢复可用时）会悄悄加载回旧 Key。
   * 写盘失败时返回值里会明确提示"旧密文可能还在，重启后可能加载旧 Key"。
   *
   * @param {{apiKey?: string, model?: string, persist?: boolean} & object} [patch]
   *   语音相关白名单字段：micEnabled / vadSensitivity / vadSilenceMs / ttsVoice /
   *   volume / subtitleMode（全部非敏感，非法值一律明确报错，绝不静默改写）。
   * @returns {{settings: object, ok: boolean, error: string | null, message: string}}
   */
  function save(patch) {
    const input = patch && typeof patch === 'object' ? patch : {};
    // 记录"保存前磁盘上是否有密文"：用于判断是否需要主动清理旧密文
    const hadStoredCipher = Boolean(config.keyEncrypted);
    const next = {
      model: config.model,
      keyEncrypted: config.keyEncrypted,
      keyHash: config.keyHash,
      micEnabled: config.micEnabled,
      vadSensitivity: config.vadSensitivity,
      vadSilenceMs: config.vadSilenceMs,
      ttsVoice: config.ttsVoice,
      volume: config.volume,
      subtitleMode: config.subtitleMode,
      petScale: config.petScale
    };

    if (Object.prototype.hasOwnProperty.call(input, 'model')) {
      const model = validateModel(input.model);
      if (!model.ok) {
        return {
          settings: getPublicSettings(),
          ok: false,
          error: model.code,
          message: SETTINGS_ERROR_MESSAGES[model.code] || '模型名不合法。'
        };
      }
      next.model = model.value;
    }

    // 阶段 4：语音设置补丁（只认白名单字段；非法值明确报错，不静默回落）
    const voicePatch = validateVoicePatch(input);
    if (!voicePatch.ok) {
      return {
        settings: getPublicSettings(),
        ok: false,
        error: voicePatch.code,
        message: voicePatch.message
      };
    }
    const voiceChanged = Object.keys(voicePatch.patch).length > 0;
    Object.assign(next, voicePatch.patch);

    let keyChanged = false;
    let clearing = false;
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
      const raw = input.apiKey;
      if (raw === CLEAR_KEY_SENTINEL) {
        clearing = true;
        keyChanged = true;
        next.keyEncrypted = '';
        next.keyHash = '';
      } else if (typeof raw === 'string' && raw.trim().length > 0) {
        const checked = validateApiKey(raw);
        if (!checked.ok) {
          return {
            settings: getPublicSettings(),
            ok: false,
            error: checked.code,
            message: SETTINGS_ERROR_MESSAGES[checked.code] || 'API Key 不合法。'
          };
        }
        sessionKey = checked.value;
        keyChanged = true;
        // 加密：拿不到密文就保持 keyEncrypted 为空 —— 宁可不落盘，也绝不退回明文
        const encrypted = encryption.encrypt(checked.value);
        if (encrypted) {
          next.keyEncrypted = encrypted;
          next.keyHash = hashKey(checked.value);
          keyLoadedFromFile = true;
        } else {
          next.keyEncrypted = '';
          next.keyHash = '';
          keyLoadedFromFile = false;
        }
      }
    }

    if (clearing) {
      sessionKey = '';
      keyLoadedFromFile = false;
    }

    config = { ...config, ...next };

    /*
     * 什么时候允许写盘？
     *   - 有密文（正常保存 / 换 Key）：一定要写，否则重启就丢；
     *   - 清除 Key：也要写，把磁盘上的旧密文真正抹掉；
     *   - **换 Key 但新 Key 只能 session-only（加密不可用 / 加密失败），而磁盘上原本有密文**：
     *     必须写一份空 keyEncrypted 覆盖旧密文，否则下次重启旧 Key 会悄悄复活（缺陷 F）；
     *   - 只改了模型名且本机没有可保存的 Key：写一份只有非敏感项的配置，
     *     这样的文件里 keyEncrypted 恒为空字符串，**不含任何秘密**。
     *   - 加密不可用、没有旧密文、也没有其它要写的内容：干脆不建文件（少一份无意义的落盘）。
     * `persist === false` 只给内部调用方（与测试）用，主进程 IPC 侧会强制成 true。
     */
    const allowPersist = input.persist !== false;
    const staleCipherToClear = hadStoredCipher && !next.keyEncrypted;
    const shouldWrite = allowPersist && (Boolean(next.keyEncrypted) || clearing || staleCipherToClear || Boolean(input.model) || voiceChanged);
    let persisted = false;
    if (shouldWrite) {
      persisted = writeConfig(next);
      if (persisted) {
        // 写盘成功说明配置文件已经是合法内容，之前"损坏"的标记可以清掉了
        configCorrupted = false;
      }
    }

    const settings = getPublicSettings();
    // 只改语音设置时给一句更贴切的提示（其它路径的文案保持阶段 3 的原样，避免回归）
    const voiceOnlyChange = !keyChanged && !clearing && !Object.prototype.hasOwnProperty.call(input, 'model') && voiceChanged;
    if (voiceOnlyChange) {
      return {
        settings,
        ok: true,
        error: null,
        message: persisted ? '语音设置已保存。' : '语音设置已在本次会话生效（本次没有需要写盘的内容）。'
      };
    }

    if (settings.keySource === 'env') {
      return {
        settings,
        ok: true,
        error: null,
        message: '设置已保存。当前生效的是环境变量 ZHIPU_API_KEY，它会优先于这里填写的 Key。'
      };
    }

    if (clearing) {
      return {
        settings,
        ok: true,
        error: null,
        message: persisted
          ? '已清除本机保存的 API Key（磁盘上的加密内容已一并抹掉）。'
          : '已清除本机保存的 API Key（本次会话生效）。'
      };
    }

    if (keyChanged) {
      if (settings.persistence === 'encrypted') {
        return {
          settings,
          ok: true,
          error: null,
          message: persisted
            ? '已配置。Key 已用本机 Electron safeStorage 加密后保存，只能在当前 Windows 用户账户下解密。'
            : (hadStoredCipher
                ? '已配置（仅本次会话）。写入配置文件失败，磁盘上可能仍保留着上一次的加密 Key，重启后请重新填写当前 Key。'
                : '已配置（仅本次会话）。写入配置文件失败，重启后需要重新填写。')
        };
      }
      // 到这里说明 safeStorage 不可用（或加密失败）：新 Key 只能 session-only
      if (persisted) {
        return {
          settings,
          ok: true,
          error: null,
          message: hadStoredCipher
            ? '已配置（仅本次会话）。本机 safeStorage 加密不可用，Key 只保存在内存里，不会明文落盘；磁盘上的旧密文已清除。'
            : '已配置（仅本次会话）。本机 safeStorage 加密不可用，Key 只保存在内存里，不会明文落盘。'
        };
      }
      return {
        settings,
        ok: true,
        error: null,
        message: '已配置（仅本次会话）。本机 safeStorage 加密不可用，Key 只保存在内存里，不会明文落盘；'
          + '且写入配置文件失败，无法清除磁盘上的旧密文，重启后可能重新加载旧 Key。'
      };
    }

    return {
      settings,
      ok: true,
      error: null,
      message: persisted ? '设置已保存。' : '设置已在本次会话生效（本次没有需要写盘的内容）。'
    };
  }

  // 构造即加载一次，启动阶段就能拿到正确的 hasApiKey / keySource
  load();

  return {
    getConfigPath: () => filePath,
    getPublicSettings,
    getApiKey,
    isPersistenceAvailable: () => encryption.available,
    getStorageInfo: () => ({
      available: encryption.available,
      backend: encryption.source,
      persistence: encryption.available ? 'encrypted' : 'session-only',
      configPath: filePath
    }),
    load,
    save
  };
}

module.exports = {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  DEFAULT_MODEL,
  MAX_CONFIG_BYTES,
  API_KEY_MIN_LENGTH,
  API_KEY_MAX_LENGTH,
  MODEL_MAX_LENGTH,
  MODEL_PATTERN,
  CLEAR_KEY_SENTINEL,
  SETTINGS_ERRORS,
  SETTINGS_ERROR_MESSAGES,
  TTS_VOICES,
  DEFAULT_TTS_VOICE,
  VOICE_DEFAULTS,
  VAD_SILENCE_RANGE,
  VOLUME_RANGE,
  VOICE_ERROR_CODES,
  VOICE_ERROR_MESSAGES,
  createSettingsStore,
  resolveSafeStorage,
  defaultConfig,
  normalizeConfig,
  normalizeVoiceSettings,
  validateVoicePatch,
  validateMicEnabled,
  validateVadSensitivity,
  validateVadSilenceMs,
  validateTtsVoice,
  validateVolume,
  validateSubtitleMode,
  parseConfigText,
  validateApiKey,
  validateModel,
  hashKey,
  hasControlChar
};
