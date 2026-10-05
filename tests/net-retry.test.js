'use strict';

/**
 * ============================================================================
 * 主进程单元测试：带超时 / 一次重试的 HTTP 执行器（main/net-retry.js）
 * ============================================================================
 *
 * ASR 与 TTS 的云调用都走这一层，所以这条测试覆盖的是"两条链路共同的正确性"：
 *
 *   1. endpoint 用的是调用方给的那个（ASR / TTS 各自写死，这里只验证不被篡改）；
 *   2. 超时 **10 秒**（需求），且**整个 fetch + 读 body 共用一个超时**；
 *   3. 读 body 卡住也会被归类为 timeout（不是永远挂起、也不是 bad-response）；
 *   4. 最多重试 **一次**，且只重试 网络 / 超时 / 408 / 425 / 429 / 5xx；
 *   5. 401 / 403 / 400 等永久错误**绝不重试**；
 *   6. 定时器一定会被清理（不泄漏）；
 *   7. 失败只回短错误码 + 固定中文短语，**绝不回显上游响应体、绝不回显 API Key**。
 *
 * 全部用假 fetch + 假定时器，**不发任何真实请求**。
 *
 * 用法：node tests/net-retry.test.js
 */

const path = require('node:path');

const { createHttpRunner, VOICE_TIMEOUT_MS, MAX_RETRIES, isRetryableCode, codeForStatus, HTTP_ERROR_MESSAGES } = require(
  path.join(__dirname, '..', 'main', 'net-retry.js')
);
const { createFakeFetch, createFakeTimers } = require(path.join(__dirname, 'helpers', 'fake-io.js'));

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

/** 一个绝不泄露给调用方的"上游正文"，用来验证错误路径不回显 */
const SECRET_BODY = 'UPSTREAM-INTERNAL-DETAIL-不要泄露';
const FAKE_KEY = '1234567890abcdef.ABCDEFGHIJKLMNOP';

/* -------------------------------------------------------------------------- */
/* 1. 常量与错误码映射                                                          */
/* -------------------------------------------------------------------------- */

{
  check('语音链路超时是 10 秒（需求）', VOICE_TIMEOUT_MS === 10000, String(VOICE_TIMEOUT_MS));
  check('最多重试一次（需求）', MAX_RETRIES === 1, String(MAX_RETRIES));
  check('408 / 425 / 429 / 5xx 可重试', [408, 425, 429, 500, 502, 503, 504].every((s) => isRetryableCode('http-error', s)));
  check('401 / 403 / 400 不可重试', [400, 401, 403, 404, 422].every((s) => isRetryableCode('http-error', s) === false));
  check('网络与超时可重试', isRetryableCode('network') && isRetryableCode('timeout'));
  check('401 映射成 auth-failed', codeForStatus(401) === 'auth-failed');
  check('403 映射成 forbidden', codeForStatus(403) === 'forbidden');
  check('429 映射成 rate-limited', codeForStatus(429) === 'rate-limited');
  check('500 映射成 server-error', codeForStatus(500) === 'server-error');
  check('400 映射成 http-error', codeForStatus(400) === 'http-error');
  check('固定中文短语里提到"网有点卡"', /网有点卡/.test(HTTP_ERROR_MESSAGES.network), HTTP_ERROR_MESSAGES.network);
  check('没有 internal-error 之类的英文短语泄漏给用户', !/undefined/.test(HTTP_ERROR_MESSAGES['internal-error']));
}

/* -------------------------------------------------------------------------- */
/* 2. 成功路径：endpoint / method / headers / body / 读 body 方式                  */
/* -------------------------------------------------------------------------- */

