'use strict';

/**
 * ============================================================================
 * 主进程单元测试：本地 faster-whisper 语音识别降级（main/local-whisper.js）
 * ============================================================================
 *
 * 需求（阶段 4）：
 *   - 云端 GLM-ASR 失败时，**只有空闲显存 >1.5GB** 才允许加载本地模型；
 *   - 只用 **CPU + int8**，默认模型 **base**，small 只在高显存档位才允许；
 *   - 没装 Python / faster-whisper / 模型时**优雅 unavailable**，绝不联网下载；
 *   - **绝不调用任何本地聊天 LLM**，只做语音转文本；
 *   - 音频路径与模型路径只经 **stdin 的 JSON** 传给 Python，绝不拼进 argv。
 *
 * 本文件用一个**可注入的假 execFile + 假 fs + 假 nativeSpeech + 假定时器**驱动，
 * **绝不真的启动 Python，也绝不下载 / 创建任何模型文件**。
 *
 * 用法：node tests/local-whisper.test.js
 */

const path = require('node:path');

const {
  DEFAULT_MODEL,
  ALLOWED_MODELS,
  TRANSCRIBE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  PYTHON_CANDIDATES,
  MODEL_DIR_NAME,
  WHISPER_SCRIPT,
  isVramSufficient,
  pickModel,
  createLocalTranscriber
} = require(path.join(__dirname, '..', 'main', 'local-whisper.js'));
const { createMemoryFs, createFakeTimers } = require(path.join(__dirname, 'helpers', 'fake-io.js'));

/* -------------------------------------------------------------------------- */
/* 迷你断言框架（与其它单测保持一致）                                            */
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

/** 只可能出现在"上游错误 / 用户数据"里的内部细节，绝不能回显给调用方 */
const UPSTREAM_SECRET = 'sk-upstream-secret 上游错误 Traceback 内部堆栈';
/** 音频 / 模型目录用带分隔符的真实感路径，便于验证"绝不进 argv" */
const AUDIO_FILE = 'C:\\audio\\turn-7.wav';
const MODEL_DIR = 'C:\\models\\whisper-models';
/** 一段只可能出现在"模型名"里的注入尝试 */
const EVIL_MODEL = 'base; rm -rf /';

/* -------------------------------------------------------------------------- */
/* 假 execFile / 假 nativeSpeech                                              */
/* -------------------------------------------------------------------------- */

/**
 * 造一个假的 execFile，记录 `(file, args, options, stdin)`。
 * 脚本项支持：
 *   - `{stdout}` 成功回调；
 *   - `{error, stdout}` 失败回调（可带 `{killed:true}` 表示超时）；
 *   - `{throws}` 同步抛异常；
 *   - `{emitChildError:true}` 触发 child 'error' 事件（模拟解释器不存在）；
 *   - 函数 `(file, args, record) => 对象`。
 * **只造假对象，绝不 spawn 真进程。**
 *
 * @param {Array<object|Function>} script
 */
function createFakeExecFile(script) {
  const calls = [];
  const list = Array.isArray(script) && script.length > 0 ? script : [{ stdout: '' }];
  let index = 0;

  const execFileImpl = (file, args, options, callback) => {
    const step = list[Math.min(index, list.length - 1)];
    index += 1;

    const record = {
      file,
      args: Array.isArray(args) ? args.slice() : args,
      options: Object.assign({}, options),
      stdin: null,
      stdinEnded: false,
      stdinEncoding: null
    };
    calls.push(record);

    if (step && typeof step === 'object' && step.throws) throw step.throws;

    const errorListeners = [];
    const child = {
      stdin: {
        on() {},
        end(text, encoding) {
          record.stdin = text;
          record.stdinEnded = true;
          record.stdinEncoding = encoding || null;
        }
      },
      on(event, handler) {
        if (event === 'error') errorListeners.push(handler);
      }
    };

    setImmediate(() => {
      let spec;
      try {
        spec = typeof step === 'function' ? step(file, args, record) || {} : step || {};
      } catch (err) {
        spec = { throws: err };
      }
      if (spec.throws) {
        if (callback) callback(spec.throws, '');
        return;
      }
      if (spec.emitChildError) {
        const error = spec.emitChildError === true ? new Error('spawn python ENOENT 内部细节') : spec.emitChildError;
        for (const handler of errorListeners) handler(error);
        return;
      }
      if (spec.neverCallback) return;
      if (callback) callback(spec.error || null, spec.stdout === undefined ? '' : spec.stdout);
    });

    return child;
  };

  return { execFileImpl, calls };
}

/** 成功探测（`import faster_whisper` 通过）对应的脚本项 */
const PROBE_OK = { stdout: '' };

/** 一段合法的识别结果 stdout */
function transcribeOk(text, model) {
  return JSON.stringify({ ok: true, text: text === undefined ? '你好' : text, model: model || 'base' });
}

