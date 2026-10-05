'use strict';

/**
 * ============================================================================
 * 主进程单元测试：智谱 GLM-TTS 语音合成客户端（main/tts-client.js）
 * ============================================================================
 *
 * 官方接口固定事实（必须逐项对上）：
 *   - endpoint: POST https://open.bigmodel.cn/api/paas/v4/audio/speech
 *   - JSON body：{ model: 'glm-tts', input: <文本>, voice: <音色 id>, response_format: 'wav' }
 *   - 响应是 audio/wav 文件字节（24kHz）
 *   - 文本最大 1024 字；默认音色 tongtong
 *
 * 覆盖需求里的行为：
 *   - 输入校验：非字符串 / 空白 / 超过 1024 字；音色白名单回落 tongtong；
 *   - 固定 endpoint / model / voice / Authorization，Key 不进返回值 / 错误 / 日志；
 *   - 超时 10s + 最多一次重试（只重试网络 / 超时 / 408 / 425 / 429 / 5xx）；
 *   - WAV 校验：空音频 / 非 RIFF 一律 bad-response；
 *   - GLM-TTS → edge-tts → SAPI 顺序与跳过条件；
 *   - 全部失败返回 fallback: 'speechSynthesis' 交给渲染层兜底；
 *   - 临时文件成功保留（调用方删）、失败删除、启动 cleanupTemp 兜底清理；
 *   - **绝不执行真实 Python / edge-tts / SAPI 进程，也绝不发真实 HTTP 请求。**
 *
 * 用法：node tests/tts-client.test.js
 */

const path = require('node:path');

const {
  TTS_ENDPOINT,
  TTS_MODEL,
  TTS_RESPONSE_FORMAT,
  TTS_SAMPLE_RATE,
  TTS_MAX_INPUT_CHARS,
  TTS_VOICES,
  TTS_DEFAULT_VOICE,
  TTS_ERROR_MESSAGES,
  FALLBACK_CODES,
  validateText,
  normalizeVoice,
  createTtsClient
} = require(path.join(__dirname, '..', 'main', 'tts-client.js'));
const {
  createFakeFetch,
  createFakeTimers,
  createMemoryFs
} = require(path.join(__dirname, 'helpers', 'fake-io.js'));

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

const FAKE_KEY = '1234567890abcdef.ABCDEFGHIJKLMNOP';
const SECRET_BODY = 'UPSTREAM-INTERNAL-DETAIL-不要泄露';

/** 造一段带合法 RIFF/WAVE 头的音频字节 */
function wavBytes(size) {
  const length = Number.isFinite(size) ? Math.max(12, size) : 128;
  const bytes = new Uint8Array(length);
  bytes[0] = 0x52; // R
  bytes[1] = 0x49; // I
  bytes[2] = 0x46; // F
  bytes[3] = 0x46; // F
  bytes[8] = 0x57; // W
  bytes[9] = 0x41; // A
  bytes[10] = 0x56; // V
  bytes[11] = 0x45; // E
  return bytes;
}

/**
 * 造一个 TTS 客户端。
 *
 * `script` 控制假 fetch；`edge` / `native` 控制注入的假子进程：
 *   - undefined：不注入（返回 not-available）；
 *   - `{bytes: n}`：成功并向目标文件写入 n 字节；
 *   - `{ok:false, code}`：失败；
 *   - `{throw:true}`：抛异常；
 *   - 函数：完全自定义 `(text, file, fs) => result`。
 */
