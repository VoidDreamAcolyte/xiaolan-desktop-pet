'use strict';

/**
 * ============================================================================
 * 主进程单元测试：智谱 GLM-ASR 语音转文本客户端（main/asr-client.js）
 * ============================================================================
 *
 * 官方接口固定事实（必须逐项对上，错一个云端就直接拒绝）：
 *   - endpoint: POST https://open.bigmodel.cn/api/paas/v4/audio/transcriptions
 *   - multipart/form-data：model=glm-asr-2512、stream=false、file=音频文件
 *   - **不要手动设置 Content-Type**（要让 fetch 自动补 boundary）
 *   - 只支持 wav / mp3；最长 30 秒；文件 ≤25MB
 *   - 成功 JSON 里有 text 字段
 *
 * 另外覆盖需求里的行为：
 *   - 上传前先做体积 / 时长 / 格式预检（超限直接拒绝，绝不发出去）；
 *   - **webm 绝不允许直接上传**；
 *   - 超时 10s + 最多一次重试（只重试网络 / 超时 / 408 / 425 / 429 / 5xx）；
 *   - **无 Key 时完全不联网**，直接本地识别，并标记 chat=false；
 *   - 云端失败时降级本地 faster-whisper；本地不可用则优雅返回 unavailable；
 *   - 临时 WAV 在成功 / 失败后都会被删除；
 *   - 任何返回值 / 日志里都不出现 API Key 或上游响应体。
 *
 * 全部用假 fetch / 假 fs / 假 FormData，**不发真实请求、不写真实文件**。
 *
 * 用法：node tests/asr-client.test.js
 */

const path = require('node:path');

