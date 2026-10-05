'use strict';

/**
 * ============================================================================
 * 主进程单元测试：本机语音能力（main/native-speech.js）
 * ============================================================================
 *
 * 这个模块管三条本机能力：edge-tts 降级合成、Windows SAPI 降级合成、
 * nvidia-smi 空闲显存查询。它的安全底线是：
 *
 *   1. **绝不使用 shell**：所有外部命令都是 `execFile(固定文件, argv数组, 固定选项)`，
 *      `shell:false`、`windowsHide:true`、`timeout` 都是写死的；
 *   2. **用户文本绝不进命令行**：edge-tts 走官方 `--file -`（util.py 里读 stdin）的 stdin，
 *      SAPI 走 base64 + stdin，脚本体是内置常量；
 *   3. **失败一律短码**：没装工具 / 非零退出 / 超时 / 抛异常 → `{ok:false, code:'not-available'}`，
 *      绝不把 ENOENT / 堆栈 / 用户文本回显给调用方；
 *   4. **显存保护**：nvidia-smi 输出解析成 MB，**>1536 才允许**本地模型，
 *      查不到 / 解析失败 / 超时 / 没装工具一律返回"不可用"。
 *
 * 本文件用一个**可注入的假 execFile + 假 fs + 假 child/stdin/error 事件**驱动，
 * **绝不真的启动 edge-tts / powershell / nvidia-smi，也绝不发任何网络请求**。
 *
 * 用法：node tests/native-speech.test.js
 */

const path = require('node:path');

const {
  EDGE_TTS_EXECUTABLE,
  EDGE_TTS_DEFAULT_VOICE,
  SUBPROCESS_TIMEOUT_MS,
  NVIDIA_TIMEOUT_MS,
  FREE_VRAM_THRESHOLD_MB,
  SAPI_SCRIPT,
  encodeTextPayload,
  createNativeSpeech
} = require(path.join(__dirname, '..', 'main', 'native-speech.js'));

/* -------------------------------------------------------------------------- */
/* 迷你断言框架（与其它单测保持一致：通过累加、失败收集、退出码 0/1）            */
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

/** 一段只可能出现在"用户文本"里的恶意内容：引号 / 分号 / 命令替换 / 反引号 / 换行 */
const EVIL_TEXT = '机密文本"; $(whoami); `反引号`;\n第二行 结束';
/** 子进程错误里可能出现、但绝不能回显给调用方的内部细节 */
const INTERNAL_DETAIL = 'spawn edge-tts ENOENT 内部细节';

/**
 * 旧实现的**错误**参数（必须被拒绝，断言里专门用来做反例）：
 *   - edge-tts 官方 CLI（上游 src/edge_tts/util.py）只接受互斥的 `--text` / `--file`，
 *     **根本没有 `--text-file`**，传了会被 argparse 直接拒绝；
 *   - 正确写法是 `--file -`（从 stdin 读文本）+ `--write-media <输出 wav>`。
 */
const LEGACY_EDGE_INPUT_FLAG = ['--text-file', '-'];

/**
 * 判断 `args` 里是否出现过某个**连续子序列**（逐元素全等比较）。
 * 用途：明确拒绝"旧参数组合"重新混回 argv，而不是只检查单个字符串存在。
 * @param {string[]} args
 * @param {string[]} sequence
 * @returns {boolean}
 */