function makeTts(options) {
  const opts = options || {};
  const script = opts.script || [{ status: 200, body: wavBytes(128) }];
  const { fetchImpl, calls } = createFakeFetch(script);
  const fs = opts.fs || createMemoryFs();
  const timers = createFakeTimers();
  const logs = [];
  const edgeCalls = [];
  const nativeCalls = [];

  function makeSubprocess(spec, list, provider) {
    if (spec === undefined || spec === null || spec === false) return null;
    return (text, file) => {
      list.push({ text, file });
      if (typeof spec === 'function') return Promise.resolve(spec(text, file, fs));
      if (spec.throw === true) return Promise.reject(new Error('subprocess exploded 内部细节'));
      if (spec.ok === false) return Promise.resolve({ ok: false, code: spec.code || 'subprocess-failed' });
      const size = Number.isFinite(spec.bytes) ? spec.bytes : 128;
      fs.writeFileSync(file, 'x'.repeat(Math.max(0, size)));
      return Promise.resolve({ ok: true, provider });
    };
  }

  const client = createTtsClient({
    fetchImpl,
    fs,
    timers,
    getApiKey: () => (opts.apiKey === undefined ? FAKE_KEY : opts.apiKey),
    getVoice: typeof opts.getVoice === 'function'
      ? opts.getVoice
      : () => (opts.voice === undefined ? TTS_DEFAULT_VOICE : opts.voice),
    runEdgeTts: makeSubprocess(opts.edge, edgeCalls, 'edge-tts'),
    runNativeTts: makeSubprocess(opts.native, nativeCalls, 'sapi'),
    tempDir: opts.tempDir || 'C:\\temp\\tts',
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    logger: { warn: (message) => logs.push(message) }
  });

  return { client, fetchCalls: calls, fs, logs, edgeCalls, nativeCalls, timers };
}

