'use strict';

/**
 * ============================================================================
 * 纯逻辑单元测试：饱食度（renderer/logic/fullness.js）
 * ============================================================================
 *
 * 全部用"假时钟 + 假存储"驱动，所以可以瞬间验证"70 分钟后饿、80 分钟后生气、
 * 离线 3 天回来只剩 0"这类需要真实等待几分钟到几小时的行为。
 *
 * 覆盖点：
 *   - 初始 100 / 每分钟掉 5 点
 *   - ≤30 进入 hungry、低饱食持续 3 分钟进入 angry
 *   - 喂饭回到 100 且清空低饱食计时
 *   - 数值永不越界（不会负数、不会超过 100）
 *   - 持久化：序列化 / 反序列化 / 离线补算 / 损坏数据 / 未来时间戳
 *   - 存储写入失败时静默降级，不抛异常
 *   - 睡觉不暂停下降（下降只由时间戳决定）
 *
 * 用法：node tests/fullness.test.js （或 npm run test:unit）
 * 退出码：0 = 全部通过；1 = 有失败项
 */

const path = require('node:path');

const {
  FULLNESS,
  decayTo,
  deriveMood,
  applyFeed,
  serialize,
  parseSerialized,
  normalizeSnapshot,
  createInitialState,
  createFullness
} = require(path.join(__dirname, '..', 'renderer', 'logic', 'fullness.js'));

/* -------------------------------------------------------------------------- */
/* 迷你断言框架 + 假时钟 + 假存储                                              */
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

/** 手动可控的假时钟 */
function createFakeClock(start) {
  let now = Number.isFinite(start) ? start : 1700000000000;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      return now;
    },
    set(value) {
      now = value;
    }
  };
}

/** 内存假存储（模拟 localStorage，可切换成"写入抛错"模式） */
function createFakeStorage() {
  let text = null;
  let failWrite = false;
  let failRead = false;
  return {
    read() {
      if (failRead) throw new Error('读取失败');
      return text;
    },
    write(next) {
      if (failWrite) throw new Error('写入失败（模拟配额不足）');
      text = next;
    },
    clear() {
      text = null;
    },
    raw: () => text,
    setFailWrite(value) {
      failWrite = value;
    },
    setFailRead(value) {
      failRead = value;
    }
  };
}

const MINUTE = 60000;

/* -------------------------------------------------------------------------- */
/* 1. 初始状态与基础衰减                                                       */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  const initial = createInitialState(t0);
  check('初始饱食度是 100', initial.value === FULLNESS.INITIAL, String(initial.value));
  check('初始没有低饱食计时', initial.hungrySince === null);
  check('初始情绪是 idle', deriveMood(initial, t0) === 'idle');

  const afterOneMinute = decayTo(initial, t0 + MINUTE);
  check('每分钟下降 5 点', afterOneMinute.value === 95, String(afterOneMinute.value));
  check('95 仍是 idle', deriveMood(afterOneMinute, t0 + MINUTE) === 'idle');

  const afterTen = decayTo(initial, t0 + 10 * MINUTE);
  check('10 分钟掉 50 点', afterTen.value === 50, String(afterTen.value));
  check('衰减不改变时间戳以外的字段', afterTen.version === FULLNESS.STORAGE_VERSION);

  const noTime = decayTo(initial, t0);
  check('同一时刻重复计算不会掉值', noTime.value === 100, String(noTime.value));

  const backwards = decayTo(initial, t0 - 5 * MINUTE);
  check('时间倒退（未来时间戳）不会回涨', backwards.value === 100, String(backwards.value));
  check('时间倒退不产生负数时长副作用', backwards.savedAt === t0 - 5 * MINUTE);
}

/* -------------------------------------------------------------------------- */
/* 2. 阈值：≤30 → hungry；低饱食持续 3 分钟 → angry                              */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  let state = createInitialState(t0);

  state = decayTo(state, t0 + 13 * MINUTE);
  check('13 分钟时饱食度 35', state.value === 35, String(state.value));
  check('35 仍是 idle（还没到阈值）', deriveMood(state, t0 + 13 * MINUTE) === 'idle');

  state = decayTo(state, t0 + 14 * MINUTE);
  check('14 分钟时饱食度 30（正好等于阈值）', state.value === 30, String(state.value));
  check('≤30 进入 hungry', deriveMood(state, t0 + 14 * MINUTE) === 'hungry');
  check('跌破阈值时记录了饿的起点', Math.abs(state.hungrySince - (t0 + 14 * MINUTE)) < 1, String(state.hungrySince));

  state = decayTo(state, t0 + 15 * MINUTE);
  check('低饱食 1 分钟仍是 hungry', deriveMood(state, t0 + 15 * MINUTE) === 'hungry');

  state = decayTo(state, t0 + 16 * MINUTE + 59000);
  check('低饱食 2 分 59 秒仍是 hungry', deriveMood(state, t0 + 16 * MINUTE + 59000) === 'hungry');

  state = decayTo(state, t0 + 17 * MINUTE);
  check('低饱食满 3 分钟进入 angry', deriveMood(state, t0 + 17 * MINUTE) === 'angry');
  check('17 分钟时饱食度约 15（浮点容差）', Math.abs(state.value - 15) < 1e-6, String(state.value));

  state = decayTo(state, t0 + 200 * MINUTE);
  check('更久之后仍然是 angry', deriveMood(state, t0 + 200 * MINUTE) === 'angry');
  check('饱食度下限是 0（不会负数）', state.value === 0, String(state.value));

  // 跨过阈值那一刻的 hungrySince 应该精确落在"刚好等于 30"的时刻
  const crossing = decayTo(createInitialState(t0), t0 + 20 * MINUTE);
  check('一次性跳过阈值也能精确算出饿的起点', Math.abs(crossing.hungrySince - (t0 + 14 * MINUTE)) < 1, String(crossing.hungrySince));
  check('一次性跳到 20 分钟时已经 angry', deriveMood(crossing, t0 + 20 * MINUTE) === 'angry');
}

