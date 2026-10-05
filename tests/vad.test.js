'use strict';

/**
 * ============================================================================
 * 纯逻辑单元测试：本地 JS VAD（renderer/logic/vad.js）
 * ============================================================================
 *
 * 阶段 4 的 VAD 需求逐条在这里被断言（全部用**假时钟**：直接喂 timestampMs，
 * 毫秒级跑完 30 秒规则，不需要真实音频设备、不需要等待真实时间）：
 *
 *   1. 迟滞（hysteresis）：唤醒阈值 > 维持阈值；低于维持阈值才算静音，
 *      电平在两者之间抖动时**不会**疯狂断句；
 *   2. 起始（speech-start）：要连续 >= wakeFrames 帧越过唤醒阈值才开段，
 *      单帧噪声不触发；
 *   3. 静音断句（silence）：连续静音达到 800ms 触发 segment-end(reason='silence')，
 *      accepted=true（只要有效语音帧 / 时长达标）；
 *   4. 无效片段：太短或压根没人声的段 accepted=false —— **绝不当作用户发言**；
 *   5. 30 秒空闲（idle）：连续 30 秒没人声 → idle-enter（进入低采样监测）；
 *   6. 唤醒（wakeup）：空闲监测中一检测到声音立刻 wakeup 并开始新段；
 *   7. 30 秒上限（cap）：单段到 30 秒强制断句并**立刻续段**（不丢字、不留空隙）；
 *   8. 体积上限：编码字节超过 maxBytes 时同样安全切段；
 *   9. 配置语义：灵敏度 0~1 越大越灵敏（阈值越低），静音毫秒可调（400~1500）。
 *
 * 用法：node tests/vad.test.js
 */

const path = require('node:path');

const { createVad, normalizeConfig, sensitivityToThreshold, DEFAULT_CONFIG } = require(
  path.join(__dirname, '..', 'renderer', 'logic', 'vad.js')
);

/* -------------------------------------------------------------------------- */
/* 迷你断言框架                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}  ← ${detail}` : name);
}

/** 默认帧步长（毫秒），与渲染层的 VAD_FRAME_MS 一致 */
const STEP = 20;

/**
 * 造一个"假时钟"驱动器：按固定步长喂帧，收集所有事件。
 * @param {object} [config]
 */
function makeDriver(config) {
  const events = [];
  const vad = createVad({ config: config || {}, onEvent: (event) => events.push(event) });
  let t = 0;

  return {
    vad,
    events,
    get now() {
      return t;
    },
    /** 喂若干帧同样的电平 */
    feed(level, frames, step) {
      const delta = Number.isFinite(step) ? step : STEP;
      const results = [];
      for (let i = 0; i < frames; i += 1) {
        t += delta;
        results.push(vad.feed({ level: level, timestampMs: t }));
      }
      return results;
    },
    /** 取某类事件 */
    eventsOf(type) {
      return events.filter((event) => event.type === type);
    },
    lastEvent(type) {
      const list = events.filter((event) => event.type === type);
      return list.length > 0 ? list[list.length - 1] : null;
    }
  };
}

/** 语音电平 / 静音电平（明显高于 / 低于默认阈值） */
const LOUD = 0.2;
const QUIET = 0.001;

/* -------------------------------------------------------------------------- */
/* 1. 配置与灵敏度换算                                                          */
/* -------------------------------------------------------------------------- */

{
  check('默认静音判定是 800ms（需求默认值）', DEFAULT_CONFIG.silenceMs === 800, String(DEFAULT_CONFIG.silenceMs));
  check('默认单段上限是 30000ms（需求硬上限 30 秒）', DEFAULT_CONFIG.maxSegmentMs === 30000, String(DEFAULT_CONFIG.maxSegmentMs));
  check('默认空闲判定是 30000ms（需求 30 秒）', DEFAULT_CONFIG.idleAfterMs === 30000, String(DEFAULT_CONFIG.idleAfterMs));

  const mid = sensitivityToThreshold(0.5);
  const dull = sensitivityToThreshold(0);
  const sharp = sensitivityToThreshold(1);
  check('灵敏度越大阈值越低（越大越灵敏）', sharp < mid && mid < dull, `${sharp} < ${mid} < ${dull}`);
  check('灵敏度 0.5 对应默认阈值', Math.abs(mid - DEFAULT_CONFIG.wakeThreshold) < 1e-9, String(mid));
  check('灵敏度非法值按 0.5 处理', sensitivityToThreshold('abc') === mid && sensitivityToThreshold(-5) === dull, '');

  const normalized = normalizeConfig({ sensitivity: 0.9, silenceMs: 1500, maxSegmentMs: 999999999 });
  check('归一化：灵敏度换算成阈值', normalized.wakeThreshold === sensitivityToThreshold(0.9));
  check('归一化：静音毫秒可调到 1500', normalized.silenceMs === 1500, String(normalized.silenceMs));
  check('归一化：维持阈值恒 <= 唤醒阈值（迟滞关系）', normalized.endThreshold <= normalized.wakeThreshold, `${normalized.endThreshold} vs ${normalized.wakeThreshold}`);
  check('归一化：maxSegmentMs 被夹到范围上限', normalized.maxSegmentMs <= 120000, String(normalized.maxSegmentMs));

  const fallback = normalizeConfig({ silenceMs: 'x', wakeFrames: null });
  check('归一化：非法值回落默认', fallback.silenceMs === 800 && fallback.wakeFrames === DEFAULT_CONFIG.wakeFrames);
  check('归一化：静音毫秒下限 100', normalizeConfig({ silenceMs: 10 }).silenceMs === 100);
}