function containsSequence(args, sequence) {
  if (!Array.isArray(args) || !Array.isArray(sequence) || sequence.length === 0) return false;
  for (let i = 0; i + sequence.length <= args.length; i += 1) {
    let hit = true;
    for (let j = 0; j < sequence.length; j += 1) {
      if (args[i + j] !== sequence[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* 假 execFile / 假 fs                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 造一个假的 execFile。它记录每次调用的 `(file, args, options)`，
 * 并支持四种脚本项：
 *   - 对象：`{stdout}` 成功；`{error, stdout}` 失败；`{throws}` 同步抛异常；
 *     `{emitChildError:true}` 触发 child 'error' 事件；`{emitStdinError:true}` 触发 stdin 'error'；
 *   - 函数：`(file, args, record) => 对象`（延迟到 setImmediate 执行）。
 *
 * 返回的 child 实现了 `on('error')` 与 `stdin.on('error')` / `stdin.end()`，
 * 足以验证主进程的"错误事件也算失败 / stdin EPIPE 要吞掉"逻辑。
 * **它只造假对象，绝不真的 spawn 任何进程。**
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

    // execFile 自身同步抛异常（例如选项非法）
    if (step && typeof step === 'object' && step.throws) throw step.throws;

    const errorListeners = [];
    const stdinErrorListeners = [];
    const child = {
      stdin: {
        on(event, handler) {
          if (event === 'error') stdinErrorListeners.push(handler);
        },
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

    // 异步回调，模拟真实子进程的时序（这样 runProcess 才来得及挂上监听器）
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
      if (spec.emitStdinError) {
        for (const handler of stdinErrorListeners) handler(new Error('EPIPE'));
      }
      if (spec.emitChildError) {
        const error = spec.emitChildError === true ? new Error(INTERNAL_DETAIL) : spec.emitChildError;
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

/**
 * 造一个只提供 `statSync` 的假 fs：按传入的尺寸表返回文件大小，其余一律 ENOENT。
 * 用于验证"命令成功但目标文件没写出来 / 写成空文件"会被判失败。
 * @param {Record<string, number>} [sizes]
 */
function createSizeFs(sizes) {
  const map = new Map(Object.entries(sizes || {}));
  const statCalls = [];
  return {
    statCalls,
    statSync(file) {
      statCalls.push(file);
      if (map.has(file)) return { size: map.get(file) };
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
  };
}

/** 造一个注入了假 execFile / 假 fs 的本机语音集合 */
function makeNative(options) {
  const opts = options || {};
  const fake = createFakeExecFile(opts.script);
  const fs = opts.fs || createSizeFs(opts.sizes);
  const env = opts.env || { PATH: 'C:\\fake-path' };
  const speech = createNativeSpeech({
    execFileImpl: fake.execFileImpl,
    fs,
    env,
    subprocessTimeoutMs: opts.subprocessTimeoutMs,
    edgeExecutable: opts.edgeExecutable,
    powershellPath: opts.powershellPath
  });
  return { speech, calls: fake.calls, fs, env };
}

/* -------------------------------------------------------------------------- */
/* 1. 常量与纯函数：固定事实                                                    */
/* -------------------------------------------------------------------------- */

{
  check('edge-tts 可执行文件名是固定的 edge-tts', EDGE_TTS_EXECUTABLE === 'edge-tts', EDGE_TTS_EXECUTABLE);
  check(
    'edge-tts 默认音色是固定的中文女声',
    EDGE_TTS_DEFAULT_VOICE === 'zh-CN-XiaoxiaoNeural',
    EDGE_TTS_DEFAULT_VOICE
  );
  check('子进程超时固定 15 秒', SUBPROCESS_TIMEOUT_MS === 15000, String(SUBPROCESS_TIMEOUT_MS));
  check('nvidia-smi 查询超时固定 3 秒', NVIDIA_TIMEOUT_MS === 3000, String(NVIDIA_TIMEOUT_MS));
  check('空闲显存门槛固定 1536MB（需求 >1.5GB）', FREE_VRAM_THRESHOLD_MB === 1536, String(FREE_VRAM_THRESHOLD_MB));

  check(
    'encodeTextPayload 输出合法 base64',
    /^[A-Za-z0-9+/]*={0,2}$/.test(encodeTextPayload('你好')),
    encodeTextPayload('你好')
  );
  check(
    'encodeTextPayload 中文 / 换行 base64 后能原样解回',
    Buffer.from(encodeTextPayload(EVIL_TEXT), 'base64').toString('utf8') === EVIL_TEXT
  );
  check('encodeTextPayload 对非字符串也做 String() 兜底', encodeTextPayload(12345) === Buffer.from('12345', 'utf8').toString('base64'));

  check(
    'SAPI 脚本是内置常量：只从 stdin 读 base64，不把文本写进脚本体',
    /FromBase64String/.test(SAPI_SCRIPT) &&
      /UTF8\.GetString/.test(SAPI_SCRIPT) &&
      /System\.Speech/.test(SAPI_SCRIPT) &&
      !SAPI_SCRIPT.includes('机密文本')
  );
  check(
    'SAPI 脚本固定：-NoProfile / -NonInteractive / 24kHz 单声道 WAV / Speak',
    /SpeechAudioFormatInfo\(24000/.test(SAPI_SCRIPT) &&
      /Sixteen/.test(SAPI_SCRIPT) &&
      /Mono/.test(SAPI_SCRIPT) &&
      /SetOutputToWaveFile/.test(SAPI_SCRIPT) &&
      /\.Speak\(\$text\)/.test(SAPI_SCRIPT)
  );
}

/* -------------------------------------------------------------------------- */
/* 2. edge-tts 成功路径：官方 argv（--voice / --write-media / --file -）+ 只走 stdin */
/* -------------------------------------------------------------------------- */

async function testEdgeSuccess() {
  const target = 'C:\\temp\\voice\\edge-1.wav';
  const h = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 4096 } });
  const result = await h.speech.runEdgeTts(EVIL_TEXT, target);

  check('edge-tts 成功返回 ok', result.ok === true, JSON.stringify(result));
  check('edge-tts 成功返回 provider=edge-tts', result.provider === 'edge-tts', String(result.provider));
  check('edge-tts 只调用一次假 execFile', h.calls.length === 1, String(h.calls.length));

  const call = h.calls[0];
  check('edge-tts 可执行文件固定为 edge-tts', call.file === 'edge-tts', String(call.file));
  // 官方 CLI 语义：edge-tts --voice <voice> --write-media <targetFile> --file -
  check(
    'edge-tts 参数是官方正确的固定 argv 数组（voice / write-media / file -）',
    JSON.stringify(call.args) ===
      JSON.stringify(['--voice', EDGE_TTS_DEFAULT_VOICE, '--write-media', target, '--file', '-']),
    JSON.stringify(call.args)
  );
  // 逐位锁定：位置 / 开关名 / 取值都不许漂移
  check('edge-tts argv 长度固定为 6（3 个开关 + 3 个取值）', call.args.length === 6, String(call.args.length));
  check('edge-tts argv[0]=--voice', call.args[0] === '--voice', String(call.args[0]));
  check('edge-tts argv[1]=默认音色', call.args[1] === EDGE_TTS_DEFAULT_VOICE, String(call.args[1]));
  check('edge-tts argv[2]=--write-media（音频输出开关，官方唯一出口）', call.args[2] === '--write-media', String(call.args[2]));
  check('edge-tts argv[3]=调用方传入的输出 wav 路径', call.args[3] === target, String(call.args[3]));
  check('edge-tts argv[4]=--file（文本输入开关）', call.args[4] === '--file', String(call.args[4]));
  check('edge-tts argv[5]=-（--file 的值必须是 "-"，即从 stdin 读文本）', call.args[5] === '-', String(call.args[5]));

  // 拒绝旧错误参数：--text-file 官方不存在；目标 wav 也绝不能当成 --file 的输入值
  check(
    'edge-tts 不含官方不存在的 --text-file 参数',
    !call.args.includes('--text-file') && !call.args.some((item) => String(item).includes('--text-file')),
    JSON.stringify(call.args)
  );
  check(
    'edge-tts 不含旧错误参数组合 [--text-file, -]',
    containsSequence(call.args, LEGACY_EDGE_INPUT_FLAG) === false,
    JSON.stringify(call.args)
  );
  check(
    'edge-tts 的 --file 取值必须是 "-"，绝不是目标 wav（绝不把输出当输入）',
    call.args[call.args.indexOf('--file') + 1] === '-' &&
      call.args[call.args.indexOf('--file') + 1] !== target,
    JSON.stringify(call.args)
  );
  check('edge-tts 只出现一次 --file 且只出现一次 --write-media',
    call.args.filter((item) => item === '--file').length === 1 &&
      call.args.filter((item) => item === '--write-media').length === 1,
    JSON.stringify(call.args));
  check(
    'edge-tts 目标 wav 只出现在 --write-media 之后（作为输出，不作为输入）',
    call.args.filter((item) => item === target).length === 1 &&
      call.args.indexOf(target) === call.args.indexOf('--write-media') + 1,
    JSON.stringify(call.args)
  );
  check(
    'edge-tts argv 里没有任何输入文本开关或目标 wav 出现在 --file 之后',
    call.args.indexOf('--file') === call.args.length - 2,
    JSON.stringify(call.args)
  );

  check('edge-tts shell 明确为 false（没有 shell:true）', call.options.shell === false, JSON.stringify(call.options));
  check('edge-tts windowsHide 固定 true', call.options.windowsHide === true, JSON.stringify(call.options));
  check('edge-tts 超时参数固定为 15 秒', call.options.timeout === SUBPROCESS_TIMEOUT_MS, String(call.options.timeout));
  check('edge-tts maxBuffer 已设置（防输出撑爆）', call.options.maxBuffer === 1024 * 1024, String(call.options.maxBuffer));
  check('edge-tts 注入了假 env', call.options.env === h.env, JSON.stringify(call.options.env));
  check('edge-tts 合成文本正是 stdin 内容（逐字相等）', call.stdin === EVIL_TEXT, String(call.stdin));
  check('edge-tts stdin 以 utf8 写入并已 end', call.stdinEnded === true && call.stdinEncoding === 'utf8', JSON.stringify(call));

  const argvText = call.args.join('\u0000');
  check('edge-tts 文本绝不进 argv（无引号 / 无命令替换 / 无反引号 / 无换行）',
    !argvText.includes('机密文本') && !argvText.includes('whoami') && !argvText.includes('反引号') && !argvText.includes('\n'),
    argvText);
  check('edge-tts 只对调用方文件做存在性/大小校验', h.fs.statCalls.length === 1 && h.fs.statCalls[0] === target, JSON.stringify(h.fs.statCalls));
  check('edge-tts 返回值不回显用户文本', !JSON.stringify(result).includes('机密文本'), JSON.stringify(result));

  // 自定义音色
  const custom = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 16 } });
  await custom.speech.runEdgeTts('你好', target, { voice: 'zh-CN-YunxiNeural' });
  check('edge-tts 自定义音色写进固定位置的 argv', custom.calls[0].args[1] === 'zh-CN-YunxiNeural', JSON.stringify(custom.calls[0].args));
  check(
    'edge-tts 自定义音色不改变 argv 结构（仍是官方三开关）',
    JSON.stringify(custom.calls[0].args) ===
      JSON.stringify(['--voice', 'zh-CN-YunxiNeural', '--write-media', target, '--file', '-']),
    JSON.stringify(custom.calls[0].args)
  );
  check('edge-tts 自定义音色时文本仍只走 stdin', custom.calls[0].stdin === '你好', String(custom.calls[0].stdin));

  // 空音色回落默认
  const fallback = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 16 } });
  await fallback.speech.runEdgeTts('你好', target, { voice: '' });
  check('edge-tts 空音色回落默认音色', fallback.calls[0].args[1] === EDGE_TTS_DEFAULT_VOICE, JSON.stringify(fallback.calls[0].args));

  // 可执行文件可注入（仍然只走 argv，不加 shell）
  const injected = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 16 }, edgeExecutable: 'C:\\fake\\edge-tts.exe' });
  await injected.speech.runEdgeTts('你好', target);
  check('edge-tts 可执行文件可注入但参数结构不变',
    injected.calls[0].file === 'C:\\fake\\edge-tts.exe' && injected.calls[0].options.shell === false,
    JSON.stringify(injected.calls[0]));
  check('edge-tts 可执行文件注入后 argv 仍是官方正确形式',
    JSON.stringify(injected.calls[0].args) ===
      JSON.stringify(['--voice', EDGE_TTS_DEFAULT_VOICE, '--write-media', target, '--file', '-']),
    JSON.stringify(injected.calls[0].args));

  // 超时可注入，且有 100ms 下限
  const shortTimeout = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 16 }, subprocessTimeoutMs: 250 });
  await shortTimeout.speech.runEdgeTts('你好', target);
  check('edge-tts 超时可注入且写进 execFile 选项', shortTimeout.calls[0].options.timeout === 250, String(shortTimeout.calls[0].options.timeout));
  const clamped = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 16 }, subprocessTimeoutMs: 10 });
  await clamped.speech.runEdgeTts('你好', target);
  check('edge-tts 超时有 100ms 下限（注入 10 被抬到 100）', clamped.calls[0].options.timeout === 100, String(clamped.calls[0].options.timeout));

  check('本机语音集合暴露固定临时目录名', /blue-fat-fish-voice$/.test(h.speech.scriptDir), h.speech.scriptDir);
}

