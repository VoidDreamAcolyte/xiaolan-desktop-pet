'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：本地 faster-whisper 语音识别降级（阶段 4，可选）
 * ============================================================================
 *
 * 需求（阶段 4 第 4 条）：
 *   - 云端 GLM-ASR 失败时，**优先尝试本地 faster-whisper（base / small）**；
 *   - **只在 CPU，或 GPU 空闲时**才用：用 `nvidia-smi` 查空闲显存，
 *     **≤1.5GB 就不加载模型**，绝不占用游戏 GPU；
 *   - 没装 Python 包 / 模型时**优雅返回 unavailable**（不是崩溃、不是静默失败）；
 *   - **绝不调用任何本地 LLM**：只做语音转文本，脚本里只有 faster-whisper。
 *
 * 安全：
 *   - 子进程一律 `execFile(python, [script], {...})`，**没有 shell**；
 *   - 用户音频只以**文件路径**通过 stdin 的 JSON 传给子进程，不拼命令行；
 *   - 脚本正文是内置常量（见 python-stt/whisper_asr.py 同一份逻辑），
 *     不从磁盘读脚本内容 —— 避免"脚本被替换"这类篡改路径；
 *   - Python 不在 PATH / 包没装 / 模型没下载，全部归类为 unavailable，绝不下载大模型。
 *
 * 依赖注入：`execFileImpl` / `fs` / `nativeSpeech` 都可替换，
 * 单元测试因此可以断言：**VRAM ≤1.5GB 时不加载模型**、**参数是数组且没有 shell**。
 */

const nodePath = require('node:path');
const { createNativeSpeech, FREE_VRAM_THRESHOLD_MB } = require('./native-speech');

/** 默认模型档位（需求：base / small） */
const DEFAULT_MODEL = 'base';
/** 允许的模型档位白名单 */
const ALLOWED_MODELS = Object.freeze(['tiny', 'base', 'small']);
/** 子进程超时：本地识别要加载模型，给得比云调用宽一些 */
const TRANSCRIBE_TIMEOUT_MS = 30000;
/** 可用性探测超时 */
const PROBE_TIMEOUT_MS = 5000;
/** python 候选命令（Windows 上通常是 py / python） */
const PYTHON_CANDIDATES = Object.freeze(['python', 'py', 'python3']);
/** 本地模型下载根目录名（位于 userData 下） */
const MODEL_DIR_NAME = 'whisper-models';

/**
 * 内置的识别脚本（与仓库 `python-stt/whisper_asr.py` 是同一份逻辑）。
 *
 * 设计要点：
 *   - 输入：stdin 一行 JSON `{audio, model, modelDir}`；
 *   - 输出：stdout 一行 JSON `{ok:true,text,model}` 或 `{ok:false,code,message}`；
 *   - 退出码：0 成功 / 2 缺 faster-whisper / 3 缺模型文件 / 4 音频读不了 / 5 其它；
 *   - **模型路径不合格时在 import faster_whisper 之前就退出**（绝不因为"没模型"而
 *     偷偷联网下载，也绝不加载任何大模型）；
 *   - 只用 CPU（device="cpu"、compute_type="int8"），显存检查在主进程侧完成。
 */
const WHISPER_SCRIPT = [
  'import json, os, sys, wave',
  'try:',
  '    import numpy as np',
  '    from faster_whisper import WhisperModel',
  'except Exception:',
  '    sys.stdout.write(json.dumps({"ok": False, "code": "no-package"}))',
  '    sys.exit(2)',
  'payload = json.loads(sys.stdin.read() or "{}")',
  'audio = payload.get("audio") or ""',
  'model_dir = payload.get("modelDir") or ""',
  'model_name = payload.get("model") or "base"',
  'if not audio or not os.path.isfile(audio):',
  '    sys.stdout.write(json.dumps({"ok": False, "code": "no-audio"}))',
  '    sys.exit(4)',
  'model_path = os.path.join(model_dir, model_name) if model_dir else model_name',
  'if os.path.isabs(model_path) and not os.path.isdir(model_path):',
  '    sys.stdout.write(json.dumps({"ok": False, "code": "model-missing"}))',
  '    sys.exit(3)',
  'try:',
  '    with wave.open(audio, "rb") as handle:',
  '        channels = handle.getnchannels()',
  '        width = handle.getsampwidth()',
  '        rate = handle.getframerate()',
  '        frames = handle.readframes(handle.getnframes())',
  '    if width != 2:',
  '        sys.stdout.write(json.dumps({"ok": False, "code": "bad-audio"}))',
  '        sys.exit(4)',
  '    samples = np.frombuffer(frames, dtype="<i2").astype("float32") / 32768.0',
  '    if channels > 1:',
  '        samples = samples.reshape(-1, channels).mean(axis=1)',
  '    model = WhisperModel(model_path, device="cpu", compute_type="int8")',
  '    segments, _info = model.transcribe(samples, language="zh", beam_size=1)',
  '    text = "".join(segment.text for segment in segments).strip()',
  '    sys.stdout.write(json.dumps({"ok": True, "text": text, "model": model_name}, ensure_ascii=False))',
  '    sys.exit(0)',
  'except Exception as error:',
  '    sys.stdout.write(json.dumps({"ok": False, "code": "error", "message": str(error)[:120]}))',
  '    sys.exit(5)'
].join('\n');

