'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯逻辑模块：动作状态机
 * ============================================================================
 *
 * 本模块【不依赖 DOM、不依赖 Electron、不依赖任何第三方库】，只做状态转移决策，
 * 因此同一份代码可以：
 *   - 在浏览器渲染层里通过 <script> 加载（挂到 window.BFFLogic.stateMachine）；
 *   - 在裸 node 环境下被单元测试 require（tests/state-machine.test.js）真正执行。
 *
 * ---------------------------------------------------------------------------
 * 状态分层（这是"不会出现多个 CSS 动作互相打架"的关键设计）
 * ---------------------------------------------------------------------------
 * 1. 持久模式（persistent）：idle / hungry / angry / sleep
 *    由饱食度与菜单驱动，不会自己超时回落。可见状态 = 动作层没有动作时的底色。
 * 2. 短暂动作（transient）：blink / eat / happy / talking / thinking / poke / pet / shake / taunt /
 *    swim / flip / greet / wake
 *    有确定时长，时间到就"回落"到当前持久模式，并回调 onActionEnd 让上层串场
 *    （例如 eat 结束 → happy）。任何时刻最多只有一个短暂动作，定时器统一清理。
 * 3. 按住状态（hold）：dragged
 *    由用户按住鼠标驱动，优先级最高，进入时清掉正在播的短暂动作，松手后回落。
 *
 * ---------------------------------------------------------------------------
 * 优先级 / 打断规则（全部是可测试的显式规则，不靠 CSS 先后顺序兜）
 * ---------------------------------------------------------------------------
 *   - 持久模式之间：直接切换；`sleep` 是互斥模式，进入时会打断正在播的短暂动作，
 *     保证"睡觉不会被任何随机动作盖住"。睡觉期间 `setBase()` 只接受 `source: 'user'`
 *     （mood / random / system 一律拒绝），只有明确用户操作能把鱼叫醒。
 *   - 随机动作（source: 'random'，眨眼 / 游动 / 发呆）：
 *       · 睡觉时一律拒绝（reason: 'sleeping'）；
 *       · 拖拽中一律拒绝（reason: 'busy-dragging'）；
 *       · 任何短暂动作正在播时一律拒绝（reason: 'busy-random'）——
 *         所以随机动作永远不会插队、不会覆盖正在进行的动作，也不会互相叠加。
 *   - 用户交互（source: 'user'）：
 *       · 可以打断任何"可打断"的短暂动作；
 *       · 打断不了 eat / talking（interruptible: false，正在吃饭/说话不被打断）；
 *       · 唯一能把睡着的鱼叫醒的来源（随机与系统动作在睡觉时一律被拒）。
 *   - 系统动作（source: 'system'）：优先级低于正在播的动作时会被拒绝。
 *
 * 渲染层只把 `visible` 映射成 DOM 上的 state-* 类，`base` 映射成 mode-* 类，
 * 因此"动作层"与"底色层"的 CSS 动画天然分离，不会出现两个动画抢同一个元素。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BFFLogic = root.BFFLogic || {};
    root.BFFLogic.stateMachine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 状态定义表：kind / duration / priority / interruptible */
  const STATE_DEFS = Object.freeze({
    // ---- 持久模式（不会自动回落）----
    idle: Object.freeze({ kind: 'persistent', priority: 0 }),
    hungry: Object.freeze({ kind: 'persistent', priority: 0 }),
    angry: Object.freeze({ kind: 'persistent', priority: 0 }),
    // sleep 互斥：进入时打断正在播的动作，且拒绝一切随机动作
    sleep: Object.freeze({ kind: 'persistent', priority: 0, exclusive: true }),

    // ---- 短暂动作（到点回落到持久模式）----
    blink: Object.freeze({ kind: 'transient', duration: 200, priority: 10, interruptible: true }),
    // 跑步（原 swim 游动）：默认时长只做兜底，实际由主进程返回的 durationMs 覆盖
    swim: Object.freeze({ kind: 'transient', duration: 3200, priority: 25, interruptible: true }),
    wake: Object.freeze({ kind: 'transient', duration: 900, priority: 30, interruptible: true }),
    flip: Object.freeze({ kind: 'transient', duration: 1800, priority: 35, interruptible: true }),
    happy: Object.freeze({ kind: 'transient', duration: 2200, priority: 40, interruptible: true }),
    greet: Object.freeze({ kind: 'transient', duration: 2100, priority: 45, interruptible: true }),
    pet: Object.freeze({ kind: 'transient', duration: 1700, priority: 45, interruptible: true }),
    poke: Object.freeze({ kind: 'transient', duration: 1100, priority: 50, interruptible: true }),
    thinking: Object.freeze({ kind: 'transient', duration: 2400, priority: 55, interruptible: true }),
    // 摇头（闲置调皮动作：左右晃脑袋）；吐舌头嘲讽（挑眉吐舌+得意晃）
    shake: Object.freeze({ kind: 'transient', duration: 1400, priority: 40, interruptible: true }),
    taunt: Object.freeze({ kind: 'transient', duration: 1800, priority: 45, interruptible: true }),
    // 吃饭与说话不被打断（随机动作与低优先动作都无法插队，只能用户强插）
    eat: Object.freeze({ kind: 'transient', duration: 3000, priority: 60, interruptible: false }),
    talking: Object.freeze({ kind: 'transient', duration: 2600, priority: 65, interruptible: false }),

    // ---- 按住状态（用户按住鼠标期间）----
    dragged: Object.freeze({ kind: 'hold', priority: 100, interruptible: false })
  });

  const STATE_NAMES = Object.freeze(Object.keys(STATE_DEFS));
  const PERSISTENT_STATES = Object.freeze(['idle', 'hungry', 'angry', 'sleep']);
  const ACTION_STATES = Object.freeze(STATE_NAMES.filter((name) => STATE_DEFS[name].kind === 'transient'));
  const HOLD_STATES = Object.freeze(STATE_NAMES.filter((name) => STATE_DEFS[name].kind === 'hold'));

  /** 默认的定时器实现（浏览器与 node 都可用）；测试会注入假时钟 */
  const defaultSetTimer = (fn, ms) => setTimeout(fn, ms);
  const defaultClearTimer = (id) => clearTimeout(id);

  /**
   * 创建一个状态机实例。
   *
   * @param {{
   *   setTimer?: (fn: () => void, ms: number) => unknown,
   *   clearTimer?: (id: unknown) => void,
   *   onChange?: (visible: string, info: object) => void,
   *   onActionEnd?: (name: string, snapshot: object) => void
   * }} [options]
   */
  function createStateMachine(options) {
    const opts = options || {};
    const setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : defaultSetTimer;
    const clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : defaultClearTimer;
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    const onActionEnd = typeof opts.onActionEnd === 'function' ? opts.onActionEnd : () => {};

    /** 当前持久模式 */
    let base = 'idle';
    /** 当前短暂动作（null 表示没有） */
    let action = null;
    /** 当前按住状态（null 表示没有） */
    let hold = null;
    /** 短暂动作的定时器句柄；0 表示没有 */
    let actionTimer = 0;

    /** 当前对外可见的状态：按住 > 动作 > 持久模式 */
    function visible() {
      return hold || action || base;
    }

    /** 打一份快照，便于测试与上层调试 */
    function snapshot() {
      return { base, action, hold, visible: visible(), hasTimer: Boolean(actionTimer) };
    }

    function emit(reason, previous) {
      onChange(visible(), {
        reason,
        previous,
        base,
        action,
        hold,
        visible: visible()
      });
    }

    /** 清理正在播的短暂动作（含定时器） */
    function clearActionTimer() {
      if (actionTimer) {
        clearTimer(actionTimer);
        actionTimer = 0;
      }
    }

    /**
     * 启动一个短暂动作：清掉旧定时器 → 记录动作 → 启动新定时器。
     * 到点时把 action 置空并回调 onActionEnd，让上层做串场（eat → happy）。
     *
     * 关键（阶段 2 缺陷修复）：改变 visible 之后必须立刻 emit。
     * 渲染层只在 onChange 里切换 `.state-*` 类，如果这里不 emit，首次 transient
     * 动作（greet / poke / happy / eat …）就不会开始显示，只有等结束回调时才看到变化。
     * @param {string} name
     * @param {number} [duration] 覆盖默认时长（如游动时长由主进程给）
     * @param {string} reason 'action-start:<source>' 或 'restart:<source>'
     *   （restart 前缀供渲染层识别"同名重播"，需要重启动画）
     */
    function startAction(name, duration, reason) {
      const previous = visible();
      clearActionTimer();
      const def = STATE_DEFS[name];
      const ms = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : def.duration;
      action = name;
      actionTimer = setTimer(() => {
        actionTimer = 0;
        action = null;
        emit('action-end:' + name, name);
        onActionEnd(name, snapshot());
      }, Math.max(1, ms));
      emit(reason, previous);
      return { accepted: true, state: visible(), reason, durationMs: Math.max(1, ms) };
    }

    /**
     * 切换持久模式（饱食度驱动的情绪变化走 source: 'mood'）。
     * 规则：睡觉期间只允许"用户显式操作"修改持久模式（叫醒 / 喂饭 / 回到当前情绪
     * 都走 source: 'user'）；mood / random / system 一律被拒，保证睡觉不会被任何
     * 自动变化（情绪、系统状态、随机行为）吵醒。
     * @param {string} name
     * @param {{source?: 'mood'|'user'|'system'|'random'}} [opts]
     */
    function setBase(name, opts) {
      const o = opts || {};
      const source = o.source || 'system';
      const def = STATE_DEFS[name];
      if (!def || def.kind !== 'persistent') {
        return { accepted: false, state: visible(), reason: 'not-persistent' };
      }
      if (name === base) {
        return { accepted: true, state: visible(), reason: 'unchanged' };
      }
      if (hold) {
        return { accepted: false, state: visible(), reason: 'busy-dragging' };
      }
      // 睡觉期间只允许用户显式操作改持久模式：mood（饱食度情绪）、random、system
      // 都不能把鱼从 sleep 里"自动"拉出来。叫醒走 request('wake', {source:'user'})。
      if (base === 'sleep' && source !== 'user') {
        return { accepted: false, state: visible(), reason: 'sleeping' };
      }

      const previous = visible();
      base = name;
      if (def.exclusive) {
        // 睡觉是互斥模式：打断正在播的动作，避免"睡觉被动作盖住"
        clearActionTimer();
        action = null;
      }
      emit('base:' + source + ':' + name, previous);
      return { accepted: true, state: visible(), reason: 'base:' + source };
    }

    /**
     * 请求一个状态。
     * @param {string} name
     * @param {{source?: 'user'|'random'|'system', duration?: number, force?: boolean}} [opts]
     * @returns {{accepted: boolean, state: string, reason: string, durationMs?: number}}
     */
    function request(name, opts) {
      const o = opts || {};
      const source = o.source || 'user';
      const force = o.force === true;
      const def = STATE_DEFS[name];
      if (!def) {
        return { accepted: false, state: visible(), reason: 'unknown-state' };
      }

      // 1) 按住状态（dragged）：优先级最高，进入时清掉正在播的动作
      if (def.kind === 'hold') {
        if (hold === name) {
          return { accepted: true, state: visible(), reason: 'hold-repeat' };
        }
        const previous = visible();
        clearActionTimer();
        action = null;
        hold = name;
        emit('hold:' + source + ':' + name, previous);
        return { accepted: true, state: visible(), reason: 'hold' };
      }

      // 拖拽期间不接受任何其它状态（除非显式 force），避免拖到一半突然换动作
      if (hold && !force) {
        return { accepted: false, state: visible(), reason: 'busy-dragging' };
      }

      // 2) 持久模式请求
      if (def.kind === 'persistent') {
        return setBase(name, { source });
      }

      // 3) 短暂动作
      if (base === 'sleep') {
        if (source !== 'user') {
          // 硬要求：睡觉时只有"用户直接交互"能把鱼叫醒 ——
          // 随机动作（眨眼 / 游动 / 发呆）与系统动作（口型、轮询）一律拒绝，
          // 从状态机层面保证"睡觉不会被别的动作盖住"。
          return { accepted: false, state: visible(), reason: 'sleeping' };
        }
        // 用户直接交互会把鱼吵醒（持久模式先回到当前情绪，具体情绪由上层指定）
        const previous = visible();
        base = 'idle';
        emit('wake-up:' + source, previous);
      }

      if (action === name) {
        if (source === 'random') {
          return { accepted: false, state: visible(), reason: 'already-active' };
        }
        // 用户重复触发同一个动作：重播一次动画（重置定时器）
        return startAction(name, o.duration, 'restart:' + source);
      }

      if (action) {
        const running = STATE_DEFS[action];
        if (source === 'random') {
          // 随机动作绝不插队
          return { accepted: false, state: visible(), reason: 'busy-random' };
        }
        if (!running.interruptible && !force) {
          return { accepted: false, state: visible(), reason: 'uninterruptible' };
        }
        if (source !== 'user' && def.priority < running.priority && !force) {
          return { accepted: false, state: visible(), reason: 'lower-priority' };
        }
      } else if (source === 'random' && !canRunRandom()) {
        return { accepted: false, state: visible(), reason: 'random-blocked' };
      }

      return startAction(name, o.duration, 'action-start:' + source);
    }

    /**
     * 随机动作（眨眼 / 游动 / 发呆）是否可以执行：
     * 没有正在播的动作、没有按住、不在睡觉。
     */
    function canRunRandom() {
      return !hold && !action && base !== 'sleep';
    }

    /** 松手：退出 dragged，回落到当前持久模式 */
    function releaseHold() {
      if (!hold) {
        return { accepted: false, state: visible(), reason: 'no-hold' };
      }
      const previous = visible();
      hold = null;
      emit('release-hold', previous);
      return { accepted: true, state: visible(), reason: 'release-hold' };
    }

    /**
     * 取消正在播的短暂动作（保留持久模式）：
     * 用于窗口被收进托盘等"要停下但不要改情绪/不要吵醒"的场景。
     */
    function cancelAction(reason) {
      if (!action) {
        return { accepted: false, state: visible(), reason: 'no-action' };
      }
      const previous = visible();
      clearActionTimer();
      action = null;
      emit('cancel-action:' + (reason || 'manual'), previous);
      return { accepted: true, state: visible(), reason: 'cancel-action' };
    }

    /** 整机复位：清掉定时器与动作，并把持久模式设回指定值 */
    function reset(opts) {
      const o = opts || {};
      const nextBase = STATE_DEFS[o.base] && STATE_DEFS[o.base].kind === 'persistent' ? o.base : 'idle';
      const previous = visible();
      clearActionTimer();
      action = null;
      hold = null;
      base = nextBase;
      emit('reset', previous);
      return snapshot();
    }

    /** 销毁：确保定时器一定被清掉（窗口卸载 / 页面隐藏时调用） */
    function dispose() {
      clearActionTimer();
      action = null;
      hold = null;
    }

    return {
      getVisible: visible,
      getBase: () => base,
      getAction: () => action,
      getHold: () => hold,
      isSleeping: () => base === 'sleep',
      isDragging: () => hold === 'dragged',
      getSnapshot: snapshot,
      canRunRandom,
      getDuration: (name) => (STATE_DEFS[name] && STATE_DEFS[name].duration) || 0,
      request,
      setBase,
      releaseHold,
      cancelAction,
      reset,
      dispose
    };
  }

  return {
    STATE_DEFS,
    STATE_NAMES,
    PERSISTENT_STATES,
    ACTION_STATES,
    HOLD_STATES,
    createStateMachine
  };
});