/** 解析一次请求的 JSON body */
function parseBody(fetchCall) {
  try {
    return JSON.parse(fetchCall.body);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 1. 常量与纯函数：官方固定事实                                                */
/* -------------------------------------------------------------------------- */

{
  check('endpoint 写死为官方地址', TTS_ENDPOINT === 'https://open.bigmodel.cn/api/paas/v4/audio/speech', TTS_ENDPOINT);
  check('模型名写死为 glm-tts', TTS_MODEL === 'glm-tts', TTS_MODEL);
  check('固定返回格式 wav', TTS_RESPONSE_FORMAT === 'wav', TTS_RESPONSE_FORMAT);
  check('采样率 24kHz', TTS_SAMPLE_RATE === 24000, String(TTS_SAMPLE_RATE));
  check('文本上限 1024 字', TTS_MAX_INPUT_CHARS === 1024, String(TTS_MAX_INPUT_CHARS));
  check('音色白名单是官方 7 个', TTS_VOICES.join(',') === 'tongtong,chuichui,xiaochen,jam,kazi,douji,luodo', TTS_VOICES.join(','));
  check('默认音色 tongtong', TTS_DEFAULT_VOICE === 'tongtong', TTS_DEFAULT_VOICE);
  check('降级白名单含无 Key / 网络 / 超时 / 5xx',
    ['no-api-key', 'network', 'timeout', 'server-error'].every((code) => FALLBACK_CODES.includes(code)),
    FALLBACK_CODES.join(','));

  check('validateText：正常文本 trim 后返回', JSON.stringify(validateText('  你好  ')) === JSON.stringify({ ok: true, value: '你好' }), JSON.stringify(validateText('  你好  ')));
  check('validateText：空字符串 → empty-text', validateText('').ok === false && validateText('').code === 'empty-text');
  check('validateText：纯空白 → empty-text', validateText('   ').code === 'empty-text');
  check('validateText：非字符串 → empty-text', validateText(null).code === 'empty-text' && validateText(123).code === 'empty-text');
  check('validateText：1024 字放行', validateText('a'.repeat(1024)).ok === true);
  check('validateText：1025 字 → too-long', validateText('a'.repeat(1025)).code === 'too-long');
  check('validateText：按码点计数（1024 个 emoji 放行）', validateText('😀'.repeat(1024)).ok === true);
  check('validateText：1025 个 emoji → too-long', validateText('😀'.repeat(1025)).code === 'too-long');

  check('normalizeVoice：白名单音色原样返回', normalizeVoice('chuichui') === 'chuichui');
  check('normalizeVoice：非法音色回落 tongtong', normalizeVoice('evil-voice') === 'tongtong');
  check('normalizeVoice：非字符串回落 tongtong', normalizeVoice(undefined) === 'tongtong' && normalizeVoice(null) === 'tongtong');
}

/* -------------------------------------------------------------------------- */
/* 2. 云端成功：endpoint / JSON body / 固定 voice / Authorization               */
/* -------------------------------------------------------------------------- */

async function testCloudSuccess() {
  const h = makeTts({ script: [{ status: 200, body: wavBytes(256) }], edge: { bytes: 64 }, native: { bytes: 64 } });
  const result = await h.client.synthesize('你好呀');

  check('云端合成成功返回 ok', result.ok === true, JSON.stringify(result));
  check('返回 provider=glm-tts', result.provider === 'glm-tts', String(result.provider));
  check('返回文本被 trim', result.text === '你好呀', JSON.stringify(result.text));
  check('返回音频字节数正确', result.bytes === 256, String(result.bytes));
  check('返回固定采样率 24kHz', result.sampleRate === TTS_SAMPLE_RATE, String(result.sampleRate));
  check('只请求 1 次（成功不重试）', h.fetchCalls.length === 1, String(h.fetchCalls.length));
  check('请求写死的 endpoint', h.fetchCalls[0].url === TTS_ENDPOINT, h.fetchCalls[0].url);
  check('方法必须是 POST', h.fetchCalls[0].method === 'POST', h.fetchCalls[0].method);

  const headerKeys = Object.keys(h.fetchCalls[0].headers).map((key) => key.toLowerCase());
  check('Content-Type 是 application/json', String(h.fetchCalls[0].headers['Content-Type']).toLowerCase() === 'application/json', JSON.stringify(h.fetchCalls[0].headers));
  check('Accept 是 audio/wav', h.fetchCalls[0].headers.Accept === 'audio/wav', JSON.stringify(h.fetchCalls[0].headers));
  check('带上了 Authorization', headerKeys.includes('authorization') && h.fetchCalls[0].headers.Authorization === `Bearer ${FAKE_KEY}`, JSON.stringify(h.fetchCalls[0].headers));

  const body = parseBody(h.fetchCalls[0]);
  check('body 是合法 JSON', body !== null, String(h.fetchCalls[0].body));
  check('body.model=glm-tts', body && body.model === TTS_MODEL, JSON.stringify(body));
  check('body.input=待合成文本', body && body.input === '你好呀', JSON.stringify(body));
  check('body.voice 默认 tongtong', body && body.voice === TTS_DEFAULT_VOICE, JSON.stringify(body));
  check('body.response_format=wav', body && body.response_format === TTS_RESPONSE_FORMAT, JSON.stringify(body));

  check('音频落到了 tempDir 下的 .wav', h.fs.files.has(result.file) && /\.wav$/.test(result.file) && result.file.indexOf('C:\\temp\\tts') === 0, String(result.file));
  check('云端成功时跳过 edge-tts', h.edgeCalls.length === 0, String(h.edgeCalls.length));
  check('云端成功时跳过 SAPI', h.nativeCalls.length === 0, String(h.nativeCalls.length));
  check('返回值不含 Key', !JSON.stringify(result).includes(FAKE_KEY), JSON.stringify(result));
  check('返回值不含上游正文', !JSON.stringify(result).includes('UPSTREAM-INTERNAL-DETAIL'), JSON.stringify(result));
}

async function testCloudBodyTextTrim() {
  const h = makeTts({ script: [{ status: 200, body: wavBytes(64) }] });
  await h.client.synthesize('   前后有空格   ');
  const body = parseBody(h.fetchCalls[0]);
  check('发给云端的 input 也是 trim 后的文本', body && body.input === '前后有空格', JSON.stringify(body));
}

async function testVoiceSelection() {
  const valid = makeTts({ voice: 'chuichui' });
  await valid.client.synthesize('你好');
  check('合法音色写进 body.voice', parseBody(valid.fetchCalls[0]).voice === 'chuichui', JSON.stringify(parseBody(valid.fetchCalls[0])));

  const invalid = makeTts({ voice: 'evil-voice' });
  await invalid.client.synthesize('你好');
  check('非法音色回落 tongtong', parseBody(invalid.fetchCalls[0]).voice === TTS_DEFAULT_VOICE, JSON.stringify(parseBody(invalid.fetchCalls[0])));
}

/* -------------------------------------------------------------------------- */
/* 3. 无 Key：不联网，直接 edge 兜底                                            */
/* -------------------------------------------------------------------------- */

async function testNoApiKey() {
  const h = makeTts({ apiKey: '', edge: { bytes: 100 } });
  const result = await h.client.synthesize('你好');

  check('无 Key 时绝不联网', h.fetchCalls.length === 0, String(h.fetchCalls.length));
  check('无 Key 时降级 edge-tts 成功', result.ok === true && result.provider === 'edge-tts', JSON.stringify(result));
  check('无 Key 时带 cloudCode=no-api-key', result.cloudCode === 'no-api-key', String(result.cloudCode));
  check('edge-tts 收到的是 trim 后文本', h.edgeCalls.length === 1 && h.edgeCalls[0].text === '你好', JSON.stringify(h.edgeCalls));
  check('无 Key 结果里不含 Key', !JSON.stringify(result).includes(FAKE_KEY), JSON.stringify(result));

  check('hasApiKey() 无 Key=false', h.client.hasApiKey() === false);
  check('hasApiKey() 有 Key=true', makeTts().client.hasApiKey() === true);
}

/* -------------------------------------------------------------------------- */
/* 4. HTTP 错误与重试策略                                                       */
/* -------------------------------------------------------------------------- */

async function testRetry() {
  // 500 重试一次成功后成功
  const recovered = makeTts({
    script: [{ status: 500, body: SECRET_BODY }, { status: 200, body: wavBytes(64) }]
  });
  const recoveredResult = await recovered.client.synthesize('你好');
  check('500 后重试成功', recoveredResult.ok === true && recoveredResult.provider === 'glm-tts', JSON.stringify(recoveredResult));
  check('重试成功后 requests=2', recovered.fetchCalls.length === 2, String(recovered.fetchCalls.length));
  check('重试成功后 attempts=2', recoveredResult.attempts === 2, String(recoveredResult.attempts));

  // 500 两次仍失败 → 降级 edge
  const serverError = makeTts({
    script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }],
    edge: { bytes: 64 }
  });
  const serverResult = await serverError.client.synthesize('你好');
  check('500 重试一次（共 2 次请求）', serverError.fetchCalls.length === 2, String(serverError.fetchCalls.length));
  check('500 后降级 edge-tts', serverResult.ok === true && serverResult.provider === 'edge-tts' && serverResult.cloudCode === 'server-error', JSON.stringify(serverResult));

  // 400 不重试
  const badRequest = makeTts({ script: [{ status: 400, body: SECRET_BODY }] });
  const badResult = await badRequest.client.synthesize('你好', { allowFallback: false });
  check('400 不重试（只请求 1 次）', badRequest.fetchCalls.length === 1, String(badRequest.fetchCalls.length));
  check('400 → http-error', badResult.code === 'http-error', JSON.stringify(badResult));

  // 429 重试
  const limited = makeTts({ script: [{ status: 429, body: SECRET_BODY }, { status: 429, body: SECRET_BODY }] });
  const limitedResult = await limited.client.synthesize('你好', { allowFallback: false });
  check('429 → rate-limited 且重试一次', limitedResult.code === 'rate-limited' && limited.fetchCalls.length === 2, `${limitedResult.code}/${limited.fetchCalls.length}`);

  // 网络错误重试
  const network = makeTts({ script: [{ throw: new Error('ECONNRESET 内部细节') }, { throw: new Error('ECONNRESET 内部细节') }] });
  const networkResult = await network.client.synthesize('你好', { allowFallback: false });
  check('网络错误 → network 且重试一次', networkResult.code === 'network' && network.fetchCalls.length === 2, `${networkResult.code}/${network.fetchCalls.length}`);
  check('网络错误提示"网有点卡…"', /网有点卡/.test(networkResult.message), networkResult.message);
  check('网络错误不回显原始 error.message', !JSON.stringify(networkResult).includes('ECONNRESET'), JSON.stringify(networkResult));
}