/**
 * 造一个注入了假依赖的本地识别器。
 *
 * @param {{
 *   script?: Array<object|Function>,
 *   freeVramMb?: number|null,
 *   fs?: object,
 *   preferredModel?: string,
 *   vramThresholdMb?: number,
 *   skipVramCheck?: boolean,
 *   modelDir?: string,
 *   nativeSpeech?: object
 * }} [options]
 */
function makeTranscriber(options) {
  const opts = options || {};
  const fake = createFakeExecFile(opts.script);
  const fs = opts.fs || createMemoryFs();
  // timers 目前实现未使用（超时交给 execFile 的 timeout 选项），仍然注入以证明可注入、
  // 并断言没有任何遗留的真实定时器。
  const timers = createFakeTimers();
  const vramCalls = [];
  const freeVramMb = opts.freeVramMb === undefined ? 4096 : opts.freeVramMb;
  const nativeSpeech = opts.nativeSpeech || {
    readFreeVramMb() {
      vramCalls.push(true);
      return Promise.resolve(freeVramMb);
    }
  };
  const transcriber = createLocalTranscriber({
    execFileImpl: fake.execFileImpl,
    fs,
    nativeSpeech,
    timers,
    modelDir: opts.modelDir === undefined ? MODEL_DIR : opts.modelDir,
    preferredModel: opts.preferredModel,
    vramThresholdMb: opts.vramThresholdMb,
    skipVramCheck: opts.skipVramCheck
  });
  return { transcriber, calls: fake.calls, fs, timers, nativeSpeech, vramCalls };
}

/** 断言一次结果不含任何秘密 / 堆栈 / 上游细节 */
function assertClean(name, result) {
  const serialized = JSON.stringify(result);
  check(`${name}：不含 API Key / 上游错误`, !serialized.includes('sk-') && !serialized.includes('Traceback') && !serialized.includes('上游错误'), serialized);
  check(`${name}：不含 stack 字段`, !/"(stack|message)"\s*:/.test(serialized), serialized);
  check(`${name}：不含 apiKey 字段`, !/api_?key/i.test(serialized), serialized);
}

/* -------------------------------------------------------------------------- */
/* 1. 常量与纯函数：固定事实                                                    */
/* -------------------------------------------------------------------------- */

{
  check('默认模型是 base', DEFAULT_MODEL === 'base', DEFAULT_MODEL);
  check('模型白名单是 tiny / base / small', JSON.stringify(ALLOWED_MODELS) === JSON.stringify(['tiny', 'base', 'small']), JSON.stringify(ALLOWED_MODELS));
  check('转录子进程超时 30 秒', TRANSCRIBE_TIMEOUT_MS === 30000, String(TRANSCRIBE_TIMEOUT_MS));
  check('可用性探测超时 5 秒', PROBE_TIMEOUT_MS === 5000, String(PROBE_TIMEOUT_MS));
  check('Python 候选顺序是 python / py / python3', JSON.stringify(PYTHON_CANDIDATES) === JSON.stringify(['python', 'py', 'python3']), JSON.stringify(PYTHON_CANDIDATES));
  check('模型目录名固定 whisper-models', MODEL_DIR_NAME === 'whisper-models', MODEL_DIR_NAME);

  // isVramSufficient：必须严格大于门槛
  check('isVramSufficient：1537 > 1536 → 可用', isVramSufficient(1537) === true);
  check('isVramSufficient：1536 等于门槛 → 不可用', isVramSufficient(1536) === false);
  check('isVramSufficient：1535 小于门槛 → 不可用', isVramSufficient(1535) === false);
  check('isVramSufficient：2048 → 可用', isVramSufficient(2048) === true);
  check('isVramSufficient：0 → 不可用', isVramSufficient(0) === false);
  check('isVramSufficient：负数 → 不可用', isVramSufficient(-1) === false);
  check('isVramSufficient：null（查不到）→ 不可用', isVramSufficient(null) === false);
  check('isVramSufficient：undefined → 不可用', isVramSufficient(undefined) === false);
  check('isVramSufficient：NaN → 不可用', isVramSufficient(NaN) === false);
  check('isVramSufficient：字符串数字不当作有效值', isVramSufficient('4096') === false);
  check('isVramSufficient：自定义门槛 100：101 可用', isVramSufficient(101, 100) === true);
  check('isVramSufficient：自定义门槛 100：100 不可用', isVramSufficient(100, 100) === false);

  // pickModel：small 只在高显存档位允许
  check('pickModel：默认档位 base', pickModel(4096) === 'base', pickModel(4096));
  check('pickModel：显存宽裕时 small 放行', pickModel(4096, 'small') === 'small', pickModel(4096, 'small'));
  check('pickModel：2049 才够 small（必须 >2048）', pickModel(2049, 'small') === 'small', pickModel(2049, 'small'));
  check('pickModel：2048 不够 small，降回 base', pickModel(2048, 'small') === 'base', pickModel(2048, 'small'));
  check('pickModel：1537 不够 small，降回 base', pickModel(1537, 'small') === 'base', pickModel(1537, 'small'));
  check('pickModel：tiny 原样放行', pickModel(4096, 'tiny') === 'tiny', pickModel(4096, 'tiny'));
  check('pickModel：非法模型名回落 base', pickModel(4096, EVIL_MODEL) === 'base', pickModel(4096, EVIL_MODEL));
  check('pickModel：非字符串回落 base', pickModel(4096, 123) === 'base' && pickModel(4096, null) === 'base');
  check('pickModel：null 显存 + small → base', pickModel(null, 'small') === 'base', pickModel(null, 'small'));
}

