'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：本机语音能力（edge-tts / Windows SAPI / nvidia-smi）
 * ============================================================================
 *
 * 三条硬规则（安全 + 需求）：
 *   1. **绝不使用 shell**：所有外部命令一律 `execFile(可执行文件, argv数组)`，
 *      既没有 `shell: true`，也没有把用户文本拼进命令行字符串。
 *      用户文本只通过 **stdin（UTF-8，base64 传输）** 或临时文件传给子系统，
 *      因此提示词 / 回复里出现引号、分号、`$()`、反引号都不可能变成命令注入。
 *   2. **绝不静默失败**：edge-tts 或 SAPI 不可用时返回 `{ok:false, code:'not-available'}`
 *      这类明确结果，由调用方继续往下一级降级（最后一级是渲染层 speechSynthesis）。
 *   3. **绝不占游戏 GPU**：本地 faster-whisper 只允许在 **nvidia-smi 报告的空闲显存
 *      > 1.5GB** 时加载；查不到 / 查询失败 / 显存不够 → 直接判定不可用，
 *      绝不在游戏满载时抢显存（需求原文）。
 *
 * 依赖注入：`execFileImpl` / `fs` / `env` / `scriptDir` 都可替换，
 * 单元测试因此可以断言"参数是数组、没有 shell、文本不落在 argv 里"。
 */

const nodePath = require('node:path');
const nodeOs = require('node:os');

/** edge-tts 可执行文件名（pip 安装后是控制台脚本，Windows 上是 edge-tts.exe） */
const EDGE_TTS_EXECUTABLE = 'edge-tts';
/** edge-tts 默认音色（中文女声；GLM-TTS 音色是智谱自己的 id，两套不通用） */
const EDGE_TTS_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** 子进程超时（毫秒）：卡住就杀掉，绝不让桌宠界面跟着挂 */
const SUBPROCESS_TIMEOUT_MS = 15000;
/** nvidia-smi 查询超时 */
const NVIDIA_TIMEOUT_MS = 3000;
/** 空闲显存阈值：>1.5GB 才允许加载本地识别模型（需求硬性要求） */
const FREE_VRAM_THRESHOLD_MB = 1536;

/**
 * 内置的 Windows SAPI 合成脚本。
 *
 * 关键点：
 *   - 文本**只从 stdin 读**（base64，避免中文在命令行 / 代码页上出问题），
 *     绝不出现在命令行参数里；
 *   - 输出用 `SpeechAudioFormatInfo` 写出 24kHz / 16bit / 单声道 WAV，
 *     与 GLM-TTS 的建议采样率一致，播放链路不需要分支；
 *   - `-NoProfile -NonInteractive`：不加载用户配置、不弹交互；
 *   - 只依赖 .NET 自带的 System.Speech，不需要任何第三方组件。
 */
const SAPI_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$out = $args[0]',
  '$input | Set-Variable -Name raw',
  '$bytes = [Convert]::FromBase64String($raw)',
  '$text = [Text.Encoding]::UTF8.GetString($bytes)',
  'Add-Type -AssemblyName System.Speech',
  '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$synth.SetOutputToWaveFile($out, $fmt)',
  '$synth.Speak($text)',
  '$synth.Dispose()'
].join('\n');

/**
 * 把文本编码成 base64（stdin 传输用；不是加密，只是为了让中文与换行安全过管道）。
 * @param {string} text
 * @returns {string}
 */