/* -------------------------------------------------------------------------- */
/* 3. edge-tts 失败路径：没装 / 非零 / 超时 / 抛异常 / 空文件，全部安全失败       */
/* -------------------------------------------------------------------------- */

async function testEdgeFailures() {
  const target = 'C:\\temp\\voice\\edge-fail.wav';

  const enoent = makeNative({
    script: [{ error: Object.assign(new Error(INTERNAL_DETAIL), { code: 'ENOENT' }) }],
    sizes: { [target]: 4096 }
  });
  const enoentResult = await enoent.speech.runEdgeTts(EVIL_TEXT, target);
  check('没装 edge-tts（ENOENT）→ not-available', enoentResult.ok === false && enoentResult.code === 'not-available', JSON.stringify(enoentResult));
  check('失败路径用的仍是官方正确 argv（--write-media 输出 + --file - 输入）',
    JSON.stringify(enoent.calls[0].args) ===
      JSON.stringify(['--voice', EDGE_TTS_DEFAULT_VOICE, '--write-media', target, '--file', '-']) &&
      !enoent.calls[0].args.includes('--text-file'),
    JSON.stringify(enoent.calls[0].args));
  check('ENOENT 不泄露内部细节', !JSON.stringify(enoentResult).includes('ENOENT') && !JSON.stringify(enoentResult).includes('内部细节'), JSON.stringify(enoentResult));
  check('ENOENT 不泄露用户文本', !JSON.stringify(enoentResult).includes('机密文本'), JSON.stringify(enoentResult));

  const nonzero = makeNative({
    script: [{ error: Object.assign(new Error('exit 1 内部细节'), { code: 1 }), stdout: '' }],
    sizes: { [target]: 4096 }
  });
  const nonzeroResult = await nonzero.speech.runEdgeTts(EVIL_TEXT, target);
  check('非零退出 → not-available', nonzeroResult.ok === false && nonzeroResult.code === 'not-available', JSON.stringify(nonzeroResult));

  const killed = makeNative({
    script: [{ error: Object.assign(new Error('killed 内部细节'), { killed: true, signal: 'SIGTERM' }), stdout: '' }],
    sizes: { [target]: 4096 }
  });
  const killedResult = await killed.speech.runEdgeTts(EVIL_TEXT, target);
  check('超时被杀 → not-available', killedResult.ok === false && killedResult.code === 'not-available', JSON.stringify(killedResult));
  check('超时路径也带着固定 timeout 选项', killed.calls[0].options.timeout === SUBPROCESS_TIMEOUT_MS, String(killed.calls[0].options.timeout));

  const thrown = makeNative({ script: [{ throws: new Error(INTERNAL_DETAIL) }], sizes: { [target]: 4096 } });
  const thrownResult = await thrown.speech.runEdgeTts(EVIL_TEXT, target);
  check('execFile 同步抛异常 → 安全失败（not-available）', thrownResult.ok === false && thrownResult.code === 'not-available', JSON.stringify(thrownResult));
  check('同步抛异常不把异常抛给调用方', thrownResult.ok === false);

  const emptyFile = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 0 } });
  const emptyResult = await emptyFile.speech.runEdgeTts(EVIL_TEXT, target);
  check('命令成功但目标文件为空 → subprocess-failed', emptyResult.ok === false && emptyResult.code === 'subprocess-failed', JSON.stringify(emptyResult));

  const missingFile = makeNative({ script: [{ stdout: '' }], sizes: {} });
  const missingResult = await missingFile.speech.runEdgeTts(EVIL_TEXT, target);
  check('命令成功但目标文件不存在（statSync ENOENT）→ subprocess-failed', missingResult.ok === false && missingResult.code === 'subprocess-failed', JSON.stringify(missingResult));
}

