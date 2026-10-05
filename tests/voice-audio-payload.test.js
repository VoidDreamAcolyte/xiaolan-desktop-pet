'use strict';

/**
 * ============================================================================
 * 主进程单元测试：TTS 临时音频"读取 + 销毁"模块（main/voice-audio-payload.js）
 * ============================================================================
 *
 * 这条测试钉死"主进程生成 TTS 音频 → 受限二进制 → 删除"的安全契约：
 *
 *   1. 只允许 tempDir 的子路径：目录本身、`..` 穿越、外部路径、前缀相似的兄弟目录
 *      全部拒绝（bad-path），渲染层传什么都删不到别的文件；
 *   2. 成功时返回独立的 Uint8Array（内容逐字节一致），并且临时文件**被删除**；
 *   3. 失败也必须删除：读出错、超大、空文件、unlink 失败都走 finally；
 *   4. 超大文件在读之前按 stat 拒绝，不把超大内容读进内存；
 *   5. 临时文件不存在时返回失败对象而**不抛异常**；
 *   6. 返回对象只有错误码，绝不包含本地路径 / 目录 / 异常细节。
 *
 * 约束（与需求一致）：
 *   - 不读用户资料目录：真实文件只在 D:\BlueFatFish\work 下的隔离临时目录里创建；
 *   - 不发任何真实 HTTP，不启动 Electron / Python / edge-tts / PowerShell / SAPI。
 *
 * 用法：node tests/voice-audio-payload.test.js
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_AUDIO_BYTES,
  VOICE_AUDIO_CODES,
  createVoiceAudioPayload
} = require(path.join(__dirname, '..', 'main', 'voice-audio-payload.js'));

/* -------------------------------------------------------------------------- */
/* 迷你断言框架                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];
/** 跳过的检查（例如当前环境不允许创建符号链接），不算失败 */
const skipped = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}  ← ${detail}` : name);
}

/* -------------------------------------------------------------------------- */
/* 隔离的临时目录（只在 work 下，绝不碰用户目录）                                 */
/* -------------------------------------------------------------------------- */

const WORK_DIR = path.join(__dirname, '..', 'work');
const SANDBOX = path.join(WORK_DIR, `voice-audio-payload-${process.pid}-${Date.now()}`);
const TEMP_DIR = path.join(SANDBOX, 'temp');
const OUTSIDE_DIR = path.join(SANDBOX, 'outside');

function setupSandbox() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
}

function cleanupSandbox() {
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    // 清理失败不影响测试结论
  }
}

/** 在 tempDir 下写一个文件并返回绝对路径 */
function writeTempFile(name, bytes) {
  const file = path.join(TEMP_DIR, name);
  fs.writeFileSync(file, bytes === undefined ? Buffer.from([1, 2, 3, 4]) : bytes);
  return file;
}

/** 在 tempDir 外（outside 目录）写一个文件并返回绝对路径 */
function writeOutsideFile(name, bytes) {
  const file = path.join(OUTSIDE_DIR, name);
  fs.writeFileSync(file, bytes === undefined ? Buffer.from([9, 9, 9, 9]) : bytes);
  return file;
}

/**
 * 造一个最小可用的假 fs，用来精确模拟"读取抛异常""删除抛异常"这类真实文件系统
 * 不好稳定触发的情况。只实现本模块用到的 API。
 * @param {{throwRead?: boolean, throwUnlink?: boolean, files?: Record<string, Buffer>}} [options]
 */
function createFakeFs(options) {
  const opts = options || {};
  const files = new Map(Object.entries(opts.files || {}));
  const unlinked = [];
  return {
    files,
    unlinked,
    statSync(file) {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      const buf = files.get(file);
      return { size: buf.length, mtimeMs: 1 };
    },
    readFileSync(file) {
      if (opts.throwRead === true) throw new Error('EACCES: 内部错误细节不应外泄');
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    unlinkSync(file) {
      unlinked.push(file);
      if (opts.throwUnlink === true) throw new Error('EPERM: 删除失败细节不应外泄');
      files.delete(file);
    }
    // 注意：故意不实现 realpathSync，验证模块在缺少该能力时仍能工作
  };
}

/* -------------------------------------------------------------------------- */
/* 1. 常量与路径白名单                                                          */
/* -------------------------------------------------------------------------- */

function testConstantsAndPathGuard() {
  check('MAX_AUDIO_BYTES 是 10 MiB', MAX_AUDIO_BYTES === 10 * 1024 * 1024, String(MAX_AUDIO_BYTES));
  check(
    '错误码齐全（bad-path / read-failed / empty-audio / too-large）',
    VOICE_AUDIO_CODES.BAD_PATH === 'bad-path' &&
      VOICE_AUDIO_CODES.READ_FAILED === 'read-failed' &&
      VOICE_AUDIO_CODES.EMPTY === 'empty-audio' &&
      VOICE_AUDIO_CODES.TOO_LARGE === 'too-large'
  );

  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });

  check('tempDir 下的直接子文件：允许', reader.isInsideTempDir(path.join(TEMP_DIR, 'tts-1-1.wav')) === true);
  check('tempDir 下的更深子目录文件：允许', reader.isInsideTempDir(path.join(TEMP_DIR, 'sub', 'tts-2-2.wav')) === true);
  check('tempDir 目录本身：拒绝', reader.isInsideTempDir(TEMP_DIR) === false);
  check('tempDir + .. 穿越（回到 work）：拒绝', reader.isInsideTempDir(path.join(TEMP_DIR, '..', 'evil.wav')) === false);
  check('外部目录文件：拒绝', reader.isInsideTempDir(path.join(OUTSIDE_DIR, 'evil.wav')) === false);
  check(
    '前缀相似的兄弟目录（temp-evil）：拒绝',
    reader.isInsideTempDir(path.join(SANDBOX, 'temp-evil', 'evil.wav')) === false
  );
  check(
    '把 tempDir 当子串的绝对路径（temp/../../outside）：拒绝',
    reader.isInsideTempDir(path.join(TEMP_DIR, '..', '..', 'evil.wav')) === false
  );
  check('空字符串：拒绝', reader.isInsideTempDir('') === false);
  check('非字符串：拒绝', reader.isInsideTempDir(null) === false && reader.isInsideTempDir(123) === false);
  check('超长路径：拒绝', reader.isInsideTempDir(path.join(TEMP_DIR, 'a'.repeat(5000))) === false);

  // 反斜杠 / 正斜杠混用时也要能归一化（Windows 常见）
  check(
    '混合分隔符仍然归一化到 tempDir 内：允许',
    reader.isInsideTempDir(TEMP_DIR + '/tts-3-3.wav') === true
  );

  const noTemp = createVoiceAudioPayload({ fs, tempDir: '' });
  check('未提供 tempDir 时一律拒绝（fail-closed）', noTemp.isInsideTempDir(path.join(TEMP_DIR, 'x.wav')) === false);
}

/* -------------------------------------------------------------------------- */
/* 2. 成功读取：返回 Uint8Array 且删除文件                                      */
/* -------------------------------------------------------------------------- */

function testSuccessfulReadAndDelete() {
  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });
  const payload = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]);
  const file = writeTempFile('tts-ok.wav', payload);

  const result = reader.consume(file);
  check('成功读取返回 ok', result.ok === true, JSON.stringify(result));
  check('返回的是 Uint8Array', result.ok === true && result.bytes instanceof Uint8Array);
  check('byteLength 与文件一致', result.ok === true && result.byteLength === payload.length, String(result.byteLength));
  check(
    '字节内容逐字节一致',
    result.ok === true && Buffer.from(result.bytes).equals(payload),
    result.ok ? Buffer.from(result.bytes).toString('hex') : 'n/a'
  );
  check('成功读取后临时文件被删除', fs.existsSync(file) === false);
  check(
    '成功结果里没有本地路径 / 目录',
    result.ok === true && !JSON.stringify(result).includes(TEMP_DIR) && !JSON.stringify(result).includes('tts-ok.wav')
  );
}

/* -------------------------------------------------------------------------- */
/* 3. 失败路径也必须删除                                                        */
/* -------------------------------------------------------------------------- */

function testEmptyFileIsDeleted() {
  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });
  const file = writeTempFile('tts-empty.wav', Buffer.alloc(0));

  const result = reader.consume(file);
  check('空文件 → empty-audio', result.ok === false && result.code === 'empty-audio', JSON.stringify(result));
  check('空文件读取失败后仍被删除', fs.existsSync(file) === false);
}

function testTooLargeIsRejectedAndDeleted() {
  // 用小上限精确验证"超限"分支，避免测试里真的写 10MB
  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR, maxBytes: 64 });
  const file = writeTempFile('tts-big.wav', Buffer.alloc(65));

  const result = reader.consume(file);
  check('超过注入上限 → too-large', result.ok === false && result.code === 'too-large', JSON.stringify(result));
  check('超限文件被删除', fs.existsSync(file) === false);
}

function testDefaultLimitRejectsHugeFile() {
  // 用稀疏文件制造"10 MiB + 1 字节"，验证默认上限；stat 预检在读取前就拦住
  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });
  const file = writeTempFile('tts-huge.wav', Buffer.from([1]));
  fs.truncateSync(file, MAX_AUDIO_BYTES + 1);

  const result = reader.consume(file);
  check(
    '默认上限（10 MiB）之外 → too-large',
    result.ok === false && result.code === 'too-large',
    JSON.stringify(result)
  );
  check('超大文件被删除（没有残留在 tempDir）', fs.existsSync(file) === false);
}

function testMissingFileDoesNotThrow() {
  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });
  const missing = path.join(TEMP_DIR, 'tts-never-existed.wav');

  let result = null;
  let threw = false;
  try {
    result = reader.consume(missing);
  } catch {
    threw = true;
  }
  check('临时文件不存在时不抛异常', threw === false);
  check('临时文件不存在时返回失败对象', result && result.ok === false, JSON.stringify(result));
  check(
    '失败对象只有安全错误码',
    result && (result.code === 'read-failed' || result.code === 'bad-path'),
    result ? String(result.code) : 'null'
  );
}

function testReadErrorStillDeletesWithFakeFs() {
  const file = path.join(TEMP_DIR, 'tts-read-error.wav');
  const fakeFs = createFakeFs({ throwRead: true, files: { [file]: Buffer.from([1, 2, 3]) } });
  const reader = createVoiceAudioPayload({ fs: fakeFs, tempDir: TEMP_DIR });

  const result = reader.consume(file);
  check('读取抛异常 → read-failed', result.ok === false && result.code === 'read-failed', JSON.stringify(result));
  check('读取抛异常时仍调用 unlinkSync 删除', fakeFs.unlinked.includes(file), JSON.stringify(fakeFs.unlinked));
  check('异常细节不外泄（结果里没有 EACCES 字样）', !JSON.stringify(result).includes('EACCES'));
}

function testUnlinkFailureDoesNotThrow() {
  const file = path.join(TEMP_DIR, 'tts-unlink-fail.wav');
  const fakeFs = createFakeFs({ throwUnlink: true, files: { [file]: Buffer.from([7, 7, 7]) } });
  const reader = createVoiceAudioPayload({ fs: fakeFs, tempDir: TEMP_DIR });

  let result = null;
  let threw = false;
  try {
    result = reader.consume(file);
  } catch {
    threw = true;
  }
  check('删除失败时不抛异常', threw === false);
  check('删除失败仍返回读到的字节（best-effort 删除）', result && result.ok === true, JSON.stringify(result));
  check('确实尝试过删除', fakeFs.unlinked.includes(file));
}

/* -------------------------------------------------------------------------- */
/* 4. 外部路径在读取前就被拒绝（不删外部文件）                                   */
/* -------------------------------------------------------------------------- */

function testOutsidePathIsNotTouched() {
  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });
  const outside = writeOutsideFile('keep-me.wav', Buffer.from([1, 2, 3, 4]));

  const result = reader.consume(outside);
  check('外部路径 → bad-path', result.ok === false && result.code === 'bad-path', JSON.stringify(result));
  check('外部文件没有被删除', fs.existsSync(outside) === true);

  const traversal = reader.consume(path.join(TEMP_DIR, '..', 'outside', 'keep-me.wav'));
  check('.. 穿越 → bad-path', traversal.ok === false && traversal.code === 'bad-path', JSON.stringify(traversal));
  check('穿越目标文件仍然存在', fs.existsSync(outside) === true);

  const dirItself = reader.consume(TEMP_DIR);
  check('目录本身 → bad-path', dirItself.ok === false && dirItself.code === 'bad-path', JSON.stringify(dirItself));
  check('tempDir 目录没有被删掉', fs.existsSync(TEMP_DIR) === true);
}

/* -------------------------------------------------------------------------- */
/* 5. 符号链接逃逸（环境不支持时跳过，不算失败）                                 */
/* -------------------------------------------------------------------------- */

function testSymlinkEscape() {
  const linkPath = path.join(TEMP_DIR, 'tts-link.wav');
  const outside = writeOutsideFile('target.wav', Buffer.from([5, 5, 5]));
  try {
    fs.symlinkSync(outside, linkPath, 'file');
  } catch (error) {
    skipped.push(`当前环境无法创建符号链接，已跳过软链逃逸检查（${error.code || 'unknown'}）`);
    return;
  }

  const reader = createVoiceAudioPayload({ fs, tempDir: TEMP_DIR });
  const result = reader.consume(linkPath);
  check('tempDir 内指向外部的软链 → 拒绝', result.ok === false, JSON.stringify(result));
  check('软链指向的外部目标没有被删除', fs.existsSync(outside) === true);
  try {
    fs.unlinkSync(linkPath);
  } catch {
    // 忽略
  }
}

/* -------------------------------------------------------------------------- */
/* 运行                                                                        */
/* -------------------------------------------------------------------------- */

function main() {
  setupSandbox();
  try {
    testConstantsAndPathGuard();
    testSuccessfulReadAndDelete();
    testEmptyFileIsDeleted();
    testTooLargeIsRejectedAndDeleted();
    testDefaultLimitRejectsHugeFile();
    testMissingFileDoesNotThrow();
    testReadErrorStillDeletesWithFakeFs();
    testUnlinkFailureDoesNotThrow();
    testOutsidePathIsNotTouched();
    testSymlinkEscape();
  } finally {
    cleanupSandbox();
  }

  console.log('');
  console.log('TTS 临时音频读取/销毁单元测试');
  console.log('='.repeat(64));
  console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
  for (const item of skipped) {
    console.log(`[跳过] ${item}`);
  }
  if (failures.length > 0) {
    console.log('');
    for (const item of failures) {
      console.log(`[失败] ${item}`);
    }
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main();
