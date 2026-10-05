'use strict';

/**
 * ============================================================================
 * 纯逻辑单元测试：状态机（renderer/logic/state-machine.js）
 * ============================================================================
 *
 * 这个测试【不依赖 Electron、不依赖 DOM、不依赖任何第三方库】，
 * 直接 require 渲染层真正使用的那份状态机实现，并注入"假时钟"精确控制时间，
 * 因此可以在毫秒内验证几分钟量级的行为（回落、打断、清理定时器）。
 *
 * 用法：node tests/state-machine.test.js （或 npm run test:unit）
 * 退出码：0 = 全部通过；1 = 有失败项
 */

const path = require('node:path');

const { createStateMachine, STATE_NAMES, STATE_DEFS } = require(
  path.join(__dirname, '..', 'renderer', 'logic', 'state-machine.js')
);

/* -------------------------------------------------------------------------- */
/* 迷你断言框架 + 假时钟                                                       */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}  ← ${detail}` : name);
}

/**
 * 假调度器：手动推进时间，并记录待处理定时器数量。
 * 这样就能"瞬间"跑完 3 秒吃饭、10 分钟饥饿之类的逻辑。
 */
function createFakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map();

  return {
    setTimer(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + Math.max(0, ms) });
      return seq;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** 推进时间：按到期顺序依次执行回调（回调里新排的定时器也会被正确处理） */
    advance(ms) {
      const end = now + Math.max(0, ms);
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next.timer.at)) {
            next = { id, timer };
          }
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn();
      }
      now = end;
    },
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 1. 状态表完整性                                                             */
/* -------------------------------------------------------------------------- */

const REQUIRED_STATES = [
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
  'angry'
];

const missing = REQUIRED_STATES.filter((name) => !STATE_NAMES.includes(name));
check('状态表覆盖需求要求的 15 个可触发状态', missing.length === 0, `缺少：${missing.join(', ')}`);
check('额外保留 wake 状态', STATE_NAMES.includes('wake'));
check('状态表共 18 项', STATE_NAMES.length === 18, `实际：${STATE_NAMES.length}`);

for (const name of REQUIRED_STATES) {
  const def = STATE_DEFS[name];
  check(
    `状态定义合法：${name}`,
    Boolean(def) && (def.kind === 'persistent' || def.kind === 'transient' || def.kind === 'hold'),
    def ? `kind=${def.kind}` : '未定义'
  );
}

for (const name of STATE_NAMES) {
  const def = STATE_DEFS[name];
  if (def.kind === 'transient') {
    check(`短暂动作有明确时长：${name}`, Number.isFinite(def.duration) && def.duration > 0, `duration=${def.duration}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 2. 短暂动作到点回落到持久模式                                                */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const events = [];
  const machine = createStateMachine({
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onChange: (visible, info) => events.push({ visible, reason: info.reason })
  });

  check('初始可见状态是 idle', machine.getVisible() === 'idle', machine.getVisible());

  const greet = machine.request('greet', { source: 'user' });
  check('请求 greet 被接受', greet.accepted === true, greet.reason);
  check('greet 期间可见状态是 greet', machine.getVisible() === 'greet', machine.getVisible());
  check('greet 排了一个定时器', scheduler.pending === 1, String(scheduler.pending));

  scheduler.advance(STATE_DEFS.greet.duration - 1);
  check('greet 未到时间不会提前回落', machine.getVisible() === 'greet', machine.getVisible());

  scheduler.advance(1);
  check('greet 到点回落到 idle', machine.getVisible() === 'idle', machine.getVisible());
  check('回落后定时器已清空', scheduler.pending === 0, String(scheduler.pending));
  check('定时器不会被重复触发', machine.getSnapshot().hasTimer === false);

  // 同名动作重复触发 = 重播（定时器重置）
  machine.request('poke', { source: 'user' });
  scheduler.advance(600);
  const restart = machine.request('poke', { source: 'user' });
  check('重复触发同一动作返回 restart', restart.reason.indexOf('restart') === 0, restart.reason);
  scheduler.advance(600);
  check('重播后不会因旧定时器提前结束', machine.getVisible() === 'poke', machine.getVisible());
  scheduler.advance(500);
  check('重播后的新定时器到点才结束', machine.getVisible() === 'idle', machine.getVisible());
}