/* -------------------------------------------------------------------------- */
/* 4. Windows SAPI：固定 PowerShell 脚本 + base64 stdin，文本不进脚本 / argv      */
/* -------------------------------------------------------------------------- */

async function testSapi() {
  const target = 'C:\\temp\\voice\\sapi-1.wav';
  const h = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 2048 } });
  const result = await h.speech.runNativeTts(EVIL_TEXT, target);

  check('SAPI 成功返回 ok + provider=sapi', result.ok === true && result.provider === 'sapi', JSON.stringify(result));
  check('SAPI 只调用一次假 execFile', h.calls.length === 1, String(h.calls.length));

  const call = h.calls[0];
  check('SAPI 默认使用 powershell.exe', call.file === 'powershell.exe', String(call.file));
  check(
    'SAPI 固定 PowerShell 参数顺序（-NoProfile/-NonInteractive/-ExecutionPolicy Bypass/-Command）',
    JSON.stringify(call.args.slice(0, 5)) ===
      JSON.stringify(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']),
    JSON.stringify(call.args.slice(0, 5))
  );
  check('SAPI 第 6 个参数是内置脚本体（固定常量）', call.args[5] === SAPI_SCRIPT, String(call.args[5]).slice(0, 40));
  check('SAPI 用 -- 隔开目标文件参数', call.args[6] === '--', String(call.args[6]));
  check('SAPI 目标文件是调用方传入的文件', call.args[7] === target, String(call.args[7]));
  check('SAPI 参数长度固定为 8', call.args.length === 8, String(call.args.length));
  check('SAPI shell 明确为 false', call.options.shell === false, JSON.stringify(call.options));
  check('SAPI windowsHide 固定 true', call.options.windowsHide === true, JSON.stringify(call.options));
  check('SAPI 超时参数固定为 15 秒', call.options.timeout === SUBPROCESS_TIMEOUT_MS, String(call.options.timeout));

  check('SAPI 文本以 base64 只走 stdin', call.stdin === encodeTextPayload(EVIL_TEXT), String(call.stdin));
  check('SAPI stdin 是 base64，可解回原始文本',
    Buffer.from(call.stdin, 'base64').toString('utf8') === EVIL_TEXT);
  check('SAPI stdin 以 utf8 写入并已 end', call.stdinEnded === true && call.stdinEncoding === 'utf8', JSON.stringify(call));

  const argvText = call.args.join('\u0000');
  check('SAPI 文本绝不进 argv', !argvText.includes('机密文本') && !argvText.includes('whoami') && !argvText.includes('反引号'), argvText);
  check('SAPI 文本绝不混进脚本体', !call.args[5].includes('机密文本') && !call.args[5].includes('whoami') && !call.args[5].includes('反引号'));
  check('SAPI 脚本体每次都是同一个内置常量（不被调用污染）', call.args[5] === SAPI_SCRIPT);
  check('SAPI 返回值不回显用户文本', !JSON.stringify(result).includes('机密文本'), JSON.stringify(result));

  // PowerShell 路径可注入
  const injected = makeNative({
    script: [{ stdout: '' }],
    sizes: { [target]: 16 },
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  });
  await injected.speech.runNativeTts('你好', target);
  check('SAPI PowerShell 路径可注入但脚本体固定',
    injected.calls[0].file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' &&
      injected.calls[0].args[5] === SAPI_SCRIPT,
    JSON.stringify(injected.calls[0].file));

  // SAPI 失败路径
  const fail = makeNative({
    script: [{ error: Object.assign(new Error(INTERNAL_DETAIL), { code: 1 }) }],
    sizes: { [target]: 16 }
  });
  const failResult = await fail.speech.runNativeTts(EVIL_TEXT, target);
  check('SAPI 非零退出 → not-available', failResult.ok === false && failResult.code === 'not-available', JSON.stringify(failResult));
  check('SAPI 失败不泄露内部错误与文本', !JSON.stringify(failResult).includes('内部细节') && !JSON.stringify(failResult).includes('机密文本'), JSON.stringify(failResult));

  const emptySapi = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 0 } });
  const emptySapiResult = await emptySapi.speech.runNativeTts(EVIL_TEXT, target);
  check('SAPI 命令成功但文件为空 → subprocess-failed', emptySapiResult.ok === false && emptySapiResult.code === 'subprocess-failed', JSON.stringify(emptySapiResult));
}