async function testSuccess() {
  const { fetchImpl, calls } = createFakeFetch([{ status: 200, body: { text: '你好' } }]);
  const runner = createHttpRunner({ fetchImpl });
  const result = await runner.run({
    url: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
    method: 'POST',
    headers: { Accept: 'application/json' },
    apiKey: FAKE_KEY,
    bodyFactory: () => 'BODY',
    readBody: 'json'
  });

  check('成功返回 ok', result.ok === true, JSON.stringify(result));
  check('成功返回解析后的 JSON', result.data && result.data.text === '你好', JSON.stringify(result.data));
  check('成功只请求了 1 次', calls.length === 1, String(calls.length));
  check('使用调用方给的 URL（不被篡改）', calls[0].url === 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions', calls[0].url);
  check('method 是 POST', calls[0].method === 'POST', calls[0].method);
  check('带上 Authorization: Bearer <key>', calls[0].headers.Authorization === `Bearer ${FAKE_KEY}`, JSON.stringify(calls[0].headers));
  check('请求体来自 bodyFactory', calls[0].body === 'BODY', String(calls[0].body));
  check('没有传 shell / signal 之外的多余字段（signal 存在以便超时 abort）', calls[0].hasSignal === true);
  check('成功结果里没有把 Key 带出来', !JSON.stringify(result).includes(FAKE_KEY));
}

async function testNoKeyHeader() {
  // 没给 apiKey 时不拼 Authorization（云端会返回 401，由调用方处理）
  const { fetchImpl, calls } = createFakeFetch([{ status: 200, body: 'ok' }]);
  const runner = createHttpRunner({ fetchImpl });
  await runner.run({ url: 'https://example.invalid/x', headers: {}, bodyFactory: () => 'x', readBody: 'text' });
  check('没有 apiKey 时不拼 Authorization 头', calls[0].headers.Authorization === undefined, JSON.stringify(calls[0].headers));
}

async function testBodyFactoryPerAttempt() {
  // bodyFactory 每次重试都会被重新调用（不能用一次性实例）
  const { fetchImpl } = createFakeFetch([
    { status: 503, body: SECRET_BODY },
    { status: 200, body: { text: 'ok' } }
  ]);
  const runner = createHttpRunner({ fetchImpl });
  let factoryCalls = 0;
  const result = await runner.run({
    url: 'https://example.invalid/x',
    bodyFactory: () => {
      factoryCalls += 1;
      return 'form-' + factoryCalls;
    },
    readBody: 'json'
  });
  check('重试时 bodyFactory 被重新调用（FormData 不能被复用）', factoryCalls === 2, String(factoryCalls));
  check('重试后成功返回 ok', result.ok === true && result.attempts === 2, JSON.stringify(result));
}

/* -------------------------------------------------------------------------- */
/* 3. 非 2xx：错误码映射 + 绝不回显上游正文                                       */
/* -------------------------------------------------------------------------- */

async function testErrorCodes() {
  const cases = [
    { status: 400, code: 'http-error', retry: false },
    { status: 401, code: 'auth-failed', retry: false },
    { status: 403, code: 'forbidden', retry: false },
    { status: 404, code: 'http-error', retry: false },
    { status: 429, code: 'rate-limited', retry: true },
    { status: 500, code: 'server-error', retry: true },
    { status: 503, code: 'server-error', retry: true }
  ];

  for (const item of cases) {
    const script = item.retry
      ? [{ status: item.status, body: SECRET_BODY }, { status: item.status, body: SECRET_BODY }]
      : [{ status: item.status, body: SECRET_BODY }];
    const { fetchImpl, calls } = createFakeFetch(script);
    const runner = createHttpRunner({ fetchImpl });
    const result = await runner.run({
      url: 'https://example.invalid/x',
      apiKey: FAKE_KEY,
      bodyFactory: () => 'x',
      readBody: 'text'
    });

    check(`HTTP ${item.status} → ${item.code}`, result.ok === false && result.code === item.code, JSON.stringify(result));
    check(`HTTP ${item.status} 的回显里没有上游正文`, !JSON.stringify(result).includes('UPSTREAM-INTERNAL-DETAIL'));
    check(`HTTP ${item.status} 的回显里没有 Key`, !JSON.stringify(result).includes(FAKE_KEY));
    check(`HTTP ${item.status} 返回固定中文短语`, typeof result.message === 'string' && result.message.length > 0, result.message);
    check(
      `HTTP ${item.status} 的重试策略正确（${item.retry ? '重试' : '不重试'}）`,
      calls.length === (item.retry ? 2 : 1),
      `实际请求 ${calls.length} 次`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4. 网络错误：归类 network，并按策略重试一次                                    */
/* -------------------------------------------------------------------------- */

async function testNetwork() {
  const { fetchImpl, calls } = createFakeFetch([
    { throw: new Error('ECONNRESET 内部细节') },
    { throw: new Error('ECONNRESET 内部细节') }
  ]);
  const runner = createHttpRunner({ fetchImpl });
  const result = await runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });

  check('网络错误归类为 network', result.ok === false && result.code === 'network', JSON.stringify(result));
  check('网络错误重试一次（共 2 次请求）', calls.length === 2, String(calls.length));
  check('网络错误返回 attempts=2', result.attempts === 2, String(result.attempts));
  check('网络错误不回显原始 error.message', !JSON.stringify(result).includes('ECONNRESET'));
  check('网络错误提示是"网有点卡…"', /网有点卡/.test(result.message), result.message);
}

async function testNetworkRetryThenSuccess() {
  // 第一次网络错误、第二次成功：最终 ok，attempts=2
  const { fetchImpl, calls } = createFakeFetch([
    { throw: new Error('boom') },
    { status: 200, body: 'fine' }
  ]);
  const runner = createHttpRunner({ fetchImpl });
  const result = await runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('网络错误后重试成功', result.ok === true && result.attempts === 2, JSON.stringify(result));
  check('重试成功共 2 次请求', calls.length === 2, String(calls.length));
}

async function testPermanentNoRetry() {
  // 永久错误不重试：只请求 1 次
  const { fetchImpl, calls } = createFakeFetch([{ status: 401, body: SECRET_BODY }]);
  const runner = createHttpRunner({ fetchImpl });
  const result = await runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('401 只请求 1 次（不重试）', calls.length === 1, String(calls.length));
  check('401 返回 attempts=1', result.attempts === 1, String(result.attempts));
}

/* -------------------------------------------------------------------------- */
/* 5. 超时：整个 fetch + 读 body 共用一个超时                                     */
/* -------------------------------------------------------------------------- */

async function testTimeout() {
  // fetch 本身卡住
  const { fetchImpl, calls } = createFakeFetch([{ hang: true }, { hang: true }]);
  const timers = createFakeTimers();
  const runner = createHttpRunner({ fetchImpl, timers, timeoutMs: 10000 });
  check('默认超时是 10 秒', runner.timeoutMs === 10000, String(runner.timeoutMs));

  const promise = runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('超时定时器已注册', timers.pendingCount === 1, String(timers.pendingCount));
  /*
   * 用异步版推进：超时回调里会 abort，而 abort 的拒绝是异步到达的，
   * 重试请求的超时定时器也在那之后才注册 —— 必须让它自己注册出来再触发，
   * 否则测试会挂死（既不会失败也不会结束，那是假的通过）。
   */
  await timers.flushAsync();
  const result = await promise;

  check('fetch 卡住 → timeout', result.ok === false && result.code === 'timeout', JSON.stringify(result));
  check('超时后重试一次（共 2 次请求）', calls.length === 2, String(calls.length));
  check('超时结果 attempts=2', result.attempts === 2, String(result.attempts));
  check('超时提示是"网有点卡…"', /网有点卡/.test(result.message), result.message);
  check('超时后定时器已被清理（没有残留）', timers.clearedIds.length >= 1, JSON.stringify(timers.clearedIds));
  check('超时路径没有留下未触发的定时器', timers.pendingCount === 0, String(timers.pendingCount));
}

async function testBodyReadTimeout() {
  // 拿到 headers 但读 body 卡住：必须同样归类 timeout（缺陷 E 的同一类问题）
  const { fetchImpl, calls } = createFakeFetch([
    { status: 200, body: { text: 'x' }, hangBody: true },
    { status: 200, body: { text: 'x' }, hangBody: true }
  ]);
  const timers = createFakeTimers();
  const runner = createHttpRunner({ fetchImpl, timers });

  const promise = runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'json' });
  // 让 fetch 的 await 先落定（进入"读 body 卡住"的状态），再推进超时
  await new Promise((resolve) => setImmediate(resolve));
  await timers.flushAsync();
  const result = await promise;

  check('读 body 卡住也归类为 timeout（不是挂起、不是 bad-response）', result.ok === false && result.code === 'timeout', JSON.stringify(result));
  check('读 body 超时同样重试一次', calls.length === 2, String(calls.length));
}

