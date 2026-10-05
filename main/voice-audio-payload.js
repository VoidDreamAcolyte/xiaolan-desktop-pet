'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：TTS 临时音频的"读取并销毁"模块
 * ============================================================================
 *
 * 背景（安全集成缺陷修复）：
 *   旧实现把主进程合成的 TTS 音频**文件路径**直接返回给渲染层，渲染层再用
 *   `fetch('file:///...')` 去读，播完再通过 IPC 叫主进程删文件。这条链路有三个问题：
 *     1. 把主进程临时文件路径暴露进页面，等于泄露主机目录结构；
 *     2. 渲染层需要 fetch 本地 file URL，与 CSP `connect-src 'none'` 的设计边界冲突；
 *     3. "删文件"变成一条渲染层可调用的接口，缩小可攻击面更稳妥。
 *
 * 新契约：临时音频只在主进程内"写 → 读 → 删"，渲染层只拿到播放所需的字节。
 * 本模块只负责后半段，且**不接受任意路径**：
 *   - 路径必须严格位于指定 tempDir **子目录**内（拒绝 `..` 穿越与目录本身）；
 *   - 若文件系统支持 realpath，再做一次符号链接解析，拒绝 tempDir 内的软链逃逸；
 *   - 读取前先按 stat 大小预检，超过上限（默认 10 MiB）直接拒绝，绝不把超大文件读进内存；
 *   - 读成一份**独立的 Uint8Array 拷贝**（不持有 Buffer 池的引用）；
 *   - **无论成功 / 失败，都在 finally 里删除这个临时文件**；
 *   - 返回给调用方的只有错误码，绝不泄露本地路径或底层异常。
 *
 * 本模块通过依赖注入 fs / tempDir，可被裸 node 单元测试完整覆盖，
 * 测试既不读用户资料目录，也不启动 Electron / Python / edge-tts / PowerShell。
 */

const nodePath = require('node:path');

/** 单份 TTS 音频的硬上限：10 MiB（远超一般 24kHz wav 语音，同时防止内存放大） */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** 允许的错误码（只对渲染层暴露码，不暴露路径 / 异常） */
const VOICE_AUDIO_CODES = Object.freeze({
  OK: 'ok',
  BAD_PATH: 'bad-path',
  READ_FAILED: 'read-failed',
  EMPTY: 'empty-audio',
  TOO_LARGE: 'too-large'
});

/**
 * 生成一份统一的失败结果（只有错误码，没有 path / stack / message）。
 * @param {string} code
 * @returns {{ok: false, code: string}}
 */
function failure(code) {
  return { ok: false, code: code };
}

/**
 * 创建一个"读取并销毁 TTS 临时音频"的读取器。
 *
 * @param {{
 *   fs?: object,
 *   tempDir?: string,
 *   maxBytes?: number
 * }} [deps]
 * @returns {{
 *   consume: (file: unknown) => {ok: true, bytes: Uint8Array, byteLength: number} | {ok: false, code: string},
 *   isInsideTempDir: (file: unknown) => boolean,
 *   tempDir: string,
 *   maxBytes: number
 * }}
 */
