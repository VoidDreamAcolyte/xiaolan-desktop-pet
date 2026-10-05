'use strict';

/**
 * ============================================================================
 * 纯逻辑单元测试：PCM / WAV 编码与重采样（renderer/logic/wav.js）
 * ============================================================================
 *
 * 为什么这条测试很关键：
 *   浏览器 MediaRecorder 录出来的是 **webm/opus**，而智谱 GLM-ASR 官方只接受
 *   **wav / mp3**。所以"断句 → 解码 → 单声道 → 16kHz → WAV"这条路是硬要求，
 *   一旦编码写错（采样率写错、声道数写错、头长度写错），云端会直接拒绝，
 *   而错误信息里不会有"你 WAV 头写错了"这种提示 —— 必须靠单元测试兜住。
 *
 * 覆盖：
 *   1. WAV 头逐字段校验（RIFF / WAVE / fmt / PCM / 单声道 / 采样率 / 位深 / data）；
 *   2. 采样率 16kHz 与单声道（需求指定）；
 *   3. float ↔ int16 饱和夹取（不回绕）；
 *   4. 多声道混合成单声道；
 *   5. 线性重采样到 16kHz（长度 / 幅值 / 非法输入）；
 *   6. 体积与时长上限（25MB / 30 秒）；
 *   7. 格式白名单（只支持 wav / mp3，**webm 必须被拒绝**）。
 *
 * 用法：node tests/wav.test.js
 */

const path = require('node:path');

const wav = require(path.join(__dirname, '..', 'renderer', 'logic', 'wav.js'));

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

/** 造一段正弦波（-1~1），用来验证编码与重采样 */
function sineWave(sampleCount, sampleRate, frequency) {
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

/** 从 WAV 字节里读第 index 个 16 位样本 */
function readSample(bytes, index) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt16(wav.WAV_HEADER_BYTES + index * 2, true);
}

/* -------------------------------------------------------------------------- */
/* 1. 常量：官方限制写死在这里                                                   */
/* -------------------------------------------------------------------------- */

{
  check('目标采样率是 16000Hz（需求：转单声道 16kHz PCM wav）', wav.TARGET_SAMPLE_RATE === 16000, String(wav.TARGET_SAMPLE_RATE));
  check('只允许 wav / mp3（官方限制）', wav.ASR_ALLOWED_FORMATS.join(',') === 'wav,mp3', wav.ASR_ALLOWED_FORMATS.join(','));
  check('单文件上限 25MB（官方限制）', wav.ASR_MAX_FILE_BYTES === 25 * 1024 * 1024, String(wav.ASR_MAX_FILE_BYTES));
  check('单段最长 30 秒（官方限制）', wav.ASR_MAX_DURATION_MS === 30000, String(wav.ASR_MAX_DURATION_MS));
  check('WAV 头固定 44 字节', wav.WAV_HEADER_BYTES === 44, String(wav.WAV_HEADER_BYTES));

  check('webm 不在允许格式里（绝不能直接上传）', wav.isAsrSupportedFormat('webm') === false);
  check('wav / mp3 / WAV（大写）都被允许', wav.isAsrSupportedFormat('wav') && wav.isAsrSupportedFormat('mp3') && wav.isAsrSupportedFormat('WAV'));
  check('非字符串格式一律拒绝', wav.isAsrSupportedFormat(null) === false && wav.isAsrSupportedFormat(12) === false);
}

/* -------------------------------------------------------------------------- */
/* 2. WAV 头逐字段校验                                                          */
/* -------------------------------------------------------------------------- */

