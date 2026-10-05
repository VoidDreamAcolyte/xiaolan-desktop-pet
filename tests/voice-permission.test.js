'use strict';

/**
 * ============================================================================
 * 主进程单元测试：语音权限策略（main/voice-permission.js）
 * ============================================================================
 *
 * 这条测试把"权限只开一条缝"的策略钉死，任何放宽都会立刻失败：
 *
 *   允许（唯一一条）：
 *     ✅ 桌宠窗口（petWindow）主 frame + 本地 index.html 的 `audio`（麦克风）请求；
 *
 *   必须拒绝（fail-closed）：
 *     ❌ 设置窗口 / 未知窗口的任何权限；
 *     ❌ 非本地入口页面（外部 URL / 其它 file 页面）；
 *     ❌ 子 frame（details.isMainFrame === false 或 source.isMainFrame === false）；
 *     ❌ video / audio+video（摄像头）；
 *     ❌ display-capture / desktop-capture（屏幕采集红线）；
 *     ❌ 其它一切权限（通知 / 定位 / 剪贴板 / MIDI …）；
 *     ❌ 没有明确 mediaType 的 media 请求；
 *     ❌ 决策过程抛异常时（回调必须是 false，绝不因内部错误放行）。
 *
 * 同时验证 request 与 check **两个 handler 都装上了**，且同一个决策函数驱动两者。
 *
 * 本测试不启动 Electron、不发任何网络请求，session 用假对象替代。
 *
 * 用法：node tests/voice-permission.test.js
 */

const path = require('node:path');

const {
  PERMISSION_REASONS,
  ALLOWED_MEDIA_TYPES,
  decideVoicePermission,
  installVoicePermissionHandlers
} = require(path.join(__dirname, '..', 'main', 'voice-permission.js'));

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

/* -------------------------------------------------------------------------- */
/* 假 session / 固定来源                                                        */
/* -------------------------------------------------------------------------- */

const PET_ID = 7;
const SETTINGS_ID = 8;
const ENTRY_URL = 'file:///d:/bluefatfish/renderer/index.html';
const EXTERNAL_URL = 'https://evil.example/index.html';
const OTHER_LOCAL_URL = 'file:///d:/bluefatfish/renderer/settings.html';

/** 造一个只记录 handler 的假 session */
function createFakeSession() {
  const session = {
    requestHandler: null,
    checkHandler: null,
    setPermissionRequestHandler(fn) {
      session.requestHandler = fn;
    },
    setPermissionCheckHandler(fn) {
      session.checkHandler = fn;
    }
  };
  return session;
}

/** 安装一套"桌宠窗口 = id 7 + 本地入口页"的策略 */
function installHarness(options) {
  const opts = options || {};
  const session = createFakeSession();
  const warnings = [];
  const result = installVoicePermissionHandlers({
    session,
    isPetWebContents: opts.isPetWebContents || ((id) => id === PET_ID),
    matchesEntryUrl: opts.matchesEntryUrl || ((url) => url === ENTRY_URL),
    isMainFrameOf: opts.isMainFrameOf || (() => true),
    logger: { warn: (message) => warnings.push(message) }
  });
  return { session, result, warnings };
}

/**
 * 调 request handler 并返回 callback 收到的值。
 * @returns {{allowed: boolean, called: boolean}}
 */
function invokeRequest(session, webContents, permission, details) {
  let called = false;
  let allowed = null;
  session.requestHandler(webContents, permission, (value) => {
    called = true;
    allowed = value;
  }, details);
  return { allowed: allowed, called: called };
}

const AUDIO_DETAILS = Object.freeze({
  mediaType: 'audio',
  requestingUrl: ENTRY_URL,
  isMainFrame: true
});

/* -------------------------------------------------------------------------- */
/* 1. 纯决策函数：唯一放行的组合                                                */
/* -------------------------------------------------------------------------- */

function testDecideAllow() {
  const decision = decideVoicePermission({
    source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
    permission: 'media',
    details: { mediaType: 'audio', requestingUrl: ENTRY_URL, isMainFrame: true }
  });
  check('宠物主 frame + 本地入口 + audio → 放行', decision.allowed === true, JSON.stringify(decision));
  check('放行原因码是 audio-only-ok', decision.reason === PERMISSION_REASONS.AUDIO_ONLY, String(decision.reason));
  check(
    '允许的媒体类型只有 audio（没有 video）',
    ALLOWED_MEDIA_TYPES.length === 1 && ALLOWED_MEDIA_TYPES[0] === 'audio',
    JSON.stringify(ALLOWED_MEDIA_TYPES)
  );
}

