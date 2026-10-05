'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯逻辑模块：本地 JS VAD（语音活动检测，阶段 4）
 * ============================================================================
 *
 * 需求（阶段 4「连续语音对话」第 3 条）逐条落到这里：
 *   - 麦克风常开、免按键：检测到"人声开始"就进入录音，**连续静音达到阈值**
 *     （默认 800ms）就断句并自动提交；
 *   - **30 秒无人说话**进入"低采样 / 低频监测"省 CPU，一检测到声音立刻唤醒；
 *   - 单段语音 **最长 30 秒**（到点强制断句并立刻起新段，绝不丢字）；
 *   - 不能把无声片段当用户发言（起始需要连续若干帧越过唤醒阈值，且段内有效语音帧
 *     与时长都要达标才 accepted）。
 *
 * 为什么单独成模块：
 *   本模块【不依赖 DOM、不依赖 WebAudio、不依赖 Electron、不依赖任何第三方库】，
 *   只接收"每一帧的音量级别 + 该帧编码后的字节数 + 当前时间戳"，输出状态迁移事件。
 *   因此：
 *     - 浏览器渲染层用 <script> 加载后 `window.BFFLogic.vad` 就是渲染层真正跑的那份；
 *     - 裸 node 单元测试可以注入**假时钟**（直接喂 timestampMs）把 800ms 静音、
 *       30 秒上限、30 秒空闲唤醒全部毫秒级跑完，不需要真实音频设备。
 *
 * ---------------------------------------------------------------------------
 * 状态机（两个状态 + 一个空闲标记，全部可断言）
 * ---------------------------------------------------------------------------
 *
 *   quiet ──(连续 >= wakeFrames 帧 level >= wakeThreshold)──► speaking
 *     ▲                                                          │
 *     │                    (连续 silenceMs 静音 / 段时长 >= maxSegmentMs
 *     │                     / 编码字节 >= maxBytes)
 *     └────────────── segment-end（accepted 决定要不要送去识别）──┘
 *
 *   quiet 内部还有一个"空闲降采样"标记 `lowRate`：连续 idleAfterMs（默认 30000ms）
 *   没有检测到人声时置位，提示采集侧把扫描频率降下来省 CPU；下一帧一旦越过唤醒阈值
 *   就立刻清掉（"一检测到声音即唤醒"）。
 *
 * 事件（按发生顺序 push 到 feed()/stop() 返回的 events 数组，同时回调 onEvent）：
 *   - {type:'speech-start', atMs, startedAtMs}
 *   - {type:'segment-end', atMs, reason, startedAtMs, durationMs, frames, voicedFrames, bytes, accepted}
 *       reason:   'silence' | 'max-duration' | 'max-bytes' | 'stopped'
 *       accepted: 是否是"值得送去识别"的语音段（太短 / 有效语音帧太少 → false，
 *                 调用方必须直接丢弃，绝不把无声片段当用户发言）
 *   - {type:'idle-enter', atMs}                     进入低采样空闲监测
 *   - {type:'wakeup', atMs}                         从空闲监测被声音唤醒
 *   - {type:'speech-continue', atMs, reason}        30 秒上限切段后立刻续段
 *
 * 注意：本模块只做"决策"，不碰音频设备、不做编码、不发网络请求。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BFFLogic = root.BFFLogic || {};
    root.BFFLogic.vad = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 默认配置（设置页里的"VAD 灵敏度 / 静音判定毫秒"改的就是 threshold / silenceMs） */
  const DEFAULT_CONFIG = Object.freeze({
    /** 唤醒（判定"有人在说话"）的音量阈值：RMS 归一化到 0~1 */
    wakeThreshold: 0.045,
    /** 维持说话状态的阈值：低于唤醒阈值，形成迟滞，避免电平抖动导致疯狂断句 */
    endThreshold: 0.02,
    /** 连续静音多久算"说完了"（需求默认 800ms） */
    silenceMs: 800,
    /** 唤醒需要连续满足阈值的帧数（默认 3 帧；按 ~20ms 一帧约 60ms） */
    wakeFrames: 3,
    /** 单段语音最长时长（需求硬上限 30 秒） */
    maxSegmentMs: 30000,
    /** 单段编码后字节上限（默认 20MB，低于 ASR 的 25MB 文件上限，留余量） */
    maxBytes: 20 * 1024 * 1024,
    /** 多久没人说话进入低采样空闲监测（需求 30 秒） */
    idleAfterMs: 30000,
    /** 一段语音至少要有多少个"有效语音帧"才值得识别（防咳嗽 / 键盘声误触发） */
    minVoicedFrames: 4,
    /** 一段语音至少持续多少毫秒才值得识别（约 2 帧，滤掉瞬时爆音） */
    minSegmentMs: 80
  });

  /**
   * 把用户可调的"灵敏度"映射成唤醒阈值。
   * 语义：灵敏度 0~1 越大越灵敏 → 阈值越低，越容易触发。
   * @param {unknown} sensitivity
   * @returns {number}
   */
  function sensitivityToThreshold(sensitivity) {
    const value = Number(sensitivity);
    const s = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
    // 分段线性，三点固定：
    //   灵敏度 0.5（默认）→ 0.045（就是默认阈值，保证"默认设置 == 默认阈值"）
    //   灵敏度 0（迟钝）  → 0.100
    //   灵敏度 1（灵敏）  → 0.012
    // 单调递减（越大越灵敏），且不做浮点运算之外的任何猜测。
    const at = s <= 0.5
      ? 0.1 + (0.045 - 0.1) * (s / 0.5)
      : 0.045 + (0.012 - 0.045) * ((s - 0.5) / 0.5);
    return Number(at.toFixed(6));
  }

  /**
   * 归一化配置：非法值一律回落到默认值，绝不抛异常。
   * @param {object} [raw]
   * @returns {object}
   */
  function normalizeConfig(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const pickNumber = (key, min, max) => {
      // 注意：null / '' / 布尔 都视为"没给"，直接回落默认值。
      // 不能只用 Number.isFinite(Number(x))：Number(null) 是 0（有限），
      // 那样 null 会被夹成下限，反而比"用默认值"更离谱。
      const raw = input[key];
      if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
        return DEFAULT_CONFIG[key];
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) return DEFAULT_CONFIG[key];
      return Math.min(max, Math.max(min, value));
    };

    // 唤醒阈值可以由 threshold 直接给，也可以由 sensitivity（0~1）换算
    let wakeThreshold = DEFAULT_CONFIG.wakeThreshold;
    if (Number.isFinite(Number(input.threshold))) {
      wakeThreshold = Math.min(1, Math.max(0, Number(input.threshold)));
    } else if (Number.isFinite(Number(input.sensitivity))) {
      wakeThreshold = sensitivityToThreshold(input.sensitivity);
    }

    // 维持阈值必须 <= 唤醒阈值，否则迟滞关系不成立、静音判定会失灵
    let endThreshold = Number.isFinite(Number(input.endThreshold))
      ? Math.min(1, Math.max(0, Number(input.endThreshold)))
      : Math.max(0.001, wakeThreshold * 0.45);
    if (endThreshold > wakeThreshold) endThreshold = wakeThreshold;

    return Object.freeze({
      wakeThreshold,
      endThreshold,
      silenceMs: Math.round(pickNumber('silenceMs', 100, 10000)),
      wakeFrames: Math.round(pickNumber('wakeFrames', 1, 20)),
      maxSegmentMs: Math.round(pickNumber('maxSegmentMs', 1000, 120000)),
      maxBytes: Math.round(pickNumber('maxBytes', 1024, 64 * 1024 * 1024)),
      idleAfterMs: Math.round(pickNumber('idleAfterMs', 1000, 600000)),
      minVoicedFrames: Math.round(pickNumber('minVoicedFrames', 0, 1000)),
      minSegmentMs: Math.round(pickNumber('minSegmentMs', 0, 10000))
    });
  }

  /**
   * 创建一个 VAD 检测器。
   *
   * @param {{
   *   config?: object,
   *   onEvent?: (event: object) => void
   * }} [options]
   */
  function createVad(options) {
    const opts = options || {};
    let config = normalizeConfig(opts.config);
    const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;

    /** 'quiet' | 'speaking' */
    let state = 'quiet';
    /** 连续越过唤醒阈值的帧数 */
    let wakeRun = 0;
    /** 段内累计的静音时长 */
    let silenceAccumMs = 0;
    /** 当前段开始时间 */
    let startedAtMs = 0;
    /** 上一帧时间戳（帧间隔自己算，不依赖定时器精度） */
    let lastFrameAtMs = null;
    /** 段内统计 */
    let frames = 0;
    let voicedFrames = 0;
    let bytes = 0;
    /** 是否处于低采样空闲监测 */
    let lowRate = false;
    /** 最近一次检测到人声的时间（idleAfterMs 判定用） */
    let lastVoiceSeenAtMs = 0;

    /** 只往 events 里塞事件；真正的 onEvent 回调在 feed/stop 末尾统一触发 */
    function push(events, event) {
      events.push(event);
      return event;
    }

    /** 开始新的一段（重置段内计数） */
    function openSegment(events, atMs) {
      state = 'speaking';
      startedAtMs = atMs;
      frames = 0;
      voicedFrames = 0;
      bytes = 0;
      silenceAccumMs = 0;
      wakeRun = 0;
      return push(events, { type: 'speech-start', atMs, startedAtMs });
    }

    /**
     * 结束当前段。
     * @param {object[]} events
     * @param {number} atMs
     * @param {'silence'|'max-duration'|'max-bytes'|'stopped'} reason
     */
    function closeSegment(events, atMs, reason) {
      const durationMs = Math.max(0, atMs - startedAtMs);
      // 只有"真的有人声且够长"的段才值得送去识别，避免把无声片段当用户发言
      const accepted =
        reason !== 'stopped' &&
        voicedFrames >= config.minVoicedFrames &&
        durationMs >= config.minSegmentMs;
      const event = {
        type: 'segment-end',
        atMs,
        reason,
        startedAtMs,
        durationMs,
        frames,
        voicedFrames,
        bytes,
        accepted
      };
      state = 'quiet';
      silenceAccumMs = 0;
      wakeRun = 0;
      return push(events, event);
    }

    function fire(events) {
      for (const event of events) {
        if (onEvent) {
          try {
            onEvent(event);
          } catch {
            // 回调抛错绝不影响 VAD 自身状态推进
          }
        }
      }
    }

    /**
     * 喂一帧。
     * @param {{level?: number, rms?: number, bytes?: number, timestampMs?: number}} frame
     *   level: 归一化音量（0~1，也可用 rms 字段）；bytes: 本帧编码后的字节增量；
     *   timestampMs: 当前时间戳（必填；假时钟测试直接给）
     * @returns {{state: string, events: object[], snapshot: object}}
     */
    function feed(frame) {
      const input = frame && typeof frame === 'object' ? frame : {};
      let rawLevel = Number(input.level);
      if (!Number.isFinite(rawLevel)) rawLevel = Number(input.rms);
      const level = Number.isFinite(rawLevel) ? Math.min(1, Math.max(0, rawLevel)) : 0;

      const now = Number(input.timestampMs);
      const atMs = Number.isFinite(now) ? now : (lastFrameAtMs === null ? 0 : lastFrameAtMs + 20);
      const deltaMs = lastFrameAtMs === null ? 0 : Math.max(0, atMs - lastFrameAtMs);
      lastFrameAtMs = atMs;

      const events = [];
      const addBytes = Number(input.bytes);

      if (state === 'quiet') {
        if (level >= config.wakeThreshold) {
          wakeRun += 1;
          lastVoiceSeenAtMs = atMs;
        } else {
          wakeRun = 0;
        }

        if (wakeRun >= config.wakeFrames) {
          if (lowRate) {
            lowRate = false;
            push(events, { type: 'wakeup', atMs });
          }
          openSegment(events, atMs);
          if (Number.isFinite(addBytes) && addBytes > 0) bytes += Math.round(addBytes);
        } else if (!lowRate && atMs - lastVoiceSeenAtMs >= config.idleAfterMs) {
          // 30 秒没人说话：进入低采样 / 低频监测省 CPU（采集侧据此降频）
          lowRate = true;
          push(events, { type: 'idle-enter', atMs });
        }
      } else {
        frames += 1;
        if (Number.isFinite(addBytes) && addBytes > 0) bytes += Math.round(addBytes);

        if (level >= config.endThreshold) {
          voicedFrames += 1;
          silenceAccumMs = 0;
        } else {
          silenceAccumMs += deltaMs;
        }

        const durationMs = atMs - startedAtMs;
        if (durationMs >= config.maxSegmentMs) {
          // 单段到 30 秒上限：先安全收尾提交，再立刻开新段继续听（不丢字）
          closeSegment(events, atMs, 'max-duration');
          push(events, { type: 'speech-continue', atMs, reason: 'max-duration' });
          openSegment(events, atMs);
        } else if (bytes >= config.maxBytes) {
          closeSegment(events, atMs, 'max-bytes');
          push(events, { type: 'speech-continue', atMs, reason: 'max-bytes' });
          openSegment(events, atMs);
        } else if (silenceAccumMs >= config.silenceMs) {
          // 连续静音达到阈值：说话结束，自动提交
          closeSegment(events, atMs, 'silence');
          lastVoiceSeenAtMs = atMs;
        }
      }

      fire(events);
      return { state, events, snapshot: snapshot() };
    }

    /**
     * 强制停止：正在录音时以 'stopped' 收尾（accepted 恒为 false，绝不提交）。
     * 用于"TTS 播放前停采""用户关麦""窗口隐藏""退出"等场景。
     * @param {number} [atMs]
     */
    function stop(atMs) {
      const now = Number(atMs);
      const at = Number.isFinite(now) ? now : (lastFrameAtMs === null ? 0 : lastFrameAtMs);
      const events = [];
      if (state === 'speaking') {
        closeSegment(events, at, 'stopped');
      }
      state = 'quiet';
      wakeRun = 0;
      silenceAccumMs = 0;
      lowRate = false;
      fire(events);
      return { state, events, snapshot: snapshot() };
    }

    /** 复位（换设置、重开麦时用）；传了 nextConfig 就同时换配置 */
    function reset(nextConfig) {
      if (nextConfig) config = normalizeConfig(nextConfig);
      state = 'quiet';
      wakeRun = 0;
      silenceAccumMs = 0;
      startedAtMs = 0;
      lastFrameAtMs = null;
      frames = 0;
      voicedFrames = 0;
      bytes = 0;
      lowRate = false;
      lastVoiceSeenAtMs = 0;
      return snapshot();
    }

    function snapshot() {
      return {
        state,
        lowRate,
        startedAtMs,
        frames,
        voicedFrames,
        bytes,
        silentMs: state === 'speaking' ? silenceAccumMs : 0,
        config
      };
    }

    return {
      feed,
      stop,
      reset,
      snapshot,
      isSpeaking: () => state === 'speaking',
      isLowRate: () => lowRate,
      getConfig: () => config
    };
  }

  return {
    DEFAULT_CONFIG,
    normalizeConfig,
    sensitivityToThreshold,
    createVad
  };
});