async function testTimerCleanup() {
  // 成功路径下定时器也必须被清掉
  const { fetchImpl } = createFakeFetch([{ status: 200, body: 'fine' }]);
  const timers = createFakeTimers();
  const runner = createHttpRunner({ fetchImpl, timers });
  const result = await runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('成功路径返回 ok', result.ok === true);
  check('成功路径清理了超时定时器', timers.pendingCount === 0, String(timers.pendingCount));
  check('成功路径至少清理过一次定时器', timers.clearedIds.length === 1, JSON.stringify(timers.clearedIds));

  // 非 2xx 路径同样要清理定时器
  const { fetchImpl: fetchImpl2 } = createFakeFetch([{ status: 400, body: SECRET_BODY }]);
  const timers2 = createFakeTimers();
  const runner2 = createHttpRunner({ fetchImpl: fetchImpl2, timers: timers2 });
  await runner2.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('非 2xx 路径也清理了定时器', timers2.pendingCount === 0, String(timers2.pendingCount));
}

/* -------------------------------------------------------------------------- */
/* 6. 可配置的重试次数 / 超时（构造参数生效）                                      */
/* -------------------------------------------------------------------------- */

async function testConfigurable() {
  const { fetchImpl, calls } = createFakeFetch([{ status: 503, body: SECRET_BODY }]);
  const runner = createHttpRunner({ fetchImpl, maxRetries: 0 });
  const result = await runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('maxRetries=0 时不重试', calls.length === 1 && result.attempts === 1, `${calls.length} / ${result.attempts}`);

  const custom = createHttpRunner({ fetchImpl: createFakeFetch([{ status: 200, body: 'x' }]).fetchImpl, timeoutMs: 15000 });
  check('timeoutMs 可配置', custom.timeoutMs === 15000, String(custom.timeoutMs));

  const bad = createHttpRunner({ fetchImpl: createFakeFetch([{ status: 200, body: 'x' }]).fetchImpl, timeoutMs: -5 });
  check('非法 timeoutMs 回落默认 10 秒', bad.timeoutMs === VOICE_TIMEOUT_MS, String(bad.timeoutMs));
}