{
  const samples = sineWave(16000, 16000, 440); // 正好 1 秒
  const bytes = wav.encodeWav(samples, 16000);
  const header = wav.parseWavHeader(bytes);

  check('编码结果是 Uint8Array', bytes instanceof Uint8Array);
  check('总长度 = 44 + 样本数 × 2', bytes.byteLength === 44 + 16000 * 2, `${bytes.byteLength}`);
  check('头部可以被解析', header.ok === true, header.reason || '');
  check('采样率是 16000', header.sampleRate === 16000, String(header.sampleRate));
  check('声道数是 1（单声道）', header.channels === 1, String(header.channels));
  check('位深是 16', header.bitsPerSample === 16, String(header.bitsPerSample));
  check('data 块长度 = 样本数 × 2', header.dataBytes === 32000, String(header.dataBytes));
  check('时长约 1000ms', header.durationMs === 1000, String(header.durationMs));

  // 直接检查字节：RIFF / WAVE / fmt / data / PCM 标记
  const ascii = (start, length) => {
    let text = '';
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[start + i]);
    return text;
  };
  check('偏移 0 是 RIFF', ascii(0, 4) === 'RIFF');
  check('偏移 8 是 WAVE', ascii(8, 4) === 'WAVE');
  check('偏移 12 是 fmt 块', ascii(12, 4) === 'fmt ');
  check('偏移 36 是 data 块', ascii(36, 4) === 'data');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check('RIFF 长度字段 = 文件长度 - 8', view.getUint32(4, true) === bytes.byteLength - 8, String(view.getUint32(4, true)));
  check('fmt 块长度是 16', view.getUint32(16, true) === 16);
  check('音频格式码是 1（PCM）', view.getUint16(20, true) === 1);
  check('字节率 = 采样率 × 声道 × 位深/8 = 32000', view.getUint32(28, true) === 32000, String(view.getUint32(28, true)));
  check('块对齐 = 声道 × 位深/8 = 2', view.getUint16(32, true) === 2, String(view.getUint16(32, true)));
}

/* -------------------------------------------------------------------------- */
/* 3. 默认采样率就是 16000（不传 sampleRate 也要对）                              */
/* -------------------------------------------------------------------------- */

{
  const bytes = wav.encodeWav(new Float32Array(100), undefined);
  const header = wav.parseWavHeader(bytes);
  check('不传采样率时默认写 16000', header.ok && header.sampleRate === 16000, header.ok ? String(header.sampleRate) : header.reason);
}

/* -------------------------------------------------------------------------- */
/* 4. float → int16 的饱和夹取（不回绕，避免爆音）                                */
/* -------------------------------------------------------------------------- */

{
  const pcm = wav.floatToPcm16([0, 1, -1, 2, -2, 0.5, -0.5, NaN]);
  check('0 → 0', pcm[0] === 0, String(pcm[0]));
  check('+1 → 32767（正半轴上限）', pcm[1] === 32767, String(pcm[1]));
  check('-1 → -32768（负半轴下限）', pcm[2] === -32768, String(pcm[2]));
  check('超过 +1 饱和到 32767，绝不回绕成负数', pcm[3] === 32767, String(pcm[3]));
  check('低于 -1 饱和到 -32768', pcm[4] === -32768, String(pcm[4]));
  check('0.5 → 约 16384（正半轴按 32767 缩放）', pcm[5] === 16384, String(pcm[5]));
  check('-0.5 → -16384（负半轴按 32768 缩放）', pcm[6] === -16384, String(pcm[6]));
  check('NaN 当作 0', pcm[7] === 0, String(pcm[7]));

  const roundTrip = wav.pcm16ToFloat(pcm);
  check('int16 → float 往返：+1 附近', Math.abs(roundTrip[1] - 1) < 1e-4, String(roundTrip[1]));
  check('int16 → float 往返：-1 附近', Math.abs(roundTrip[2] + 1) < 1e-4, String(roundTrip[2]));
  check('floatToPcm16(空) 返回空数组', wav.floatToPcm16([]).length === 0);
  check('floatToPcm16(null) 不抛异常', wav.floatToPcm16(null).length === 0);
}

/* -------------------------------------------------------------------------- */
/* 5. 编码后的样本与原始波形一致（不是全 0 也不是噪声）                            */
/* -------------------------------------------------------------------------- */

