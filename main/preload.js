'use strict';

/**
 * ============================================================================
 * preload —— 渲染层与主进程之间唯一的、最小化的桥梁
 * ============================================================================
 *
 * 安全约定（务必保持）：
 *   1. 只往渲染层暴露 window.blueFatFish 这一个对象，且用 Object.freeze 冻结；
 *   2. 暴露的方法全部是"固定通道 + 参数校验"的窄接口，绝不暴露 ipcRenderer 本体，
 *      也绝不暴露 require / process / fs 等任何 Node 能力；
 *   3. 通道名与主进程 main/ipc-channels.js 完全一致，渲染层无法自造通道；
 *   4. 阶段 2 新增的游动（swim）接口刻意设计成"不带任何参数"——渲染层只能请求
 *      "游一次"，目标位置由主进程按显示器 workArea 自行计算并限幅；
 *   5. 阶段 2 新增的喂饭（feed）是主进程 → 渲染层的单向通知，同样只做白名单转发。
 *   6. 阶段 3：**桌宠窗口这里没有任何 settings:* 通道**。读取/保存 API Key、测试连接、
 *      云端对话全部属于设置窗口（main/settings-preload.js）的通道，两套通道彼此不通用；
 *      桌宠窗口只能通过 reportSettingsState() 只读地问一句"有没有可用的 Key"，
 *      拿到的只有布尔状态与来源标记，没有任何 Key 内容，也没有任何派生值。
 *      阶段 3 桌宠渲染层也不会主动调用它（启动密钥检查留到后续语音对话阶段），
 *      这样即便没配置 Key，启动时也不会被任何提示打扰。
 *
 * 关于 sandbox（重要修正）：
 *   主窗口开启 sandbox: true 后，preload 也运行在受限沙箱里。沙箱模式下 Electron
 *   注入的 require **只能加载 electron 以及少数内置模块，无法加载本地 CommonJS
 *   相对模块**（例如 './ipc-channels'）。所以本文件：
 *     - 顶层只调用一次 require('electron')，不再 require 任何本地文件；
 *     - 需要的 IPC_CHANNELS / PET_EVENTS / 动作白名单在本文件内部以冻结常量定义一份副本；
 *     - 副本与 main/ipc-channels.js 的一致性由 tests/smoke.test.js 逐项比对，
 *       两侧数值一旦漂移，静态检查会立刻失败。
 *   注意：绝不要为了"能 require 本地文件"而关闭 sandbox。
 */

// 沙箱 preload 下唯一可用的模块：electron（必须在文件顶层同步 require）
const { contextBridge, ipcRenderer } = require('electron');

/* -------------------------------------------------------------------------- */
/* 通道常量（沙箱内无法 require 本地模块，故在此冻结定义）                       */
/* 必须与 main/ipc-channels.js 里的 IPC_CHANNELS / PET_EVENTS 逐项一致          */
/* -------------------------------------------------------------------------- */

/** 渲染层 → 主进程（invoke/handle，一问一答）通道白名单 */
const IPC_CHANNELS = Object.freeze({
  // 窗口拖拽：渲染层把"指针相对窗口的偏移"告诉主进程，主进程按屏幕坐标移动窗口
  DRAG_START: 'pet:drag-start',
  DRAG_MOVE: 'pet:drag-move',
  DRAG_END: 'pet:drag-end',
  // 右键：让主进程弹出与托盘一致的菜单（坐标由 Electron 默认取当前光标位置）
  SHOW_CONTEXT_MENU: 'pet:show-context-menu',
  // 鼠标穿透：按光标是否落在鱼身上，动态开关 ignoreMouseEvents
  SET_IGNORE_MOUSE_EVENTS: 'pet:set-ignore-mouse-events',
  // 渲染层把自己的状态（如 idle / hungry / sleep）回报给主进程，供托盘提示做只读联动
  REPORT_STATE: 'pet:report-state',
  // 游动请求：渲染层不带任何坐标，主进程自行取窗口与显示器 workArea 计算目标
  SWIM_REQUEST: 'pet:swim-request',
  /*
   * 阶段 3：只读地问一句"现在有没有可用的 API Key"。
   * 返回 { hasApiKey, keySource } —— 没有 Key 内容、也没有任何派生值。
   * 桌宠窗口既不能读设置全文，也不能改设置，更不能发起云端对话。
   */
  REPORT_SETTINGS_STATE: 'pet:report-settings-state',
  /*
   * 阶段 4（连续语音对话）三条窄接口：
   *   - VOICE_TRANSCRIBE / VOICE_CHAT / VOICE_SPEAK 都是"渲染层把内容交给主进程"，
   *     主进程才是唯一持有 API Key 的地方；
   *   - 合成的 TTS 音频由主进程读取成 Uint8Array 后回传，**没有"删除临时文件"通道**：
   *     临时音频的读取与删除都在主进程内完成，渲染层拿不到路径，也就没有可删任意文件的接口。
   * 设置窗口的 preload 里**没有**这些通道（两套通道互不通用）。
   */
  VOICE_TRANSCRIBE: 'pet:voice-transcribe',
  VOICE_CHAT: 'pet:voice-chat',
  VOICE_SPEAK: 'pet:voice-speak'
});