async function testTimeout() {
  const h = makeTts({ script: [{ hang: true }, { hang: true }] });

  check('TTS 默认超时 10 秒', h.client.timeoutMs === 10000, String(h.client.timeoutMs));
  check('TTS 默认最多重试一次', h.client.maxRetries === 1, String(h.client.maxRetries));

  const promise = h.client.synthesize('你好', { allowFallback: false });
  check('超时定时器已注册', h.timers.pendingCount === 1, String(h.timers.pendingCount));
  await h.timers.flushAsync();
  const result = await promise;

  check('超时 → timeout', result.ok === false && result.code === 'timeout', JSON.stringify(result));
  check('超时重试一次（共 2 次请求）', h.fetchCalls.length === 2, String(h.fetchCalls.length));
  check('超时提示"网有点卡…"', /网有点卡/.test(result.message), result.message);
}

async function testAuthError() {
  const h = makeTts({ script: [{ status: 401, body: SECRET_BODY }] });
  const result = await h.client.synthesize('你好', { allowFallback: false });

  check('401 → auth-failed', result.ok === false && result.code === 'auth-failed', JSON.stringify(result));
  check('401 不重试（只请求 1 次）', h.fetchCalls.length === 1, String(h.fetchCalls.length));
  check('401 文案引导去 open.bigmodel.cn', /open\.bigmodel\.cn/.test(result.message), result.message);
  check('401 不回显上游正文', !JSON.stringify(result).includes('UPSTREAM-INTERNAL-DETAIL'), JSON.stringify(result));
  check('401 不回显 Key', !JSON.stringify(result).includes(FAKE_KEY), JSON.stringify(result));
}