/**
 * 纯函数：空闲显存是否达到"可以用本地模型"的门槛。
 *
 * 规则（需求硬性要求）：**> 1.5GB 才允许**；查询不到（null）一律不允许。
 * 单独抽成纯函数是为了让单元测试直接把 1500 / 1536 / 1537 / 2048 / null 都跑一遍。
 *
 * @param {number | null} freeMb
 * @param {number} [thresholdMb]
 * @returns {boolean}
 */
function isVramSufficient(freeMb, thresholdMb) {
  const threshold = Number.isFinite(thresholdMb) ? thresholdMb : 1536;
  if (!Number.isFinite(freeMb)) return false;
  return Number(freeMb) > threshold;
}

/**
 * 选择模型档位：显存宽裕才允许 small，否则 base；再不然 tiny。
 * @param {number | null} freeMb
 * @param {string} [preferred]
 * @returns {string}
 */
function pickModel(freeMb, preferred) {
  const want = typeof preferred === 'string' && ALLOWED_MODELS.includes(preferred) ? preferred : DEFAULT_MODEL;
  if (want === 'small') {
    // small 大约需要 1GB 以上显存 / 内存，显存不宽裕就降一档
    return isVramSufficient(freeMb, 2048) ? 'small' : 'base';
  }
  return want;
}

/**
 * 创建一个本地识别器。
 *
 * @param {{
 *   execFileImpl?: Function,
 *   fs?: object,
 *   nativeSpeech?: object,
 *   modelDir?: string,
 *   preferredModel?: string,
 *   vramThresholdMb?: number,
 *   skipVramCheck?: boolean,
 *   timers?: object,
 *   logger?: {warn?: Function}
 * }} [deps]
 */