/* -------------------------------------------------------------------------- */
/* 2B. startAction 立即 emit（阶段 2 缺陷修复：transient 首次请求必须上报）       */
/* -------------------------------------------------------------------------- */

/*
 * 修复前的真实缺陷：request('greet') 把内部 visible 改成 greet，却没有调用 emit()，
 * 于是渲染层 onChange 一次都没触发、切不到 .state-greet —— 所有 transient 动作
 * 都不会开始显示，只可能在结束回调时变化。下面这组断言直接复现该调用并检查事件流。
 */
{
  const scheduler = createFakeScheduler();
  const changes = [];
  const ended = [];
  const machine = createStateMachine({
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onChange: (visible, info) => changes.push({ visible, reason: info.reason, previous: info.previous }),
    onActionEnd: (name) => ended.push(name)
  });

  // 1) 首次 transient 动作必须立刻发出一次 onChange
  changes.length = 0;
  const greet = machine.request('greet', { source: 'user' });
  check('首次 greet 立即发出 onChange（修复前为 0 次）', changes.length === 1, `changes=${changes.length}`);
  check('首次 greet 的 visible 是 greet', changes[0] && changes[0].visible === 'greet', changes[0] ? changes[0].visible : '无事件');
  check('首次 greet 的 previous 是 idle', changes[0] && changes[0].previous === 'idle', changes[0] ? String(changes[0].previous) : '无事件');
  check(
    '首次 greet 的 reason 是 action-start（渲染层据此开始播动画）',
    changes[0] && changes[0].reason.indexOf('action-start') === 0,
    changes[0] ? changes[0].reason : '无事件'
  );
  check('greet 请求本身仍返回 accepted', greet.accepted === true, greet.reason);

  // 2) greet → poke：两次请求共发出两次 onChange，previous 串得上
  const poke = machine.request('poke', { source: 'user' });
  check('greet→poke 之间共发出两次 onChange', changes.length === 2, `changes=${changes.length}`);
  check('poke 的 visible 是 poke', changes[1] && changes[1].visible === 'poke', changes[1] ? changes[1].visible : '无事件');
  check('poke 的 previous 是 greet（可见状态确实从 greet 切走）', changes[1] && changes[1].previous === 'greet', changes[1] ? String(changes[1].previous) : '无事件');
  check('poke 请求被接受', poke.accepted === true, poke.reason);

  // 3) 同名动作重复触发：restart 原因必须能被渲染层识别（前缀 restart）
  changes.length = 0;
  const restart = machine.request('poke', { source: 'user' });
  check('重复 poke 返回 restart', restart.reason.indexOf('restart') === 0, restart.reason);
  check('重复 poke 也发出一次 onChange', changes.length === 1, `changes=${changes.length}`);
  check(
    'restart 的 reason 以 restart 开头（渲染层据此重播动画）',
    changes[0] && changes[0].reason.indexOf('restart') === 0,
    changes[0] ? changes[0].reason : '无事件'
  );
  check('restart 的 previous 仍是 poke（同名重播）', changes[0] && changes[0].previous === 'poke', changes[0] ? String(changes[0].previous) : '无事件');

  // 4) 动作到点回落：再 emit 一次持久模式
  changes.length = 0;
  scheduler.advance(STATE_DEFS.poke.duration);
  check('动作到点回落会再 emit 一次', changes.length === 1, `changes=${changes.length}`);
  check('回落后 visible 是持久模式 idle', changes[0] && changes[0].visible === 'idle', changes[0] ? changes[0].visible : '无事件');
  check('回落的 previous 是 poke', changes[0] && changes[0].previous === 'poke', changes[0] ? String(changes[0].previous) : '无事件');
  check('回落的 reason 是 action-end', changes[0] && changes[0].reason.indexOf('action-end') === 0, changes[0] ? changes[0].reason : '无事件');
  check('回落时 onActionEnd 被调用一次', ended.length === 1 && ended[0] === 'poke', ended.join(','));

  // 5) 没被接受的请求不应该 emit（避免渲染层空切一次）
  machine.request('eat', { source: 'user' });
  changes.length = 0;
  const rejected = machine.request('pet', { source: 'user' });
  check('不可打断动作期间的请求被拒绝', rejected.accepted === false, rejected.reason);
  check('被拒绝的请求不会发出 onChange', changes.length === 0, `changes=${changes.length}`);
}