function testDecideDenyMatrix() {
  /** @type {Array<{name: string, input: object, reason: string}>} */
  const cases = [
    {
      name: '设置窗口（不是 pet 窗口）',
      input: {
        source: { isPetWindow: false, urlMatchesEntry: true, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'audio', requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.NOT_PET_WINDOW
    },
    {
      name: '外部 URL',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: false, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'audio', requestingUrl: EXTERNAL_URL }
      },
      reason: PERMISSION_REASONS.BAD_URL
    },
    {
      name: '其它本地页面（settings.html）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: false, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'audio', requestingUrl: OTHER_LOCAL_URL }
      },
      reason: PERMISSION_REASONS.BAD_URL
    },
    {
      name: '子 frame（source.isMainFrame=false）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: false },
        permission: 'media',
        details: { mediaType: 'audio', requestingUrl: ENTRY_URL, isMainFrame: true }
      },
      reason: PERMISSION_REASONS.NOT_MAIN_FRAME
    },
    {
      name: '子 frame（details.isMainFrame=false）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'audio', requestingUrl: ENTRY_URL, isMainFrame: false }
      },
      reason: PERMISSION_REASONS.NOT_MAIN_FRAME
    },
    {
      name: 'video（摄像头）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'video', requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.VIDEO_DENIED
    },
    {
      name: 'audio+video（摄像头）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'audio+video', requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.VIDEO_DENIED
    },
    {
      name: 'display-capture（屏幕采集红线）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'display-capture',
        details: { requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.DISPLAY_DENIED
    },
    {
      name: 'desktop-capture（屏幕采集红线）',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'desktop-capture',
        details: { requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.DISPLAY_DENIED
    },
    {
      name: '通知权限',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'notifications',
        details: { requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.NOT_MEDIA
    },
    {
      name: '定位权限',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'geolocation',
        details: { requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.NOT_MEDIA
    },
    {
      name: '剪贴板读权限',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'clipboard-read',
        details: { requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.NOT_MEDIA
    },
    {
      name: 'media 但缺 mediaType',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'media',
        details: { requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.MEDIA_TYPE_MISSING
    },
    {
      name: 'media + 未知 mediaType',
      input: {
        source: { isPetWindow: true, urlMatchesEntry: true, isMainFrame: true },
        permission: 'media',
        details: { mediaType: 'unknown', requestingUrl: ENTRY_URL }
      },
      reason: PERMISSION_REASONS.NOT_MEDIA
    },
    {
      name: '空输入',
      input: {},
      reason: PERMISSION_REASONS.NOT_PET_WINDOW
    }
  ];

  for (const item of cases) {
    const decision = decideVoicePermission(item.input);
    check(
      `拒绝：${item.name}（原因 ${item.reason}）`,
      decision.allowed === false && decision.reason === item.reason,
      JSON.stringify(decision)
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2. 两个 handler 都装上，且都按同一策略放行 / 拒绝                              */
/* -------------------------------------------------------------------------- */

function testHandlersInstalled() {
  const harness = installHarness();
  check('安装成功（session 支持两个 setter）', harness.result.installed === true);
  check('request handler 已安装', typeof harness.session.requestHandler === 'function');
  check('check handler 已安装', typeof harness.session.checkHandler === 'function');
  check('安装结果同时暴露两个 handler', typeof harness.result.requestHandler === 'function' && typeof harness.result.checkHandler === 'function');
}

function testRequestHandlerAllowsAudio() {
  const harness = installHarness();
  const res = invokeRequest(harness.session, { id: PET_ID }, 'media', Object.assign({}, AUDIO_DETAILS));
  check('request handler：宠物主 frame 的 audio → callback(true)', res.called === true && res.allowed === true, JSON.stringify(res));
  check(
    '决策被记录为 audio-only-ok',
    harness.result.decisions.some((d) => d.allowed === true && d.reason === PERMISSION_REASONS.AUDIO_ONLY),
    JSON.stringify(harness.result.decisions)
  );
}

function testRequestHandlerDenies() {
  const harness = installHarness();
  const cases = [
    { name: '设置窗口', wc: { id: SETTINGS_ID }, permission: 'media', details: { mediaType: 'audio', requestingUrl: ENTRY_URL } },
    { name: '外部 URL', wc: { id: PET_ID }, permission: 'media', details: { mediaType: 'audio', requestingUrl: EXTERNAL_URL } },
    { name: '子 frame', wc: { id: PET_ID }, permission: 'media', details: { mediaType: 'audio', requestingUrl: ENTRY_URL, isMainFrame: false } },
    { name: 'video', wc: { id: PET_ID }, permission: 'media', details: { mediaType: 'video', requestingUrl: ENTRY_URL } },
    { name: 'display-capture', wc: { id: PET_ID }, permission: 'display-capture', details: { requestingUrl: ENTRY_URL } },
    { name: '通知权限', wc: { id: PET_ID }, permission: 'notifications', details: { requestingUrl: ENTRY_URL } },
    { name: '缺 mediaType', wc: { id: PET_ID }, permission: 'media', details: { requestingUrl: ENTRY_URL } }
  ];
  for (const item of cases) {
    const res = invokeRequest(harness.session, item.wc, item.permission, item.details);
    check(`request handler 拒绝：${item.name}（callback=false）`, res.called === true && res.allowed === false, JSON.stringify(res));
  }
  check('拒绝时没有产生 allowed=true 的决策', harness.result.decisions.every((d) => d.allowed === false));
}

function testCheckHandler() {
  const harness = installHarness();

  const allowed = harness.session.checkHandler({ id: PET_ID }, 'media', ENTRY_URL, { mediaType: 'audio', isMainFrame: true });
  check('check handler：宠物主 frame 的 audio → true', allowed === true, String(allowed));

  const denials = [
    { name: '设置窗口', wc: { id: SETTINGS_ID }, permission: 'media', origin: ENTRY_URL, details: { mediaType: 'audio' } },
    { name: '外部 URL', wc: { id: PET_ID }, permission: 'media', origin: EXTERNAL_URL, details: { mediaType: 'audio' } },
    { name: '子 frame', wc: { id: PET_ID }, permission: 'media', origin: ENTRY_URL, details: { mediaType: 'audio', isMainFrame: false } },
    { name: 'video', wc: { id: PET_ID }, permission: 'media', origin: ENTRY_URL, details: { mediaType: 'video' } },
    { name: 'display-capture', wc: { id: PET_ID }, permission: 'display-capture', origin: ENTRY_URL, details: {} },
    { name: '其它权限', wc: { id: PET_ID }, permission: 'midi', origin: ENTRY_URL, details: {} },
    { name: '缺 mediaType', wc: { id: PET_ID }, permission: 'media', origin: ENTRY_URL, details: {} }
  ];
  for (const item of denials) {
    const result = harness.session.checkHandler(item.wc, item.permission, item.origin, item.details);
    check(`check handler 拒绝：${item.name} → false`, result === false, String(result));
  }
}

/* -------------------------------------------------------------------------- */
/* 3. fail-closed：内部异常 / 未安装时也绝不放行                                  */
/* -------------------------------------------------------------------------- */

function testFailClosedOnException() {
  const harness = installHarness({
    isPetWebContents: () => {
      throw new Error('内部错误细节不应外泄');
    }
  });

  const requestResult = invokeRequest(harness.session, { id: PET_ID }, 'media', Object.assign({}, AUDIO_DETAILS));
  check('request handler 内部异常 → callback(false)', requestResult.called === true && requestResult.allowed === false, JSON.stringify(requestResult));

  let checkResult = true;
  let threw = false;
  try {
    checkResult = harness.session.checkHandler({ id: PET_ID }, 'media', ENTRY_URL, { mediaType: 'audio' });
  } catch {
    threw = true;
  }
  check('check handler 内部异常不抛出', threw === false);
  check('check handler 内部异常 → false', checkResult === false, String(checkResult));

  // 日志只记权限名 + 原因码，不含异常细节
  check(
    '拒绝日志不含异常细节',
    harness.warnings.every((message) => !String(message).includes('内部错误细节')),
    JSON.stringify(harness.warnings)
  );
}

function testNotInstalledWhenSessionIncomplete() {
  const bare = {};
  const result = installVoicePermissionHandlers({ session: bare });
  check('session 不完整时 installed=false', result.installed === false, JSON.stringify(result));

  const missingCheck = {
    setPermissionRequestHandler() {}
  };
  const result2 = installVoicePermissionHandlers({ session: missingCheck });
  check('缺 check setter 时 installed=false', result2.installed === false, JSON.stringify(result2));

  const result3 = installVoicePermissionHandlers({});
  check('没有 session 时 installed=false', result3.installed === false, JSON.stringify(result3));
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

function main() {
  testDecideAllow();
  testDecideDenyMatrix();
  testHandlersInstalled();
  testRequestHandlerAllowsAudio();
  testRequestHandlerDenies();
  testCheckHandler();
  testFailClosedOnException();
  testNotInstalledWhenSessionIncomplete();

  console.log('');
  console.log('语音权限策略单元测试');
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

main();