/* -------------------------------------------------------------------------- */
/* 2. 起始：需要连续若干帧越过唤醒阈值（单帧噪声不触发）                          */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver();
  d.feed(QUIET, 5);
  check('一直安静时没有 speech-start', d.eventsOf('speech-start').length === 0);
  check('一直安静时状态是 quiet', d.vad.snapshot().state === 'quiet', d.vad.snapshot().state);

  // 只来一帧大声：不足以唤醒（默认 wakeFrames=3）
  d.feed(LOUD, 1);
  check('单帧噪声不足以唤醒', d.eventsOf('speech-start').length === 0, JSON.stringify(d.events));
  d.feed(LOUD, 2);
  check('连续 3 帧大声才触发 speech-start', d.eventsOf('speech-start').length === 1, JSON.stringify(d.events));
  check('触发后状态变成 speaking', d.vad.snapshot().state === 'speaking', d.vad.snapshot().state);
  check('speech-start 事件带 startedAtMs', Number.isFinite(d.lastEvent('speech-start').startedAtMs));
}

/* -------------------------------------------------------------------------- */
/* 3. 迟滞：电平在维持阈值与唤醒阈值之间抖动不会断句                              */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver();
  d.feed(LOUD, 5); // 进入 speaking
  check('已进入 speaking', d.vad.isSpeaking());

  // 电平落在 endThreshold 与 wakeThreshold 之间（0.03）：算"还在说话"，不计静音
  const between = (DEFAULT_CONFIG.endThreshold + DEFAULT_CONFIG.wakeThreshold) / 2;
  d.feed(between, 20); // 400ms
  check('电平在迟滞区间内不被判为静音', d.eventsOf('segment-end').length === 0, JSON.stringify(d.events));
  check('段内静音累计仍然是 0', d.vad.snapshot().silentMs === 0, String(d.vad.snapshot().silentMs));

  const low = DEFAULT_CONFIG.endThreshold / 2;
  d.feed(low, 10); // 200ms 静音
  check('200ms 静音还不够断句（默认 800ms）', d.eventsOf('segment-end').length === 0);
  check('静音时长被累计', Math.round(d.vad.snapshot().silentMs) === 200, String(d.vad.snapshot().silentMs));

  d.feed(LOUD, 2); // 又说话了
  check('重新说话会把静音累计清零', d.vad.snapshot().silentMs === 0, String(d.vad.snapshot().silentMs));
}

/* -------------------------------------------------------------------------- */
/* 4. 静音断句：连续 800ms 静音自动提交                                          */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver();
  d.feed(LOUD, 10); // 200ms 说话
  d.feed(QUIET, 39); // 780ms 静音
  check('780ms 静音还没到阈值', d.eventsOf('segment-end').length === 0, JSON.stringify(d.eventsOf('segment-end')));
  d.feed(QUIET, 1); // 凑满 800ms
  const end = d.lastEvent('segment-end');
  check('800ms 静音触发 segment-end', Boolean(end), JSON.stringify(d.events));
  check('断句原因是 silence', end && end.reason === 'silence', end ? end.reason : 'null');
  check('有效段 accepted=true', end && end.accepted === true, JSON.stringify(end));
  check(
    '段时长在 0.8~1.1 秒之间（唤醒需要 3 帧，所以略短于 1 秒）',
    end && end.durationMs >= 800 && end.durationMs <= 1100,
    end ? String(end.durationMs) : 'null'
  );
  check('断句后回到 quiet（可以接着听下一句）', d.vad.snapshot().state === 'quiet', d.vad.snapshot().state);
  check('段内有效语音帧 >= 5', end && end.voicedFrames >= 5, end ? String(end.voicedFrames) : 'null');
}