/* -------------------------------------------------------------------------- */
/* 3. 吃完 → 开心（onActionEnd 串场）                                          */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onActionEnd: (name) => {
      if (name === 'eat') {
        machine.request('happy', { source: 'system' });
      }
    }
  });

  machine.request('eat', { source: 'user' });
  check('eat 期间可见状态是 eat', machine.getVisible() === 'eat', machine.getVisible());
  scheduler.advance(STATE_DEFS.eat.duration);
  check('eat 结束后自动接上 happy', machine.getVisible() === 'happy', machine.getVisible());
  scheduler.advance(STATE_DEFS.happy.duration);
  check('happy 结束后回落到 idle', machine.getVisible() === 'idle', machine.getVisible());
}

/* -------------------------------------------------------------------------- */
/* 4. 睡觉：互斥、拒绝随机、不被 idle / 情绪顶掉                                */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

  machine.request('happy', { source: 'user' });
  const sleep = machine.setBase('sleep', { source: 'user' });
  check('睡觉请求被接受', sleep.accepted === true, sleep.reason);
  check('睡觉会打断正在播的动作', machine.getVisible() === 'sleep', machine.getVisible());
  check('睡觉后动作定时器被清理', scheduler.pending === 0, String(scheduler.pending));

  const randomBlink = machine.request('blink', { source: 'random' });
  check('睡觉时随机眨眼被拒绝', randomBlink.accepted === false && randomBlink.reason === 'sleeping', randomBlink.reason);
  const randomSwim = machine.request('swim', { source: 'random' });
  check('睡觉时随机游动被拒绝', randomSwim.accepted === false && randomSwim.reason === 'sleeping', randomSwim.reason);
  const systemTalking = machine.request('talking', { source: 'system' });
  check('睡觉时系统动作（口型）也被拒绝，不会把鱼吵醒', systemTalking.accepted === false && systemTalking.reason === 'sleeping', systemTalking.reason);
  const systemBlink = machine.request('blink', { source: 'system' });
  check('睡觉时系统动作（眨眼）同样被拒绝', systemBlink.accepted === false && systemBlink.reason === 'sleeping', systemBlink.reason);
  check('睡觉期间可见状态仍是 sleep', machine.getVisible() === 'sleep', machine.getVisible());

  const moodIdle = machine.setBase('idle', { source: 'mood' });
  check('睡觉不会被"情绪/待机"类改动顶掉', moodIdle.accepted === false && machine.getVisible() === 'sleep', moodIdle.reason);
  const moodHungry = machine.setBase('hungry', { source: 'mood' });
  check('睡觉期间情绪变化也不会顶掉 sleep', moodHungry.accepted === false && machine.getVisible() === 'sleep', moodHungry.reason);
  check('立即检查 canRunRandom 在睡觉时为 false', machine.canRunRandom() === false);

  // 阶段 2 收紧：睡觉期间 setBase 只接受 source:'user'（mood / random / system 全拒）
  const systemIdle = machine.setBase('idle', { source: 'system' });
  check(
    '睡觉期间 system 改动也被拒绝（收紧为 user only）',
    systemIdle.accepted === false && systemIdle.reason === 'sleeping',
    systemIdle.reason
  );
  const randomHungry = machine.setBase('hungry', { source: 'random' });
  check('睡觉期间 random 改动也被拒绝', randomHungry.accepted === false && randomHungry.reason === 'sleeping', randomHungry.reason);
  check('系统 / 随机改动被拒后可见状态仍是 sleep', machine.getVisible() === 'sleep', machine.getVisible());

  // 明确的用户操作仍然能改持久模式（喂饭 / userAction 唤醒依赖这条）
  const userBase = machine.setBase('hungry', { source: 'user' });
  check(
    '只有明确 user 操作能改睡眠中的持久模式',
    userBase.accepted === true && machine.getBase() === 'hungry',
    userBase.reason
  );
  machine.setBase('sleep', { source: 'user' });
  check('用户操作后可以重新睡下', machine.isSleeping() === true, machine.getBase());

  // 用户直接交互能把鱼叫醒
  const poke = machine.request('poke', { source: 'user' });
  check('用户戳一下能把睡着的鱼叫醒', poke.accepted === true && machine.getVisible() === 'poke', poke.reason);
  check('被叫醒后持久模式回到 idle 而不是继续 sleep', machine.getBase() === 'idle', machine.getBase());

  // 叫醒菜单
  machine.setBase('sleep', { source: 'user' });
  const wake = machine.request('wake', { source: 'user' });
  check('叫醒动作被接受', wake.accepted === true && machine.getVisible() === 'wake', wake.reason);
  scheduler.advance(STATE_DEFS.wake.duration);
  check('叫醒后回到 idle', machine.getVisible() === 'idle', machine.getVisible());
}