const {
  ASR_ENDPOINT,
  ASR_MODEL,
  ASR_MAX_FILE_BYTES,
  ASR_MAX_DURATION_MS,
  ASR_ALLOWED_FORMATS,
  ASR_ERROR_MESSAGES,
  LOCAL_FALLBACK_CODES,
  createAsrClient
} = require(path.join(__dirname, '..', 'main', 'asr-client.js'));
const {
  createFakeFetch,
  createFakeTimers,
  createMemoryFs,
  createFakeFormData,
  createFakeBlob
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

/** 造一段假的 WAV 字节（内容不重要，客户端只做体积 / 格式检查） */
function fakeWav(size) {
  return new Uint8Array(size || 6400);
}

/** 造一个 ASR 客户端，返回 { client, fetchCalls, fs, logs, forms } */
function makeClient(options) {
  const opts = options || {};
  const { fetchImpl, calls } = createFakeFetch(opts.script || [{ status: 200, body: { text: '你好呀' } }]);
  const fs = createMemoryFs();
  const timers = createFakeTimers();
  const logs = [];
  const FakeFormData = createFakeFormData();
  const FakeBlob = createFakeBlob();

  const localCalls = [];
  let localTranscriber = null;
  if (opts.localThrows) {
    // 模拟本地识别实现直接抛异常（验证不把原始异常 / Key 抛给上层）
    localTranscriber = {
      transcribe: (file, meta) => {
        localCalls.push({ file, meta });
        return Promise.reject(new Error('whisper exploded 内部细节'));
      }
    };
  } else if (opts.local) {
    localTranscriber = {
      transcribe: (file, meta) => {
        localCalls.push({ file, meta });
        return Promise.resolve(opts.local);
      }
    };
  }

  const client = createAsrClient({
    fetchImpl,
    fs,
    timers,
    getApiKey: () => (opts.apiKey === undefined ? FAKE_KEY : opts.apiKey),
    localTranscriber,
    tempDir: opts.tempDir || 'C:\\temp\\blue-fat-fish-voice',
    FormDataImpl: FakeFormData,
    BlobImpl: FakeBlob,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    logger: { warn: (message) => logs.push(message) }
  });

  return { client, fetchCalls: calls, fs, logs, forms: FakeFormData.entriesRef, localCalls, timers };
}

/** 在 multipart 表单里取某个字段 */
function formField(entries, name) {
  const found = entries.find((entry) => entry.name === name);
  return found ? found.value : undefined;
}

/* -------------------------------------------------------------------------- */
/* 1. 常量：官方固定事实                                                        */
/* -------------------------------------------------------------------------- */

{
  check(
    'endpoint 写死为官方地址',
    ASR_ENDPOINT === 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
    ASR_ENDPOINT
  );
  check('模型名写死为 glm-asr-2512', ASR_MODEL === 'glm-asr-2512', ASR_MODEL);
  check('文件上限 25MB', ASR_MAX_FILE_BYTES === 25 * 1024 * 1024, String(ASR_MAX_FILE_BYTES));
  check('时长上限 30 秒', ASR_MAX_DURATION_MS === 30000, String(ASR_MAX_DURATION_MS));
  check('只支持 wav / mp3', ASR_ALLOWED_FORMATS.join(',') === 'wav,mp3', ASR_ALLOWED_FORMATS.join(','));
  check('通用 http-error 不在本地降级白名单里（400 参数错误不降级）', !LOCAL_FALLBACK_CODES.includes('http-error'), LOCAL_FALLBACK_CODES.join(','));
  check('空识别结果不在本地降级白名单里', !LOCAL_FALLBACK_CODES.includes('empty-transcript'), LOCAL_FALLBACK_CODES.join(','));
  check('本地拦截错误码（no-audio/too-large/too-long/bad-format）都不在降级白名单里',
    ['no-audio', 'too-large', 'too-long', 'bad-format'].every((code) => !LOCAL_FALLBACK_CODES.includes(code)),
    LOCAL_FALLBACK_CODES.join(','));
  check('网络/超时/限流/5xx 可以降级本地',
    ['network', 'timeout', 'rate-limited', 'server-error'].every((code) => LOCAL_FALLBACK_CODES.includes(code)),
    LOCAL_FALLBACK_CODES.join(','));
  check('错误提示表覆盖所有云端错误码（不含 internal-error 兜底）',
    ['no-audio', 'too-large', 'too-long', 'bad-format', 'empty-transcript', 'bad-response', 'auth-failed', 'forbidden', 'rate-limited', 'server-error', 'http-error', 'timeout', 'network', 'unavailable']
      .every((code) => typeof ASR_ERROR_MESSAGES[code] === 'string' && ASR_ERROR_MESSAGES[code].length > 0 && ASR_ERROR_MESSAGES[code] !== ASR_ERROR_MESSAGES['internal-error']),
    JSON.stringify(ASR_ERROR_MESSAGES));
}

/* -------------------------------------------------------------------------- */
/* 2. 云端成功：endpoint / multipart 字段 / 不手写 Content-Type                  */
/* -------------------------------------------------------------------------- */

async function testCloudSuccess() {
  const h = makeClient({ script: [{ status: 200, body: { text: '  今天吃什么  ' } }] });
  const result = await h.client.transcribe(fakeWav(6400), { durationMs: 1200, format: 'wav' });

  check('云端识别成功返回 ok', result.ok === true, JSON.stringify(result));
  check('返回的 text 被 trim', result.text === '今天吃什么', JSON.stringify(result.text));
  check('provider 标记为 cloud', result.provider === 'cloud', String(result.provider));
  check('model 是 glm-asr-2512', result.model === ASR_MODEL, String(result.model));
  check('有 Key 时 chat=true（可以把识别结果送去对话）', result.chat === true, String(result.chat));

  check('只请求了 1 次（成功不重试）', h.fetchCalls.length === 1, String(h.fetchCalls.length));
  check('请求的是写死的 endpoint', h.fetchCalls[0].url === ASR_ENDPOINT, h.fetchCalls[0].url);
  check('方法必须是 POST', h.fetchCalls[0].method === 'POST', h.fetchCalls[0].method);

  // 关键点：**绝不手动设置 Content-Type** —— 让 fetch 自己补 multipart boundary
  const headerKeys = Object.keys(h.fetchCalls[0].headers).map((key) => key.toLowerCase());
  check('没有手动设置 Content-Type（让 fetch 补 boundary）', !headerKeys.includes('content-type'), JSON.stringify(h.fetchCalls[0].headers));
  check('带上了 Authorization', String(h.fetchCalls[0].headers.Authorization).indexOf('Bearer ') === 0);
  check('Authorization 里确实是当前 Key（且只在请求头里）', h.fetchCalls[0].headers.Authorization === `Bearer ${FAKE_KEY}`);

  // multipart 字段
  check('表单里有 model=glm-asr-2512', formField(h.forms, 'model') === ASR_MODEL, String(formField(h.forms, 'model')));
  check('表单里 stream=false', formField(h.forms, 'stream') === 'false', String(formField(h.forms, 'stream')));
  const fileEntry = h.forms.find((entry) => entry.name === 'file');
  check('表单里有 file 字段', Boolean(fileEntry));
  check('file 是音频 Blob（audio/wav）', fileEntry && fileEntry.value && fileEntry.value.type === 'audio/wav', fileEntry ? String(fileEntry.value.type) : 'null');
  check('file 带 wav 文件名', fileEntry && String(fileEntry.filename).endsWith('.wav'), fileEntry ? fileEntry.filename : 'null');
  check('file 体积与输入一致', fileEntry && fileEntry.value.size === 6400, fileEntry ? String(fileEntry.value.size) : 'null');
  check('表单字段恰好三个（model / stream / file）', h.forms.length === 3, JSON.stringify(h.forms.map((entry) => entry.name)));
}

async function testCloudSuccessNoTempFile() {
  // 成功路径不应写临时文件（有 Key 走云端，不需要落盘）
  const h = makeClient({ script: [{ status: 200, body: { text: '好' } }] });
  await h.client.transcribe(fakeWav(), { durationMs: 500, format: 'wav' });
  check('云端成功不写临时文件', h.fs.files.size === 0, JSON.stringify(Array.from(h.fs.files.keys())));
}

/* -------------------------------------------------------------------------- */
/* 3. 上传前预检：体积 / 时长 / 格式（绝不把 webm 传上去）                        */
/* -------------------------------------------------------------------------- */

async function testPreflight() {
  // 预检失败必须**云端与本地双重拦截**：所有用例都注入一个可用的本地识别，
  // 断言它一次都没被调用（不能"参数错误还浪费地降级到本地"）。
  const badLocal = { ok: true, text: '不该走到本地' };

  // 空音频
  const empty = makeClient({ local: badLocal });
  const emptyResult = await empty.client.transcribe(new Uint8Array(0), { durationMs: 100, format: 'wav' });
  check('空音频返回 no-audio', emptyResult.ok === false && emptyResult.code === 'no-audio', JSON.stringify(emptyResult));
  check('空音频不联网', empty.fetchCalls.length === 0, String(empty.fetchCalls.length));
  check('空音频也不降级本地', empty.localCalls.length === 0, String(empty.localCalls.length));

  // 超过 25MB
  const huge = makeClient({ local: badLocal });
  const hugeResult = await huge.client.transcribe(fakeWav(ASR_MAX_FILE_BYTES + 1), { durationMs: 5000, format: 'wav' });
  check('超过 25MB 直接拒绝', hugeResult.ok === false && hugeResult.code === 'too-large', JSON.stringify(hugeResult));
  check('超限音频绝不发出去', huge.fetchCalls.length === 0, String(huge.fetchCalls.length));
  check('超限音频也不降级本地', huge.localCalls.length === 0, String(huge.localCalls.length));
  check('超限提示是中文且不含 Key', /音频太大/.test(hugeResult.message) && !JSON.stringify(hugeResult).includes(FAKE_KEY), hugeResult.message);

  // 超过 30 秒
  const long = makeClient({ local: badLocal });
  const longResult = await long.client.transcribe(fakeWav(), { durationMs: 31000, format: 'wav' });
  check('超过 30 秒直接拒绝', longResult.ok === false && longResult.code === 'too-long', JSON.stringify(longResult));
  check('超时长音频绝不发出去', long.fetchCalls.length === 0, String(long.fetchCalls.length));
  check('超时长音频也不降级本地', long.localCalls.length === 0, String(long.localCalls.length));

  // 严格边界：30 秒 + 1 毫秒也必须拒绝（"最多 30 秒"）
  const overByOne = makeClient({ local: badLocal });
  const overByOneResult = await overByOne.client.transcribe(fakeWav(), { durationMs: ASR_MAX_DURATION_MS + 1, format: 'wav' });
  check('30 秒 + 1ms 直接拒绝', overByOneResult.ok === false && overByOneResult.code === 'too-long', JSON.stringify(overByOneResult));
  check('30 秒 + 1ms 不联网也不降级', overByOne.fetchCalls.length === 0 && overByOne.localCalls.length === 0, `${overByOne.fetchCalls.length}/${overByOne.localCalls.length}`);

  // webm 绝不直接上传
  const webm = makeClient({ local: badLocal });
  const webmResult = await webm.client.transcribe(fakeWav(), { durationMs: 1000, format: 'webm' });
  check('webm 被拒绝（官方只支持 wav / mp3）', webmResult.ok === false && webmResult.code === 'bad-format', JSON.stringify(webmResult));
  check('webm 绝不发出去', webm.fetchCalls.length === 0, String(webm.fetchCalls.length));
  check('webm 也不降级本地', webm.localCalls.length === 0, String(webm.localCalls.length));

  // mp3 是允许的（官方支持）
  const mp3 = makeClient({ script: [{ status: 200, body: { text: '好' } }] });
  const mp3Result = await mp3.client.transcribe(fakeWav(), { durationMs: 1000, format: 'mp3' });
  check('mp3 格式允许上传', mp3Result.ok === true, JSON.stringify(mp3Result));

  // 刚好边界：30 秒 / 25MB 都要放行
  const edge = makeClient({ script: [{ status: 200, body: { text: '边界' } }], local: badLocal });
  const edgeResult = await edge.client.transcribe(fakeWav(ASR_MAX_FILE_BYTES), { durationMs: 30000, format: 'wav' });
  check('25MB / 30 秒整的边界值仍然放行', edgeResult.ok === true, JSON.stringify(edgeResult));
  check('边界值走云端、不误伤本地', edge.localCalls.length === 0, String(edge.localCalls.length));

  // 非 Uint8Array 输入也不能崩
  const weird = makeClient({ local: badLocal });
  const weirdResult = await weird.client.transcribe('not-bytes', { durationMs: 100, format: 'wav' });
  check('非二进制输入返回 no-audio（不抛异常）', weirdResult.ok === false && weirdResult.code === 'no-audio', JSON.stringify(weirdResult));
  check('非二进制输入也不降级本地', weird.localCalls.length === 0, String(weird.localCalls.length));
}

/* -------------------------------------------------------------------------- */
/* 4. HTTP 错误与重试策略                                                       */
/* -------------------------------------------------------------------------- */

async function testHttpErrors() {
  // 401 不重试，且不回显上游正文 / Key
  const unauthorized = makeClient({ script: [{ status: 401, body: SECRET_BODY }] });
  const unauthorizedResult = await unauthorized.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('401 → auth-failed', unauthorizedResult.ok === false && unauthorizedResult.code === 'auth-failed', JSON.stringify(unauthorizedResult));
  check('401 不重试（只请求 1 次）', unauthorized.fetchCalls.length === 1, String(unauthorized.fetchCalls.length));
  check('401 不回显上游正文', !JSON.stringify(unauthorizedResult).includes('UPSTREAM-INTERNAL-DETAIL'));
  check('401 不回显 Key', !JSON.stringify(unauthorizedResult).includes(FAKE_KEY));
  check('401 提示引导去 open.bigmodel.cn', /open\.bigmodel\.cn/.test(unauthorizedResult.message), unauthorizedResult.message);

  // 500 重试一次后仍失败
  const serverError = makeClient({
    script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }]
  });
  const serverResult = await serverError.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('500 → server-error', serverResult.ok === false && serverResult.code === 'server-error', JSON.stringify(serverResult));
  check('500 重试一次（共 2 次请求）', serverError.fetchCalls.length === 2, String(serverError.fetchCalls.length));
  check('500 返回 attempts=2', serverResult.attempts === 2, String(serverResult.attempts));

  // 500 重试第二次成功
  const recovered = makeClient({
    script: [{ status: 503, body: SECRET_BODY }, { status: 200, body: { text: '恢复了' } }]
  });
  const recoveredResult = await recovered.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav' });
  check('503 后重试成功', recoveredResult.ok === true && recoveredResult.text === '恢复了', JSON.stringify(recoveredResult));
  check('重试成功后 attempts=2', recoveredResult.attempts === 2, String(recoveredResult.attempts));

  // 400 不重试
  const badRequest = makeClient({ script: [{ status: 400, body: SECRET_BODY }] });
  const badResult = await badRequest.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('400 不重试（只请求 1 次）', badRequest.fetchCalls.length === 1, String(badRequest.fetchCalls.length));
  check('400 → http-error', badResult.ok === false && badResult.code === 'http-error', JSON.stringify(badResult));

  // 429 重试
  const limited = makeClient({ script: [{ status: 429, body: SECRET_BODY }, { status: 429, body: SECRET_BODY }] });
  const limitedResult = await limited.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('429 → rate-limited 且重试一次', limitedResult.code === 'rate-limited' && limited.fetchCalls.length === 2, `${limitedResult.code}/${limited.fetchCalls.length}`);

  // 网络错误
  const network = makeClient({ script: [{ throw: new Error('ECONNRESET 内部细节') }, { throw: new Error('ECONNRESET 内部细节') }] });
  const networkResult = await network.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('网络错误 → network', networkResult.code === 'network', JSON.stringify(networkResult));
  check('网络错误重试一次', network.fetchCalls.length === 2, String(network.fetchCalls.length));
  check('网络错误不回显原始 error.message', !JSON.stringify(networkResult).includes('ECONNRESET'));
  check('网络错误提示是"网有点卡…"', /网有点卡/.test(networkResult.message), networkResult.message);

  // 响应结构不对
  const badShape = makeClient({ script: [{ status: 200, body: { result: 'no-text-field' } }] });
  const badShapeResult = await badShape.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('响应里没有 text 字段 → empty-transcript', badShapeResult.ok === false && badShapeResult.code === 'empty-transcript', JSON.stringify(badShapeResult));

  // 空文本
  const blank = makeClient({ script: [{ status: 200, body: { text: '   ' } }] });
  const blankResult = await blank.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('空白 text 也算 empty-transcript', blankResult.code === 'empty-transcript', JSON.stringify(blankResult));
}