/* -------------------------------------------------------------------------- */
/* 2. 内置 Python 脚本的静态契约：CPU+int8、缺模型先退、绝不下载、绝无聊天 LLM     */
/* -------------------------------------------------------------------------- */

{
  check('脚本只导入 faster_whisper 做语音识别', /from faster_whisper import WhisperModel/.test(WHISPER_SCRIPT));
  check('脚本只用 CPU + int8', /device="cpu"/.test(WHISPER_SCRIPT) && /compute_type="int8"/.test(WHISPER_SCRIPT));
  check('脚本绝不使用 cuda / gpu 设备', !/cuda/i.test(WHISPER_SCRIPT) && !/device\s*=\s*"gpu"/i.test(WHISPER_SCRIPT));
  check('脚本从 stdin 读一行 JSON', /sys\.stdin\.read\(\)/.test(WHISPER_SCRIPT) && /json\.loads/.test(WHISPER_SCRIPT));
  check('脚本用 os.path.isdir 校验模型目录', /os\.path\.isdir\(model_path\)/.test(WHISPER_SCRIPT));
  check(
    '脚本在实例化 WhisperModel 之前就检查 model-missing（绝不为缺模型而加载/下载）',
    WHISPER_SCRIPT.indexOf('model-missing') !== -1 &&
      WHISPER_SCRIPT.indexOf('model-missing') < WHISPER_SCRIPT.indexOf('WhisperModel('),
    `model-missing@${WHISPER_SCRIPT.indexOf('model-missing')} / WhisperModel(@${WHISPER_SCRIPT.indexOf('WhisperModel(')}`
  );
  check(
    '脚本绝不触发 Hugging Face 下载',
    !/huggingface/i.test(WHISPER_SCRIPT) &&
      !/snapshot_download/.test(WHISPER_SCRIPT) &&
      !/from_pretrained/.test(WHISPER_SCRIPT) &&
      !/hf_hub|download_root|local_files_only\s*=\s*False/i.test(WHISPER_SCRIPT)
  );
  check(
    '脚本绝不加载任何本地聊天 LLM',
    !/llama|chatglm|qwen|openai|transformers|AutoModel|local_llm|chat_model/i.test(WHISPER_SCRIPT)
  );
  check(
    '脚本缺包 / 缺模型 / 音频坏 / 其它错误都有固定退出码与短码',
    /"code": "no-package"/.test(WHISPER_SCRIPT) &&
      /sys\.exit\(2\)/.test(WHISPER_SCRIPT) &&
      /"code": "model-missing"/.test(WHISPER_SCRIPT) &&
      /sys\.exit\(3\)/.test(WHISPER_SCRIPT) &&
      /"code": "no-audio"/.test(WHISPER_SCRIPT) &&
      /sys\.exit\(4\)/.test(WHISPER_SCRIPT) &&
      /sys\.exit\(5\)/.test(WHISPER_SCRIPT)
  );
  check('脚本成功时输出 ok/text/model 的 JSON', /"ok": True, "text": text, "model": model_name/.test(WHISPER_SCRIPT));
  // 内置脚本文本里本身就有 modelDir / audio 变量名，但绝不能出现任何真实路径
  check('内置脚本常量里没有真实音频 / 模型路径', !WHISPER_SCRIPT.includes(AUDIO_FILE) && !WHISPER_SCRIPT.includes(MODEL_DIR));
}

/* -------------------------------------------------------------------------- */
/* 3. 输入校验：空输入立即 no-audio，不起任何子进程                              */
/* -------------------------------------------------------------------------- */

async function testInputValidation() {
  for (const input of ['', null, undefined, 123, {}]) {
    const h = makeTranscriber({ script: [PROBE_OK] });
    // eslint-disable-next-line no-await-in-loop
    const result = await h.transcriber.transcribe(input);
    check(`空 / 非字符串输入 ${JSON.stringify(input)} → no-audio`, result.ok === false && result.code === 'no-audio', JSON.stringify(result));
    check(`空输入 ${JSON.stringify(input)} 不起子进程`, h.calls.length === 0, String(h.calls.length));
    check(`空输入 ${JSON.stringify(input)} 不查显存`, h.vramCalls.length === 0, String(h.vramCalls.length));
  }
}