/* -------------------------------------------------------------------------- */
/* 5. runProcess：child 'error' 事件 / stdin EPIPE / 无 stdin                    */
/* -------------------------------------------------------------------------- */

async function testRunProcessEvents() {
  const target = 'C:\\temp\\voice\\proc.wav';

  const childError = makeNative({ script: [{ emitChildError: true }], sizes: { [target]: 16 } });
  const childErrorResult = await childError.speech.runProcess('edge-tts', ['--x'], { stdin: 'hi' });
  check('child error 事件判为失败（subprocess-failed）', childErrorResult.ok === false && childErrorResult.code === 'subprocess-failed', JSON.stringify(childErrorResult));
  check('child error 事件不泄露内部错误', !JSON.stringify(childErrorResult).includes('内部细节'), JSON.stringify(childErrorResult));

  const stdinError = makeNative({ script: [{ emitStdinError: true, stdout: '' }], sizes: { [target]: 16 } });
  const stdinErrorResult = await stdinError.speech.runProcess('edge-tts', ['--x'], { stdin: 'hi' });
  check('stdin EPIPE 被吞掉，由 close 回调决定成功', stdinErrorResult.ok === true, JSON.stringify(stdinErrorResult));

  const noStdin = makeNative({ script: [{ stdout: '' }], sizes: { [target]: 16 } });
  const noStdinResult = await noStdin.speech.runProcess('edge-tts', ['--x']);
  check('没有 stdin 时不写 stdin，也能成功', noStdinResult.ok === true && noStdin.calls[0].stdin === null, JSON.stringify(noStdinResult));

  const procThrow = makeNative({ script: [{ throws: new Error(INTERNAL_DETAIL) }], sizes: { [target]: 16 } });
  const procThrowResult = await procThrow.speech.runProcess('edge-tts', ['--x'], { stdin: 'hi' });
  check('runProcess 同步抛异常 → subprocess-failed', procThrowResult.ok === false && procThrowResult.code === 'subprocess-failed', JSON.stringify(procThrowResult));

  const procOk = makeNative({ script: [{ stdout: 'ignored' }], sizes: { [target]: 16 } });
  const procOkResult = await procOk.speech.runProcess('edge-tts', ['--voice', 'v', '--write-media', target, '--file', '-'], { stdin: 'text' });
  const procCall = procOk.calls[0];
  check('runProcess 传入的是 argv 数组而不是命令字符串', Array.isArray(procCall.args), String(typeof procCall.args));
  check('runProcess 始终 shell:false / windowsHide:true', procCall.options.shell === false && procCall.options.windowsHide === true, JSON.stringify(procCall.options));
  check('runProcess 把 stdin 原样写入', procCall.stdin === 'text', String(procCall.stdin));
  check('runProcess 不带旧错误参数组合 [--text-file, -]', containsSequence(procCall.args, LEGACY_EDGE_INPUT_FLAG) === false, JSON.stringify(procCall.args));
  check('runProcess 成功返回 ok', procOkResult.ok === true, JSON.stringify(procOkResult));
}