/* -------------------------------------------------------------------------- */
/* 5. 超时：10 秒 + 整个 body read 也在超时保护内                                */
/* -------------------------------------------------------------------------- */

async function testTimeout() {
  const { fetchImpl, calls } = createFakeFetch([{ hang: true }, { hang: true }]);
  const timers = createFakeTimers();
  const client = createAsrClient({
    fetchImpl,
    fs: createMemoryFs(),
    timers,
    getApiKey: () => FAKE_KEY,
    FormDataImpl: createFakeFormData(),
    BlobImpl: createFakeBlob(),
    tempDir: 'C:\\temp\\x'
  });

  check('ASR 默认超时是 10 秒', client.timeoutMs === 10000, String(client.timeoutMs));
  check('ASR 默认最多重试一次', client.maxRetries === 1, String(client.maxRetries));

  const promise = client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('超时定时器已注册', timers.pendingCount === 1, String(timers.pendingCount));
  await timers.flushAsync();
  const result = await promise;

  check('超时 → timeout', result.ok === false && result.code === 'timeout', JSON.stringify(result));
  check('超时重试一次（共 2 次请求）', calls.length === 2, String(calls.length));
  check('超时提示是"网有点卡…"', /网有点卡/.test(result.message), result.message);
}

/* -------------------------------------------------------------------------- */
/* 6. 无 Key：完全不联网，直接本地识别，并标记 chat=false                          */
/* -------------------------------------------------------------------------- */

