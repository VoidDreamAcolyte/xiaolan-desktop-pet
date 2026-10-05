'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯逻辑模块：连续语音对话的回合管理（turn-taking，阶段 4）
 * ============================================================================
 *
 * 一轮完整对话：
 *
 *     用户停说 ──► ASR（云 GLM-ASR 优先，失败降级本地 faster-whisper）
 *              ──► chat（已有 zhipu-client，内置鱼设 system、30 字上限）
 *              ──► TTS（GLM-TTS → edge-tts → SAPI/speechSynthesis）
 *              ──► 播放结束 ──► 只有 micEnabled 才重新开麦
 *
 * 本模块把这套回合规则抽成**不依赖 DOM / 音频设备 / 网络**的纯状态机：
 *   - 所有副作用（请求识别、发对话、合成语音、开麦关麦）都由调用方注入的
 *     `pipelines` 提供，返回值固定为 `{ok, ...}`，**绝不抛异常**；
 *   - 因此单元测试可以注入"永远失败的 ASR""没有 Key 的对话""播放完成的 TTS"，
 *     用假时钟把"TTS 播放期间不采集、播放结束且 micEnabled 才恢复监听"跑一遍。
 *
 * 状态：'idle' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking'
 *
 * 硬规则（每一条都有对应断言）：
 *   1. **TTS 播放期间必须停止采集**：进入 'speaking' 前先 `mic.pause()`；
 *      只有 `speak()` resolve（播放完成）或失败后，才在 `micEnabled` 为 true 时 `mic.resume()`。
 *   2. **无 Key 时绝不把识别文本发给聊天模型**：`pipeline === 'local'` 或
 *      `chat.available === false` 时只气泡提示，不调用 `chat.ask`。
 *   3. **识别失败要分级提示**：无 Key / 鉴权失败 → 「我还没大脑，去 open.bigmodel.cn 领个 Key 呀」；
 *      网络 / 超时 → 「网有点卡…」；都只走轻量气泡，不弹窗。
 *   4. **有效语音段才提交**：VAD 判定 `accepted === false` 的片段直接丢弃
 *      （绝不把无声片段当用户发言）。
 *   5. 麦克风关闭（micEnabled=false）时 `start()` 直接不启动，`setMicEnabled(false)`
 *      会立刻停采并回到 idle。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BFFLogic = root.BFFLogic || {};
    root.BFFLogic.turnTaking = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 对话气泡文案（简短、傲娇、口语化；与需求规格逐字对应） */
  const TEXTS = Object.freeze({
    noBrain: '我还没大脑，去 open.bigmodel.cn 领个 Key 呀',
    bedtime: '哼、本鱼听着呢，快说呀',
    network: '网有点卡…',
    asrFailed: '没听清…再说一遍嘛',
    emptySpeech: '哼，本鱼什么都没听到',
    micOn: '麦开着呢，本鱼听着',
    micOff: '哼，不听了'
  });

  /** 错误码 → 用户可见的短文案类别（只分类，不拼上游细节） */
  const NO_BRAIN_CODES = Object.freeze(['no-api-key', 'auth-failed', 'invalid-key', 'forbidden']);
  const NETWORK_CODES = Object.freeze(['network', 'timeout', 'rate-limited', 'server-error', 'http-error', 'aborted']);

  /**
   * 把错误码归类成气泡文案。
   * @param {string} code
   * @returns {{kind: 'no-brain'|'network'|'unknown', text: string}}
   */
  function classifyError(code) {
    if (typeof code === 'string' && NO_BRAIN_CODES.includes(code)) {
      return { kind: 'no-brain', text: TEXTS.noBrain };
    }
    if (typeof code === 'string' && NETWORK_CODES.includes(code)) {
      return { kind: 'network', text: TEXTS.network };
    }
    return { kind: 'unknown', text: TEXTS.asrFailed };
  }

  /**
   * 创建回合管理器。
   *
   * @param {{
   *   mic?: {start?: Function, pause?: Function, resume?: Function, close?: Function},
   *   pipelines?: {
   *     transcribe?: (wavBytes: Uint8Array, meta: object) => Promise<object>,
   *     chat?: (text: string) => Promise<object>,
   *     speak?: (text: string, meta?: object) => Promise<object>
   *   },
   *   onBubble?: (payload: {text: string, kind: string, caption: boolean}) => void,
   *   onStateChange?: (state: string, info: object) => void,
   *   onCaption?: (text: string) => void,
   *   captionEnabled?: () => boolean,
   *   minTranscriptChars?: number
   * }} [deps]
   */
  function createTurnTaking(deps) {
    const options = deps || {};
    const mic = options.mic && typeof options.mic === 'object' ? options.mic : {};
    const pipelines = options.pipelines && typeof options.pipelines === 'object' ? options.pipelines : {};
    const onBubble = typeof options.onBubble === 'function' ? options.onBubble : () => {};
    const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
    const onCaption = typeof options.onCaption === 'function' ? options.onCaption : () => {};
    const captionEnabled = typeof options.captionEnabled === 'function' ? options.captionEnabled : () => false;
    const minTranscriptChars = Number.isFinite(Number(options.minTranscriptChars))
      ? Math.max(0, Math.round(Number(options.minTranscriptChars)))
      : 2;

    /** 当前状态 */
    let state = 'idle';
    /** 麦克风是否被用户允许（设置项，默认开） */
    let micEnabled = true;
    /** 最近一轮的识别文本与回复（只保留在内存，不写盘、不记录日志） */
    let lastTranscript = '';
    let lastReply = '';
    /** 播放是否被 stop() 打断（打断后不再自动恢复监听） */
    let disposed = false;

    function setState(next, info) {
      if (state === next) return;
      const previous = state;
      state = next;
      try {
        onStateChange(next, Object.assign({ previous }, info || {}));
      } catch {
        // 回调异常不影响回合推进
      }
    }

    /** 轻量气泡：`kind` 用于样式，`caption` 表示要不要按字幕模式一起显示 */
    function bubble(text, kind) {
      if (typeof text !== 'string' || text.length === 0) return;
      try {
        onBubble({ text, kind: kind || 'info', caption: captionEnabled() === true });
      } catch {
        // 忽略
      }
    }

    /**
     * 启动监听（幂等）。micEnabled 为 false 时直接保持 idle，不开麦。
     * @returns {Promise<{ok: boolean, reason?: string, state: string}>}
     */
    async function start() {
      if (disposed) return { ok: false, reason: 'disposed', state };
      if (!micEnabled) {
        setState('idle', { reason: 'mic-disabled' });
        return { ok: false, reason: 'mic-disabled', state };
      }
      if (state !== 'idle' && state !== 'starting') {
        return { ok: true, reason: 'already-running', state };
      }

      setState('starting', { reason: 'start' });
      if (typeof mic.start !== 'function') {
        setState('idle', { reason: 'no-mic' });
        return { ok: false, reason: 'no-mic', state };
      }

      let result = null;
      try {
        result = await mic.start();
      } catch {
        result = { ok: false, reason: 'mic-error' };
      }

      if (disposed) return { ok: false, reason: 'disposed', state };

      if (!result || result.ok !== true) {
        const reason = (result && result.reason) || 'mic-error';
        setState('idle', { reason });
        // 设备 / 权限问题只给一次轻量提示，绝不反复弹框
        bubble(
          reason === 'permission-denied'
            ? '哼、麦克风被拦住了…去系统设置里放开嘛'
            : '听不到你说话…麦克风好像不太行',
          'warn'
        );
        return { ok: false, reason, state };
      }

      setState('listening', { reason: 'mic-ready' });
      return { ok: true, state };
    }

    /**
     * 采集侧判定"一段有效语音结束"，把编码好的 WAV 交给识别。
     *
     * @param {{bytes?: Uint8Array|ArrayBuffer, wav?: Uint8Array|ArrayBuffer, durationMs?: number, accepted?: boolean, reason?: string}} segment
     * @returns {Promise<{ok: boolean, reason?: string, state: string, transcript?: string, reply?: string}>}
     */
    async function onSpeechEnd(segment) {
      const info = segment && typeof segment === 'object' ? segment : {};

      // 无效片段（太短 / 压根没人声）：直接丢弃，绝不当作一次用户发言
      if (info.accepted === false) {
        return { ok: false, reason: 'segment-rejected', state };
      }
      if (disposed) return { ok: false, reason: 'disposed', state };

      const bytes = info.bytes instanceof Uint8Array
        ? info.bytes
        : info.wav instanceof Uint8Array
          ? info.wav
          : info.bytes instanceof ArrayBuffer
            ? new Uint8Array(info.bytes)
            : null;
      if (!bytes || bytes.byteLength === 0) {
        return { ok: false, reason: 'empty-audio', state };
      }

      // 正在说话 / 正在处理上一轮：绝不允许重入（否则会出现两轮抢麦）
      if (state !== 'listening') {
        return { ok: false, reason: 'busy', state };
      }

      // 1) 识别（语音段上传 / 本地降级全部发生在主进程里）
      setState('transcribing', { reason: 'speech-end', durationMs: info.durationMs || 0 });
      if (typeof pipelines.transcribe !== 'function') {
        setState('listening', { reason: 'no-asr' });
        return { ok: false, reason: 'no-asr', state };
      }

      let asr = null;
      try {
        asr = await pipelines.transcribe(bytes, { durationMs: info.durationMs || 0, format: 'wav' });
      } catch {
        asr = { ok: false, code: 'network' };
      }
      if (disposed) return { ok: false, reason: 'disposed', state };

      if (!asr || asr.ok !== true || typeof asr.text !== 'string' || asr.text.trim().length === 0) {
        // 明确区分"识别成功但没听出内容"与"识别链路失败"
        const code = !asr || asr.ok !== true
          ? ((asr && asr.code) || 'network')
          : 'empty-transcript';
        const classified = classifyError(code);
        setState('listening', { reason: code });

        if (code === 'no-audio') {
          // 根本没有音频：安静跳过（不该发生，调用方已经过滤过空片段）
          return { ok: false, reason: code, state };
        }
        if (code === 'empty-transcript') {
          bubble(TEXTS.emptySpeech, 'info');
          return { ok: false, reason: code, state };
        }
        bubble(classified.text, classified.kind === 'no-brain' ? 'warn' : 'error');
        return { ok: false, reason: code, state };
      }

      const transcript = asr.text.trim();
      lastTranscript = transcript;

      // 太短的误触发（咳嗽、键盘声、单字语气词）不回复，直接回到监听
      if (transcript.length < minTranscriptChars) {
        setState('listening', { reason: 'too-short' });
        return { ok: false, reason: 'too-short', state, transcript };
      }

      // 2) 对话：**没有 Key 就绝不调用聊天模型**（识别结果只在本地用）
      const canChat = asr.chat !== false;
      if (!canChat) {
        bubble(TEXTS.noBrain, 'warn');
        setState('listening', { reason: 'no-api-key' });
        return { ok: false, reason: 'no-api-key', state, transcript };
      }

      setState('thinking', { reason: 'asr-done' });
      if (typeof pipelines.chat !== 'function') {
        bubble(TEXTS.noBrain, 'warn');
        setState('listening', { reason: 'no-chat' });
        return { ok: false, reason: 'no-chat', state, transcript };
      }

      let chat = null;
      try {
        chat = await pipelines.chat(transcript);
      } catch {
        chat = { ok: false, code: 'network' };
      }
      if (disposed) return { ok: false, reason: 'disposed', state };

      if (!chat || chat.ok !== true || typeof chat.text !== 'string' || chat.text.trim().length === 0) {
        const code = (chat && chat.code) || 'network';
        const classified = classifyError(code);
        bubble(classified.text, classified.kind === 'no-brain' ? 'warn' : 'error');
        setState('listening', { reason: code });
        return { ok: false, reason: code, state, transcript };
      }

      const reply = chat.text.trim();
      lastReply = reply;

      // 3) 播报：**先停采**，播完（或失败）再按 micEnabled 恢复
      await speakAndResume(reply);
      return { ok: true, state, transcript, reply };
    }

    /**
     * 播报一段语音：停采 → TTS 播放 → 恢复采集（仅 micEnabled）。
     * 字幕模式开启时同步显示同一段文字。
     * @param {string} text
     * @returns {Promise<{ok: boolean, reason?: string}>}
     */
    async function speakAndResume(text) {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, reason: 'empty-text' };
      }
      const reply = text.trim();

      // 停采：TTS 播放期间必须停止采集，避免鱼"自言自语"回环
      stopCapture('speaking');
      setState('speaking', { reason: 'tts-start' });

      // 字幕与语音同源：打开字幕模式才显示，内容一字不差
      if (captionEnabled() === true) {
        try {
          onCaption(reply);
        } catch {
          // 忽略
        }
      }

      let spoken = null;
      if (typeof pipelines.speak === 'function') {
        try {
          spoken = await pipelines.speak(reply, { caption: captionEnabled() === true });
        } catch {
          spoken = { ok: false, code: 'tts-failed' };
        }
      } else {
        spoken = { ok: false, code: 'no-tts' };
      }

      if (disposed) return { ok: false, reason: 'disposed' };

      // 播放失败时明确提示一次（不静默只显示文字）
      if (!spoken || spoken.ok !== true) {
        bubble('本鱼嗓子哑了…等会儿再说', 'error');
      }

      resumeCapture('tts-end');
      return { ok: Boolean(spoken && spoken.ok === true), reason: spoken && spoken.code };
    }

    /** 关闭采集（不改变 micEnabled 意愿） */
    function stopCapture(reason) {
      if (typeof mic.pause === 'function') {
        try {
          mic.pause(reason || 'pause');
        } catch {
          // 采集侧异常不应影响回合状态
        }
      }
    }

    /** 按 micEnabled 决定是否恢复监听 */
    function resumeCapture(reason) {
      if (disposed) return;
      if (!micEnabled) {
        setState('idle', { reason: 'mic-disabled-after-speech' });
        return;
      }
      if (typeof mic.resume === 'function') {
        try {
          const result = mic.resume(reason || 'resume');
          // resume 返回 Promise（要重新 getUserMedia）时等它落定再报 listening
          if (result && typeof result.then === 'function') {
            result
              .then((value) => {
                if (disposed) return;
                if (value && value.ok === false) {
                  setState('idle', { reason: value.reason || 'mic-error' });
                } else {
                  setState('listening', { reason: 'resumed' });
                }
              })
              .catch(() => {
                if (!disposed) setState('idle', { reason: 'mic-error' });
              });
            return;
          }
        } catch {
          setState('idle', { reason: 'mic-error' });
          return;
        }
      }
      setState('listening', { reason: 'resumed' });
    }

    /**
     * 用户开 / 关麦克风（菜单「语音对话」、全局 Ctrl+Shift+V、设置页开关都走这里）。
     * @param {boolean} enabled
     * @returns {Promise<{ok: boolean, enabled: boolean, state: string, reason?: string}>}
     */
    async function setMicEnabled(enabled) {
      const next = enabled === true;
      if (micEnabled === next) {
        return { ok: true, enabled: micEnabled, state, reason: 'unchanged' };
      }
      micEnabled = next;
      if (!next) {
        stopCapture('mic-off');
        setState('idle', { reason: 'mic-off' });
        bubble(TEXTS.micOff, 'info');
        return { ok: true, enabled: false, state };
      }
      // 重新开麦：等真正拿到设备再报 listening
      const result = await start();
      if (result.ok) bubble(TEXTS.micOn, 'info');
      return { ok: result.ok, enabled: true, state, reason: result.reason };
    }

    /**
     * 打开 / 关闭麦克风（翻转当前值）。
     * @returns {Promise<{ok: boolean, enabled: boolean, state: string}>}
     */
    async function toggleMic() {
      return setMicEnabled(!micEnabled);
    }

    /**
     * 外部（采集侧）通知"已进入低采样空闲监测 / 已被唤醒"。
     * @param {'idle-enter'|'wakeup'} kind
     */
    function notifyIdle(kind) {
      if (kind === 'idle-enter') {
        bubble(TEXTS.bedtime, 'info');
        return;
      }
      bubble(TEXTS.micOn, 'info');
    }

    /** 释放：清掉采集、标记不再自动恢复 */
    function dispose() {
      disposed = true;
      stopCapture('dispose');
      state = 'idle';
      lastTranscript = '';
      lastReply = '';
      if (typeof mic.close === 'function') {
        try {
          mic.close('dispose');
        } catch {
          // 忽略
        }
      }
    }

    return {
      start,
      onSpeechEnd,
      speakAndResume,
      setMicEnabled,
      toggleMic,
      notifyIdle,
      classifyError,
      dispose,
      getState: () => state,
      isMicEnabled: () => micEnabled,
      getLastTranscript: () => lastTranscript,
      getLastReply: () => lastReply,
      TEXTS
    };
  }

  return {
    TEXTS,
    NO_BRAIN_CODES,
    NETWORK_CODES,
    classifyError,
    createTurnTaking
  };
});