/* -------------------------------------------------------------------------- */
/* 5. WAV 校验：空音频 / 非 RIFF 都算 bad-response                              */
/* -------------------------------------------------------------------------- */

async function testWavValidation() {
  // 空音频
  const empty = makeTts({ script: [{ status: 200, body: new Uint8Array(0) }], edge: { bytes: 64 } });
  const emptyResult = await empty.client.synthesize('你好');
  check('空音频 → bad-response 并降级 edge', emptyResult.ok === true && emptyResult.provider === 'edge-tts' && emptyResult.cloudCode === 'bad-response', JSON.stringify(emptyResult));

  // 云端返回 JSON 错误体而不是音频
  const notWav = makeTts({ script: [{ status: 200, body: '{"error":"boom"}' }], edge: { bytes: 64 } });
  const notWavResult = await notWav.client.synthesize('你好');
  check('非 RIFF 响应 → bad-response 并降级 edge', notWavResult.ok === true && notWavResult.cloudCode === 'bad-response', JSON.stringify(notWavResult));

  // 太短（< 12 字节）也不是 WAV
  const tooShort = makeTts({ script: [{ status: 200, body: new Uint8Array(8) }] });
  const tooShortResult = await tooShort.client.synthesize('你好');
  check('过短响应 → bad-response', tooShortResult.ok === false && tooShortResult.code === 'bad-response', JSON.stringify(tooShortResult));

  // 禁止降级时直接返回 bad-response + speechSynthesis
  const noFallback = makeTts({ script: [{ status: 200, body: '{"error":"boom"}' }] });
  const noFallbackResult = await noFallback.client.synthesize('你好');
  check('bad-response 且禁用降级 → fallback speechSynthesis', noFallbackResult.ok === false && noFallbackResult.code === 'bad-response' && noFallbackResult.fallback === 'speechSynthesis', JSON.stringify(noFallbackResult));
}

/* -------------------------------------------------------------------------- */
/* 6. 降级顺序与跳过条件：GLM-TTS → edge-tts → SAPI → speechSynthesis           */
/* -------------------------------------------------------------------------- */