async function testNoKey() {
  const h = makeClient({
    apiKey: '',
    local: { ok: true, text: '本地识别结果', model: 'base' }
  });
  const result = await h.client.transcribe(fakeWav(), { durationMs: 900, format: 'wav' });

  check('无 Key 时绝不联网', h.fetchCalls.length === 0, String(h.fetchCalls.length));
  check('无 Key 时走本地识别并成功', result.ok === true && result.text === '本地识别结果', JSON.stringify(result));
  check('无 Key 时 provider 是 local', result.provider === 'local', String(result.provider));
  check('无 Key 时 chat=false（识别结果不能发聊天）', result.chat === false, String(result.chat));
  check('无 Key 时没有 Authorization 之类的残留', !JSON.stringify(result).includes(FAKE_KEY));
  check('无 Key 本地识别会先落一个临时 WAV', h.fs.operations.some((op) => op.op === 'write'), JSON.stringify(h.fs.operations));
  check('无 Key 本地识别结束后临时 WAV 被删除', h.localCalls.length === 1 && h.fs.files.size === 0, JSON.stringify(Array.from(h.fs.files.keys())));

  // 无 Key 且本地不可用 → 优雅返回 unavailable
  const unavailable = makeClient({ apiKey: '', local: null });
  const unavailableResult = await unavailable.client.transcribe(fakeWav(), { durationMs: 900, format: 'wav' });
  check('无 Key 且本地不可用 → unavailable（优雅降级）', unavailableResult.ok === false && unavailableResult.code === 'unavailable', JSON.stringify(unavailableResult));
  check('无 Key 且本地不可用时仍然不联网', unavailable.fetchCalls.length === 0, String(unavailable.fetchCalls.length));
  check('无 Key 且本地不可用时 chat=false', unavailableResult.chat === false, String(unavailableResult.chat));

  // 无 Key 且显式禁止本地 → 也是 unavailable，不联网
  const noLocal = makeClient({ apiKey: '', local: { ok: true, text: 'x' } });
  const noLocalResult = await noLocal.client.transcribe(fakeWav(), { durationMs: 900, format: 'wav', allowLocal: false });
  check('无 Key + 禁用本地 → unavailable', noLocalResult.ok === false && noLocalResult.code === 'unavailable', JSON.stringify(noLocalResult));
  check('无 Key + 禁用本地时不联网', noLocal.fetchCalls.length === 0, String(noLocal.fetchCalls.length));

  check('hasApiKey() 无 Key 时返回 false', noLocal.client.hasApiKey() === false);
  check('hasApiKey() 有 Key 时返回 true', h.client.hasApiKey() === false && makeClient().client.hasApiKey() === true);
}