function createVoiceAudioPayload(deps) {
  const options = deps || {};
  const fs = options.fs || require('node:fs');
  const tempDir = typeof options.tempDir === 'string' ? options.tempDir : '';
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : MAX_AUDIO_BYTES;

  /**
   * 判断一个路径是否严格位于 tempDir 子目录内。
   *
   * 两道防线：
   *   1. `path.resolve` 归一化后做前缀比较，挡掉 `..` 穿越、绝对路径、目录本身；
   *   2. 若 fs.realpathSync 可用，再解析一次符号链接，挡掉 tempDir 内软链指向外部。
   *      （文件不存在时 realpath 会抛错，此时仍返回归一化路径，让后续读取自然返回
   *       read-failed，而不是把"文件不存在"误判成"路径非法"。）
   *
   * @param {unknown} file
   * @returns {string | null} 通过校验时返回可安全读取 / 删除的绝对路径，否则 null
   */
  function resolveInsideTempDir(file) {
    if (typeof file !== 'string' || file.length === 0 || file.length > 4096) return null;
    if (tempDir.length === 0) return null;

    let resolvedFile = '';
    let resolvedDir = '';
    try {
      resolvedFile = nodePath.resolve(file);
      resolvedDir = nodePath.resolve(tempDir);
    } catch {
      return null;
    }

    // 必须是 tempDir 的**子**路径：等于 tempDir 本身也拒绝
    if (resolvedFile === resolvedDir) return null;
    if (!resolvedFile.startsWith(resolvedDir + nodePath.sep)) return null;

    // 符号链接二次校验：只在能解析出真实路径时生效
    if (fs && typeof fs.realpathSync === 'function') {
      let realDir = null;
      try {
        realDir = fs.realpathSync(resolvedDir);
      } catch {
        realDir = null;
      }
      if (realDir) {
        let realFile = null;
        try {
          realFile = fs.realpathSync(resolvedFile);
        } catch {
          realFile = null;
        }
        if (realFile) {
          if (realFile === realDir) return null;
          if (!realFile.startsWith(realDir + nodePath.sep)) return null;
        }
      }
    }

    return resolvedFile;
  }

  /**
   * 读取 tempDir 下的一个 TTS 临时音频，并**无条件删除**它。
   *
   * @param {unknown} file 主进程 tts-client 生成的产物路径
   * @returns {{ok: true, bytes: Uint8Array, byteLength: number} | {ok: false, code: string}}
   */
  function consume(file) {
    const resolved = resolveInsideTempDir(file);
    if (!resolved) return failure(VOICE_AUDIO_CODES.BAD_PATH);

    try {
      // 先看大小：拿不到 stat 就直接当作读取失败，绝不冒险读取未知大小的文件
      let size = -1;
      try {
        const stat = fs.statSync(resolved);
        size = stat && Number.isFinite(stat.size) ? stat.size : -1;
      } catch {
        return failure(VOICE_AUDIO_CODES.READ_FAILED);
      }
      if (size === 0) return failure(VOICE_AUDIO_CODES.EMPTY);
      if (size < 0) return failure(VOICE_AUDIO_CODES.READ_FAILED);
      if (size > maxBytes) return failure(VOICE_AUDIO_CODES.TOO_LARGE);

      const buffer = fs.readFileSync(resolved);
      if (!buffer || buffer.byteLength === 0) return failure(VOICE_AUDIO_CODES.EMPTY);
      // stat 与 read 之间文件可能变大：读回来再挡一次
      if (buffer.byteLength > maxBytes) return failure(VOICE_AUDIO_CODES.TOO_LARGE);

      // 复制成独立 Uint8Array：不把 Buffer 的底层内存池引用交给 IPC / 渲染层
      const bytes = new Uint8Array(buffer);
      return { ok: true, bytes: bytes, byteLength: bytes.byteLength };
    } catch {
      // 底层异常（EACCES / EISDIR / ENOENT …）一律归一化成 read-failed，绝不外泄细节
      return failure(VOICE_AUDIO_CODES.READ_FAILED);
    } finally {
      // 需求：成功 / 失败都要删掉这份临时音频（best-effort，删除失败也不抛）
      try {
        fs.unlinkSync(resolved);
      } catch {
        // 已经不存在 / 没有权限删除都不影响本次结果
      }
    }
  }

  return {
    consume: consume,
    isInsideTempDir: (file) => resolveInsideTempDir(file) !== null,
    tempDir: tempDir,
    maxBytes: maxBytes
  };
}

module.exports = {
  MAX_AUDIO_BYTES,
  VOICE_AUDIO_CODES,
  createVoiceAudioPayload
};