/* -------------------------------------------------------------------------- */
/* 4. 可用性探测：包缺失 / Python 缺失 / 缓存与重置                              */
/* -------------------------------------------------------------------------- */

async function testProbe() {
  // 第一个候选就成功
  const ok = makeTranscriber({ script: [PROBE_OK] });
  const okAvail = await ok.transcriber.isAvailable();
  check('探测成功返回 available=true', okAvail.available === true, JSON.stringify(okAvail));
  check('探测成功只调用一次（python 是第一个候选）', ok.calls.length === 1, String(ok.calls.length));
  check('探测命令固定为 python -c "import faster_whisper"',
    ok.calls[0].file === 'python' &&
      JSON.stringify(ok.calls[0].args) === JSON.stringify(['-c', 'import faster_whisper']),
    JSON.stringify(ok.calls[0]));
  check('探测不加载模型：参数里没有脚本本体', ok.calls[0].args[1] !== WHISPER_SCRIPT);
  check('探测不通过 stdin 传数据', ok.calls[0].stdin === null, String(ok.calls[0].stdin));
  check('探测 shell:false / windowsHide:true / 超时 5 秒',
    ok.calls[0].options.shell === false &&
      ok.calls[0].options.windowsHide === true &&
      ok.calls[0].options.timeout === PROBE_TIMEOUT_MS,
    JSON.stringify(ok.calls[0].options));

  // 包没装：解释器存在但 import 失败（非零退出）→ no-package，不再试其它候选
  const noPackage = makeTranscriber({ script: [{ error: Object.assign(new Error('ModuleNotFoundError 内部细节'), { code: 1 }), stdout: '' }] });
  const noPackageAvail = await noPackage.transcriber.isAvailable();
  check('faster-whisper 没装 → available=false / code=no-package',
    noPackageAvail.available === false && noPackageAvail.code === 'no-package',
    JSON.stringify(noPackageAvail));
  check('包缺失只探测一次（不逐个试 python/py/python3）', noPackage.calls.length === 1, String(noPackage.calls.length));
  const noPackageTranscribe = await noPackage.transcriber.transcribe(AUDIO_FILE);
  check('包缺失时识别 → unavailable（detail=no-package）',
    noPackageTranscribe.ok === false && noPackageTranscribe.code === 'unavailable' && noPackageTranscribe.detail === 'no-package',
    JSON.stringify(noPackageTranscribe));
  check('包缺失时不查显存、不起转录进程', noPackage.vramCalls.length === 0 && noPackage.calls.length === 1, `${noPackage.vramCalls.length}/${noPackage.calls.length}`);

  // Python 完全不存在：每个候选都 spawn 失败（child error）→ no-python
  const noPython = makeTranscriber({ script: [{ emitChildError: true }] });
  const noPythonAvail = await noPython.transcriber.isAvailable();
  check('Python 全不存在 → available=false / code=no-python',
    noPythonAvail.available === false && noPythonAvail.code === 'no-python',
    JSON.stringify(noPythonAvail));
  check('Python 不存在时逐个试满 3 个候选', noPython.calls.length === 3, String(noPython.calls.length));
  check('Python 候选顺序被完整使用',
    noPython.calls.map((call) => call.file).join(',') === 'python,py,python3',
    noPython.calls.map((call) => call.file).join(','));
  const noPythonTranscribe = await noPython.transcriber.transcribe(AUDIO_FILE);
  check('Python 不存在时识别 → unavailable / detail=no-python',
    noPythonTranscribe.ok === false && noPythonTranscribe.code === 'unavailable' && noPythonTranscribe.detail === 'no-python',
    JSON.stringify(noPythonTranscribe));

  // 同步抛异常也当作不可用，继续试下一个候选
  const throwing = makeTranscriber({ script: [{ throws: new Error('spawn 内部细节') }] });
  const throwingAvail = await throwing.transcriber.isAvailable();
  check('探测同步抛异常 → 优雅 no-python', throwingAvail.available === false && throwingAvail.code === 'no-python', JSON.stringify(throwingAvail));
  check('探测同步抛异常试满 3 个候选', throwing.calls.length === 3, String(throwing.calls.length));

  // 探测超时 → 不冒充 subprocess-failed，继续试候选，最终 no-python
  const probeTimeout = makeTranscriber({ script: [{ error: Object.assign(new Error('killed 内部细节'), { killed: true }), stdout: '' }] });
  const probeTimeoutAvail = await probeTimeout.transcriber.isAvailable();
  check('探测超时 → 优雅 no-python（不崩溃）', probeTimeoutAvail.available === false && probeTimeoutAvail.code === 'no-python', JSON.stringify(probeTimeoutAvail));

  // 第一个候选失败、第二个成功 → 使用 py
  const fallback = makeTranscriber({ script: [{ emitChildError: true }, PROBE_OK] });
  const fallbackAvail = await fallback.transcriber.isAvailable();
  check('python 不可用时回落到 py 候选', fallbackAvail.available === true, JSON.stringify(fallbackAvail));
  check('回落时第二个候选文件是 py', fallback.calls.length === 2 && fallback.calls[1].file === 'py', JSON.stringify(fallback.calls.map((call) => call.file)));

  // 缓存：同一次会话只探测一次；resetCache 后重新探测
  const cached = makeTranscriber({ script: [PROBE_OK] });
  await cached.transcriber.isAvailable();
  await cached.transcriber.isAvailable();
  check('探测结果被缓存（两次 isAvailable 只探测一次）', cached.calls.length === 1, String(cached.calls.length));
  cached.transcriber.resetCache();
  await cached.transcriber.isAvailable();
  check('resetCache 后会重新探测', cached.calls.length === 2, String(cached.calls.length));

  // 缓存命中时 transcribe 不再重复探测
  const cachedTranscribe = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk() }] });
  await cachedTranscribe.transcriber.isAvailable();
  await cachedTranscribe.transcriber.transcribe(AUDIO_FILE);
  check('探测已缓存时 transcribe 复用结果（1 次探测 + 1 次转录）', cachedTranscribe.calls.length === 2, String(cachedTranscribe.calls.length));
}