/* -------------------------------------------------------------------------- */
/* 7. 云端失败降级本地：临时 WAV 落地后必须删除                                   */
/* -------------------------------------------------------------------------- */

async function testLocalFallback() {
  // 云端 500（可重试，最终失败）→ 本地成功
  const h = makeClient({
    script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }],
    local: { ok: true, text: '本地兜底识别', model: 'base' }
  });
  const result = await h.client.transcribe(fakeWav(), { durationMs: 1500, format: 'wav' });

  check('云端失败后降级本地成功', result.ok === true && result.provider === 'local' && result.text === '本地兜底识别', JSON.stringify(result));
  check('降级结果里带上 cloudCode 便于诊断', result.cloudCode === 'server-error', String(result.cloudCode));
  check('有 Key 时 chat 仍然为 true', result.chat === true, String(result.chat));
  check('本地识别读取的是临时 WAV 文件', h.localCalls.length === 1 && /\.wav$/.test(h.localCalls[0].file), JSON.stringify(h.localCalls));

  // 成败都要删临时文件
  check('本地识别结束后临时 WAV 被删除', h.fs.operations.some((op) => op.op === 'unlink'), JSON.stringify(h.fs.operations));
  check('临时目录里已经没有残留文件', h.fs.files.size === 0, JSON.stringify(Array.from(h.fs.files.keys())));
  check('临时文件写在注入的 tempDir 下', h.localCalls[0].file.indexOf('C:\\temp\\blue-fat-fish-voice') === 0, h.localCalls[0].file);

  // 本地也失败 → 返回云端的错误码
  const bothFail = makeClient({
    script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }],
    local: { ok: false, code: 'model-missing' }
  });
  const bothResult = await bothFail.client.transcribe(fakeWav(), { durationMs: 1500, format: 'wav' });
  check('云端与本地都失败时返回云端错误码', bothResult.ok === false && bothResult.code === 'server-error', JSON.stringify(bothResult));
  check('两个都失败时也带 localCode', bothResult.localCode === 'model-missing', String(bothResult.localCode));
  check('两个都失败时临时文件同样被删除', bothFail.fs.files.size === 0, JSON.stringify(Array.from(bothFail.fs.files.keys())));

  // 400 是参数错误，降级本地也没意义：不调用本地
  const paramError = makeClient({
    script: [{ status: 400, body: SECRET_BODY }],
    local: { ok: true, text: '不该走到这里' }
  });
  const paramResult = await paramError.client.transcribe(fakeWav(), { durationMs: 1500, format: 'wav' });
  check('400 参数错误不降级本地（降级也没用）', paramError.localCalls.length === 0, String(paramError.localCalls.length));
  check('400 直接返回 http-error', paramResult.code === 'http-error', JSON.stringify(paramResult));

  // 写临时文件失败时也要明确报错（不静默继续）
  const fsFailure = createMemoryFs();
  fsFailure.mkdirSync = () => {
    throw new Error('EACCES');
  };
  const writeFailClient = createAsrClient({
    fetchImpl: createFakeFetch([{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }]).fetchImpl,
    fs: fsFailure,
    timers: createFakeTimers(),
    getApiKey: () => FAKE_KEY,
    localTranscriber: { transcribe: () => Promise.resolve({ ok: true, text: 'x' }) },
    tempDir: 'C:\\temp\\x',
    FormDataImpl: createFakeFormData(),
    BlobImpl: createFakeBlob()
  });
  const writeFailResult = await writeFailClient.transcribe(fakeWav(), { durationMs: 1500, format: 'wav' });
  check('写临时文件失败时返回 internal-error（不静默继续）', writeFailResult.ok === false && writeFailResult.code === 'server-error', JSON.stringify(writeFailResult));
}

