'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 设置窗口 preload 行为回归（阶段 3 缺陷修复 B / C）
 * ============================================================================
 *
 * 为什么单独一个文件：
 *   main/settings-preload.js 顶层只能 `require('electron')`（sandbox: true 下无法
 *   require 本地模块），所以裸 node 不能直接 require 它。这里用 `node:vm` 造一个
 *   最小沙箱，把 electron 换成 mock，**真实执行 preload 源码**，再驱动它暴露出来的
 *   `window.blueFatFishSettings` 观察行为 —— 不是 grep 假装验证。
 *
 * 覆盖的缺陷：
 *   B. 清除 Key 的哨兵精确匹配：`'\u0000CLEAR\u0000'` 必须原样透传给主进程。
 *      旧实现先用通用控制字符过滤，NUL 被丢掉，清除命令根本没发出去。
 *   C. 非空但不合法的草稿 Key / 模型名必须本地报错、**不调用主进程**，
 *      绝不能让主进程回落到已保存的 Key / 环境变量（那会造成"保存/测试成功"的假象）。
 *      同样地，非精确的控制串（例如哨兵多一个字符）仍然要被拒绝。
 *
 * 本文件不联网、不读真实配置、不碰真实 Electron。
 *
 * 用法：node tests/settings-preload.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PRELOAD_PATH = path.join(ROOT, 'main', 'settings-preload.js');

/** 与 settings-store / settings-preload 一致的清除哨兵 */
const CLEAR_KEY_SENTINEL = '\u0000CLEAR\u0000';

/** 一个合法假 Key（形如智谱的 `id.secret`） */
const FAKE_KEY = '1234567890abcdef.ABCDEFGHIJKLMNOP';
const FAKE_KEY_TRIMMED = '0123456789abcdef.QQQQQQQQQQQQQQQQ';

/* -------------------------------------------------------------------------- */
/* 迷你断言框架                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `  ← ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/* VM 加载器：真实执行 preload，mock 掉 electron                                */
/* -------------------------------------------------------------------------- */

/**
 * 在 VM 沙箱里执行 settings-preload.js，返回它暴露的 API 与 IPC 调用记录。
 * @returns {{
 *   api: any,
 *   exposed: Record<string, unknown>,
 *   invokeCalls: Array<{channel: string, payload: unknown}>,
 *   listenerCalls: Array<{channel: string, listener: Function, removed?: boolean}>,
 *   requireRequests: string[]
 * }}
 */