/* -------------------------------------------------------------------------- */
/* 5. 显存保护（核心）：≤1536MB 拒绝识别且不运行转录进程，只有 >1536 才允许        */
/* -------------------------------------------------------------------------- */

async function testVramGate() {
  const refused = [0, 1, 512, 1024, 1500, 1535, 1536];
  for (const freeVramMb of refused) {
    const h = makeTranscriber({
      script: [PROBE_OK, { stdout: transcribeOk() }],
      freeVramMb
    });
    // eslint-disable-next-line no-await-in-loop
    const result = await h.transcriber.transcribe(AUDIO_FILE);
    check(`空闲显存 ${freeVramMb}MB ≤1536 → 拒绝识别（vram-busy）`,
      result.ok === false && result.code === 'vram-busy' && result.vramFreeMb === freeVramMb,
      JSON.stringify(result));
    check(`空闲显存 ${freeVramMb}MB：只跑了探测，没有运行转录进程`,
      h.calls.length === 1 && !h.calls.some((call) => call.args[1] === WHISPER_SCRIPT),
      JSON.stringify(h.calls.map((call) => call.args)));
    check(`空闲显存 ${freeVramMb}MB：确实查询过一次显存`, h.vramCalls.length === 1, String(h.vramCalls.length));
    assertClean(`显存 ${freeVramMb}MB 拒绝`, result);
  }

  const allowed = [1537, 1600, 2048, 4096, 8192];
  for (const freeVramMb of allowed) {
    const h = makeTranscriber({
      script: [PROBE_OK, { stdout: transcribeOk('识别成功', 'base') }],
      freeVramMb
    });
    // eslint-disable-next-line no-await-in-loop
    const result = await h.transcriber.transcribe(AUDIO_FILE);
    check(`空闲显存 ${freeVramMb}MB >1536 → 允许识别`,
      result.ok === true && result.text === '识别成功' && result.vramFreeMb === freeVramMb,
      JSON.stringify(result));
    check(`空闲显存 ${freeVramMb}MB：确实运行了转录进程`,
      h.calls.length === 2 && h.calls[1].args[1] === WHISPER_SCRIPT,
      JSON.stringify(h.calls.map((call) => call.args)));
  }

  // 查询失败（null）→ 同样拒绝
  const queryFailed = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk() }], freeVramMb: null });
  const queryFailedResult = await queryFailed.transcriber.transcribe(AUDIO_FILE);
  check('显存查询失败（null）→ 拒绝识别 vram-busy',
    queryFailedResult.ok === false && queryFailedResult.code === 'vram-busy' && queryFailedResult.vramFreeMb === null,
    JSON.stringify(queryFailedResult));
  check('显存查询失败时不运行转录进程', queryFailed.calls.length === 1, String(queryFailed.calls.length));

  // 自定义门槛
  const customAllowed = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk() }], freeVramMb: 513, vramThresholdMb: 512 });
  check('自定义门槛 512MB：513 允许', (await customAllowed.transcriber.transcribe(AUDIO_FILE)).ok === true);
  const customRefused = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk() }], freeVramMb: 512, vramThresholdMb: 512 });
  const customRefusedResult = await customRefused.transcriber.transcribe(AUDIO_FILE);
  check('自定义门槛 512MB：512 拒绝', customRefusedResult.code === 'vram-busy', JSON.stringify(customRefusedResult));

  // skipVramCheck:true 才允许跳过（默认必须检查）
  const skipped = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk() }], freeVramMb: 0, skipVramCheck: true });
  const skippedResult = await skipped.transcriber.transcribe(AUDIO_FILE);
  check('仅显式 skipVramCheck:true 才跳过显存检查', skippedResult.ok === true, JSON.stringify(skippedResult));
  check('skipVramCheck 时不查询显存', skipped.vramCalls.length === 0, String(skipped.vramCalls.length));
  check('skipVramCheck 默认值为 false（0MB 默认仍拒绝）',
    (await makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk() }], freeVramMb: 0 }).transcriber.transcribe(AUDIO_FILE)).code === 'vram-busy');
}