{
  const samples = sineWave(1000, 16000, 100);
  const bytes = wav.encodeWav(samples, 16000);
  const first = readSample(bytes, 1); // sin(2π·100/16000) ≈ 0.0393
  check('第一个样本被真的写进去了（非 0）', first !== 0, String(first));
  check('第一个样本幅值合理（约 1288）', Math.abs(first - Math.round(Math.sin((2 * Math.PI * 100) / 16000) * 32767)) <= 1, String(first));

  // 全部样本不能都是同一个值（避免"把数组写成一堆 0"的假实现）
  let distinct = new Set();
  for (let i = 0; i < 200; i += 1) distinct.add(readSample(bytes, i));
  check('写出的样本不是常量（真的有波形）', distinct.size > 10, String(distinct.size));

  let max = 0;
  for (let i = 0; i < 1000; i += 1) max = Math.max(max, Math.abs(readSample(bytes, i)));
  check('峰值接近 int16 满量程', max > 32000, String(max));
}

/* -------------------------------------------------------------------------- */
/* 6. 多声道混合成单声道                                                        */
/* -------------------------------------------------------------------------- */

{
  const left = new Float32Array([1, -1, 0.5]);
  const right = new Float32Array([0, 0, -0.5]);
  const mono = wav.mixToMono([left, right]);
  check('双声道取平均', Math.abs(mono[0] - 0.5) < 1e-6 && Math.abs(mono[1] + 0.5) < 1e-6 && mono[2] === 0, JSON.stringify(Array.from(mono)));
  check('单声道输入原样返回（副本）', wav.mixToMono([left]).length === 3 && Math.abs(wav.mixToMono([left])[0] - 1) < 1e-6);
  check('空输入返回空数组', wav.mixToMono([]).length === 0 && wav.mixToMono(null).length === 0);
  check('混合结果仍在 -1~1 内', (() => {
    const loud = new Float32Array([5, -5]);
    const mixed = wav.mixToMono([loud, loud]);
    return mixed[0] <= 1 && mixed[1] >= -1;
  })());
}

/* -------------------------------------------------------------------------- */
/* 7. 重采样到 16kHz                                                            */
/* -------------------------------------------------------------------------- */

{
  // 48kHz → 16kHz：长度应该变成 1/3
  const input = sineWave(48000, 48000, 440);
  const output = wav.resampleLinear(input, 48000, 16000);
  check('48kHz → 16kHz 长度是 1/3', output.length === 16000, String(output.length));
  check('重采样结果仍是 -1~1 的波形（峰值接近 1）', (() => {
    let max = 0;
    for (const value of output) max = Math.max(max, Math.abs(value));
    return max > 0.9;
  })());

  // 44.1kHz → 16kHz：长度按比例
  const cd = sineWave(44100, 44100, 440);
  const down = wav.resampleLinear(cd, 44100, 16000);
  check('44.1kHz → 16kHz 长度按比例', down.length === Math.floor(44100 * (16000 / 44100)), String(down.length));

  // 已经是目标采样率：原样返回（长度不变）
  const same = wav.resampleLinear(input.slice(0, 100), 16000, 16000);
  check('采样率相同则长度不变', same.length === 100, String(same.length));

  // 非法输入
  check('源采样率为 0 返回空数组', wav.resampleLinear(input, 0, 16000).length === 0);
  check('目标采样率为负返回空数组', wav.resampleLinear(input, 48000, -1).length === 0);
  check('空输入返回空数组', wav.resampleLinear([], 48000, 16000).length === 0);
  check('NaN 采样率返回空数组', wav.resampleLinear(input, NaN, 16000).length === 0);

  // 恒定直流信号重采样后仍然是同一个直流值（线性插值不应该制造波动）
  const dc = new Float32Array(480).fill(0.25);
  const dcOut = wav.resampleLinear(dc, 48000, 16000);
  let dcOk = true;
  for (const value of dcOut) {
    if (Math.abs(value - 0.25) > 1e-6) dcOk = false;
  }
  check('直流信号重采样后保持不变', dcOk);
}

/* -------------------------------------------------------------------------- */
/* 8. RMS（VAD 的输入）                                                          */
/* -------------------------------------------------------------------------- */

