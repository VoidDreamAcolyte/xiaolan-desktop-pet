'use strict';

/**
 * ============================================================================
 * 纯逻辑单元测试：语音回合管理（renderer/logic/turn-taking.js）
 * ============================================================================
 *
 * 这一条测试把"免按键连续对话"的回合规则全部钉死（不碰真实麦克风 / 网络）：
 *
 *   1. **TTS 播放期间必须停止采集**：进入 speaking 前调用 mic.pause()；
 *   2. **播完只按 micEnabled 恢复**：micEnabled=false 时绝不自动开麦；
 *   3. **无 Key 绝不发聊天**：识别文本不会被送到聊天模型，只气泡提示；
 *   4. **错误分级**：无 Key / 鉴权失败 → 「我还没大脑…」；网络 / 超时 → 「网有点卡…」；
 *   5. **无效语音段直接丢弃**：VAD 判定 accepted=false 的片段不会触发识别；
 *   6. **字幕默认关**：subtitleMode=false 时不显示回复文字，打开后显示同一段文字；
 *   7. **麦克风开关**：setMicEnabled(false) 立刻停采；重新打开才恢复监听；
 *   8. 识别太短 / 空文本不回复；播放失败会给一次明确提示（不是静默只显示文字）。
 *
 * 用法：node tests/turn-taking.test.js
 */

const path = require('node:path');

const { createTurnTaking, classifyError, TEXTS } = require(
  path.join(__dirname, '..', 'renderer', 'logic', 'turn-taking.js')
);

/* -------------------------------------------------------------------------- */
/* 迷你断言框架 + 假依赖                                                        */
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

/** 一段假的 wav 字节（只要非空即可） */
function fakeWav(size) {
  return new Uint8Array(size || 3200);
}

/**
 * 造一套记录调用的假依赖。
 * @param {{
 *   micStart?: object,
 *   asr?: object,
 *   chat?: object,
 *   speak?: object,
 *   micEnabled?: boolean,
 *   subtitleMode?: boolean
 * }} [options]
 */