/* -------------------------------------------------------------------------- */
/* 6. 转录子进程：固定 Python + argv，路径只走 stdin JSON，CPU/int8，档位策略      */
/* -------------------------------------------------------------------------- */

async function testTranscribeCallShape() {
  const h = makeTranscriber({
    script: [PROBE_OK, { stdout: transcribeOk(' 你好 ', 'base') }],
    freeVramMb: 4096
  });
  const result = await h.transcriber.transcribe(AUDIO_FILE);

  const probeCall = h.calls[0];
  const txCall = h.calls[1];
  check('探测调用 file=python，argv 固定',
    probeCall.file === 'python' && JSON.stringify(probeCall.args) === JSON.stringify(['-c', 'import faster_whisper']),
    JSON.stringify(probeCall));
  check('转录调用 file 复用探测到的 python', txCall.file === 'python', String(txCall.file));
  check('转录 argv 固定为 [-c, 内置脚本]',
    JSON.stringify(txCall.args) === JSON.stringify(['-c', WHISPER_SCRIPT]),
    JSON.stringify(txCall.args.map((item) => (item === WHISPER_SCRIPT ? '<WHISPER_SCRIPT>' : item))));
  check('转录 shell:false / windowsHide:true', txCall.options.shell === false && txCall.options.windowsHide === true, JSON.stringify(txCall.options));
  check('转录超时 30 秒', txCall.options.timeout === TRANSCRIBE_TIMEOUT_MS, String(txCall.options.timeout));
  check('转录 stdin 以 utf8 写入并已 end', txCall.stdinEnded === true && txCall.stdinEncoding === 'utf8', JSON.stringify(txCall));

  const payload = JSON.parse(txCall.stdin);
  check('stdin 是 JSON，字段固定为 audio / model / modelDir',
    JSON.stringify(Object.keys(payload)) === JSON.stringify(['audio', 'model', 'modelDir']),
    JSON.stringify(Object.keys(payload)));
  check('stdin.audio 是音频文件路径', payload.audio === AUDIO_FILE, String(payload.audio));
  check('stdin.modelDir 是模型目录', payload.modelDir === MODEL_DIR, String(payload.modelDir));
  check('stdin.model 默认 base', payload.model === 'base', String(payload.model));

  const argvText = txCall.args.join('\u0000');
  check('音频路径绝不出现在 argv', !argvText.includes(AUDIO_FILE) && !argvText.includes('turn-7.wav'), argvText);
  check('模型目录绝不出现在 argv', !argvText.includes(MODEL_DIR) && !argvText.includes('whisper-models'), argvText);
  // 注意：JSON.stringify 会把反斜杠转义，所以这里查路径的"文件名片段"而不是原始字符串
  check('音频 / 模型路径只在 stdin JSON 里（argv 里没有任何片段）',
    txCall.stdin.includes('turn-7.wav') && txCall.stdin.includes('whisper-models') &&
      !argvText.includes('turn-7.wav') && !argvText.includes('whisper-models'),
    txCall.stdin);

  check('成功结果 ok / text trim / model / vramFreeMb 正确',
    result.ok === true && result.text === '你好' && result.model === 'base' && result.vramFreeMb === 4096,
    JSON.stringify(result));
  check('成功结果不回显音频路径 / 模型目录',
    !JSON.stringify(result).includes(AUDIO_FILE) && !JSON.stringify(result).includes(MODEL_DIR),
    JSON.stringify(result));
}