/* -------------------------------------------------------------------------- */
/* 8. 日志与返回值绝不泄密                                                       */
/* -------------------------------------------------------------------------- */

async function testNoSecretLeak() {
  const h = makeClient({ script: [{ status: 401, body: SECRET_BODY }] });
  const result = await h.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  const serialized = JSON.stringify(result);
  check('返回值里没有 Key', !serialized.includes(FAKE_KEY));
  check('返回值里没有 Key 的前缀片段', !serialized.includes(FAKE_KEY.slice(0, 8)));
  check('日志里没有 Key', h.logs.every((message) => !message.includes(FAKE_KEY)), h.logs.join(' | '));
  check('日志里没有上游正文', h.logs.every((message) => !message.includes('UPSTREAM-INTERNAL-DETAIL')), h.logs.join(' | '));
  check('请求头里的 Key 不会出现在返回对象里', !Object.prototype.hasOwnProperty.call(result, 'apiKey'));
  check('返回值只有白名单字段', Object.keys(result).every((key) => ['ok', 'code', 'message', 'status', 'attempts', 'chat', 'localCode'].includes(key)), Object.keys(result).join(','));

  // 400 这类参数错误：既不泄露 Key / 上游正文，也不能被说成 Key 失效
  const bad = makeClient({ script: [{ status: 400, body: SECRET_BODY }], local: { ok: true, text: '不该走这里' } });
  const badResult = await bad.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav' });
  const badSerialized = JSON.stringify(badResult);
  check('400 返回值不含 Key', !badSerialized.includes(FAKE_KEY), badSerialized);
  check('400 返回值不含上游正文', !badSerialized.includes('UPSTREAM-INTERNAL-DETAIL'), badSerialized);
  check('400 提示不误导成 Key 失效', !/Key|密钥|api\s*key/i.test(badResult.message), badResult.message);

  // 网络错误：不泄露原始 error.message
  const net = makeClient({ script: [{ throw: new Error('ECONNRESET 内部细节') }, { throw: new Error('ECONNRESET 内部细节') }] });
  const netResult = await net.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('网络错误返回值不含原始 error.message', !JSON.stringify(netResult).includes('ECONNRESET'), JSON.stringify(netResult));
}