async function testFallbackOrder() {
  // 云端成功：不碰 edge / native
  const cloudOk = makeTts({ edge: { bytes: 64 }, native: { bytes: 64 } });
  const cloudOkResult = await cloudOk.client.synthesize('你好');
  check('云端成功时不调用 edge/SAPI', cloudOkResult.provider === 'glm-tts' && cloudOk.edgeCalls.length === 0 && cloudOk.nativeCalls.length === 0, `${cloudOk.edgeCalls.length}/${cloudOk.nativeCalls.length}`);

  // 云端失败 → edge 成功 → 不碰 native
  const edgeOk = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { bytes: 64 }, native: { bytes: 64 } });
  const edgeOkResult = await edgeOk.client.synthesize('你好');
  check('云端失败后走 edge-tts', edgeOkResult.ok === true && edgeOkResult.provider === 'edge-tts', JSON.stringify(edgeOkResult));
  check('edge 成功后跳过 SAPI', edgeOk.edgeCalls.length === 1 && edgeOk.nativeCalls.length === 0, `${edgeOk.edgeCalls.length}/${edgeOk.nativeCalls.length}`);

  // 云端失败 → edge 失败 → SAPI 成功
  const nativeOk = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { ok: false, code: 'subprocess-failed' }, native: { bytes: 64 } });
  const nativeOkResult = await nativeOk.client.synthesize('你好');
  check('edge 失败后走 SAPI', nativeOkResult.ok === true && nativeOkResult.provider === 'sapi', JSON.stringify(nativeOkResult));
  check('SAPI 成功时带 edgeCode', nativeOkResult.edgeCode === 'subprocess-failed', String(nativeOkResult.edgeCode));
  check('SAPI 成功时带 cloudCode', nativeOkResult.cloudCode === 'server-error', String(nativeOkResult.cloudCode));

  // 云端失败 → 没注入 edge → SAPI 成功
  const noEdge = makeTts({ script: [{ status: 500 }, { status: 500 }], native: { bytes: 64 } });
  const noEdgeResult = await noEdge.client.synthesize('你好');
  check('未注入 edge 时直接走 SAPI', noEdgeResult.ok === true && noEdgeResult.provider === 'sapi' && noEdge.nativeCalls.length === 1, JSON.stringify(noEdgeResult));

  // 三层全失败 → speechSynthesis 兜底
  const allFail = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { ok: false }, native: { ok: false } });
  const allFailResult = await allFail.client.synthesize('你好');
  check('三层全失败返回 speechSynthesis 兜底', allFailResult.ok === false && allFailResult.fallback === 'speechSynthesis', JSON.stringify(allFailResult));
  check('三层全失败返回云端错误码与文案', allFailResult.code === 'server-error' && allFailResult.message === TTS_ERROR_MESSAGES['server-error'], JSON.stringify(allFailResult));

  // allowFallback:false → 跳过 edge / SAPI
  const noFallback = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { bytes: 64 }, native: { bytes: 64 } });
  const noFallbackResult = await noFallback.client.synthesize('你好', { allowFallback: false });
  check('allowFallback:false 时跳过 edge/SAPI', noFallback.edgeCalls.length === 0 && noFallback.nativeCalls.length === 0, `${noFallback.edgeCalls.length}/${noFallback.nativeCalls.length}`);
  check('allowFallback:false 仍返回 speechSynthesis 兜底', noFallbackResult.fallback === 'speechSynthesis' && noFallbackResult.code === 'server-error', JSON.stringify(noFallbackResult));
}

/* -------------------------------------------------------------------------- */
/* 7. 对外入口输入校验                                                          */
/* -------------------------------------------------------------------------- */

async function testInputValidation() {
  const empty = makeTts({ edge: { bytes: 64 }, native: { bytes: 64 } });
  const emptyResult = await empty.client.synthesize('');
  check('空文本 → empty-text', emptyResult.ok === false && emptyResult.code === 'empty-text', JSON.stringify(emptyResult));
  check('空文本不联网、不调用 edge/SAPI', empty.fetchCalls.length === 0 && empty.edgeCalls.length === 0 && empty.nativeCalls.length === 0, `${empty.fetchCalls.length}/${empty.edgeCalls.length}/${empty.nativeCalls.length}`);
  check('空文本返回 speechSynthesis 兜底', emptyResult.fallback === 'speechSynthesis', JSON.stringify(emptyResult));

  const notString = makeTts();
  const notStringResult = await notString.client.synthesize(null);
  check('非字符串 → empty-text 且不联网', notStringResult.code === 'empty-text' && notString.fetchCalls.length === 0, JSON.stringify(notStringResult));

  const tooLong = makeTts({ edge: { bytes: 64 } });
  const tooLongResult = await tooLong.client.synthesize('a'.repeat(TTS_MAX_INPUT_CHARS + 1));
  check('超过 1024 字 → too-long', tooLongResult.ok === false && tooLongResult.code === 'too-long', JSON.stringify(tooLongResult));
  check('超长文本不联网、不降级', tooLong.fetchCalls.length === 0 && tooLong.edgeCalls.length === 0, `${tooLong.fetchCalls.length}/${tooLong.edgeCalls.length}`);

  const edge = makeTts({ script: [{ status: 200, body: wavBytes(32) }] });
  const edgeResult = await edge.client.synthesize('a'.repeat(TTS_MAX_INPUT_CHARS));
  check('刚好 1024 字放行', edgeResult.ok === true, JSON.stringify(edgeResult));
}