async function testModelTier() {
  const cases = [
    [{ preferredModel: 'base', freeVramMb: 4096 }, 'base'],
    [{ freeVramMb: 4096 }, 'base'],
    [{ preferredModel: 'tiny', freeVramMb: 4096 }, 'tiny'],
    [{ preferredModel: 'small', freeVramMb: 4096 }, 'small'],
    [{ preferredModel: 'small', freeVramMb: 2049 }, 'small'],
    [{ preferredModel: 'small', freeVramMb: 2048 }, 'base'],
    [{ preferredModel: 'small', freeVramMb: 1537 }, 'base'],
    [{ preferredModel: EVIL_MODEL, freeVramMb: 4096 }, 'base']
  ];
  for (const [opts, expected] of cases) {
    const h = makeTranscriber(Object.assign({
      script: [PROBE_OK, { stdout: transcribeOk('好', expected) }]
    }, opts));
    // eslint-disable-next-line no-await-in-loop
    const result = await h.transcriber.transcribe(AUDIO_FILE);
    check(`档位策略 preferred=${JSON.stringify(opts.preferredModel)} free=${opts.freeVramMb} → ${expected}`,
      result.ok === true && JSON.parse(h.calls[1].stdin).model === expected,
      JSON.stringify(JSON.parse(h.calls[1].stdin)));
  }

  // 非法模型名绝不进入参数（argv 也没有）
  const evil = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk('好', 'base') }], preferredModel: EVIL_MODEL, freeVramMb: 4096 });
  await evil.transcriber.transcribe(AUDIO_FILE);
  const evilArgv = evil.calls[1].args.join('\u0000');
  check('非法模型名绝不进 argv', !evilArgv.includes('rm -rf') && !evilArgv.includes('evil'), evilArgv);
  check('非法模型名只在 stdin JSON 里回落为 base', JSON.parse(evil.calls[1].stdin).model === 'base');

  // 转录进程只用 CPU + int8 由内置脚本保证；这里断言脚本确实进了 argv
  check('转录 argv 携带的内置脚本包含 CPU + int8', evil.calls[1].args[1].includes('device="cpu"') && evil.calls[1].args[1].includes('compute_type="int8"'));
}

/* -------------------------------------------------------------------------- */
/* 7. stdout 解析：正常 / 空文本 / 坏 JSON / 异常都返回固定短码                  */
/* -------------------------------------------------------------------------- */

/** 用一段固定 stdout 跑一次转录 */
async function runParse(stdout, extra) {
  const h = makeTranscriber(Object.assign({
    script: [PROBE_OK, { stdout }],
    freeVramMb: 4096
  }, extra || {}));
  const result = await h.transcriber.transcribe(AUDIO_FILE);
  return { result, h };
}

async function testParsing() {
  const normal = await runParse('{"ok": true, "text": " 识别文本 ", "model": "small"}');
  check('正常 JSON：ok=true，text 被 trim', normal.result.ok === true && normal.result.text === '识别文本', JSON.stringify(normal.result));
  check('正常 JSON：model 用脚本返回的 small', normal.result.model === 'small', String(normal.result.model));

  const multiline = await runParse('一条日志行\n{"ok": true, "text": "行尾 JSON", "model": "base"}');
  check('多行 stdout：取最后一行 JSON 解析', multiline.result.ok === true && multiline.result.text === '行尾 JSON', JSON.stringify(multiline.result));

  const emptyText = await runParse('{"ok": true, "text": "   "}');
  check('空文本 → 固定短码 unavailable', emptyText.result.ok === false && emptyText.result.code === 'unavailable', JSON.stringify(emptyText.result));

  const noText = await runParse('{"ok": true}');
  check('缺少 text 字段 → unavailable', noText.result.ok === false && noText.result.code === 'unavailable', JSON.stringify(noText.result));

  const badJson = await runParse('这不是 JSON');
  check('坏 JSON → 固定短码 bad-response', badJson.result.ok === false && badJson.result.code === 'bad-response', JSON.stringify(badJson.result));

  const modelMissing = await runParse('{"ok": false, "code": "model-missing"}');
  check('模型缺失 → 保留短码 model-missing', modelMissing.result.code === 'model-missing', JSON.stringify(modelMissing.result));

  const noPackage = await runParse('{"ok": false, "code": "no-package"}');
  check('子进程报缺包 → 保留短码 no-package', noPackage.result.code === 'no-package', JSON.stringify(noPackage.result));

  const noAudio = await runParse('{"ok": false, "code": "no-audio"}');
  check('子进程报音频读不了 → 保留短码 no-audio', noAudio.result.code === 'no-audio', JSON.stringify(noAudio.result));

  const errorPayload = await runParse(JSON.stringify({ ok: false, code: 'error', message: UPSTREAM_SECRET }));
  check('脚本内部错误 → 归并为固定短码 unavailable', errorPayload.result.ok === false && errorPayload.result.code === 'unavailable', JSON.stringify(errorPayload.result));
  check('脚本错误 message 绝不回显', !JSON.stringify(errorPayload.result).includes('Traceback') && !JSON.stringify(errorPayload.result).includes('上游错误'), JSON.stringify(errorPayload.result));

  const weirdCode = await runParse('{"ok": false, "code": "weird-code"}');
  check('未知短码 → 归并为 unavailable', weirdCode.result.code === 'unavailable', JSON.stringify(weirdCode.result));

  // 子进程回调错误（非零退出）但没有 stdout → subprocess-failed
  const failed = await runParse(undefined, { script: [PROBE_OK, { error: Object.assign(new Error('boom 内部细节'), { code: 1 }), stdout: '' }] });
  check('转录非零退出且无输出 → subprocess-failed', failed.result.ok === false && failed.result.code === 'subprocess-failed', JSON.stringify(failed.result));

  // 超时（killed）→ timeout
  const timeout = await runParse(undefined, { script: [PROBE_OK, { error: Object.assign(new Error('killed 内部细节'), { killed: true }), stdout: '' }] });
  check('转录超时 → 固定短码 timeout', timeout.result.ok === false && timeout.result.code === 'timeout', JSON.stringify(timeout.result));

  // 非零退出但 stdout 带 JSON 短码 → 用 JSON 里的短码
  const failedWithPayload = await runParse(undefined, {
    script: [PROBE_OK, { error: Object.assign(new Error('exit 5 内部细节'), { code: 5 }), stdout: '{"ok": false, "code": "no-package"}' }]
  });
  check('非零退出但 stdout 有 JSON → 用 JSON 短码', failedWithPayload.result.code === 'no-package', JSON.stringify(failedWithPayload.result));

  // child error 事件 → not-available
  const childError = await runParse(undefined, { script: [PROBE_OK, { emitChildError: true }] });
  check('转录 child error 事件 → 固定短码 not-available', childError.result.ok === false && childError.result.code === 'not-available', JSON.stringify(childError.result));

  // 同步抛异常 → not-available
  const thrown = await runParse(undefined, { script: [PROBE_OK, { throws: new Error('spawn 内部堆栈') }] });
  check('转录同步抛异常 → 固定短码 not-available', thrown.result.ok === false && thrown.result.code === 'not-available', JSON.stringify(thrown.result));

  // 所有失败结果都干净
  for (const item of [emptyText, noText, badJson, modelMissing, noPackage, noAudio, errorPayload, weirdCode, failed, timeout, childError, thrown]) {
    assertClean('解析失败结果', item.result);
  }
}