function encodeTextPayload(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

/**
 * 校验目标音频文件是否真的被写出来且非空。
 * @param {object} fs
 * @param {string} file
 * @returns {number} 字节数（0 表示失败）
 */
function fileSize(fs, file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 创建一个本机语音能力集合。
 *
 * @param {{
 *   execFileImpl?: Function,
 *   fs?: object,
 *   env?: Record<string, string|undefined>,
 *   logger?: {warn?: Function},
 *   subprocessTimeoutMs?: number,
 *   edgeExecutable?: string,
 *   powershellPath?: string
 * }} [deps]
 */
function createNativeSpeech(deps) {
  const options = deps || {};
  const fs = options.fs || require('node:fs');
  const env = options.env || process.env;
  const subprocessTimeoutMs = Number.isFinite(options.subprocessTimeoutMs)
    ? Math.max(100, Math.floor(options.subprocessTimeoutMs))
    : SUBPROCESS_TIMEOUT_MS;
  const edgeExecutable = typeof options.edgeExecutable === 'string' && options.edgeExecutable.length > 0
    ? options.edgeExecutable
    : EDGE_TTS_EXECUTABLE;

  /**
   * 取默认的 child_process.execFile。
   * 延迟 require：模块本身可以只在需要时才加载 child_process。
   * @returns {Function | null}
   */
  function defaultExecFile() {
    try {
      const childProcess = require('node:child_process');
      return typeof childProcess.execFile === 'function' ? childProcess.execFile : null;
    } catch {
      return null;
    }
  }

  const execFileImpl = typeof options.execFileImpl === 'function'
    ? options.execFileImpl
    : defaultExecFile();

  /**
   * 统一执行一个"无 shell"的子进程。
   *
   * **这里没有任何 shell 参数**：`execFile(file, args, {windowsHide, timeout, maxBuffer})`。
   * 超时由 Node 自己 kill（`timeout`），不需要额外定时器；
   * 一旦超时 / 非 0 退出 / 抛异常，一律返回 `{ok:false, code:'subprocess-failed'}`。
   *
   * @param {string} file
   * @param {string[]} args
   * @param {{stdin?: string}} [io]
   * @returns {Promise<{ok: boolean, code?: string, stdout?: string}>}
   */
  function runProcess(file, args, io) {
    if (!execFileImpl) return Promise.resolve({ ok: false, code: 'not-available' });
    const input = io && typeof io.stdin === 'string' ? io.stdin : null;
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = execFileImpl(
          file,
          args,
          {
            // 明确关闭 shell（即使将来有人误传 shell 也会被这里覆盖）
            shell: false,
            windowsHide: true,
            timeout: subprocessTimeoutMs,
            maxBuffer: 1024 * 1024,
            // 文本通过 stdin 传，不需要额外的环境变量
            env: env
          },
          (error) => {
            if (error) {
              done({ ok: false, code: 'subprocess-failed' });
              return;
            }
            done({ ok: true });
          }
        );
        if (child && typeof child.on === 'function') {
          child.on('error', () => done({ ok: false, code: 'subprocess-failed' }));
        }
        if (input !== null && child && child.stdin) {
          child.stdin.on('error', () => {
            // 子进程提前退出时 stdin 会 EPIPE，这里吞掉，由 close 回调决定结果
          });
          child.stdin.end(input, 'utf8');
        }
      } catch {
        done({ ok: false, code: 'subprocess-failed' });
      }
    });
  }

  /**
   * 运行 PowerShell 脚本（脚本体只从 stdin 读，不带任何用户文本）。
   * @param {string} script
   * @param {string[]} args
   * @param {string} stdin
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  function runPowerShell(script, args, stdin) {
    const powershell = typeof options.powershellPath === 'string' && options.powershellPath.length > 0
      ? options.powershellPath
      : 'powershell.exe';
    return runProcess(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, '--', ...args],
      { stdin }
    );
  }

  /**
   * edge-tts 降级合成。
   *
   * 命令（严格对齐官方 CLI 的参数解析，上游 src/edge_tts/util.py）：
   *   `edge-tts --voice <固定音色> --write-media <目标 wav> --file -`
   *
   * 三个不能含糊的点：
   *   1. **文本只走 stdin**：`--file -` 是官方约定的"从标准输入读文本"
   *      （util.py 读到 "-" 时执行 `sys.stdin.read()`），所以文本**绝不进 argv**；
   *   2. **音频输出必须用 `--write-media <路径>` 指定**：官方 CLI 不会凭
   *      `--file` 生成音频，把目标 wav 塞给 `--file` 只会被当成"输入文本文件"；
   *   3. **官方没有 `--text-file` 参数**：`--text` 与 `--file` 是互斥的两个输入开关，
   *      旧实现传的 `['--text-file', '-']` 会被 argparse 直接拒绝（历史错误，禁止再用）；
   *      等价地，argv 里也绝不会出现"`--file` 后面跟着目标 wav"这种把输出当输入的写法。
   *
   * argv 固定为 `['--voice', voice, '--write-media', targetFile, '--file', '-']`：
   * 顺序与取值都被单测逐位锁定。没装 edge-tts 时 execFile 会直接报 ENOENT，
   * 我们归类为 not-available（由调用方继续往下一级降级）。
   *
   * @param {string} text
   * @param {string} targetFile
   * @param {{voice?: string}} [opts]
   * @returns {Promise<{ok: boolean, code?: string, provider?: string}>}
   */
  async function runEdgeTts(text, targetFile, opts) {
    const voice = opts && typeof opts.voice === 'string' && opts.voice.length > 0
      ? opts.voice
      : EDGE_TTS_DEFAULT_VOICE;
    const result = await runProcess(
      edgeExecutable,
      ['--voice', voice, '--write-media', targetFile, '--file', '-'],
      { stdin: String(text) }
    );
    if (!result.ok) return { ok: false, code: 'not-available' };
    if (fileSize(fs, targetFile) <= 0) return { ok: false, code: 'subprocess-failed' };
    return { ok: true, provider: 'edge-tts' };
  }

  /**
   * Windows SAPI（System.Speech）降级合成。
   * 文本 base64 后走 stdin；脚本体是内置常量，不会被用户文本污染。
   *
   * @param {string} text
   * @param {string} targetFile
   * @returns {Promise<{ok: boolean, code?: string, provider?: string}>}
   */
  async function runNativeTts(text, targetFile) {
    const result = await runPowerShell(SAPI_SCRIPT, [targetFile], encodeTextPayload(text));
    if (!result.ok) return { ok: false, code: 'not-available' };
    if (fileSize(fs, targetFile) <= 0) return { ok: false, code: 'subprocess-failed' };
    return { ok: true, provider: 'sapi' };
  }

  /**
   * 查询 nvidia-smi 的**空闲显存**（MB）。
   *
   * 返回 null 的情况很多，全部按"不可用"处理，绝不猜：
   *   - 没有 nvidia-smi / 没有 N 卡 / 驱动异常；
   *   - 命令超时 / 返回码非 0 / 输出解析不出来；
   *   - 显存值 <= 0。
   *
   * @returns {Promise<number | null>}
   */
  async function readFreeVramMb() {
    if (!execFileImpl) return null;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        execFileImpl(
          'nvidia-smi',
          ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
          { shell: false, windowsHide: true, timeout: NVIDIA_TIMEOUT_MS, maxBuffer: 64 * 1024 },
          (error, stdout) => {
            if (error) {
              done(null);
              return;
            }
            const text = typeof stdout === 'string' ? stdout : String(stdout || '');
            const match = text.match(/-?\d+(\.\d+)?/);
            if (!match) {
              done(null);
              return;
            }
            const value = Number(match[0]);
            done(Number.isFinite(value) && value > 0 ? value : null);
          }
        );
      } catch {
        done(null);
      }
    });
  }

  /**
   * 空闲显存是否足够加载本地识别模型（需求：>1.5GB 才允许）。
   * 查询不到 → 一律返回 false（宁可不用本地模型，也不抢游戏显存）。
   * @param {number} [thresholdMb]
   * @returns {Promise<boolean>}
   */
  async function hasEnoughFreeVram(thresholdMb) {
    const threshold = Number.isFinite(thresholdMb) ? thresholdMb : FREE_VRAM_THRESHOLD_MB;
    const free = await readFreeVramMb();
    if (free === null) return false;
    return free > threshold;
  }

  return {
    runProcess,
    runEdgeTts,
    runNativeTts,
    readFreeVramMb,
    hasEnoughFreeVram,
    edgeExecutable,
    scriptDir: nodePath.join(nodeOs.tmpdir(), 'blue-fat-fish-voice')
  };
}

module.exports = {
  EDGE_TTS_EXECUTABLE,
  EDGE_TTS_DEFAULT_VOICE,
  SUBPROCESS_TIMEOUT_MS,
  NVIDIA_TIMEOUT_MS,
  FREE_VRAM_THRESHOLD_MB,
  SAPI_SCRIPT,
  encodeTextPayload,
  createNativeSpeech
};