/* -------------------------------------------------------------------------- */
/* 7. 没有 fetch 实现时返回 internal-error（不抛异常）                             */
/* -------------------------------------------------------------------------- */

async function testNoFetch() {
  const runner = createHttpRunner({ fetchImpl: null });
  const result = await runner.run({ url: 'https://example.invalid/x', bodyFactory: () => 'x', readBody: 'text' });
  check('没有 fetch 时返回 internal-error 而不是抛异常', result.ok === false && result.code === 'internal-error', JSON.stringify(result));
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  /*
   * 安全网：任何一条用例把 Promise 挂死时，这里会主动失败并把错误打出来，
   * 而不是让 `node tests/net-retry.test.js` 静默退出（那会伪装成"测试通过"）。
   */
  let safetyFired = false;
  const safety = setTimeout(() => {
    safetyFired = true;
    check('用例未在 10 秒内结束（存在挂死的 Promise）', false);
    console.log('');
    console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
    for (const item of failures) console.log(`[失败] ${item}`);
    process.exit(1);
  }, 10000);

  await testSuccess();
  await testNoKeyHeader();
  await testBodyFactoryPerAttempt();
  await testErrorCodes();
  await testNetwork();
  await testNetworkRetryThenSuccess();
  await testPermanentNoRetry();
  await testTimeout();
  await testBodyReadTimeout();
  await testTimerCleanup();
  await testConfigurable();
  await testNoFetch();

  if (!safetyFired) clearTimeout(safety);
  console.log('');
  console.log('HTTP 超时 / 重试单元测试');
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