function createLocalTranscriber(deps) {
  const options = deps || {};
  const fs = options.fs || require('node:fs');
  const nativeSpeech = options.nativeSpeech && typeof options.nativeSpeech === 'object'
    ? options.nativeSpeech
    : createNativeSpeech({ fs: fs });
  const preferredModel = typeof options.preferredModel === 'string' ? options.preferredModel : DEFAULT_MODEL;
  const vramThresholdMb = Number.isFinite(options.vramThresholdMb)
    ? options.vramThresholdMb
    : FREE_VRAM_THRESHOLD_MB;
  /**
   * 是否跳过显存检查。
   * **只有显式传 `skipVramCheck: true` 才会跳过**（默认 false = 必须检查），
   * 这样任何"忘了检查"的改动都会让单元测试失败。
   */
  const skipVramCheck = options.skipVramCheck === true;
  const modelDir = typeof options.modelDir === 'string' && options.modelDir.length > 0
    ? options.modelDir
    : nodePath.join(require('node:os').tmpdir(), MODEL_DIR_NAME);

  const execFileImpl = typeof options.execFileImpl === 'function'
    ? options.execFileImpl
    : (() => {
        try {
          const childProcess = require('node:child_process');
          return typeof childProcess.execFile === 'function' ? childProcess.execFile : null;
        } catch {
          return null;
        }
      })();

  /** 缓存的可用性探测结果；null 表示还没探测过 */
  let cachedAvailability = null;

  /**
   * 执行一个"无 shell"的子进程并把 stdout 收回来。
   * @param {string} file
   * @param {string[]} args
   * @param {{stdin?: string, timeoutMs?: number}} [io]
   * @returns {Promise<{ok: boolean, code?: string, stdout?: string, exitCode?: number}>}
   */
  function run(file, args, io) {
    if (!execFileImpl) return Promise.resolve({ ok: false, code: 'not-available' });
    const input = io && typeof io.stdin === 'string' ? io.stdin : null;
    const timeout = io && Number.isFinite(io.timeoutMs) ? io.timeoutMs : PROBE_TIMEOUT_MS;
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
            // 明确无 shell：外部命令名 + argv 数组，绝不拼字符串
            shell: false,
            windowsHide: true,
            timeout: timeout,
            maxBuffer: 4 * 1024 * 1024,
            env: process.env
          },
          (error, stdout) => {
            const text = typeof stdout === 'string' ? stdout : String(stdout || '');
            if (error) {
              // 超时 / 非 0 退出：把 stdout 也带回去（脚本自己写的 JSON 在里面）
              done({ ok: false, code: error.killed ? 'timeout' : 'subprocess-failed', stdout: text });
              return;
            }
            done({ ok: true, stdout: text });
          }
        );
        if (child && typeof child.on === 'function') {
          child.on('error', () => done({ ok: false, code: 'not-available' }));
        }
        if (input !== null && child && child.stdin) {
          child.stdin.on('error', () => {
            // 子进程提前退出会 EPIPE，交给回调决定结果
          });
          child.stdin.end(input, 'utf8');
        }
      } catch {
        done({ ok: false, code: 'not-available' });
      }
    });
  }

  /**
   * 找可用的 python 解释器，并检查 faster-whisper 是否已安装。
   * 结果会缓存（一次会话里只探测一次，避免反复起子进程）。
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{available: boolean, code?: string, python?: string}>}
   */
  async function probe(opts) {
    const force = opts && opts.force === true;
    if (!force && cachedAvailability) return cachedAvailability;
    if (!execFileImpl) {
      cachedAvailability = { available: false, code: 'unavailable' };
      return cachedAvailability;
    }

    for (const candidate of PYTHON_CANDIDATES) {
      // -c 探测：只 import，不加载任何模型、不联网
      const result = await run(candidate, ['-c', 'import faster_whisper'], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.ok) {
        cachedAvailability = { available: true, python: candidate };
        return cachedAvailability;
      }
      if (result.code === 'subprocess-failed') {
        // 解释器存在但 import 失败 → 包没装；不必再试其它候选
        cachedAvailability = { available: false, code: 'no-package' };
        return cachedAvailability;
      }
    }
    cachedAvailability = { available: false, code: 'no-python' };
    return cachedAvailability;
  }

  /**
   * 是否可用（探测 python / 包；**不含显存判断**，显存每次识别前实时看）。
   * @returns {Promise<{available: boolean, code?: string}>}
   */
  async function isAvailable() {
    const probed = await probe();
    return probed.available ? { available: true } : { available: false, code: probed.code };
  }

  /**
   * 识别一个 WAV 文件。
   *
   * 顺序：
   *   1. python / 包探测（不可用 → `{ok:false, code:'unavailable'}`）；
   *   2. **显存检查**：默认必须通过 `nvidia-smi` 空闲显存 > 1.5GB，否则不加载模型；
   *   3. 起子进程跑内置脚本（无 shell），把音频路径通过 stdin JSON 传入；
   *   4. 解析 stdout JSON；任何异常都归类为明确短码。
   *
   * @param {string} audioFile
   * @param {{durationMs?: number}} [meta]
   * @returns {Promise<{ok: boolean, text?: string, code?: string, model?: string, vramFreeMb?: number|null}>}
   */
  async function transcribe(audioFile, meta) {
    void meta;
    if (typeof audioFile !== 'string' || audioFile.length === 0) {
      return { ok: false, code: 'no-audio' };
    }

    const probed = await probe();
    if (!probed.available) {
      return { ok: false, code: 'unavailable', detail: probed.code };
    }

    // 显存保护：游戏满载时直接用不了本地模型，绝不抢 GPU
    let freeVramMb = null;
    if (!skipVramCheck) {
      freeVramMb = await nativeSpeech.readFreeVramMb();
      if (!isVramSufficient(freeVramMb, vramThresholdMb)) {
        return { ok: false, code: 'vram-busy', vramFreeMb: freeVramMb };
      }
    }

    const model = pickModel(freeVramMb, preferredModel);
    const payload = JSON.stringify({ audio: audioFile, model: model, modelDir: modelDir });

    const result = await run(probed.python, ['-c', WHISPER_SCRIPT], {
      stdin: payload,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS
    });

    if (!result.stdout) {
      return { ok: false, code: result.code || 'subprocess-failed', vramFreeMb: freeVramMb };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    } catch {
      return { ok: false, code: 'bad-response', vramFreeMb: freeVramMb };
    }

    if (parsed && parsed.ok === true && typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
      return { ok: true, text: parsed.text.trim(), model: parsed.model || model, vramFreeMb: freeVramMb };
    }
    const code = parsed && typeof parsed.code === 'string' ? parsed.code : 'subprocess-failed';
    const mapped = code === 'model-missing' || code === 'no-package' || code === 'no-audio' ? code : 'unavailable';
    return { ok: false, code: mapped, vramFreeMb: freeVramMb };
  }

  return {
    transcribe,
    isAvailable,
    readFreeVramMb: () => nativeSpeech.readFreeVramMb(),
    getModelDir: () => modelDir,
    getPreferredModel: () => preferredModel,
    getVramThresholdMb: () => vramThresholdMb,
    /** 仅测试使用：清掉探测缓存 */
    resetCache: () => {
      cachedAvailability = null;
    }
  };
}

module.exports = {
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
};