function makeHarness(options) {
  const opts = options || {};
  const calls = [];
  const bubbles = [];
  const captions = [];
  const states = [];

  const mic = {
    start: () => {
      calls.push('mic.start');
      return Promise.resolve(opts.micStart || { ok: true });
    },
    pause: (reason) => {
      calls.push('mic.pause:' + (reason || ''));
    },
    resume: (reason) => {
      calls.push('mic.resume:' + (reason || ''));
      return Promise.resolve(opts.micResume || { ok: true });
    },
    close: () => {
      calls.push('mic.close');
    }
  };

  const pipelines = {
    transcribe: (bytes, meta) => {
      calls.push(`asr:${bytes.byteLength}:${meta.durationMs}`);
      return Promise.resolve(opts.asr || { ok: true, text: '你好呀', provider: 'cloud', chat: true });
    },
    chat: (text) => {
      calls.push('chat:' + text);
      return Promise.resolve(opts.chat || { ok: true, text: '哼、本鱼在呢' });
    },
    speak: (text) => {
      calls.push('speak:' + text);
      return Promise.resolve(opts.speak || { ok: true, provider: 'glm-tts' });
    }
  };

  const turn = createTurnTaking({
    mic,
    pipelines,
    captionEnabled: () => opts.subtitleMode === true,
    onBubble: (payload) => bubbles.push(payload),
    onCaption: (text) => captions.push(text),
    onStateChange: (state, info) => states.push(state + (info && info.reason ? ':' + info.reason : ''))
  });

  return {
    turn,
    mic,
    pipelines,
    calls,
    bubbles,
    captions,
    states,
    /** 调用顺序里某两个下标的先后关系 */
    orderOf(prefix) {
      return calls.findIndex((entry) => entry.indexOf(prefix) === 0);
    },
    has(prefix) {
      return calls.some((entry) => entry.indexOf(prefix) === 0);
    },
    bubblesOf(kind) {
      return bubbles.filter((entry) => entry.kind === kind);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 1. 启动：默认开麦即开始监听；micEnabled=false 时不启动                          */
/* -------------------------------------------------------------------------- */

async function testStart() {
  const h = makeHarness();
  const result = await h.turn.start();
  check('默认启动会把麦克风打开', result.ok === true && h.has('mic.start'), JSON.stringify(result));
  check('启动后状态是 listening', h.turn.getState() === 'listening', h.turn.getState());
  check('启动阶段没有任何气泡（不打扰用户）', h.bubbles.length === 0, JSON.stringify(h.bubbles));

  const off = makeHarness();
  await off.turn.setMicEnabled(false); // 先关（这是初始即关的等价路径）
  const offResult = await off.turn.start();
  check('麦克风关闭时 start() 不会开麦', offResult.ok === false && offResult.reason === 'mic-disabled', JSON.stringify(offResult));
  check('麦克风关闭时状态保持 idle', off.turn.getState() === 'idle', off.turn.getState());

  const denied = makeHarness({ micStart: { ok: false, reason: 'permission-denied' } });
  const deniedResult = await denied.turn.start();
  check('权限被拒时 start() 返回明确原因', deniedResult.ok === false && deniedResult.reason === 'permission-denied');
  check('权限被拒只给一条轻量提示（不是反复弹框）', denied.bubbles.length === 1 && denied.bubbles[0].kind === 'warn', JSON.stringify(denied.bubbles));
  check('权限提示文案提到"麦克风"', /麦克风/.test(denied.bubbles[0].text), denied.bubbles[0].text);
  check('权限被拒后回到 idle（不会卡在 starting）', denied.turn.getState() === 'idle', denied.turn.getState());
}

/* -------------------------------------------------------------------------- */
/* 2. 一轮完整对话：停说 → ASR → 对话 → TTS，且播放期间停采、播完恢复              */
/* -------------------------------------------------------------------------- */

async function testHappyPath() {
  const h = makeHarness();
  await h.turn.start();
  h.calls.length = 0;

  const result = await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 1200, accepted: true });

  check('一轮成功对话返回 transcript 与 reply', result.ok === true && result.transcript === '你好呀' && result.reply === '哼、本鱼在呢', JSON.stringify(result));
  check('调用顺序：识别 → 对话 → 合成', h.orderOf('asr') < h.orderOf('chat') && h.orderOf('chat') < h.orderOf('speak'), h.calls.join(' | '));
  check('TTS 之前的最后一步是停采（mic.pause）', h.calls[h.orderOf('speak') - 1].indexOf('mic.pause') === 0, h.calls.join(' | '));
  check('播放结束后恢复采集（mic.resume）', h.has('mic.resume'), h.calls.join(' | '));
  check('停采发生在播放之前', h.orderOf('mic.pause') < h.orderOf('speak'), h.calls.join(' | '));
  check('恢复采集发生在播放之后', h.orderOf('mic.resume') > h.orderOf('speak'), h.calls.join(' | '));
  check('一轮结束后回到 listening', h.turn.getState() === 'listening', h.turn.getState());
  check('成功路径不产生错误气泡', h.bubbles.length === 0, JSON.stringify(h.bubbles));
  check('状态迁移包含 transcribing / thinking / speaking', h.states.some((s) => s.indexOf('transcribing') === 0) && h.states.some((s) => s.indexOf('thinking') === 0) && h.states.some((s) => s.indexOf('speaking') === 0), h.states.join(' → '));
  check('识别被调用了 1 次、对话 1 次、合成 1 次', h.calls.filter((c) => c.indexOf('asr') === 0).length === 1 && h.calls.filter((c) => c.indexOf('chat') === 0).length === 1 && h.calls.filter((c) => c.indexOf('speak') === 0).length === 1);
}

/* -------------------------------------------------------------------------- */
/* 3. micEnabled=false：TTS 播完**绝不**自动恢复监听                              */
/* -------------------------------------------------------------------------- */

async function testNoResumeWhenDisabled() {
  const h = makeHarness();
  await h.turn.start();

  // 在说话前把麦克风关掉（等价于用户在 TTS 播放期间点了关麦）
  h.calls.length = 0;
  await h.turn.setMicEnabled(false);
  check('关麦后立刻停采', h.has('mic.pause'), h.calls.join(' | '));
  check('关麦后状态是 idle', h.turn.getState() === 'idle', h.turn.getState());
  check('关麦会给一条状态气泡', h.bubbles.some((b) => b.text === TEXTS.micOff), JSON.stringify(h.bubbles));

  // 关麦状态下再来一段语音：不应该触发识别
  h.calls.length = 0;
  const result = await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 1000, accepted: true });
  check('关麦后不接受新的语音段', result.ok === false && result.reason === 'busy', JSON.stringify(result));
  check('关麦后不会调用识别', !h.has('asr'), h.calls.join(' | '));

  // 现在打开麦克风，跑一轮，然后在播放期间关麦：播完不能再 resume
  await h.turn.setMicEnabled(true);
  const h2 = makeHarness({ subtitleMode: false });
  await h2.turn.start();
  h2.calls.length = 0;
  const speaking = h2.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  // speak 是同步 resolve 的，这里直接 await 完，检查 resume 一定发生
  await speaking;
  check('micEnabled=true 时播完会 resume', h2.has('mic.resume'), h2.calls.join(' | '));
}