/* -------------------------------------------------------------------------- */
/* 5. 无效片段绝不能当作用户发言（防咳嗽 / 键盘声）                               */
/* -------------------------------------------------------------------------- */

{
  // 只有 1 帧大声 + 长时间安静 → 有效语音帧太少，accepted 必须是 false
  const d = makeDriver({ wakeFrames: 1, minVoicedFrames: 4 });
  d.feed(LOUD, 1);
  d.feed(QUIET, 60);
  const end = d.lastEvent('segment-end');
  check('极短噪声段被标成 accepted=false', end && end.accepted === false, JSON.stringify(end));

  // 2 帧大声（40ms）仍然不够 minSegmentMs=80 的边界……这里给 4 帧但时长很短
  const d2 = makeDriver({ wakeFrames: 1, minVoicedFrames: 10, minSegmentMs: 500 });
  d2.feed(LOUD, 4); // 80ms
  d2.feed(QUIET, 50);
  const end2 = d2.lastEvent('segment-end');
  check('语音帧不足时 accepted=false', end2 && end2.accepted === false, JSON.stringify(end2));
}

/* -------------------------------------------------------------------------- */
/* 6. 30 秒没人说话 → idle-enter；一有声音立刻 wakeup                             */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver();
  d.feed(QUIET, 100); // 2 秒
  check('2 秒安静还不进入空闲监测', d.eventsOf('idle-enter').length === 0, JSON.stringify(d.events));

  d.feed(QUIET, 1400); // 再 28 秒（共 30 秒）
  check('30 秒没人说话进入低采样空闲监测', d.eventsOf('idle-enter').length === 1, JSON.stringify(d.eventsOf('idle-enter')));
  check('空闲标记 lowRate=true', d.vad.isLowRate() === true);

  // 空闲监测中一检测到声音立刻唤醒
  d.feed(LOUD, 3);
  check('空闲中被声音唤醒（wakeup 事件）', d.eventsOf('wakeup').length === 1, JSON.stringify(d.events));
  check('唤醒事件发生在 speech-start 之前', d.events.findIndex((e) => e.type === 'wakeup') < d.events.findIndex((e) => e.type === 'speech-start'));
  check('唤醒后 lowRate=false', d.vad.isLowRate() === false);

  // 唤醒之后正常走一轮：静音断句
  d.feed(QUIET, 45);
  const end = d.lastEvent('segment-end');
  check('唤醒后仍然能正常断句', Boolean(end) && end.reason === 'silence', JSON.stringify(end));
}

/* -------------------------------------------------------------------------- */
/* 7. 单段 30 秒上限：安全切段并立刻续段（不丢字）                                */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver();
  // 一直大声说话 35 秒：每帧 20ms，共 1750 帧
  d.feed(LOUD, 1750);

  const ends = d.eventsOf('segment-end');
  check('超过 30 秒会被强制切段', ends.length === 1, `段数=${ends.length}`);
  check('切段原因是 max-duration', ends[0].reason === 'max-duration', ends[0].reason);
  check('切段时长约 30 秒', ends[0].durationMs >= 30000 && ends[0].durationMs <= 30020, String(ends[0].durationMs));
  check('被切段仍然 accepted=true（这段是真的有人说话）', ends[0].accepted === true);
  check('切段后立刻续段（speech-continue 事件）', d.eventsOf('speech-continue').length === 1, JSON.stringify(d.eventsOf('speech-continue')));
  check(
    '事件顺序是 segment-end → speech-continue → speech-start（先收尾、再声明续段、再开新段）',
    (() => {
      const endIndex = d.events.findIndex((e) => e.type === 'segment-end');
      const continueIndex = d.events.findIndex((e) => e.type === 'speech-continue');
      // 第二段起点：最后一个 speech-start
      const secondStart = d.events.map((e) => e.type).lastIndexOf('speech-start');
      return endIndex + 1 === continueIndex && continueIndex + 1 === secondStart;
    })(),
    d.events.map((e) => e.type).join(' → ')
  );
  check('续段后仍在 speaking（不丢字、不留空隙）', d.vad.isSpeaking(), d.vad.snapshot().state);
  check('续段后统计已被重置', d.vad.snapshot().frames <= 751, String(d.vad.snapshot().frames));
  check('整轮里 speech-start 出现两次（原始段 + 续段）', d.eventsOf('speech-start').length === 2, String(d.eventsOf('speech-start').length));
}