/* -------------------------------------------------------------------------- */
/* 6. nvidia-smi：参数固定 + 解析 MB + 门槛判断 + 各种失败都不可用               */
/* -------------------------------------------------------------------------- */

async function testNvidiaSmi() {
  const h = makeNative({ script: [{ stdout: '2048' }] });
  const free = await h.speech.readFreeVramMb();

  check('nvidia-smi 返回解析成数字 2048', free === 2048, String(free));
  check('nvidia-smi 只调用一次', h.calls.length === 1, String(h.calls.length));

  const call = h.calls[0];
  check('nvidia-smi 可执行文件固定', call.file === 'nvidia-smi', String(call.file));
  check(
    'nvidia-smi 查询参数固定（memory.free / csv,noheader,nounits）',
    JSON.stringify(call.args) === JSON.stringify(['--query-gpu=memory.free', '--format=csv,noheader,nounits']),
    JSON.stringify(call.args)
  );
  check('nvidia-smi shell 明确为 false', call.options.shell === false, JSON.stringify(call.options));
  check('nvidia-smi windowsHide 固定 true', call.options.windowsHide === true, JSON.stringify(call.options));
  check('nvidia-smi 查询有超时且固定 3 秒', call.options.timeout === NVIDIA_TIMEOUT_MS, String(call.options.timeout));
  check('nvidia-smi maxBuffer 已设置', call.options.maxBuffer === 64 * 1024, String(call.options.maxBuffer));

  // 解析：带单位 / 前后空白 / 小数 / 多行
  const cases = [
    ['  3200 MiB\n', 3200],
    ['\n4096\n', 4096],
    ['1024.5', 1024.5],
    ['1537 MiB\n', 1537]
  ];
  for (const [stdout, expected] of cases) {
    const parsed = makeNative({ script: [{ stdout }] });
    // eslint-disable-next-line no-await-in-loop
    const value = await parsed.speech.readFreeVramMb();
    check(`nvidia-smi 解析 "${stdout.replace(/\n/g, '\\n')}" → ${expected}`, value === expected, String(value));
  }

  // 无效输出 / 非正数 → null
  for (const stdout of ['N/A', '', 'abc', '0', '-8', 'no devices']) {
    const invalid = makeNative({ script: [{ stdout }] });
    // eslint-disable-next-line no-await-in-loop
    const value = await invalid.speech.readFreeVramMb();
    check(`nvidia-smi 无效输出 "${stdout}" → null`, value === null, String(value));
  }

  // 查询失败 / 超时 / 同步抛异常 / 没装工具 → null
  const failed = makeNative({ script: [{ error: Object.assign(new Error('nvidia-smi failed 内部细节'), { code: 1 }) }] });
  check('nvidia-smi 非零退出 → null', (await failed.speech.readFreeVramMb()) === null);

  const timeout = makeNative({ script: [{ error: Object.assign(new Error('killed 内部细节'), { killed: true }), stdout: '' }] });
  check('nvidia-smi 超时 → null', (await timeout.speech.readFreeVramMb()) === null);

  const thrown = makeNative({ script: [{ throws: new Error('内部细节') }] });
  check('nvidia-smi 同步抛异常 → null', (await thrown.speech.readFreeVramMb()) === null);

  const notInstalled = makeNative({ script: [{ error: Object.assign(new Error('spawn nvidia-smi ENOENT 内部细节'), { code: 'ENOENT' }) }] });
  check('没装 nvidia-smi（ENOENT）→ null', (await notInstalled.speech.readFreeVramMb()) === null);

  // hasEnoughFreeVram：>1536 可用，等于/小于/查不到不可用
  const map = [
    ['4096', true],
    ['2048', true],
    ['1537', true],
    ['1536', false],
    ['1535', false],
    ['1024', false],
    ['1', false],
    ['0', false],
    ['N/A', false]
  ];
  for (const [stdout, expected] of map) {
    const probe = makeNative({ script: [{ stdout }] });
    // eslint-disable-next-line no-await-in-loop
    const enough = await probe.speech.hasEnoughFreeVram();
    check(`空闲显存 ${stdout} → hasEnoughFreeVram=${expected}`, enough === expected, String(enough));
  }

  const queryFail = makeNative({ script: [{ error: Object.assign(new Error('内部细节'), { code: 1 }) }] });
  check('查询失败时 hasEnoughFreeVram=false（绝不猜）', (await queryFail.speech.hasEnoughFreeVram()) === false);

  const custom = makeNative({ script: [{ stdout: '300' }] });
  check('自定义门槛 100MB：300 可用', (await custom.speech.hasEnoughFreeVram(100)) === true);
  const custom2 = makeNative({ script: [{ stdout: '100' }] });
  check('自定义门槛 100MB：等于 100 不可用（必须严格大于）', (await custom2.speech.hasEnoughFreeVram(100)) === false);
  const custom3 = makeNative({ script: [{ stdout: '2048' }] });
  check('自定义门槛 2048MB：等于 2048 不可用', (await custom3.speech.hasEnoughFreeVram(2048)) === false);

  check('nvidia-smi 每次查询都是一次独立子进程（显存不缓存）',
    (await h.speech.readFreeVramMb()) === 2048 && h.calls.length === 2,
    String(h.calls.length));
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  await testEdgeSuccess();
  await testEdgeFailures();
  await testSapi();
  await testRunProcessEvents();
  await testNvidiaSmi();

  console.log('');
  console.log('本机语音能力单元测试（edge-tts / SAPI / nvidia-smi）');
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