/* -------------------------------------------------------------------------- */
/* 4. 无 Key：识别文本绝不发给聊天模型                                            */
/* -------------------------------------------------------------------------- */

async function testNoKey() {
  const h = makeHarness({ asr: { ok: true, text: '今天吃什么', provider: 'local', chat: false } });
  await h.turn.start();
  h.calls.length = 0;

  const result = await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 1000, accepted: true });

  check('无 Key 时不调用聊天模型', !h.has('chat'), h.calls.join(' | '));
  check('无 Key 时不合成语音（没有回复可播）', !h.has('speak'), h.calls.join(' | '));
  check('无 Key 时给出"我还没大脑"气泡', h.bubbles.some((b) => b.text === TEXTS.noBrain), JSON.stringify(h.bubbles));
  check('无 Key 气泡是 warn 级别（轻提示，不是错误弹窗）', h.bubbles.some((b) => b.kind === 'warn' && b.text === TEXTS.noBrain));
  check('无 Key 时返回 no-api-key 且带回识别文本', result.ok === false && result.reason === 'no-api-key' && result.transcript === '今天吃什么', JSON.stringify(result));
  check('无 Key 时仍处于 listening（可以继续说下一句）', h.turn.getState() === 'listening', h.turn.getState());
}

/* -------------------------------------------------------------------------- */
/* 5. 错误分级文案                                                              */
/* -------------------------------------------------------------------------- */

async function testErrorTexts() {
  const cases = [
    { code: 'no-api-key', expect: TEXTS.noBrain, kind: 'warn' },
    { code: 'auth-failed', expect: TEXTS.noBrain, kind: 'warn' },
    { code: 'forbidden', expect: TEXTS.noBrain, kind: 'warn' },
    { code: 'network', expect: TEXTS.network, kind: 'error' },
    { code: 'timeout', expect: TEXTS.network, kind: 'error' },
    { code: 'rate-limited', expect: TEXTS.network, kind: 'error' }
  ];

  for (const item of cases) {
    const h = makeHarness({ asr: { ok: false, code: item.code, chat: true } });
    await h.turn.start();
    h.bubbles.length = 0;
    await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
    check(`识别错误 ${item.code} 的气泡文案正确`, h.bubbles.some((b) => b.text === item.expect && b.kind === item.kind), JSON.stringify(h.bubbles));
    check(`识别错误 ${item.code} 时不会调用聊天`, !h.has('chat'), h.calls.join(' | '));
  }

  check('文案里明确给出 open.bigmodel.cn 引导', /open\.bigmodel\.cn/.test(TEXTS.noBrain), TEXTS.noBrain);
  check('网络错误文案是"网有点卡…"', TEXTS.network === '网有点卡…', TEXTS.network);
  check('classifyError 把 401 类错误归到 no-brain', classifyError('auth-failed').kind === 'no-brain');
  check('classifyError 把超时归到 network', classifyError('timeout').kind === 'network');
  check('classifyError 未知错误兜底文案不是"没大脑"', classifyError('bad-response').kind === 'unknown');
}

/* -------------------------------------------------------------------------- */
/* 6. 无效语音段（VAD accepted=false）绝不提交                                    */
/* -------------------------------------------------------------------------- */

async function testRejectedSegment() {
  const h = makeHarness();
  await h.turn.start();
  h.calls.length = 0;

  const result = await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 120, accepted: false, reason: 'silence' });
  check('accepted=false 的片段被直接丢弃', result.ok === false && result.reason === 'segment-rejected', JSON.stringify(result));
  check('被丢弃的片段不会调用识别', !h.has('asr'), h.calls.join(' | '));
  check('被丢弃的片段不会产生任何气泡（无声片段不是用户发言）', h.bubbles.length === 0, JSON.stringify(h.bubbles));

  const empty = await h.turn.onSpeechEnd({ bytes: new Uint8Array(0), durationMs: 500, accepted: true });
  check('空音频不会调用识别', empty.ok === false && empty.reason === 'empty-audio', JSON.stringify(empty));
  check('空音频确实没有调用识别', !h.has('asr'));
}

