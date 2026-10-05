'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯逻辑模块：PCM / WAV 编码与重采样（阶段 4）
 * ============================================================================
 *
 * 为什么必须有这一层：
 *   浏览器 MediaRecorder 直接录出来的是 **webm/opus**，而智谱 GLM-ASR 官方接口
 *   只接受 **wav / mp3**（见 README 的官方链接）。所以每次断句后都必须把录音
 *   解码 → 混合成单声道 → 重采样到 16kHz → 编码成标准 PCM WAV 再上传，
 *   **绝不能把 webm 原样上传**。
 *
 * 本模块是纯函数集合：
 *   - 不依赖 DOM / WebAudio / Electron / 任何第三方库；
 *   - 输入输出只有 ArrayBuffer / TypedArray / 普通对象；
 *   - 因此浏览器渲染层与裸 node 单元测试跑的是同一份实现。
 *
 * 提供的能力：
 *   - floatToPcm16 / pcm16ToFloat      浮点 ↔ 16 位整数（带饱和夹取）
 *   - computeRms                       归一化 RMS（VAD 的输入）
 *   - mixToMono                        多声道混合成单声道
 *   - resampleLinear                   线性插值重采样（16kHz 目标）
 *   - encodeWav                        44 字节标准 RIFF/WAVE 头 + PCM 数据
 *   - parseWavHeader                   解析并校验头部（单元测试与自检用）
 *   - estimateWavBytes / exceedsAsrFileLimit  上传前的体积预判（25MB 硬上限）
 *
 * 需求硬约束（与官方文档一致）：
 *   - 采样率 16kHz、单声道、16 位 PCM（智谱 ASR 与 faster-whisper 都吃这一套）；
 *   - 单段音频 ≤30 秒（由 VAD 的 maxSegmentMs 保证）；
 *   - 文件 ≤25MB（这里再兜一层，超了直接拒绝，绝不发出去）。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BFFLogic = root.BFFLogic || {};
    root.BFFLogic.wav = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 语音链路统一的采样率（需求：转单声道 16kHz PCM wav） */
  const TARGET_SAMPLE_RATE = 16000;
  /** 智谱 GLM-ASR 只支持 wav / mp3 */
  const ASR_ALLOWED_FORMATS = Object.freeze(['wav', 'mp3']);
  /** 单文件上限 25MB（官方文档） */
  const ASR_MAX_FILE_BYTES = 25 * 1024 * 1024;
  /** 单段音频最长 30 秒（官方文档） */
  const ASR_MAX_DURATION_MS = 30000;
  /** WAV 头固定 44 字节 */
  const WAV_HEADER_BYTES = 44;

  /** @param {unknown} value @returns {number} */
  function clampUnit(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(1, Math.max(-1, num));
  }

  /** @param {number} value 取整夹到 int16 范围 */
  function clampInt16(value) {
    if (!Number.isFinite(value)) return 0;
    if (value > 32767) return 32767;
    if (value < -32768) return -32768;
    return Math.round(value);
  }

  /**
   * 把 -1~1 的浮点样本转成 16 位 PCM。超出范围直接饱和，不做回绕（回绕会变爆音）。
   * @param {ArrayLike<number>} samples
   * @returns {Int16Array}
   */
  function floatToPcm16(samples) {
    const out = new Int16Array(samples ? samples.length : 0);
    for (let i = 0; i < out.length; i += 1) {
      const value = clampUnit(samples[i]);
      // 负半轴范围是 32768，正半轴是 32767，分开缩放保证对称
      out[i] = clampInt16(value < 0 ? value * 32768 : value * 32767);
    }
    return out;
  }

  /**
   * 把 16 位 PCM 转回 -1~1 浮点。
   * @param {ArrayLike<number>} pcm
   * @returns {Float32Array}
   */
  function pcm16ToFloat(pcm) {
    const out = new Float32Array(pcm ? pcm.length : 0);
    for (let i = 0; i < out.length; i += 1) {
      out[i] = clampUnit(Number(pcm[i]) / 32768);
    }
    return out;
  }

  /**
   * 计算归一化 RMS（0~1）。
   * 用 RMS 而不是峰值：RMS 对稳态人声更敏感，对单个爆音更钝，适合做 VAD 输入。
   * @param {ArrayLike<number>} samples -1~1 的样本
   * @returns {number}
   */
  function computeRms(samples) {
    if (!samples || samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = clampUnit(samples[i]);
      sum += value * value;
    }
    const rms = Math.sqrt(sum / samples.length);
    return Number.isFinite(rms) ? Math.min(1, rms) : 0;
  }

  /**
   * 多声道混合成单声道（简单平均，够用且不会引入相位问题）。
   * 传进来单声道时原样返回副本。
   * @param {Array<ArrayLike<number>>} channels
   * @returns {Float32Array}
   */
  function mixToMono(channels) {
    if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
    const first = channels[0] || [];
    const out = new Float32Array(first.length);
    for (let i = 0; i < first.length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels.length; c += 1) {
        const channel = channels[c] || [];
        sum += clampUnit(channel[i]);
      }
      out[i] = clampUnit(sum / channels.length);
    }
    return out;
  }

  /**
   * 线性插值重采样。
   * 语音识别只要 16kHz，用线性插值足够了；避免引入任何重采样库。
   * @param {ArrayLike<number>} samples
   * @param {number} sourceRate
   * @param {number} targetRate
   * @returns {Float32Array}
   */
  function resampleLinear(samples, sourceRate, targetRate) {
    const input = samples || [];
    const from = Number(sourceRate);
    const to = Number(targetRate);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) {
      return new Float32Array(0);
    }
    if (input.length === 0) return new Float32Array(0);
    if (from === to) {
      const same = new Float32Array(input.length);
      for (let i = 0; i < input.length; i += 1) same[i] = clampUnit(input[i]);
      return same;
    }

    const ratio = to / from;
    // 输出长度按比例缩放；至少保留 1 个样本
    const outLength = Math.max(1, Math.floor(input.length * ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const position = i / ratio;
      const index = Math.floor(position);
      const frac = position - index;
      const a = clampUnit(input[index]);
      const b = index + 1 < input.length ? clampUnit(input[index + 1]) : a;
      out[i] = clampUnit(a + (b - a) * frac);
    }
    return out;
  }

  /**
   * 编码标准 PCM WAV（RIFF/WAVE，格式码 1 = PCM）。
   * @param {ArrayLike<number>} samples -1~1 的浮点样本（单声道）
   * @param {number} [sampleRate]
   * @returns {Uint8Array} 完整的 wav 字节（44 字节头 + 数据）
   */
  function encodeWav(samples, sampleRate) {
    const rate = Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0
      ? Math.round(Number(sampleRate))
      : TARGET_SAMPLE_RATE;
    const pcm = samples instanceof Int16Array ? samples : floatToPcm16(samples || []);
    const dataBytes = pcm.length * 2;
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
    const view = new DataView(buffer);

    /** 写 ASCII 标签 */
    const writeTag = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeTag(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true); // 文件长度 - 8
    writeTag(8, 'WAVE');
    writeTag(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt 块长度
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // 单声道
    view.setUint32(24, rate, true); // 采样率
    view.setUint32(28, rate * 2, true); // 字节率 = 采样率 × 声道 × 位深/8
    view.setUint16(32, 2, true); // 块对齐
    view.setUint16(34, 16, true); // 位深
    writeTag(36, 'data');
    view.setUint32(40, dataBytes, true); // 数据长度

    for (let i = 0; i < pcm.length; i += 1) {
      view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i], true);
    }
    return new Uint8Array(buffer);
  }

  /**
   * 解析并校验 WAV 头。
   * @param {ArrayBuffer | Uint8Array | ArrayLike<number>} bytes
   * @returns {{ok: boolean, reason?: string, sampleRate?: number, channels?: number, bitsPerSample?: number, dataBytes?: number, durationMs?: number}}
   */
  function parseWavHeader(bytes) {
    let view = null;
    let length = 0;
    try {
      if (bytes instanceof DataView) {
        view = bytes;
        length = bytes.byteLength;
      } else if (bytes && typeof bytes.byteLength === 'number' && bytes.byteLength > 0) {
        view = new DataView(bytes.buffer ? bytes.buffer : bytes, bytes.byteOffset || 0, bytes.byteLength);
        length = bytes.byteLength;
      }
    } catch {
      return { ok: false, reason: 'bad-buffer' };
    }
    if (!view || length < WAV_HEADER_BYTES) return { ok: false, reason: 'too-short' };

    const tag = (offset) => {
      let text = '';
      for (let i = 0; i < 4; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
      return text;
    };
    if (tag(0) !== 'RIFF') return { ok: false, reason: 'not-riff' };
    if (tag(8) !== 'WAVE') return { ok: false, reason: 'not-wave' };
    if (tag(12) !== 'fmt ') return { ok: false, reason: 'no-fmt' };

    const fmtSize = view.getUint32(16, true);
    const audioFormat = view.getUint16(20, true);
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    if (fmtSize < 16) return { ok: false, reason: 'bad-fmt-size' };
    if (audioFormat !== 1) return { ok: false, reason: 'not-pcm' };
    if (sampleRate <= 0) return { ok: false, reason: 'bad-sample-rate' };
    if (channels <= 0) return { ok: false, reason: 'bad-channels' };
    if (bitsPerSample !== 16) return { ok: false, reason: 'bad-bits' };
    if (tag(36) !== 'data') return { ok: false, reason: 'no-data' };

    const dataBytes = view.getUint32(40, true);
    if (WAV_HEADER_BYTES + dataBytes > length) return { ok: false, reason: 'truncated' };
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    return {
      ok: true,
      sampleRate,
      channels,
      bitsPerSample,
      dataBytes,
      durationMs: bytesPerSecond > 0 ? Math.round((dataBytes / bytesPerSecond) * 1000) : 0
    };
  }

  /**
   * 预估编码后的 WAV 体积（用于"发之前先判断会不会超限"）。
   * @param {number} sampleCount
   * @param {number} [sampleRate]
   * @returns {number}
   */
  function estimateWavBytes(sampleCount, sampleRate) {
    // 位深固定 16 位、单声道，所以字节数只跟样本数有关；采样率参数保留是为了
    // 让调用方在"还没重采样"时也能按目标采样率换算（seconds * TARGET_SAMPLE_RATE）。
    const rate = Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0
      ? Math.round(Number(sampleRate))
      : TARGET_SAMPLE_RATE;
    if (rate !== TARGET_SAMPLE_RATE) {
      // 非目标采样率时按比例折算到目标采样率的样本数
      const seconds = Number(sampleCount) / rate;
      if (Number.isFinite(seconds) && seconds > 0) {
        return WAV_HEADER_BYTES + Math.floor(seconds * TARGET_SAMPLE_RATE) * 2;
      }
    }
    const count = Number.isFinite(Number(sampleCount)) ? Math.max(0, Math.floor(Number(sampleCount))) : 0;
    return WAV_HEADER_BYTES + count * 2;
  }

  /**
   * 上传前的体积 / 时长预判（两道都要过）。
   * @param {number} byteLength
   * @param {number} [durationMs]
   * @returns {{ok: boolean, reason?: 'too-large'|'too-long'}}
   */
  function checkAsrLimits(byteLength, durationMs) {
    if (Number.isFinite(Number(byteLength)) && Number(byteLength) > ASR_MAX_FILE_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    if (Number.isFinite(Number(durationMs)) && Number(durationMs) > ASR_MAX_DURATION_MS + 500) {
      return { ok: false, reason: 'too-long' };
    }
    return { ok: true };
  }

  /** 便捷判断：是否超过 25MB 上限 */
  function exceedsAsrFileLimit(byteLength) {
    return checkAsrLimits(byteLength, 0).ok === false;
  }

  /** 便捷判断：格式是否为 ASR 支持的 wav / mp3 */
  function isAsrSupportedFormat(extension) {
    return typeof extension === 'string' && ASR_ALLOWED_FORMATS.includes(extension.toLowerCase());
  }

  return {
    TARGET_SAMPLE_RATE,
    ASR_ALLOWED_FORMATS,
    ASR_MAX_FILE_BYTES,
    ASR_MAX_DURATION_MS,
    WAV_HEADER_BYTES,
    floatToPcm16,
    pcm16ToFloat,
    computeRms,
    mixToMono,
    resampleLinear,
    encodeWav,
    parseWavHeader,
    estimateWavBytes,
    checkAsrLimits,
    exceedsAsrFileLimit,
    isAsrSupportedFormat
  };
});