{
  check('全 0 的 RMS 是 0', wav.computeRms(new Float32Array(100)) === 0);
  const full = new Float32Array(100).fill(1);
  check('全 1 的 RMS 是 1', Math.abs(wav.computeRms(full) - 1) < 1e-6, String(wav.computeRms(full)));
  const half = new Float32Array(100).fill(0.5);
  check('全 0.5 的 RMS 是 0.5', Math.abs(wav.computeRms(half) - 0.5) < 1e-6, String(wav.computeRms(half)));
  check('交变 ±1 的 RMS 是 1（RMS 不吃符号）', Math.abs(wav.computeRms(sineWave(1000, 16000, 100)) - Math.SQRT1_2) < 0.02);
  check('空输入 RMS 是 0', wav.computeRms([]) === 0 && wav.computeRms(null) === 0);
  check('超范围样本先夹取再算（不会算出 >1）', wav.computeRms([5, -5]) <= 1);
}

/* -------------------------------------------------------------------------- */
/* 9. 体积 / 时长上限与体积预估                                                  */
/* -------------------------------------------------------------------------- */

{
  const oneSecond = wav.estimateWavBytes(16000, 16000);
  check('1 秒 16kHz 单声道 16bit 约 32044 字节', oneSecond === 44 + 32000, String(oneSecond));

  const thirtySeconds = wav.estimateWavBytes(16000 * 30, 16000);
  check('30 秒（上限）远小于 25MB', thirtySeconds < wav.ASR_MAX_FILE_BYTES, String(thirtySeconds));

  const tooLongBytes = thirtySeconds * 100; // 约 50 分钟
  check('超过 25MB 会被判定超限', wav.exceedsAsrFileLimit(tooLongBytes) === true, String(tooLongBytes));
  check('30 秒整不超体积上限', wav.exceedsAsrFileLimit(thirtySeconds) === false);

  check('31 秒会被判定超时长', wav.checkAsrLimits(1000, 31000).ok === false && wav.checkAsrLimits(1000, 31000).reason === 'too-long');
  check('30 秒整不超时长', wav.checkAsrLimits(thirtySeconds, 30000).ok === true);
  check('超体积时 reason 是 too-large', wav.checkAsrLimits(tooLongBytes, 1000).reason === 'too-large');
  check('非数字参数不误判', wav.checkAsrLimits(NaN, NaN).ok === true);

  // 按目标采样率折算：48kHz 的 1 秒样本数也会被折算成 16kHz 的字节数
  check('传非目标采样率时按秒折算', wav.estimateWavBytes(48000, 48000) === 44 + 32000, String(wav.estimateWavBytes(48000, 48000)));
}

/* -------------------------------------------------------------------------- */
/* 10. WAV 头解析的异常输入                                                      */
/* -------------------------------------------------------------------------- */

{
  check('空数组解析失败', wav.parseWavHeader(new Uint8Array(0)).ok === false);
  check('太短解析失败', wav.parseWavHeader(new Uint8Array(20)).ok === false);
  check('null 解析失败', wav.parseWavHeader(null).ok === false);

  const good = wav.encodeWav(sineWave(100, 16000, 100), 16000);
  const brokenTag = good.slice();
  brokenTag[0] = 'X'.charCodeAt(0);
  check('RIFF 标记被改坏会解析失败', wav.parseWavHeader(brokenTag).ok === false);

  const brokenFormat = good.slice();
  new DataView(brokenFormat.buffer).setUint16(20, 3, true); // 3 = IEEE float
  check('非 PCM 格式会被拒绝', wav.parseWavHeader(brokenFormat).ok === false);

  const brokenRate = good.slice();
  new DataView(brokenRate.buffer).setUint32(24, 0, true);
  check('采样率 0 会被拒绝', wav.parseWavHeader(brokenRate).ok === false);

  const truncated = good.slice(0, 100);
  check('data 块大于实际长度会被拒绝', wav.parseWavHeader(truncated).ok === false);

  // DataView 输入也要支持（调用方可能已经建好视图）
  const view = new DataView(good.buffer, good.byteOffset, good.byteLength);
  check('接受 DataView 输入', wav.parseWavHeader(view).ok === true);
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('');
console.log('WAV / PCM 编码单元测试');
console.log('='.repeat(64));
console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('');
  for (const item of failures) {
    console.log(`[失败] ${item}`);
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