/* -------------------------------------------------------------------------- */
/* 3. 喂饭                                                                     */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  let state = decayTo(createInitialState(t0), t0 + 20 * MINUTE);
  check('准备：此时处于 angry', deriveMood(state, t0 + 20 * MINUTE) === 'angry');

  state = applyFeed(state, t0 + 20 * MINUTE);
  check('喂饭后回到 100', state.value === 100, String(state.value));
  check('喂饭后清空低饱食计时', state.hungrySince === null);
  check('喂饭后立刻是 idle 情绪', deriveMood(state, t0 + 20 * MINUTE) === 'idle');
  check('喂饭后时间戳被刷新', state.savedAt === t0 + 20 * MINUTE);

  const later = decayTo(state, t0 + 21 * MINUTE);
  check('喂饭后再过 1 分钟掉 5 点', later.value === 95, String(later.value));
}

/* -------------------------------------------------------------------------- */
/* 4. 序列化 / 反序列化 / 损坏与边界数据                                        */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  const state = decayTo(createInitialState(t0), t0 + 85 * MINUTE);
  const text = serialize(state);
  check('序列化结果是 JSON 字符串', typeof text === 'string' && text.startsWith('{'));
  const parsed = parseSerialized(text, t0 + 85 * MINUTE);
  check('反序列化后数值一致', parsed.state.value === state.value, String(parsed.state.value));
  check('反序列化后情绪仍是 angry', deriveMood(parsed.state, t0 + 85 * MINUTE) === 'angry');
  check('反序列化后低饱食计时保留', parsed.state.hungrySince === state.hungrySince);
  check('正常数据不算损坏', parsed.corrupted === false && parsed.restored === true);

  const empty = parseSerialized(null, t0);
  check('没有历史记录时给全新状态（不算损坏）', empty.state.value === 100 && empty.corrupted === false);
  check('缺失记录时 restored 为 false', empty.restored === false);

  const broken = parseSerialized('{"value": 12, "savedAt": ', t0);
  check('JSON 损坏时重置为 100 并标记 corrupted', broken.state.value === 100 && broken.corrupted === true);

  const wrongType = parseSerialized('"just a string"', t0);
  check('类型不对时重置为 100', wrongType.state.value === 100 && wrongType.corrupted === true);

  const missingFields = parseSerialized('{"foo": 1}', t0);
  check('缺字段时重置为 100 并标记损坏', missingFields.state.value === 100 && missingFields.corrupted === true);

  const negative = parseSerialized(JSON.stringify({ value: -40, savedAt: t0 - MINUTE, hungrySince: null }), t0);
  check('负值被夹到 0', negative.state.value === 0, String(negative.state.value));

  const tooBig = parseSerialized(JSON.stringify({ value: 999, savedAt: t0 - MINUTE, hungrySince: null }), t0);
  check('超过 100 的值被夹到 100', tooBig.state.value === 100, String(tooBig.state.value));

  const future = parseSerialized(JSON.stringify({ value: 50, savedAt: t0 + 60 * MINUTE, hungrySince: null }), t0);
  check('未来时间戳被压回当前时间', future.state.savedAt === t0, String(future.state.savedAt));
  check('未来时间戳不会让饱食度回涨', decayTo(future.state, t0).value === 50, String(decayTo(future.state, t0).value));
  check('未来时间戳不会产生负值', future.state.value >= 0);

  const nullHungrySince = normalizeSnapshot({ value: 20, savedAt: t0, hungrySince: null }, t0);
  check('hungrySince=null 不会被当成 0（否则一载入就 angry）', nullHungrySince.state.hungrySince === null);
  check('hungrySince=null 时按当前时间兜底为 hungry', deriveMood(nullHungrySince.state, t0) === 'hungry');

  const crazyHungrySince = normalizeSnapshot({ value: 20, savedAt: t0, hungrySince: t0 + 10 * MINUTE }, t0);
  check('hungrySince 在未来时被丢弃', crazyHungrySince.state.hungrySince === null);

  const nanValue = parseSerialized('{"value": "abc", "savedAt": 123}', t0);
  check('NaN 值被重置', nanValue.state.value === 100 && nanValue.corrupted === true);
}