/** 主进程 → 渲染层（send/on，单向通知）事件白名单 */
const PET_EVENTS = Object.freeze({
  // 触发一个可见动作状态，payload: { state: '...', durationMs?: number }
  ACTION: 'pet:action',
  // 喂饭：重置饱食度并串起 eat → happy（payload 为空）
  FEED: 'pet:feed',
  // 阶段 4：语音相关通知（气泡 / 开关麦克风 / 设置变更 / 本机 TTS 兜底）
  VOICE_BUBBLE: 'pet:voice-bubble',
  VOICE_TOGGLE_MIC: 'pet:voice-toggle-mic',
  VOICE_SETTINGS: 'pet:voice-settings',
  VOICE_SPEAK_TEXT: 'pet:voice-speak-text'
});

/**
 * 渲染层允许触发/上报的动作状态白名单（16 个：需求 15 个 + wake）。
 * 必须与 main/ipc-channels.js 的 PET_STATES 逐项一致（烟测比对）。
 */
const ALLOWED_ACTIONS = Object.freeze([
  'idle',
  'blink',
  'eat',
  'happy',
  'hungry',
  'sleep',
  'talking',
  'thinking',
  'dragged',
  'poke',
  'pet',
  'swim',
  'flip',
  'greet',
  'angry',
  'wake'
]);

const ALLOWED_ACTION_SET = new Set(ALLOWED_ACTIONS);

/* -------------------------------------------------------------------------- */
/* 参数校验小工具                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 校验并归一化一个"点/偏移"对象，防止渲染层传入奇怪的值。
 * @param {unknown} value
 * @returns {{x: number, y: number, dx: number, dy: number}}
 */
function normalizePoint(value) {
  const src = value && typeof value === 'object' ? value : {};
  const pick = (key) => {
    const num = Number(src[key]);
    return Number.isFinite(num) ? num : 0;
  };
  return { x: pick('x'), y: pick('y'), dx: pick('dx'), dy: pick('dy') };
}

/**
 * 语音类事件的通用订阅封装：统一做"回调类型检查 → 字段白名单归一化 → 取消订阅"。
 *
 * 阶段 4 新增了 4 条主进程 → 渲染层的语音事件。如果每条都手写一遍
 * `ipcRenderer.on(...)`，很容易漏掉"payload 不是对象""字段没过滤"这类细节，
 * 所以集中在这里处理：
 *   - `normalize` 返回 null 表示这条事件不合法，直接丢弃（渲染层不会看到脏数据）；
 *   - 回调只拿到归一化后的普通对象，**拿不到 event 对象**（也就拿不到 sender）。
 *
 * @param {string} channel
 * @param {Function} handler
 * @param {(payload: any) => object | null} normalize
 * @returns {() => void}
 */
function subscribeVoiceEvent(channel, handler, normalize) {
  if (typeof handler !== 'function') return () => {};
  const listener = (_event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const normalized = normalize(payload);
    if (!normalized) return;
    handler(normalized);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/* -------------------------------------------------------------------------- */
/* 阶段 4（安全集成修复）：voiceSpeak 返回值的白名单归一化                       */
/* -------------------------------------------------------------------------- */

/**
 * 单份 TTS 音频的硬上限：10 MiB。
 * 必须与主进程 main/voice-audio-payload.js 的 MAX_AUDIO_BYTES 保持一致
 * （沙箱 preload 无法 require 本地模块，所以这里保留一份常量副本）。
 */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** 允许的 TTS 提供方（与 main/tts-client.js 的 provider 取值一致） */
const ALLOWED_TTS_PROVIDERS = Object.freeze(['glm-tts', 'edge-tts', 'sapi']);

/** 安全错误码形状：小写字母开头、只含小写字母 / 数字 / 连字符，最长 64 */
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** 文本统一截断到 1024 字（与主进程的 TTS 上限一致） */
function normalizeSpeakText(value) {
  return typeof value === 'string' ? value.slice(0, 1024) : '';
}

/**
 * 把主进程回传的音频归一化成 Uint8Array。
 * 只接受 Uint8Array / ArrayBuffer；越界或空一律返回 null（由调用方降级）。
 * 用 `Object.prototype.toString` 而不是只看 instanceof，兼容跨 realm 的视图。
 * @param {unknown} value
 * @returns {Uint8Array | null}
 */
function normalizeAudioBytes(value) {
  let bytes = null;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Uint8Array]') {
    // 跨 realm / 跨 contextBridge 的 Uint8Array：复制成本 realm 的一份
    bytes = new Uint8Array(value);
  } else {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) return null;
  return bytes;
}

