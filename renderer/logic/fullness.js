'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯逻辑模块：饱食度（fullness）
 * ============================================================================
 *
 * 本模块【不依赖 DOM、不依赖 Electron、不依赖任何第三方库】，时间与存储都是注入的，
 * 因此同一份代码可以：
 *   - 在渲染层里通过 <script> 加载（挂到 window.BFFLogic.fullness）；
 *   - 在裸 node 单元测试里配"假时钟 + 假存储 + 假 uuid"真正执行
 *     （tests/fullness.test.js），不需要真的等几分钟。
 *
 * ---------------------------------------------------------------------------
 * 设计（明确写死，避免"随实际时间漂移"的模糊行为）
 * ---------------------------------------------------------------------------
 *   - 初始饱食度 100；
 *   - 每分钟下降 5 点（= 每毫秒 5/60000 点），基于**时间戳差值**而不是定时器次数，
 *     所以页面被节流、窗口被收进托盘、甚至程序关闭一段时间，都能按真实时间补算；
 *   - 饱食度 ≤ 30 进入 hungry（催饭）；
 *   - 连续处于"低饱食（≤30）"状态满 3 分钟进入 angry；
 *   - 喂饭：立刻回到 100，并清空 hungry 计时；
 *   - **睡觉不暂停下降**：这是刻意的设计——睡着的鱼也会饿，醒来就催饭；
 *   - 数值永远夹在 [0, 100]，任何情况下都不会出现负数或超过上限；
 *   - 离线补算用 storage 里存的时间戳；遇到"时间戳在未来"（系统时钟被改早、
 *     跨时区、手动调表）时按"时长 0"处理，绝不让饱食度因为负时长而回涨。
 *
 * 持久化内容只有饱食度与两个时间戳，不含任何 API Key 或隐私数据。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BFFLogic = root.BFFLogic || {};
    root.BFFLogic.fullness = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MS_PER_MINUTE = 60000;

  /** 饱食度全部可调参数（集中在一处，测试与上层都引用这里） */
  const FULLNESS = Object.freeze({
    MIN: 0,
    MAX: 100,
    INITIAL: 100,
    /** 每分钟下降点数（2026-10-05 调快：1 → 5，约 14 分钟从满状态饿到蔫，肉眼可见） */
    DECAY_PER_MINUTE: 5,
    /** ≤ 该值进入 hungry */
    HUNGRY_AT: 30,
    /** 低饱食持续该毫秒数后进入 angry（10 分钟 → 3 分钟） */
    ANGRY_AFTER_MS: 3 * MS_PER_MINUTE,
    /** 渲染层刷新间隔（只影响显示延迟，不影响到数值计算） */
    TICK_MS: 15000,
    /** 落盘最小间隔 */
    SAVE_MIN_INTERVAL_MS: MS_PER_MINUTE,
    STORAGE_KEY: 'blueFatFish.fullness.v1',
    STORAGE_VERSION: 1
  });

  /**
   * 把数值夹到 [0, 100]。非有限值（NaN / Infinity / 字符串垃圾）退回 MIN，
   * 由 normalizeSnapshot 在更外层把"整条记录损坏"的情况重置为 INITIAL。
   * @param {unknown} value
   * @returns {number}
   */
  function clampFullness(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return FULLNESS.MIN;
    if (num < FULLNESS.MIN) return FULLNESS.MIN;
    if (num > FULLNESS.MAX) return FULLNESS.MAX;
    return num;
  }

  /**
   * 全新的饱食度状态。
   * @param {number} now 当前时间戳（毫秒）
   */
  function createInitialState(now) {
    const time = Number.isFinite(now) ? now : 0;
    return {
      value: FULLNESS.INITIAL,
      savedAt: time,
      hungrySince: null,
      version: FULLNESS.STORAGE_VERSION
    };
  }

  /**
   * 把任意来源（localStorage 反序列化结果）的数据规整成合法状态。
   * 处理：损坏 / 缺字段 / 类型不对 / 越界 / 未来时间戳。
   * @param {unknown} raw
   * @param {number} now
   * @returns {{state: object, corrupted: boolean, restored: boolean, notes: string[]}}
   */
  function normalizeSnapshot(raw, now) {
    const time = Number.isFinite(now) ? now : 0;
    const notes = [];

    if (!raw || typeof raw !== 'object') {
      if (raw !== null && raw !== undefined) notes.push('记录不是对象');
      return { state: createInitialState(time), corrupted: notes.length > 0, restored: false, notes };
    }

    const value = Number(raw.value);
    const savedAt = Number(raw.savedAt);

    if (!Number.isFinite(value)) {
      notes.push('饱食度不是数字');
      return { state: createInitialState(time), corrupted: true, restored: false, notes };
    }
    if (!Number.isFinite(savedAt) || savedAt <= 0) {
      notes.push('缺少可用的时间戳');
      return { state: createInitialState(time), corrupted: true, restored: false, notes };
    }

    let nextValue = clampFullness(value);
    if (nextValue !== value) {
      notes.push('饱食度越界，已夹到 [0, 100]');
    }

    // 未来时间戳：按"时长 0"处理，既不会倒扣也不会回涨
    let saved = savedAt;
    if (saved > time) {
      notes.push('时间戳在未来，按 0 时长处理');
      saved = time;
    }

    // 注意：不要把 null 用 Number(null)=0 变成"1970 年就饿了"，那会一载入就 angry
    let hungrySince = null;
    if (raw.hungrySince !== null && raw.hungrySince !== undefined) {
      const since = Number(raw.hungrySince);
      hungrySince = Number.isFinite(since) && since > 0 && since <= time ? since : null;
    }

    return {
      state: { value: nextValue, savedAt: saved, hungrySince, version: FULLNESS.STORAGE_VERSION },
      corrupted: false,
      restored: true,
      notes
    };
  }

  /**
   * 按真实时间差衰减。
   * @param {{value: number, savedAt: number, hungrySince: number|null}} state
   * @param {number} now
   */
  function decayTo(state, now) {
    const time = Number.isFinite(now) ? now : state.savedAt;
    let elapsed = time - state.savedAt;
    // 未来时间戳 / 非法值：按 0 处理，保证只会下降、不会上升
    if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;

    const previousValue = clampFullness(state.value);
    const lost = (elapsed / MS_PER_MINUTE) * FULLNESS.DECAY_PER_MINUTE;
    const value = clampFullness(previousValue - lost);

    let hungrySince = state.hungrySince;
    if (value > FULLNESS.HUNGRY_AT) {
      // 回到健康区间：清空低饱食计时
      hungrySince = null;
    } else if (!Number.isFinite(hungrySince)) {
      // 精确算出"跌破阈值"的时刻；本来就已低于阈值时用本次区间的起点兜底
      if (previousValue > FULLNESS.HUNGRY_AT) {
        hungrySince =
          state.savedAt + ((previousValue - FULLNESS.HUNGRY_AT) / FULLNESS.DECAY_PER_MINUTE) * MS_PER_MINUTE;
      } else {
        hungrySince = state.savedAt;
      }
      if (!Number.isFinite(hungrySince) || hungrySince > time) hungrySince = time;
    }

    return { value, savedAt: time, hungrySince, version: FULLNESS.STORAGE_VERSION };
  }

  /**
   * 由状态推导情绪：'idle' | 'hungry' | 'angry'。
   * @param {{value: number, savedAt: number, hungrySince: number|null}} state
   * @param {number} now
   * @returns {'idle'|'hungry'|'angry'}
   */
  function deriveMood(state, now) {
    const time = Number.isFinite(now) ? now : state.savedAt;
    if (state.value > FULLNESS.HUNGRY_AT) return 'idle';
    const since = Number.isFinite(state.hungrySince) ? state.hungrySince : state.savedAt;
    return time - since >= FULLNESS.ANGRY_AFTER_MS ? 'angry' : 'hungry';
  }

  /**
   * 喂饭：回到满值并清空低饱食计时。
   * @param {object} state
   * @param {number} now
   */
  function applyFeed(state, now) {
    const time = Number.isFinite(now) ? now : state.savedAt;
    return {
      value: FULLNESS.INITIAL,
      savedAt: time,
      hungrySince: null,
      version: FULLNESS.STORAGE_VERSION
    };
  }

  /** 序列化成存储字符串 */
  function serialize(state) {
    return JSON.stringify({
      version: FULLNESS.STORAGE_VERSION,
      value: state.value,
      savedAt: state.savedAt,
      hungrySince: state.hungrySince
    });
  }

  /**
   * 反序列化 + 规整。空字符串 / 没存过 → 全新状态且不算损坏；
   * JSON 解析失败 → 记为损坏并给出全新状态（绝不让坏数据把桌宠卡住）。
   * @param {unknown} text
   * @param {number} now
   */
  function parseSerialized(text, now) {
    if (typeof text !== 'string' || text.length === 0) {
      return { state: createInitialState(now), corrupted: false, restored: false, notes: ['没有历史记录'] };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { state: createInitialState(now), corrupted: true, restored: false, notes: ['JSON 解析失败'] };
    }
    return normalizeSnapshot(parsed, now);
  }

  /**
   * 带持久化与定时刷新的饱食度控制器。
   *
   * @param {{
   *   storage?: {read: () => (string|null), write: (text: string) => void, clear?: () => void} | null,
   *   clock?: () => number,
   *   tickMs?: number,
   *   onChange?: (info: {mood: string, previous: string, value: number, reason: string}) => void
   * }} [options]
   */
  function createFullness(options) {
    const opts = options || {};
    const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now();
    const storage = opts.storage || null;
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    const tickMs = Number.isFinite(opts.tickMs) && opts.tickMs > 0 ? opts.tickMs : FULLNESS.TICK_MS;

    let state = createInitialState(clock());
    let mood = deriveMood(state, state.savedAt);
    let corrupted = false;
    let lastSavedAt = 0;
    let timer = 0;

    function readStorage() {
      if (!storage || typeof storage.read !== 'function') return null;
      try {
        return storage.read();
      } catch (error) {
        corrupted = true;
        return null;
      }
    }

    function writeStorage() {
      if (!storage || typeof storage.write !== 'function') return false;
      try {
        storage.write(serialize(state));
        lastSavedAt = clock();
        return true;
      } catch (error) {
        // 存储不可用（配额 / 权限 / file:// 限制）时静默降级为"仅内存"
        return false;
      }
    }

    /** 把情绪变化回调出去（只在真的变了的时候） */
    function publish(previous, reason) {
      if (mood === previous) return;
      onChange({ mood, previous, value: state.value, reason });
    }

    /** 从存储恢复：先按时间戳补算离线下降，再推导情绪 */
    function load() {
      const now = clock();
      const text = readStorage();
      const parsed = parseSerialized(text, now);
      // 注意：这里必须再做一次 decayTo —— 存储里记的是"上次保存的时刻"，
      // 程序关闭期间少掉的那部分饱食度就是靠这一步补算出来的。
      state = decayTo(parsed.state, now);
      corrupted = parsed.corrupted;
      const previous = mood;
      mood = deriveMood(state, now);
      publish(previous, 'load');
      return { value: state.value, mood, corrupted, restored: parsed.restored, notes: parsed.notes };
    }

    /** 按当前时间重算（不落盘） */
    function refresh(now) {
      const time = Number.isFinite(now) ? now : clock();
      const previous = mood;
      state = decayTo(state, time);
      mood = deriveMood(state, time);
      publish(previous, 'tick');
      return { value: state.value, mood };
    }

    /** 定时调用：重算 + 按最小间隔落盘 */
    function tick(now) {
      const result = refresh(now);
      if (clock() - lastSavedAt >= FULLNESS.SAVE_MIN_INTERVAL_MS) {
        writeStorage();
      }
      return result;
    }

    /** 喂饭：先结清时间差，再回满 */
    function feed(now) {
      const time = Number.isFinite(now) ? now : clock();
      state = decayTo(state, time);
      const previous = mood;
      state = applyFeed(state, time);
      mood = deriveMood(state, time);
      publish(previous, 'feed');
      writeStorage();
      return { value: state.value, mood };
    }

    /** 立刻重算并落盘（页面隐藏 / 退出前调用） */
    function save(now) {
      refresh(now);
      return writeStorage();
    }

    function start() {
      if (timer) return;
      timer = setInterval(() => tick(), tickMs);
    }

    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = 0;
      }
    }

    return {
      load,
      refresh,
      tick,
      feed,
      save,
      start,
      stop,
      getValue: () => state.value,
      getMood: () => mood,
      getState: () => ({ ...state }),
      isCorrupted: () => corrupted,
      storageKey: FULLNESS.STORAGE_KEY
    };
  }

  return {
    FULLNESS,
    MS_PER_MINUTE,
    clampFullness,
    createInitialState,
    normalizeSnapshot,
    decayTo,
    deriveMood,
    applyFeed,
    serialize,
    parseSerialized,
    createFullness
  };
});