/* -------------------------------------------------------------------------- */
/* 5. 拖拽（hold）：优先级最高、打断动作、松手回落、拖拽中不能睡觉               */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

  machine.setBase('hungry', { source: 'mood' });
  machine.request('happy', { source: 'user' });
  const drag = machine.request('dragged', { source: 'user' });
  check('拖拽请求被接受', drag.accepted === true && machine.getVisible() === 'dragged', drag.reason);
  check('拖拽会清掉正在播的动作定时器', scheduler.pending === 0, String(scheduler.pending));

  const blocked = machine.request('poke', { source: 'user' });
  check('拖拽期间其它动作被拒绝', blocked.accepted === false && blocked.reason === 'busy-dragging', blocked.reason);
  const randomWhileDrag = machine.request('blink', { source: 'random' });
  check('拖拽期间随机动作被拒绝', randomWhileDrag.accepted === false, randomWhileDrag.reason);
  const sleepWhileDrag = machine.setBase('sleep', { source: 'user' });
  check('拖拽期间不能切到睡觉', sleepWhileDrag.accepted === false, sleepWhileDrag.reason);
  check('拖拽期间 canRunRandom 为 false', machine.canRunRandom() === false);

  const released = machine.releaseHold();
  check('松手后退出 dragged', released.accepted === true && machine.getVisible() === 'hungry', released.reason);
  check('松手后持久模式没被改掉（还是 hungry）', machine.getBase() === 'hungry', machine.getBase());
  check('松手后没有残留定时器', scheduler.pending === 0, String(scheduler.pending));
}