/* -------------------------------------------------------------------------- */
/* 8. 临时文件生命周期：成功保留 / 失败清理 / removeTemp / cleanupTemp / prune   */
/* -------------------------------------------------------------------------- */

async function testTempLifecycle() {
  // edge 成功：文件保留（交给调用方播放后删除）
  const edgeOk = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { bytes: 64 } });
  const edgeOkResult = await edgeOk.client.synthesize('你好');
  check('edge 成功后文件仍在（供播放）', edgeOk.fs.files.has(edgeOkResult.file), String(edgeOkResult.file));
  edgeOk.client.removeTemp(edgeOkResult.file);
  check('调用方 removeTemp 后文件被删除', edgeOk.fs.files.size === 0, JSON.stringify(Array.from(edgeOk.fs.files.keys())));

  // edge 失败：临时文件删除
  const edgeFail = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { ok: false, code: 'subprocess-failed' } });
  const edgeFailResult = await edgeFail.client.synthesize('你好');
  check('edge 失败时清理临时文件', edgeFailResult.ok === false && edgeFail.fs.files.size === 0, JSON.stringify(Array.from(edgeFail.fs.files.keys())));

  // edge 先写出半成品再报失败：必须调用 unlink 清掉
  const edgePartial = makeTts({
    script: [{ status: 500 }, { status: 500 }],
    edge: (text, file, fsRef) => {
      fsRef.writeFileSync(file, 'partial');
      return { ok: false, code: 'subprocess-failed' };
    }
  });
  const edgePartialResult = await edgePartial.client.synthesize('你好');
  check('edge 失败时清理已写出的半成品', edgePartialResult.ok === false && edgePartial.fs.files.size === 0, JSON.stringify(Array.from(edgePartial.fs.files.keys())));
  check('edge 失败时确实调用了 unlink', edgePartial.fs.operations.some((op) => op.op === 'unlink'), JSON.stringify(edgePartial.fs.operations));

  // edge 声称成功但没写文件：按 subprocess-failed 处理并清理
  const edgeEmpty = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { bytes: 0 } });
  const edgeEmptyResult = await edgeEmpty.client.synthesize('你好');
  check('edge 写空文件时按 subprocess-failed 处理', edgeEmptyResult.ok === false && edgeEmpty.fs.files.size === 0, JSON.stringify(edgeEmptyResult));

  // edge 抛异常：不把异常抛给上层，临时文件清理
  const edgeThrow = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { throw: true } });
  const edgeThrowResult = await edgeThrow.client.synthesize('你好');
  check('edge 抛异常时优雅失败且清理', edgeThrowResult.ok === false && edgeThrow.fs.files.size === 0, JSON.stringify(edgeThrowResult));
  check('edge 抛异常不泄露内部细节', !JSON.stringify(edgeThrowResult).includes('subprocess exploded'), JSON.stringify(edgeThrowResult));

  // SAPI 失败：临时文件删除
  const nativeFail = makeTts({ script: [{ status: 500 }, { status: 500 }], edge: { ok: false }, native: { ok: false } });
  const nativeFailResult = await nativeFail.client.synthesize('你好');
  check('SAPI 失败时清理临时文件', nativeFailResult.ok === false && nativeFail.fs.files.size === 0, JSON.stringify(Array.from(nativeFail.fs.files.keys())));

  // 云端写入失败（mkdir 抛错）
  const fsFail = createMemoryFs();
  fsFail.mkdirSync = () => {
    throw new Error('EACCES');
  };
  const writeFail = makeTts({ fs: fsFail, script: [{ status: 200, body: wavBytes(64) }], edge: {}, native: {} });
  const writeFailResult = await writeFail.client.synthesize('你好');
  check('临时目录创建失败 → internal-error + speechSynthesis', writeFailResult.ok === false && writeFailResult.code === 'internal-error' && writeFailResult.fallback === 'speechSynthesis', JSON.stringify(writeFailResult));
  check('临时目录不可用时不盲目启动 edge/SAPI 子进程', writeFail.edgeCalls.length === 0 && writeFail.nativeCalls.length === 0, `${writeFail.edgeCalls.length}/${writeFail.nativeCalls.length}`);
}