function loadPreload() {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const invokeCalls = [];
  const listenerCalls = [];
  const requireRequests = [];
  const exposed = {};

  const ipcRenderer = {
    invoke(channel, payload) {
      invokeCalls.push({ channel: channel, payload: payload });
      return Promise.resolve({ ok: true, stub: true });
    },
    on(channel, listener) {
      listenerCalls.push({ channel: channel, listener: listener });
    },
    removeListener(channel, listener) {
      listenerCalls.push({ channel: channel, listener: listener, removed: true });
    }
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed[name] = value;
    }
  };
  const electron = { contextBridge: contextBridge, ipcRenderer: ipcRenderer };

  const sandbox = {
    require(name) {
      requireRequests.push(name);
      if (name === 'electron') return electron;
      throw new Error('preload 只允许 require electron，实际请求：' + name);
    },
    module: { exports: {} },
    console: console
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'main/settings-preload.js' }).runInContext(sandbox);

  return {
    api: exposed.blueFatFishSettings,
    exposed: exposed,
    invokeCalls: invokeCalls,
    listenerCalls: listenerCalls,
    requireRequests: requireRequests
  };
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('设置窗口 preload 行为回归（阶段 3 缺陷修复 B / C）');

  /* ---- 0. 基本暴露面 ---- */
  const env = loadPreload();
  const api = env.api;

  check('preload 只 require 了 electron', env.requireRequests.length === 1 && env.requireRequests[0] === 'electron', env.requireRequests.join(','));
  check('preload 只暴露 window.blueFatFishSettings 一个对象', Object.keys(env.exposed).join(',') === 'blueFatFishSettings', Object.keys(env.exposed).join(','));
  check('暴露对象是冻结的', api && Object.isFrozen(api) === true);
  check(
    '暴露的方法恰好是 getSettings / saveSettings / testConnection / onSettingsChanged / setVoiceSettings（+ phase）',
    api &&
      ['getSettings', 'saveSettings', 'testConnection', 'onSettingsChanged', 'setVoiceSettings'].every(function (name) {
        return typeof api[name] === 'function';
      }) &&
      Object.keys(api).sort().join(',') === 'getSettings,onSettingsChanged,phase,saveSettings,setVoiceSettings,testConnection',
    api ? Object.keys(api).sort().join(',') : '未暴露 API'
  );
  check('缺陷D：preload 已彻底删除 chat 方法', api && typeof api.chat === 'undefined');

  /* ---- 1. getSettings 使用正确通道 ---- */
  {
    const local = loadPreload();
    await local.api.getSettings();
    check(
      'getSettings 走 settings:get 且不带任何参数',
      local.invokeCalls.length === 1 &&
        local.invokeCalls[0].channel === 'settings:get' &&
        local.invokeCalls[0].payload === undefined,
      JSON.stringify(local.invokeCalls)
    );
  }

  /* ---- 2. 缺陷 B：精确哨兵才作为清除命令 ---- */
  {
    const local = loadPreload();
    const result = await local.api.saveSettings({ apiKey: CLEAR_KEY_SENTINEL });
    check(
      '缺陷B：精确哨兵被原样透传（NUL 没有被过滤掉）',
      local.invokeCalls.length === 1 &&
        local.invokeCalls[0].channel === 'settings:save' &&
        local.invokeCalls[0].payload.apiKey === CLEAR_KEY_SENTINEL,
      JSON.stringify(local.invokeCalls)
    );
    check('缺陷B：精确哨兵仍然调用主进程（保存结果由主进程返回）', result && result.ok === true);
  }

  {
    const local = loadPreload();
    const result = await local.api.saveSettings({ apiKey: '\u0000CLEAR\u0000x' });
    check(
      '缺陷B/C：哨兵多一个字符（非精确）被拒绝且不调用主进程',
      local.invokeCalls.length === 0 && result.ok === false && result.error === 'invalid-api-key',
      JSON.stringify({ calls: local.invokeCalls.length, result: result })
    );
    check('缺陷B/C：非精确哨兵的提示不回显输入内容', !JSON.stringify(result).includes('CLEAR'));
  }

  {
    const local = loadPreload();
    const result = await local.api.saveSettings({ apiKey: 'abcdefgh\u0000ijklmnop' });
    check(
      '缺陷B/C：其它含 NUL 的串仍然被拒绝且不调用主进程',
      local.invokeCalls.length === 0 && result.ok === false && result.error === 'invalid-api-key',
      JSON.stringify({ calls: local.invokeCalls.length, result: result })
    );
  }

  {
    const local = loadPreload();
    const result = await local.api.saveSettings({ apiKey: 'abcdefgh\nijklmnop' });
    check(
      '缺陷C：含换行的 Key 被拒绝且不调用主进程',
      local.invokeCalls.length === 0 && result.ok === false && result.error === 'invalid-api-key'
    );
  }

  /* ---- 3. 缺陷 C：非法非空草稿 Key 不 fallback、不联网 ---- */
  {
    const local = loadPreload();
    const result = await local.api.saveSettings({ apiKey: 'abc' });
    check(
      '缺陷C：过短的草稿 Key 本地报 invalid-api-key、不调用主进程',
      local.invokeCalls.length === 0 && result.ok === false && result.error === 'invalid-api-key',
      JSON.stringify({ calls: local.invokeCalls.length, result: result })
    );
    check('缺陷C：报错信息不包含刚输入的 Key 原文', !JSON.stringify(result).includes('abc'));
    check('缺陷C：报错信息是简短中文', /API Key/.test(result.message), result.message);
  }

  {
    const local = loadPreload();
    const tooLong = 'a'.repeat(513);
    const result = await local.api.saveSettings({ apiKey: tooLong });
    check(
      '缺陷C：超长草稿 Key 本地报错、不调用主进程、不回显',
      local.invokeCalls.length === 0 && result.ok === false && result.error === 'invalid-api-key' && !JSON.stringify(result).includes(tooLong.slice(0, 20))
    );
  }

  {
    const local = loadPreload();
    const result = await local.api.testConnection({ apiKey: 'short' });
    check(
      '缺陷C：测试连接的非空非法 Key 本地失败、不调用主进程',
      local.invokeCalls.length === 0 && result.ok === false && result.code === 'invalid-api-key',
      JSON.stringify({ calls: local.invokeCalls.length, result: result })
    );
    check('缺陷C：测试连接本地失败不返回任何正文 / 模型', result.model === '' && result.latencyMs === 0 && result.content === undefined);
    check('缺陷C：测试连接本地失败的提示不回显输入', !JSON.stringify(result).includes('short'));
  }

  {
    const local = loadPreload();
    const result = await local.api.testConnection({ apiKey: CLEAR_KEY_SENTINEL });
    check(
      '缺陷C：哨兵不能用于测试连接（视为非法、不调用主进程）',
      local.invokeCalls.length === 0 && result.ok === false && result.code === 'invalid-api-key'
    );
  }

  /* ---- 4. 空 Key = 不改动；合法 Key = 透传（trim 后） ---- */
  {
    const local = loadPreload();
    await local.api.saveSettings({ apiKey: '', model: 'glm-4.7-flash' });
    check(
      '空字符串 Key 表示"不改动"：payload 里没有 apiKey 字段',
      local.invokeCalls.length === 1 &&
        Object.prototype.hasOwnProperty.call(local.invokeCalls[0].payload, 'apiKey') === false &&
        local.invokeCalls[0].payload.model === 'glm-4.7-flash',
      JSON.stringify(local.invokeCalls)
    );
  }
  {
    const local = loadPreload();
    await local.api.saveSettings({});
    check('完全不传 Key/模型：payload 为空对象', local.invokeCalls.length === 1 && JSON.stringify(local.invokeCalls[0].payload) === '{}');
  }
  {
    const local = loadPreload();
    await local.api.saveSettings({ apiKey: `  ${FAKE_KEY}  ` });
    check(
      '合法 Key 被 trim 后透传',
      local.invokeCalls.length === 1 && local.invokeCalls[0].payload.apiKey === FAKE_KEY,
      JSON.stringify(local.invokeCalls)
    );
  }
  {
    const local = loadPreload();
    await local.api.testConnection({ apiKey: `  ${FAKE_KEY_TRIMMED}  ` });
    check(
      '测试连接的合法草稿 Key 被 trim 后透传（settings:test-connection）',
      local.invokeCalls.length === 1 &&
        local.invokeCalls[0].channel === 'settings:test-connection' &&
        local.invokeCalls[0].payload.apiKey === FAKE_KEY_TRIMMED,
      JSON.stringify(local.invokeCalls)
    );
  }
  {
    const local = loadPreload();
    await local.api.testConnection({});
    check('测试连接不传 Key：payload 为空对象（用已保存的 Key）', local.invokeCalls.length === 1 && JSON.stringify(local.invokeCalls[0].payload) === '{}');
  }

  /* ---- 5. 缺陷 C：save 的非空非法模型名 -> invalid-model ---- */
  {
    const local = loadPreload();
    const result = await local.api.saveSettings({ model: 'bad model!', apiKey: FAKE_KEY });
    check(
      '缺陷C：save 的非空非法模型名返回 invalid-model 且不调用主进程',
      local.invokeCalls.length === 0 && result.ok === false && result.error === 'invalid-model',
      JSON.stringify({ calls: local.invokeCalls.length, result: result })
    );
    check('缺陷C：invalid-model 提示不回显模型名原文', !JSON.stringify(result).includes('bad model'));
  }
  {
    const local = loadPreload();
    await local.api.saveSettings({ model: 'glm-4.6-flash' });
    check('合法模型名透传', local.invokeCalls.length === 1 && local.invokeCalls[0].payload.model === 'glm-4.6-flash');
  }
  {
    const local = loadPreload();
    await local.api.saveSettings({ model: '' });
    check('空模型名 = 不改动（payload 里没有 model）', local.invokeCalls.length === 1 && !Object.prototype.hasOwnProperty.call(local.invokeCalls[0].payload, 'model'));
  }

  /* ---- 6. 不接受 url / endpoint 覆盖 ---- */
  {
    const local = loadPreload();
    await local.api.saveSettings({ apiKey: FAKE_KEY, url: 'https://evil.example.com', endpoint: 'http://evil' });
    const payload = local.invokeCalls[0] ? local.invokeCalls[0].payload : {};
    check(
      'saveSettings 丢弃 url / endpoint 等非白名单字段',
      local.invokeCalls.length === 1 &&
        !Object.prototype.hasOwnProperty.call(payload, 'url') &&
        !Object.prototype.hasOwnProperty.call(payload, 'endpoint') &&
        !JSON.stringify(payload).includes('evil'),
      JSON.stringify(payload)
    );
  }
  {
    const local = loadPreload();
    await local.api.testConnection({ apiKey: FAKE_KEY, url: 'https://evil.example.com' });
    const payload = local.invokeCalls[0] ? local.invokeCalls[0].payload : {};
    check('testConnection 丢弃 url 等非白名单字段', !JSON.stringify(payload).includes('evil'), JSON.stringify(payload));
  }

  /* ---- 7. onSettingsChanged 只转发白名单字段 ---- */
  {
    const local = loadPreload();
    const seen = [];
    const unsubscribe = local.api.onSettingsChanged(function (payload) {
      seen.push(payload);
    });
    check('onSettingsChanged 订阅了 settings:changed', local.listenerCalls.some((c) => c.channel === 'settings:changed' && c.removed !== true));
    const entry = local.listenerCalls.find((c) => c.channel === 'settings:changed' && c.removed !== true);
    if (entry) {
      entry.listener({}, { model: 'glm-4.6-flash', hasApiKey: true, keySource: 'file', persistence: 'encrypted', apiKey: 'SECRET', evil: 1 });
    }
    check(
      'onSettingsChanged 只转发 model / hasApiKey / keySource / persistence',
      seen.length === 1 && seen[0].apiKey === undefined && seen[0].evil === undefined && seen[0].model === 'glm-4.6-flash' && seen[0].keySource === 'file',
      JSON.stringify(seen)
    );
    check('onSettingsChanged 对非对象 payload 直接忽略', (function () {
      if (entry) entry.listener({}, null);
      return seen.length === 1;
    })());
    unsubscribe();
    check('onSettingsChanged 返回的取消订阅真的调用 removeListener', local.listenerCalls.some((c) => c.removed === true));
  }

  /* ---- 输出 ---- */
  console.log('='.repeat(64));
  console.log(`共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项。`);
  if (failed > 0) {
    console.log('');
    console.log('失败项：');
    for (const item of failures) console.log(`  × ${item}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(function (error) {
  console.error('测试脚本自身异常：', error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