/* -------------------------------------------------------------------------- */
/* 6. 打断规则：随机绝不插队、用户可打断、eat/talking 不可打断                   */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

  machine.request('thinking', { source: 'user' });
  const randomInterrupt = machine.request('blink', { source: 'random' });
  check('随机动作不会插队', randomInterrupt.accepted === false && randomInterrupt.reason === 'busy-random', randomInterrupt.reason);
  check('被拒绝后原动作继续', machine.getVisible() === 'thinking', machine.getVisible());

  const systemLower = machine.request('blink', { source: 'system' });
  check('低优先级的系统动作被拒绝', systemLower.accepted === false && systemLower.reason === 'lower-priority', systemLower.reason);

  const userHigher = machine.request('poke', { source: 'user' });
  check('用户高优先级动作可以打断', userHigher.accepted === true && machine.getVisible() === 'poke', userHigher.reason);

  machine.request('eat', { source: 'user' });
  const userDuringEat = machine.request('pet', { source: 'user' });
  check('吃饭过程中用户摸头也打断不了（eat 不可打断）', userDuringEat.accepted === false && userDuringEat.reason === 'uninterruptible', userDuringEat.reason);
  const forced = machine.request('pet', { source: 'user', force: true });
  check('force 可以强制打断 eat', forced.accepted === true && machine.getVisible() === 'pet', forced.reason);

  machine.request('talking', { source: 'system' });
  const randomDuringTalking = machine.request('blink', { source: 'random' });
  check('说话过程中随机动作被拒绝', randomDuringTalking.accepted === false, randomDuringTalking.reason);
  scheduler.advance(STATE_DEFS.talking.duration);
  check('talking 到点回落', machine.getVisible() === 'idle', machine.getVisible());
}

/* -------------------------------------------------------------------------- */
/* 7. 随机动作在 idle / hungry / angry 下都能执行                               */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

  for (const mood of ['idle', 'hungry', 'angry']) {
    machine.setBase(mood, { source: 'mood' });
    check(`canRunRandom 在 ${mood} 下为 true`, machine.canRunRandom() === true);
    const blink = machine.request('blink', { source: 'random' });
    check(`${mood} 下随机眨眼被接受`, blink.accepted === true, blink.reason);
    scheduler.advance(STATE_DEFS.blink.duration);
    check(`${mood} 下眨眼结束后回落到 ${mood}`, machine.getVisible() === mood, machine.getVisible());
  }
}

/* -------------------------------------------------------------------------- */
/* 8. 生命周期：cancelAction / reset / dispose                                  */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

  machine.setBase('hungry', { source: 'mood' });
  machine.request('swim', { source: 'user' });
  const cancelled = machine.cancelAction('hidden');
  check('cancelAction 会停掉动作但保留情绪', cancelled.accepted === true && machine.getVisible() === 'hungry', machine.getVisible());
  check('cancelAction 清掉定时器', scheduler.pending === 0, String(scheduler.pending));

  machine.request('happy', { source: 'user' });
  const reset = machine.reset({ base: 'idle' });
  check('reset 清掉动作与定时器', reset.visible === 'idle' && scheduler.pending === 0, JSON.stringify(reset));

  machine.request('swim', { source: 'user' });
  machine.dispose();
  check('dispose 一定清掉定时器（页面卸载用）', scheduler.pending === 0, String(scheduler.pending));
  check('dispose 后没有正在播的动作', machine.getAction() === null && machine.getHold() === null);

  const unknown = machine.request('不存在的状态', { source: 'user' });
  check('未知状态被拒绝', unknown.accepted === false && unknown.reason === 'unknown-state', unknown.reason);
}

/* -------------------------------------------------------------------------- */
/* 9. 新动作的时长可以覆盖（游动时长由主进程决定）                              */
/* -------------------------------------------------------------------------- */

{
  const scheduler = createFakeScheduler();
  const machine = createStateMachine({ setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer });

  const swim = machine.request('swim', { source: 'system', duration: 4200 });
  check('游动接受主进程给的时长', swim.accepted === true && swim.durationMs === 4200, JSON.stringify(swim));
  scheduler.advance(4199);
  check('游动未到时间不结束', machine.getVisible() === 'swim', machine.getVisible());
  scheduler.advance(1);
  check('游动到时间结束', machine.getVisible() === 'idle', machine.getVisible());

  const badDuration = machine.request('swim', { source: 'system', duration: -100 });
  check('非法时长退回默认值', badDuration.durationMs === STATE_DEFS.swim.duration, String(badDuration.durationMs));
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('');
console.log('状态机单元测试');
console.log('='.repeat(64));
console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('');
  for (const item of failures) {
    console.log(`[失败] ${item}`);
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