{
  // 连续 60 秒以上：应该切出多段（每段 30 秒），且每段都不超过 30 秒上限
  const d = makeDriver();
  d.feed(LOUD, 3100); // 62 秒
  const ends = d.eventsOf('segment-end');
  check('连续 62 秒会切出 2 段（每段 30 秒）', ends.length === 2, `段数=${ends.length}`);
  check('每段都恰好卡在 30 秒上限', ends.every((e) => e.durationMs === 30000), JSON.stringify(ends.map((e) => e.durationMs)));
  check('两段都是有效段（真的有人说话）', ends.every((e) => e.accepted === true));
}

/* -------------------------------------------------------------------------- */
/* 8. 体积上限：编码后字节超限也安全切段                                         */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver({ maxBytes: 1000 });
  d.feed(LOUD, 5);
  check('已进入 speaking（准备验证体积上限）', d.vad.isSpeaking(), d.vad.snapshot().state);
  // 每帧 300 字节：4 帧就超过 1000；时间戳从当前时钟继续往前推
  for (let i = 0; i < 6; i += 1) {
    d.vad.feed({ level: LOUD, bytes: 300, timestampMs: d.now + (i + 1) * STEP });
  }
  const end = d.lastEvent('segment-end');
  check('字节超限触发切段', Boolean(end), JSON.stringify(d.events));
  check('切段原因是 max-bytes', end && end.reason === 'max-bytes', end ? end.reason : 'null');
  check('字节超限也会立刻续段', d.eventsOf('speech-continue').length === 1, JSON.stringify(d.eventsOf('speech-continue')));
}

/* -------------------------------------------------------------------------- */
/* 9. stop / reset：关麦与换设置时的清理                                          */
/* -------------------------------------------------------------------------- */

{
  const d = makeDriver();
  d.feed(LOUD, 10);
  const result = d.vad.stop(d.now);
  check('stop 时正在录音会以 stopped 收尾', result.events.length === 1 && result.events[0].reason === 'stopped', JSON.stringify(result.events));
  check('stopped 段永远 accepted=false（绝不提交）', result.events[0].accepted === false);
  check('stop 后状态是 quiet', result.state === 'quiet', result.state);
  check('stop 后 isSpeaking() 为 false', d.vad.isSpeaking() === false);

  d.vad.reset({ silenceMs: 400 });
  check('reset 后配置更新', d.vad.getConfig().silenceMs === 400, String(d.vad.getConfig().silenceMs));
  check('reset 后统计清空', d.vad.snapshot().frames === 0 && d.vad.isLowRate() === false);

  // 用新配置验证：400ms 静音就断句
  const d2 = makeDriver({ silenceMs: 400 });
  d2.feed(LOUD, 10);
  d2.feed(QUIET, 20); // 400ms
  const end = d2.lastEvent('segment-end');
  check('静音判定可调到 400ms 并生效', Boolean(end) && end.reason === 'silence', JSON.stringify(d2.eventsOf('segment-end')));
}

/* -------------------------------------------------------------------------- */
/* 10. 事件回调与非法输入                                                        */
/* -------------------------------------------------------------------------- */

{
  const seen = [];
  const vad = createVad({ onEvent: (event) => seen.push(event.type) });
  vad.feed({ level: 0.5, timestampMs: 10 });
  vad.feed({ level: 0.5, timestampMs: 20 });
  vad.feed({ level: 0.5, timestampMs: 30 });
  check('onEvent 回调收到 speech-start', seen.includes('speech-start'), seen.join(','));
  check('feed 返回值同时带 state / events / snapshot', (() => {
    const result = vad.feed({ level: 0.5, timestampMs: 40 });
    return result.state === 'speaking' && Array.isArray(result.events) && Boolean(result.snapshot);
  })());

  // 非法输入不能抛异常
  check('feed(null) 不抛异常', (() => {
    try {
      vad.feed(null);
      return true;
    } catch (error) {
      return false;
    }
  })());
  check('feed 缺 timestampMs 时按上一帧 +20ms 推进', (() => {
    const local = createVad();
    local.feed({ level: 0.5, timestampMs: 1000 });
    local.feed({ level: 0.5 });
    local.feed({ level: 0.5 });
    // 第三帧才凑满 wakeFrames=3，段起点应该是 1040（两帧各 +20ms）
    return local.snapshot().startedAtMs === 1040;
  })());
  check('onEvent 回调抛异常不影响 VAD 推进', (() => {
    const local = createVad({
      onEvent: () => {
        throw new Error('boom');
      }
    });
    local.feed({ level: 0.9, timestampMs: 10 });
    local.feed({ level: 0.9, timestampMs: 20 });
    local.feed({ level: 0.9, timestampMs: 30 });
    return local.isSpeaking() === true;
  })());
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('');
console.log('本地 VAD 单元测试（假时钟）');
console.log('='.repeat(64));
console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('');
  for (const item of failures) {
    console.log(`[失败] ${item}`);
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