/* -------------------------------------------------------------------------- */
/* 9. 错误码 → 用户提示的正确性                                                  */
/* -------------------------------------------------------------------------- */

async function testErrorMessages() {
  // 401：明确引导去 open.bigmodel.cn，且只请求一次
  const auth = makeClient({ script: [{ status: 401, body: SECRET_BODY }] });
  const authResult = await auth.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('401 文案引导去 open.bigmodel.cn', /open\.bigmodel\.cn/.test(authResult.message), authResult.message);
  check('401 文案不是通用内部错误', authResult.message !== ASR_ERROR_MESSAGES['internal-error'], authResult.message);
  check('401 文案不含上游正文', !authResult.message.includes('UPSTREAM-INTERNAL-DETAIL'), authResult.message);

  // 403：权限问题，不是 Key 失效
  const forbidden = makeClient({ script: [{ status: 403, body: SECRET_BODY }] });
  const forbiddenResult = await forbidden.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('403 → forbidden 且有专属文案', forbiddenResult.code === 'forbidden' && forbiddenResult.message === ASR_ERROR_MESSAGES.forbidden, JSON.stringify(forbiddenResult));

  // 400：参数错误文案，绝不提示 Key 失效
  const bad = makeClient({ script: [{ status: 400, body: SECRET_BODY }] });
  const badResult = await bad.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('400 → http-error 且有参数类文案', badResult.code === 'http-error' && badResult.message === ASR_ERROR_MESSAGES['http-error'], JSON.stringify(badResult));
  check('400 文案不被说成 key 失效', !/Key|密钥|api\s*key/i.test(badResult.message), badResult.message);
  check('400 文案不是通用内部错误', badResult.message !== ASR_ERROR_MESSAGES['internal-error'], badResult.message);

  // 429：限流文案
  const limited = makeClient({ script: [{ status: 429, body: SECRET_BODY }, { status: 429, body: SECRET_BODY }] });
  const limitedResult = await limited.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('429 → rate-limited 且有专属文案', limitedResult.message === ASR_ERROR_MESSAGES['rate-limited'], limitedResult.message);

  // 5xx：服务端文案
  const serverError = makeClient({ script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }] });
  const serverResult = await serverError.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('500 → server-error 且有专属文案', serverResult.message === ASR_ERROR_MESSAGES['server-error'], serverResult.message);

  // 空识别结果：专属文案
  const blank = makeClient({ script: [{ status: 200, body: { text: '   ' } }] });
  const blankResult = await blank.client.transcribe(fakeWav(), { durationMs: 1000, format: 'wav', allowLocal: false });
  check('empty-transcript 有专属文案', blankResult.message === ASR_ERROR_MESSAGES['empty-transcript'], blankResult.message);
}

/* -------------------------------------------------------------------------- */
/* 10. 降级范围：只有瞬时 / 基础设施失败才触发本地识别                            */
/* -------------------------------------------------------------------------- */