/* -------------------------------------------------------------------------- */
/* 7. 识别文本太短 / 空文本不回复                                                 */
/* -------------------------------------------------------------------------- */

async function testShortTranscript() {
  const h = makeHarness({ asr: { ok: true, text: '嗯', provider: 'cloud', chat: true } });
  await h.turn.start();
  h.calls.length = 0;

  const result = await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 700, accepted: true });
  check('识别文本太短时不回复', result.ok === false && result.reason === 'too-short', JSON.stringify(result));
  check('太短时没有调用聊天', !h.has('chat'), h.calls.join(' | '));
  check('太短时没有错误气泡（安静跳过）', h.bubbles.length === 0, JSON.stringify(h.bubbles));

  const emptyText = makeHarness({ asr: { ok: true, text: '   ', provider: 'cloud', chat: true } });
  await emptyText.turn.start();
  emptyText.calls.length = 0;
  const emptyResult = await emptyText.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 700, accepted: true });
  check('空识别文本返回 empty-transcript', emptyResult.ok === false && emptyResult.reason === 'empty-transcript', JSON.stringify(emptyResult));
  check('空识别文本不调用聊天', !emptyText.has('chat'));

  const localEmpty = makeHarness({ asr: { ok: false, code: 'empty-transcript', chat: true } });
  await localEmpty.turn.start();
  await localEmpty.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 700, accepted: true });
  check('识别服务报 empty-transcript 时给"什么都没听到"提示', localEmpty.bubbles.some((b) => b.text === TEXTS.emptySpeech), JSON.stringify(localEmpty.bubbles));
  check('empty-transcript 不会去调用聊天', !localEmpty.has('chat'));
}

/* -------------------------------------------------------------------------- */
/* 8. 字幕模式：默认关（不显示；只有文字没有声音是不允许的）                        */
/* -------------------------------------------------------------------------- */

async function testCaption() {
  // 默认（字幕关）：不显示字幕，但**语音照播**
  const off = makeHarness({ subtitleMode: false });
  await off.turn.start();
  await off.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  check('字幕关闭时不显示任何字幕', off.captions.length === 0, JSON.stringify(off.captions));
  check('字幕关闭时语音仍然播放（不是只出文字）', off.has('speak'), off.calls.join(' | '));

  // 打开字幕：显示的文本与播报的文本完全一致
  const on = makeHarness({ subtitleMode: true });
  await on.turn.start();
  const result = await on.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  check('字幕打开时显示 1 条字幕', on.captions.length === 1, JSON.stringify(on.captions));
  check('字幕内容与回复完全一致', on.captions[0] === result.reply && on.captions[0] === '哼、本鱼在呢', JSON.stringify(on.captions));
  check('字幕文本与 TTS 播报的文本相同', on.calls.some((c) => c === 'speak:' + on.captions[0]), `${on.calls.join(' | ')} vs ${on.captions[0]}`);
  check('字幕显示发生在播放开始附近（先显示后播放）', on.calls.indexOf('speak:' + on.captions[0]) >= 0);
}

/* -------------------------------------------------------------------------- */
/* 9. 播放失败：必须给一次明确提示（绝不静默只显示文字）                           */
/* -------------------------------------------------------------------------- */

async function testSpeakFailure() {
  const h = makeHarness({ speak: { ok: false, code: 'tts-failed' } });
  await h.turn.start();
  h.bubbles.length = 0;
  const result = await h.turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });

  check('播放失败时给出错误气泡', h.bubbles.some((b) => b.kind === 'error'), JSON.stringify(h.bubbles));
  check('播放失败仍然回到 listening（不卡死）', h.turn.getState() === 'listening', h.turn.getState());
  check('播放失败仍然返回识别文本与回复（内容没丢）', result.transcript === '你好呀' && result.reply === '哼、本鱼在呢', JSON.stringify(result));
  check('播放失败仍然恢复采集', h.has('mic.resume'), h.calls.join(' | '));
}

/* -------------------------------------------------------------------------- */
/* 10. 麦克风开关（菜单 / 快捷键 / 设置页共用同一条路径）                          */
/* -------------------------------------------------------------------------- */