/**
 * 对 voiceSpeak 的结果做白名单归一化：**只保留播放必需字段**。
 *
 * 安全约定：
 *   - 成功时必须同时满足 `ok === true`、provider 在白名单内、audioBytes 是
 *     合法且不超限的二进制；任一不满足就当作失败降级；
 *   - **绝不透传 file / path / 异常字段 / 上游响应**：返回对象是当场新建的普通对象；
 *   - 失败时只保留安全错误码 + 固定兜底标记 + 截断文本。
 *
 * @param {unknown} raw
 * @returns {{ok: true, provider: string, audioBytes: Uint8Array, text: string}
 *   | {ok: false, code: string, fallback: 'speechSynthesis', text: string}}
 */
function normalizeSpeakResult(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  if (source.ok === true) {
    const provider = typeof source.provider === 'string' ? source.provider : '';
    const audioBytes = normalizeAudioBytes(source.audioBytes);
    if (ALLOWED_TTS_PROVIDERS.includes(provider) && audioBytes) {
      return {
        ok: true,
        provider: provider,
        audioBytes: audioBytes,
        text: normalizeSpeakText(source.text)
      };
    }
    // 主进程说成功但字段不合法：按失败处理，绝不把可疑数据交给渲染层
    return { ok: false, code: 'bad-response', fallback: 'speechSynthesis', text: normalizeSpeakText(source.text) };
  }
  const code = typeof source.code === 'string' && SAFE_CODE_PATTERN.test(source.code)
    ? source.code
    : 'internal-error';
  return { ok: false, code: code, fallback: 'speechSynthesis', text: normalizeSpeakText(source.text) };
}

/* -------------------------------------------------------------------------- */
/* 暴露给渲染层的最小 API                                                      */
/* -------------------------------------------------------------------------- */