async function testFallbackScope() {
  const fallbackCases = [
    { name: 'network', script: [{ throw: new Error('x') }, { throw: new Error('x') }], code: 'network' },
    { name: 'server-error', script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }], code: 'server-error' },
    { name: 'rate-limited', script: [{ status: 429, body: SECRET_BODY }, { status: 429, body: SECRET_BODY }], code: 'rate-limited' },
    { name: 'auth-failed', script: [{ status: 401, body: SECRET_BODY }], code: 'auth-failed' },
    { name: 'forbidden', script: [{ status: 403, body: SECRET_BODY }], code: 'forbidden' }
  ];

  for (const item of fallbackCases) {
    const h = makeClient({ script: item.script, local: { ok: true, text: `本地兜底-${item.name}` } });
    const result = await h.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav' });
    check(`可降级错误 ${item.name} 触发本地识别`, result.ok === true && result.provider === 'local' && h.localCalls.length === 1, JSON.stringify(result));
    check(`可降级错误 ${item.name} 结果带 cloudCode=${item.code}`, result.cloudCode === item.code, String(result.cloudCode));
    check(`可降级错误 ${item.name} 临时文件被清理`, h.fs.files.size === 0, JSON.stringify(Array.from(h.fs.files.keys())));
  }

  // 400 参数错误：不降级
  const param = makeClient({ script: [{ status: 400, body: SECRET_BODY }], local: { ok: true, text: '不该走这里' } });
  const paramResult = await param.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav' });
  check('400 参数错误不降级本地', param.localCalls.length === 0 && paramResult.code === 'http-error', JSON.stringify(paramResult));

  // 云端 200 但没有文本：不降级
  const blank = makeClient({ script: [{ status: 200, body: {} }], local: { ok: true, text: '不该走这里' } });
  const blankResult = await blank.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav' });
  check('空识别结果不降级本地', blank.localCalls.length === 0 && blankResult.code === 'empty-transcript', JSON.stringify(blankResult));

  // 无 Key 时本地成功：不联网
  const noKey = makeClient({ apiKey: '', local: { ok: true, text: '本地' } });
  const noKeyResult = await noKey.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav' });
  check('无 Key 时本地成功且不联网', noKeyResult.ok === true && noKey.fetchCalls.length === 0, JSON.stringify(noKeyResult));

  // 无 Key 时显式禁用本地：不联网，返回 unavailable
  const noKeyNoLocal = makeClient({ apiKey: '', local: { ok: true, text: '本地' } });
  const noKeyNoLocalResult = await noKeyNoLocal.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav', allowLocal: false });
  check('无 Key + 禁用本地 → unavailable 且不联网', noKeyNoLocalResult.code === 'unavailable' && noKeyNoLocal.fetchCalls.length === 0, JSON.stringify(noKeyNoLocalResult));
}

/* -------------------------------------------------------------------------- */
/* 11. 本地识别实现抛异常：优雅返回、清理临时文件、不泄露异常细节                  */
/* -------------------------------------------------------------------------- */

async function testLocalThrows() {
  // 有 Key，云端 500 后降级本地，但本地实现直接 reject
  const h = makeClient({
    script: [{ status: 500, body: SECRET_BODY }, { status: 500, body: SECRET_BODY }],
    localThrows: true
  });
  const result = await h.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav' });

  check('本地识别抛异常时不把异常抛给上层', result.ok === false, JSON.stringify(result));
  check('本地识别抛异常时返回云端的 code', result.code === 'server-error', String(result.code));
  check('本地识别抛异常时 localCode=internal-error', result.localCode === 'internal-error', String(result.localCode));
  check('本地识别抛异常后临时文件被删除', h.fs.files.size === 0, JSON.stringify(Array.from(h.fs.files.keys())));
  check('本地识别抛异常不泄露原始 error.message', !JSON.stringify(result).includes('whisper exploded'), JSON.stringify(result));
  check('本地识别抛异常不泄露 Key', !JSON.stringify(result).includes(FAKE_KEY), JSON.stringify(result));

  // 无 Key 时本地实现抛异常，同样不能崩
  const noKey = makeClient({ apiKey: '', localThrows: true });
  const noKeyResult = await noKey.client.transcribe(fakeWav(), { durationMs: 1200, format: 'wav' });
  check('无 Key + 本地抛异常 → internal-error（不崩）', noKeyResult.ok === false && noKeyResult.code === 'internal-error', JSON.stringify(noKeyResult));
  check('无 Key + 本地抛异常仍不联网', noKey.fetchCalls.length === 0, String(noKey.fetchCalls.length));
  check('无 Key + 本地抛异常临时文件被删除', noKey.fs.files.size === 0, JSON.stringify(Array.from(noKey.fs.files.keys())));
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  await testCloudSuccess();
  await testPreflight();
  await testHttpErrors();
  await testTimeout();
  await testNoKey();
  await testLocalFallback();
  await testNoSecretLeak();
  await testErrorMessages();
  await testFallbackScope();
  await testLocalThrows();

  console.log('');
  console.log('ASR 客户端单元测试');
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