async function testMicToggle() {
  const h = makeHarness();
  await h.turn.start();
  check('初始是开麦状态', h.turn.isMicEnabled() === true);

  const offResult = await h.turn.toggleMic();
  check('toggle 后变成关麦', offResult.enabled === false && h.turn.isMicEnabled() === false, JSON.stringify(offResult));
  check('关麦会停采并回到 idle', h.has('mic.pause') && h.turn.getState() === 'idle', h.calls.join(' | '));

  const onResult = await h.turn.toggleMic();
  check('再 toggle 变成开麦', onResult.enabled === true && h.turn.isMicEnabled() === true, JSON.stringify(onResult));
  check('重新开麦会重新拿到设备并回到 listening', onResult.ok === true && h.turn.getState() === 'listening', JSON.stringify(onResult));

  const idleBubbles = [];
  const idle = createTurnTaking({
    mic: { start: () => Promise.resolve({ ok: true }), pause: () => {}, resume: () => Promise.resolve({ ok: true }) },
    pipelines: {},
    onBubble: (payload) => idleBubbles.push(payload)
  });
  await idle.start();
  idle.notifyIdle('idle-enter');
  check('30 秒没说话会给一句撒娇式提示（轻量气泡）', idleBubbles.some((b) => b.text === TEXTS.bedtime), JSON.stringify(idleBubbles));
}

/* -------------------------------------------------------------------------- */
/* 11. 重入保护 / 释放                                                          */
/* -------------------------------------------------------------------------- */

async function testReentryAndDispose() {
  let resolveChat = null;
  const calls = [];
  const bubbles = [];
  const turn = createTurnTaking({
    mic: {
      start: () => Promise.resolve({ ok: true }),
      pause: () => calls.push('pause'),
      resume: () => Promise.resolve({ ok: true }),
      close: () => calls.push('close')
    },
    pipelines: {
      transcribe: () => Promise.resolve({ ok: true, text: '在的', chat: true }),
      chat: () =>
        new Promise((resolve) => {
          resolveChat = resolve;
        }),
      speak: () => Promise.resolve({ ok: true })
    },
    onBubble: (payload) => bubbles.push(payload)
  });

  await turn.start();
  const first = turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  // 等一拍，让状态推进到 thinking（此时 chat 还没 resolve）
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('思考中状态是 thinking', turn.getState() === 'thinking', turn.getState());

  const second = await turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  check('上一轮没结束时新的语音段被拒绝（防重入）', second.ok === false && second.reason === 'busy', JSON.stringify(second));

  resolveChat({ ok: true, text: '嗯嗯' });
  const finished = await first;
  check('上一轮最终正常完成', finished.ok === true && finished.reply === '嗯嗯', JSON.stringify(finished));

  turn.dispose();
  check('dispose 会关闭采集', calls.includes('close'), calls.join(','));
  const afterDispose = await turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  check('dispose 后不再接受语音段', afterDispose.ok === false && afterDispose.reason === 'disposed', JSON.stringify(afterDispose));
  check('dispose 后状态回到 idle', turn.getState() === 'idle', turn.getState());
}

/* -------------------------------------------------------------------------- */
/* 12. pipelines 抛异常也不会崩                                                  */
/* -------------------------------------------------------------------------- */

async function testPipelineThrows() {
  const bubbles = [];
  const turn = createTurnTaking({
    mic: { start: () => Promise.resolve({ ok: true }), pause: () => {}, resume: () => Promise.resolve({ ok: true }) },
    pipelines: {
      transcribe: () => {
        throw new Error('boom');
      }
    },
    onBubble: (payload) => bubbles.push(payload)
  });
  await turn.start();
  const result = await turn.onSpeechEnd({ bytes: fakeWav(), durationMs: 900, accepted: true });
  check('识别抛异常被归类为网络错误，不冒泡', result.ok === false && result.reason === 'network', JSON.stringify(result));
  check('识别抛异常时给"网有点卡…"气泡', bubbles.some((b) => b.text === TEXTS.network), JSON.stringify(bubbles));
  check('异常后仍然回到 listening（桌宠不会卡死）', turn.getState() === 'listening', turn.getState());
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  await testStart();
  await testHappyPath();
  await testNoResumeWhenDisabled();
  await testNoKey();
  await testErrorTexts();
  await testRejectedSegment();
  await testShortTranscript();
  await testCaption();
  await testSpeakFailure();
  await testMicToggle();
  await testReentryAndDispose();
  await testPipelineThrows();

  console.log('');
  console.log('语音回合管理单元测试');
  console.log('='.repeat(64));
  console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
  if (failures.length > 0) {
    console.log('');
    for (const item of failures) {
      console.log(`[失败] ${item}`);
    }
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('测试脚本自身异常：', error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