/* -------------------------------------------------------------------------- */
/* 5. 离线补算：真的"关掉程序一段时间"                                          */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  const storage = createFakeStorage();
  const clock = createFakeClock(t0);

  const first = createFullness({ storage, clock: clock.now });
  first.load();
  check('首次启动是满的', first.getValue() === 100);
  check('首次启动情绪 idle', first.getMood() === 'idle');
  first.save();
  check('落盘成功', typeof storage.raw() === 'string');

  // 模拟：程序关闭 16 分钟后再打开（新节奏：每分钟掉 5 点 → 100-80=20，已饿）
  clock.advance(16 * MINUTE);
  const second = createFullness({ storage, clock: clock.now });
  const loaded = second.load();
  check('离线 16 分钟后恢复到 20', second.getValue() === 20, String(second.getValue()));
  check('离线后情绪是 hungry', loaded.mood === 'hungry', loaded.mood);
  check('离线恢复不算损坏', loaded.corrupted === false && loaded.restored === true);

  // 模拟：再关闭 30 分钟（累计低饱食远超 3 分钟）→ angry
  clock.advance(30 * MINUTE);
  const third = createFullness({ storage, clock: clock.now });
  const loaded3 = third.load();
  check('离线后低饱食超过 3 分钟进入 angry', loaded3.mood === 'angry', loaded3.mood);
  check('离线很久后饱食度归 0 且不为负', third.getValue() === 0, String(third.getValue()));

  // 喂饭 → 立刻恢复
  const fed = third.feed();
  check('喂饭后回到 100 / idle', fed.value === 100 && fed.mood === 'idle', JSON.stringify(fed));
  check('喂饭后写回存储', storage.raw().includes('"value":100'));

  // 离线 3 天：依然是 0，不会变负
  clock.advance(3 * 24 * 60 * MINUTE);
  const fourth = createFullness({ storage, clock: clock.now });
  fourth.load();
  check('离线 3 天后饱食度停在 0', fourth.getValue() === 0, String(fourth.getValue()));
}

/* -------------------------------------------------------------------------- */
/* 6. 控制器 tick / 定时回调 / 存储异常容错                                     */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  const storage = createFakeStorage();
  const clock = createFakeClock(t0);
  const moods = [];

  const controller = createFullness({
    storage,
    clock: clock.now,
    onChange: (info) => moods.push(info)
  });
  controller.load();

  clock.advance(14 * MINUTE);
  const tick1 = controller.tick();
  check('tick 后按真实时间衰减到 30', tick1.value === 30, String(tick1.value));
  check('tick 触发 idle → hungry 回调', moods.some((m) => m.previous === 'idle' && m.mood === 'hungry'));
  check('回调里带着触发原因', moods[moods.length - 1].reason === 'tick');

  clock.advance(3 * MINUTE);
  const tick2 = controller.tick();
  check('tick 后进入 angry', tick2.mood === 'angry', tick2.mood);
  check('hungry → angry 回调只发生一次', moods.filter((m) => m.mood === 'angry').length === 1);

  clock.advance(1 * MINUTE);
  controller.tick();
  check('情绪不变时不再重复回调', moods.filter((m) => m.mood === 'angry').length === 1);

  // 写入失败必须静默降级（不抛异常，值仍在内存里正确变化）
  storage.setFailWrite(true);
  let threw = false;
  try {
    controller.feed();
    controller.save();
  } catch (error) {
    threw = true;
  }
  check('存储写入失败时不抛异常', threw === false);
  check('写入失败后内存值仍然正确', controller.getValue() === 100, String(controller.getValue()));

  // 读取失败也不能崩
  storage.setFailRead(true);
  const controller2 = createFullness({ storage, clock: clock.now });
  let readThrew = false;
  try {
    controller2.load();
  } catch (error) {
    readThrew = true;
  }
  check('存储读取失败时不抛异常', readThrew === false);
  check('读取失败后给出安全初始值', controller2.getValue() === 100, String(controller2.getValue()));
}

/* -------------------------------------------------------------------------- */
/* 7. 睡觉不暂停下降（设计说明的可执行验证）                                     */
/* -------------------------------------------------------------------------- */

{
  const t0 = 1700000000000;
  let state = createInitialState(t0);
  // 饱食度模块不知道"睡觉"，下降只由时间戳决定 —— 所以睡 6 分钟照样掉 30 点
  state = decayTo(state, t0 + 6 * MINUTE);
  check('睡着 6 分钟照样掉 30 点（睡觉不暂停饱食度）', state.value === 70, String(state.value));

  // 醒来时情绪跟着实际数值走：再睡 8 分钟（共 14 分钟）就到阈值进 hungry
  state = decayTo(state, t0 + 14 * MINUTE);
  check('睡着期间饿到阈值，醒来就是 hungry', deriveMood(state, t0 + 14 * MINUTE) === 'hungry');
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('');
console.log('饱食度单元测试');
console.log('='.repeat(64));
console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('');
  for (const item of failures) {
    console.log(`[失败] ${item}`);
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