const api = {
  /** 标记：便于渲染层做特性探测 / 调试（4 = 已接入连续语音对话） */
  phase: 4,

  /**
   * 开始拖拽窗口。
   * @param {{dx: number, dy: number}} offset 指针相对窗口左上角的偏移
   */
  dragStart(offset) {
    return ipcRenderer.invoke(IPC_CHANNELS.DRAG_START, normalizePoint(offset));
  },

  /**
   * 拖拽中：传入光标的屏幕坐标。
   * @param {{x: number, y: number}} point
   */
  dragMove(point) {
    return ipcRenderer.invoke(IPC_CHANNELS.DRAG_MOVE, normalizePoint(point));
  },

  /** 结束拖拽 */
  dragEnd() {
    return ipcRenderer.invoke(IPC_CHANNELS.DRAG_END);
  },

  /** 在光标处弹出与托盘一致的右键菜单 */
  showContextMenu() {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_CONTEXT_MENU);
  },

  /**
   * 切换鼠标穿透：光标在鱼身上时传 false（要能点到鱼），
   * 在透明区域时传 true（把桌面操作让出去）。
   * @param {boolean} ignore
   */
  setIgnoreMouseEvents(ignore) {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_IGNORE_MOUSE_EVENTS, Boolean(ignore));
  },

  /**
   * 请求主进程游动一次（从工作区一侧游到另一侧再游回来）。
   * 刻意不接受任何参数：渲染层无法指定坐标，目标位置完全由主进程算。
   * @returns {Promise<{ok: boolean, reason?: string, durationMs?: number, direction?: 'left'|'right'}>}
   */
  requestSwim() {
    return ipcRenderer.invoke(IPC_CHANNELS.SWIM_REQUEST);
  },

  /**
   * 向主进程回报当前动作状态（只读用途）。仅接受白名单内的状态名。
   * @param {string} state
   */
  reportState(state) {
    if (typeof state !== 'string' || !ALLOWED_ACTION_SET.has(state)) {
      return Promise.resolve(false);
    }
    return ipcRenderer.invoke(IPC_CHANNELS.REPORT_STATE, state);
  },

  /**
   * 只读地问一句"现在有没有可用的 API Key"（阶段 3）。
   *
   * 返回 `{ hasApiKey, keySource }`：只有状态位，**没有 Key、也没有任何派生值**。
   * 阶段 3 的桌宠渲染层不会主动调用它 —— 启动时不发任何请求、不打扰未配置 Key 的用户；
   * 密钥有效性检查留到后续语音对话阶段接。
   * @returns {Promise<{hasApiKey: boolean, keySource: string}>}
   */
  reportSettingsState() {
    return ipcRenderer.invoke(IPC_CHANNELS.REPORT_SETTINGS_STATE);
  },

  /**
   * 把一段**已经编码成 WAV** 的语音交给主进程识别（阶段 4）。
   *
   * 参数窄化：
   *   - 只接受 Uint8Array（Electron 结构化克隆直接传二进制，不做 base64 膨胀）；
   *   - 只透传 `durationMs` / `format` 两个元信息字段，其它字段一律丢弃；
   *   - 返回值由主进程决定，可能是云端识别结果，也可能是 `{ok:false, code:'unavailable'}`。
   * **渲染层永远拿不到 API Key，也拿不到任何云端响应体。**
   * @param {Uint8Array} audioBytes
   * @param {{durationMs?: number, format?: string}} [meta]
   */
  voiceTranscribe(audioBytes, meta) {
    if (!(audioBytes instanceof Uint8Array) || audioBytes.byteLength === 0) {
      return Promise.resolve({ ok: false, code: 'no-audio', chat: false });
    }
    const info = meta && typeof meta === 'object' ? meta : {};
    const payload = { bytes: audioBytes };
    if (Number.isFinite(Number(info.durationMs))) payload.durationMs = Math.round(Number(info.durationMs));
    // 只允许 wav：主进程还会再校验一次，webm 绝不允许上传
    payload.format = 'wav';
    return ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, payload);
  },

  /**
   * 把识别出来的文本交给主进程的云端对话（阶段 4）。
   * `history` 是最近几轮的对话上下文（主进程内部还会再裁剪到 <=6 条）。
   * @param {string} text
   * @param {{history?: Array<{role: string, content: string}>}} [options]
   * @returns {Promise<{ok: boolean, text?: string, code?: string, message?: string}>}
   */
  voiceChat(text, options) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return Promise.resolve({ ok: false, code: 'bad-request' });
    }
    const source = options && typeof options === 'object' ? options : {};
    const history = Array.isArray(source.history)
      ? source.history
          .filter((item) => item && typeof item === 'object')
          .slice(-6)
          .map((item) => ({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: typeof item.content === 'string' ? item.content.slice(0, 1000) : ''
          }))
          .filter((item) => item.content.length > 0)
      : [];
    return ipcRenderer.invoke(IPC_CHANNELS.VOICE_CHAT, { text: text.slice(0, 1000), history });
  },

  /**
   * 请求合成一段语音（阶段 4）：GLM-TTS → edge-tts → SAPI → 渲染层 speechSynthesis。
   *
   * 成功时返回 `{ok:true, provider, audioBytes:Uint8Array, text}`：
   *   - 音频字节由主进程读取成二进制，**没有本地路径**，渲染层不需要 fetch / file URL；
   *   - 结果在 preload 这里再做一次白名单归一化（见 normalizeSpeakResult）：
   *     校验 ok / provider / audioBytes 类型与字节上限 / text 长度，
   *     **绝不透传 file、path、异常字段或上游响应**；
   *   - 失败 / 字段非法统一返回 `{ok:false, code, fallback:'speechSynthesis', text}`，
   *     由渲染层用本机语音兜底。
   * @param {string} text
   * @returns {Promise<{ok: boolean, provider?: string, audioBytes?: Uint8Array, text: string, code?: string, fallback?: string}>}
   */
  voiceSpeak(text) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return Promise.resolve({ ok: false, code: 'empty-text', fallback: 'speechSynthesis', text: '' });
    }
    return ipcRenderer
      .invoke(IPC_CHANNELS.VOICE_SPEAK, { text: text.slice(0, 1024) })
      .then((raw) => normalizeSpeakResult(raw))
      .catch(() => ({ ok: false, code: 'internal-error', fallback: 'speechSynthesis', text: '' }));
  },

  /**
   * 订阅轻量气泡（错误 / 麦克风状态提示）。
   * 回调只收到 `{text, kind, caption}`，收不到原始 IPC 事件对象。
   * @param {(payload: {text: string, kind: string, caption: boolean}) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onVoiceBubble(handler) {
    return subscribeVoiceEvent(PET_EVENTS.VOICE_BUBBLE, handler, (payload) => {
      const text = typeof payload.text === 'string' ? payload.text.slice(0, 200) : '';
      if (text.length === 0) return null;
      return {
        text,
        kind: typeof payload.kind === 'string' ? payload.kind : 'info',
        caption: payload.caption === true
      };
    });
  },

  /**
   * 订阅"开关麦克风"指令（菜单「语音对话」/ 全局 Ctrl+Shift+V）。
   * @param {() => void} handler
   * @returns {() => void}
   */
  onVoiceToggleMic(handler) {
    return subscribeVoiceEvent(PET_EVENTS.VOICE_TOGGLE_MIC, handler, () => ({}));
  },

  /**
   * 订阅语音设置变更（只含非敏感字段：麦克风 / 灵敏度 / 静音毫秒 / 音色 / 音量 / 字幕）。
   * @param {(settings: object) => void} handler
   * @returns {() => void}
   */
  onVoiceSettings(handler) {
    return subscribeVoiceEvent(PET_EVENTS.VOICE_SETTINGS, handler, (payload) => ({
      micEnabled: payload.micEnabled === true,
      vadSensitivity: Number.isFinite(Number(payload.vadSensitivity)) ? Number(payload.vadSensitivity) : 0.5,
      vadSilenceMs: Number.isFinite(Number(payload.vadSilenceMs)) ? Math.round(Number(payload.vadSilenceMs)) : 800,
      ttsVoice: typeof payload.ttsVoice === 'string' ? payload.ttsVoice : 'tongtong',
      volume: Number.isFinite(Number(payload.volume)) ? Number(payload.volume) : 0.8,
      subtitleMode: payload.subtitleMode === true
    }));
  },

  /**
   * 订阅"用本机 speechSynthesis 播报"的兜底请求（三级 TTS 的最后一级）。
   * 文本长度在主进程已限制到 1024 字以内，这里再兜一次。
   * @param {(payload: {text: string, volume: number}) => void} handler
   * @returns {() => void}
   */
  onVoiceSpeakText(handler) {
    return subscribeVoiceEvent(PET_EVENTS.VOICE_SPEAK_TEXT, handler, (payload) => {
      const text = typeof payload.text === 'string' ? payload.text.slice(0, 1024) : '';
      if (text.length === 0) return null;
      const volume = Number(payload.volume);
      return { text, volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.8 };
    });
  },

  /**
   * 订阅主进程下发的动作指令（托盘菜单等触发）。
   * 回调只收到经过白名单过滤的状态名与可选时长，收不到原始 IPC 事件对象。
   * @param {(state: string, options: {durationMs: number | null}) => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onAction(handler) {
    if (typeof handler !== 'function') {
      return () => {};
    }
    const listener = (_event, payload) => {
      const state = payload && typeof payload.state === 'string' ? payload.state : null;
      if (!state || !ALLOWED_ACTION_SET.has(state)) return;
      const durationMs = payload && Number.isFinite(payload.durationMs) ? payload.durationMs : null;
      handler(state, { durationMs });
    };
    ipcRenderer.on(PET_EVENTS.ACTION, listener);
    return () => ipcRenderer.removeListener(PET_EVENTS.ACTION, listener);
  },

  /**
   * 订阅「喂饭」指令（主进程菜单触发）。
   * 渲染层收到后需要：饱食度重置到 100 → 播 eat → 吃完转 happy。
   * @param {() => void} handler
   * @returns {() => void} 取消订阅函数
   */
  onFeed(handler) {
    if (typeof handler !== 'function') {
      return () => {};
    }
    const listener = () => handler();
    ipcRenderer.on(PET_EVENTS.FEED, listener);
    return () => ipcRenderer.removeListener(PET_EVENTS.FEED, listener);
  }
};

// 冻结后暴露：渲染层无法篡改或替换这些方法，也无法通过它拿到 ipcRenderer
contextBridge.exposeInMainWorld('blueFatFish', Object.freeze(api));