async function testCleanupTemp() {
  const h = makeTts();
  h.fs.writeFileSync('C:\\temp\\tts\\tts-1-1.wav', 'x');
  h.fs.writeFileSync('C:\\temp\\tts\\edge-2-2.wav', 'x');
  h.fs.writeFileSync('C:\\temp\\tts\\sapi-3-3.wav', 'x');
  h.fs.writeFileSync('C:\\temp\\tts\\user-note.wav', 'x');
  h.fs.writeFileSync('C:\\temp\\tts\\keep.txt', 'x');

  const removed = h.client.cleanupTemp();
  check('启动清理只删本应用的 tts/edge/sapi 产物', removed === 3, String(removed));
  check('启动清理不误删用户文件', h.fs.files.has('C:\\temp\\tts\\user-note.wav') && h.fs.files.has('C:\\temp\\tts\\keep.txt'), JSON.stringify(Array.from(h.fs.files.keys())));
  check('启动清理后本应用产物已删除', !h.fs.files.has('C:\\temp\\tts\\tts-1-1.wav') && !h.fs.files.has('C:\\temp\\tts\\edge-2-2.wav') && !h.fs.files.has('C:\\temp\\tts\\sapi-3-3.wav'));

  const noReaddir = makeTts({ fs: { readdirSync: null, unlinkSync: () => {} } });
  check('fs 不支持 readdir 时 cleanupTemp 静默返回 0', noReaddir.client.cleanupTemp() === 0);
}

async function testPruneTemp() {
  const h = makeTts({ script: [{ status: 200, body: wavBytes(64) }] });
  for (let i = 0; i < 55; i += 1) {
    h.fs.writeFileSync(`C:\\temp\\tts\\tts-${i}-1.wav`, 'x');
  }
  const result = await h.client.synthesize('你好');
  check('产物超过上限时自动清理最旧的', h.fs.files.size === 50, String(h.fs.files.size));
  check('清理后刚写出的产物仍在', result.ok === true && h.fs.files.has(result.file), JSON.stringify(result));
}

/* -------------------------------------------------------------------------- */
/* 9. 安全：Key / 上游正文绝不进入返回值、错误与日志                             */
/* -------------------------------------------------------------------------- */

async function testNoSecretLeak() {
  const h = makeTts({ script: [{ status: 401, body: SECRET_BODY }], edge: { bytes: 64 } });
  const result = await h.client.synthesize('你好');
  const serialized = JSON.stringify(result);

  check('降级成功时返回值不含 Key', !serialized.includes(FAKE_KEY), serialized);
  check('降级成功时返回值不含 Key 前缀', !serialized.includes(FAKE_KEY.slice(0, 8)), serialized);
  check('降级成功时返回值不含上游正文', !serialized.includes('UPSTREAM-INTERNAL-DETAIL'), serialized);
  check('日志里没有 Key', h.logs.every((message) => !message.includes(FAKE_KEY)), h.logs.join(' | '));
  check('日志里没有上游正文', h.logs.every((message) => !message.includes('UPSTREAM-INTERNAL-DETAIL')), h.logs.join(' | '));
  check('返回对象没有 apiKey 字段', !Object.prototype.hasOwnProperty.call(result, 'apiKey'));

  const fail = makeTts({ script: [{ status: 401, body: SECRET_BODY }] });
  const failResult = await fail.client.synthesize('你好', { allowFallback: false });
  const failSerialized = JSON.stringify(failResult);
  check('失败返回值不含 Key', !failSerialized.includes(FAKE_KEY), failSerialized);
  check('失败返回值不含上游正文', !failSerialized.includes('UPSTREAM-INTERNAL-DETAIL'), failSerialized);
  check('失败提示确实引导去 open.bigmodel.cn', /open\.bigmodel\.cn/.test(failResult.message), failResult.message);
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  await testCloudSuccess();
  await testCloudBodyTextTrim();
  await testVoiceSelection();
  await testNoApiKey();
  await testRetry();
  await testTimeout();
  await testAuthError();
  await testWavValidation();
  await testFallbackOrder();
  await testInputValidation();
  await testTempLifecycle();
  await testCleanupTemp();
  await testPruneTemp();
  await testNoSecretLeak();

  console.log('');
  console.log('TTS 客户端单元测试');
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