/* -------------------------------------------------------------------------- */
/* 8. 降级安全：不联网、不下载、不建模型文件、不调聊天 LLM                       */
/* -------------------------------------------------------------------------- */

async function testGracefulDegradation() {
  const h = makeTranscriber({
    script: [{ error: Object.assign(new Error('ModuleNotFoundError 内部细节'), { code: 1 }), stdout: '' }],
    freeVramMb: 4096
  });
  const result = await h.transcriber.transcribe(AUDIO_FILE);

  check('本地包缺失是优雅降级（unavailable），不是抛异常', result.ok === false && result.code === 'unavailable', JSON.stringify(result));
  check('降级结果带上固定短码 detail', result.detail === 'no-package', String(result.detail));
  const files = h.calls.map((call) => call.file);
  check('所有子进程只用 Python 候选，绝不调用 huggingface / pip / git / curl',
    files.every((file) => PYTHON_CANDIDATES.includes(file)),
    files.join(','));
  const allArgv = h.calls.map((call) => call.args.join(' ')).join(' | ');
  check('参数里绝不含 download / huggingface / pip install',
    !/download/i.test(allArgv) && !/huggingface/i.test(allArgv) && !/pip\s+install/i.test(allArgv),
    allArgv);
  check('没有创建任何模型文件（假 fs 里没有任何写入）',
    h.fs.files.size === 0 && !h.fs.operations.some((op) => op.op === 'write'),
    JSON.stringify(h.fs.operations));
  assertClean('包缺失降级', result);

  // 模型缺失也是优雅降级
  const modelMissing = await runParse('{"ok": false, "code": "model-missing"}');
  check('模型缺失时返回 model-missing，不尝试下载',
    modelMissing.result.ok === false && modelMissing.result.code === 'model-missing',
    JSON.stringify(modelMissing.result));
  check('模型缺失时没有创建任何模型文件', modelMissing.h.fs.files.size === 0);
  check('模型缺失时只用了 Python 候选', modelMissing.h.calls.every((call) => PYTHON_CANDIDATES.includes(call.file)));

  // 没有任何遗留的真实定时器（超时由 execFile 的 timeout 选项承担，已在第 6 节断言）
  check('没有遗留挂起的假定时器', h.timers.pendingCount === 0, String(h.timers.pendingCount));

  // 返回对象整体不含敏感信息（成功 + 失败都查一遍）
  const success = makeTranscriber({ script: [PROBE_OK, { stdout: transcribeOk('干净结果') }], freeVramMb: 4096 });
  const successResult = await success.transcriber.transcribe(AUDIO_FILE);
  assertClean('成功结果', successResult);
  check('成功结果不含用户音频 / 模型路径',
    !JSON.stringify(successResult).includes(AUDIO_FILE) && !JSON.stringify(successResult).includes(MODEL_DIR),
    JSON.stringify(successResult));
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  await testInputValidation();
  await testProbe();
  await testVramGate();
  await testTranscribeCallShape();
  await testModelTier();
  await testParsing();
  await testGracefulDegradation();

  console.log('');
  console.log('本地 faster-whisper 识别降级单元测试');
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
