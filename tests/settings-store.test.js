'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 设置存储单元测试（阶段 3）
 * ============================================================================
 *
 * 覆盖的安全与可靠性要求：
 *   1. Key 加解密（注入假 safeStorage）；
 *   2. **Key 不回传**：getPublicSettings() 的序列化结果里没有 Key、没有密文、
 *      也没有任何派生值；
 *   3. **环境变量优先**：ZHIPU_API_KEY 存在时压过配置文件里的 Key；
 *   4. **损坏 JSON 兜底**：坏 JSON / 错类型 / 超长文件都回落到默认值且不抛异常；
 *   5. **加密不可用时不写明文**：safeStorage 不可用时磁盘上不会出现 Key，
 *      状态变成 session-only，并且 Key 在本次会话内仍然可用；
 *   6. 原子写入（先写 .tmp 再 rename）、写盘失败只降级不崩、目录权限最小化；
 *   7. 参数校验（长度 / 控制字符 / 模型名）、显式清除 Key 的哨兵值。
 *
 * 全部依赖（fs / safeStorage / env / clock）都是注入的假实现，
 * **不读不写真实磁盘、不碰真实系统密钥环、不访问网络**。
 *
 * 用法：node tests/settings-store.test.js
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  createSettingsStore,
  resolveSafeStorage,
  parseConfigText,
  normalizeConfig,
  validateApiKey,
  validateModel,
  defaultConfig,
  hashKey,
  hasControlChar,
  CLEAR_KEY_SENTINEL,
  DEFAULT_MODEL,
  MAX_CONFIG_BYTES,
  CONFIG_VERSION
} = require(path.join(ROOT, 'main', 'settings-store.js'));

/* -------------------------------------------------------------------------- */
/* 迷你断言框架                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? `  ← ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 假 fs：完全在内存里，可注入"写入失败""重命名失败"                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {{files?: Record<string, string>, failWrite?: boolean, failRename?: boolean, failRead?: boolean, failMkdir?: boolean}} [options]
 */
function createFakeFs(options) {
  const opts = options || {};
  /** @type {Map<string, string>} */
  const files = new Map(Object.entries(opts.files || {}));
  const calls = { write: [], rename: [], mkdir: [], read: [], unlink: [] };

  return {
    files,
    calls,
    existsSync(p) {
      return files.has(p);
    },
    readFileSync(p) {
      if (opts.failRead) throw new Error('EACCES');
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync(p, data) {
      calls.write.push(p);
      if (opts.failWrite) throw new Error('EIO');
      files.set(p, data);
    },
    renameSync(from, to) {
      calls.rename.push([from, to]);
      if (opts.failRename) throw new Error('EXDEV');
      if (!files.has(from)) throw new Error('ENOENT');
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync(p) {
      calls.unlink.push(p);
      files.delete(p);
    },
    mkdirSync(p, opts2) {
      calls.mkdir.push([p, opts2]);
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 假 safeStorage：base64("enc:" + 明文)，外部无法从密文直接看出明文            */
/* -------------------------------------------------------------------------- */

/**
 * @param {{available?: boolean, failEncrypt?: boolean, failDecrypt?: boolean, backend?: string}} [options]
 */
function createFakeSafeStorage(options) {
  const opts = options || {};
  const available = opts.available !== false;
  const prefix = 'enc:';
  return {
    isEncryptionAvailable() {
      return available;
    },
    getSelectedStorageBackend() {
      return opts.backend || 'dpapi';
    },
    encryptString(text) {
      if (opts.failEncrypt) throw new Error('encrypt failed');
      return Buffer.from(prefix + String(text), 'utf8');
    },
    decryptString(buffer) {
      if (opts.failDecrypt) throw new Error('decrypt failed');
      const text = Buffer.from(buffer).toString('utf8');
      if (!text.startsWith(prefix)) throw new Error('bad payload');
      return text.slice(prefix.length);
    }
  };
}

/** 一个合法的假 Key（形如智谱的 `id.secret`） */
const FAKE_KEY = '1234567890abcdef.ABCDEFGHIJKLMNOP';

/** 固定时钟，保证 updatedAt 可预期 */
const FIXED_NOW = 1700000000000;

/**
 * 便捷构造：临时目录路径 + 假 fs + 假 safeStorage
 * @param {{fsOptions?: object, safeStorageOptions?: object, env?: object, dirPath?: string, fileName?: string}} [options]
 */
function build(options) {
  const opts = options || {};
  const dirPath = opts.dirPath || 'C:\\fake-userdata';
  const fileName = opts.fileName || 'settings.json';
  const filePath = path.join(dirPath, fileName);
  const fs = createFakeFs(opts.fsOptions);
  const safeStorage = createFakeSafeStorage(opts.safeStorageOptions);
  const store = createSettingsStore({
    safeStorage,
    fs,
    dirPath,
    filePath,
    env: opts.env || {},
    clock: () => FIXED_NOW
  });
  return { store, fs, safeStorage, filePath, dirPath };
}

/* ========================================================================== */
/* 1. 纯函数校验                                                               */
/* ========================================================================== */

console.log('设置存储单元测试（阶段 3）');

check('默认模型是 glm-4.7-flash', DEFAULT_MODEL === 'glm-4.7-flash', DEFAULT_MODEL);
check('默认配置版本是 1', CONFIG_VERSION === 1, String(CONFIG_VERSION));
check('默认配置不含任何 Key 字段内容', defaultConfig().keyEncrypted === '' && defaultConfig().keyHash === '');

check('validateApiKey 接受合法 Key', validateApiKey(FAKE_KEY).ok === true);
check('validateApiKey 接受首尾带空白的 Key（会 trim）', validateApiKey(`  ${FAKE_KEY}  `).value === FAKE_KEY);
check('validateApiKey 拒绝过短的 Key', validateApiKey('short').ok === false, JSON.stringify(validateApiKey('short')));
check('validateApiKey 拒绝非字符串', validateApiKey(12345).ok === false && validateApiKey(null).ok === false && validateApiKey(undefined).ok === false);
check('validateApiKey 拒绝含换行的 Key', validateApiKey(`abcdefgh\nijklmnop`).ok === false);
check('validateApiKey 拒绝含 NUL 的 Key', validateApiKey('abcdefgh\u0000').ok === false);
check('validateApiKey 拒绝含制表符的 Key', validateApiKey('abcdefgh\t').ok === false);
check('validateApiKey 拒绝超长 Key', validateApiKey('a'.repeat(513)).ok === false);
check('validateApiKey 边界：8 字符通过、512 字符通过', validateApiKey('a'.repeat(8)).ok === true && validateApiKey('a'.repeat(512)).ok === true);
check('hasControlChar 能识别控制字符', hasControlChar('a\nb') && hasControlChar('a\u0000b') && !hasControlChar('a b'));

check('validateModel 接受 glm-4.7-flash', validateModel('glm-4.7-flash').ok === true);
check('validateModel 拒绝空字符串 / 纯空格', validateModel('').ok === false && validateModel('   ').ok === false);
check('validateModel 拒绝带空格的模型名', validateModel('glm 4.7').ok === false);
check('validateModel 拒绝超长模型名', validateModel('m'.repeat(65)).ok === false);
check('validateModel 拒绝非字符串', validateModel({}).ok === false && validateModel(7).ok === false);

check('hashKey 是稳定的 32 位十六进制、且不等于明文', hashKey(FAKE_KEY) === hashKey(FAKE_KEY) && /^[0-9a-f]{32}$/.test(hashKey(FAKE_KEY)) && !hashKey(FAKE_KEY).includes(FAKE_KEY));

/* ========================================================================== */
/* 2. parseConfigText / normalizeConfig：损坏数据兜底                            */
/* ========================================================================== */

const corruptSamples = [
  ['空字符串', ''],
  ['纯空白', '   \n  '],
  ['坏 JSON', '{坏掉的 json'],
  ['截断 JSON', '{"version":1,"model":"glm-4.7-flash"'],
  ['JSON 数组', '[1,2,3]'],
  ['JSON 字符串', '"just a string"'],
  ['JSON null', 'null'],
  ['JSON 数字', '42']
];
for (const [label, text] of corruptSamples) {
  const parsed = parseConfigText(text);
  check(
    `parseConfigText 对「${label}」回落到默认配置`,
    parsed.config.model === DEFAULT_MODEL && parsed.config.keyEncrypted === '',
    JSON.stringify(parsed.config)
  );
}
check('parseConfigText 对空字符串不标记 corrupted（首次运行是正常状态）', parseConfigText('').corrupted === false);
check('parseConfigText 对坏 JSON 标记 corrupted', parseConfigText('{坏').corrupted === true);
check('parseConfigText 对超长文件标记 corrupted（防御超大文件）', parseConfigText(`{"pad":"${'x'.repeat(MAX_CONFIG_BYTES + 10)}"}`).corrupted === true);
check('parseConfigText 对非字符串标记为未损坏的默认值', parseConfigText(null).corrupted === false && parseConfigText(null).config.model === DEFAULT_MODEL);

const goodJson = JSON.stringify({ version: 1, model: 'glm-4.7-flash', keyEncrypted: 'AAAA', keyHash: 'abc', updatedAt: 5 });
const goodParsed = parseConfigText(goodJson);
check('parseConfigText 能读回合法配置', goodParsed.corrupted === false && goodParsed.config.model === 'glm-4.7-flash' && goodParsed.config.keyEncrypted === 'AAAA');

check(
  'normalizeConfig 丢弃非法模型名并回落默认值',
  normalizeConfig({ model: 'bad model!' }).model === DEFAULT_MODEL,
  normalizeConfig({ model: 'bad model!' }).model
);
check(
  'normalizeConfig 丢弃非 base64 形态的密文（不把任意字符串当密文）',
  normalizeConfig({ keyEncrypted: 'not base64 with spaces!' }).keyEncrypted === '',
  normalizeConfig({ keyEncrypted: 'not base64 with spaces!' }).keyEncrypted
);
check(
  'normalizeConfig 丢弃负数 / NaN 的 updatedAt',
  normalizeConfig({ updatedAt: -1 }).updatedAt === 0 && normalizeConfig({ updatedAt: 'x' }).updatedAt === 0
);

/* ========================================================================== */
/* 3. Key 加密保存 + 不回传 + 原子写入                                          */
/* ========================================================================== */

{
  const { store, fs, filePath } = build();
  check('初始状态：没有 Key、来源 none', store.getPublicSettings().hasApiKey === false && store.getPublicSettings().keySource === 'none');

  const saved = store.save({ apiKey: FAKE_KEY, model: 'glm-4.7-flash' });
  check('save 返回 ok', saved.ok === true, JSON.stringify(saved));
  check('save 后 hasApiKey 为 true', saved.settings.hasApiKey === true);
  check('save 后 keySource 为 file（配置文件）', saved.settings.keySource === 'file', saved.settings.keySource);
  check('save 后 persistence 为 encrypted', saved.settings.persistence === 'encrypted', saved.settings.persistence);
  check('save 的提示里明确说了加密保存', /safeStorage/.test(saved.message), saved.message);

  // ---- 核心安全断言：Key 不回传 ----
  const serialized = JSON.stringify(store.getPublicSettings());
  check('getPublicSettings 序列化后不含 Key 明文', !serialized.includes(FAKE_KEY), serialized.slice(0, 200));
  check('getPublicSettings 不含 Key 的任意 8 字符以上片段', !/1234567890/.test(serialized));
  check('getPublicSettings 不含密文 / 摘要字段', !serialized.includes('keyEncrypted') && !serialized.includes('keyHash'));
  check('getPublicSettings 不含 secret 部分', !serialized.includes('ABCDEFGHIJKLMNOP'));
  check(
    'getPublicSettings 的键集合是固定的非敏感集合',
    Object.keys(store.getPublicSettings()).sort().join(',') === [
      // 阶段 3 的非敏感状态字段 + 阶段 4 新增的非敏感语音字段（全部可明文回传渲染层）
      // petScale / petScaleRange：桌宠大小（2026-10-05 新增，同样非敏感）
      'configCorrupted', 'configPath', 'defaultModel', 'defaultVoice', 'endpoint', 'hasApiKey',
      'keySource', 'micEnabled', 'model', 'persistence', 'petScale', 'petScaleRange',
      'storageAvailable', 'subtitleMode',
      'ttsVoice', 'updatedAt', 'vadSensitivity', 'vadSilenceMs', 'vadSilenceRange', 'voiceDefaults',
      'voiceOptions', 'volume'
    ].sort().join(','),
    Object.keys(store.getPublicSettings()).sort().join(',')
  );
  check(
    'getPublicSettings 里的 endpoint 是只读展示字段（就是写死的那个地址）',
    store.getPublicSettings().endpoint === 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    store.getPublicSettings().endpoint
  );

  // ---- 磁盘上必须是密文 ----
  const onDisk = fs.files.get(filePath);
  check('配置文件已写入', typeof onDisk === 'string' && onDisk.length > 0);
  check('磁盘上不含 Key 明文', !onDisk.includes(FAKE_KEY), onDisk);
  check('磁盘上不含 Key 的 secret 部分', !onDisk.includes('ABCDEFGHIJKLMNOP'));
  check('磁盘上是 base64 密文（与内存密文一致）', /"keyEncrypted":\s*"[A-Za-z0-9+/=]+"/.test(onDisk));
  check('磁盘上的 keyHash 不是明文 Key', !onDisk.includes(`"keyHash": "${FAKE_KEY}"`));

  // ---- 原子写入 ----
  check('写入走"临时文件 + rename"（先写 .tmp）', fs.calls.write.length === 1 && fs.calls.write[0] === `${filePath}.tmp`, JSON.stringify(fs.calls.write));
  check('rename 的目标就是最终配置文件', fs.calls.rename.length === 1 && fs.calls.rename[0][1] === filePath, JSON.stringify(fs.calls.rename));
  check('临时文件写完就消失了（没有残留）', fs.files.has(`${filePath}.tmp`) === false);
  check('建目录时用了最小权限 0o700', fs.calls.mkdir.length >= 1 && fs.calls.mkdir[0][1] && fs.calls.mkdir[0][1].mode === 0o700, JSON.stringify(fs.calls.mkdir));

  // ---- 重新 load：能解密回来 ----
  const reloaded = store.load();
  check('重新 load 不报损坏', reloaded.corrupted === false);
  check('重新 load 后 Key 仍可用（解密成功）', store.getApiKey() === FAKE_KEY);
  check('重新 load 后 keySource 仍是 file', store.getPublicSettings().keySource === 'file');
}

/* ========================================================================== */
/* 4. 环境变量优先                                                             */
/* ========================================================================== */

{
  // 先落盘一个文件 Key，再让环境变量存在
  const { store, fs, filePath } = build();
  store.save({ apiKey: FAKE_KEY });
  check('（前置）文件 Key 已保存', store.getApiKey() === FAKE_KEY);

  const envKey = 'environment-key-abcdef123456.zzzz';
  const withEnv = build({
    env: { ZHIPU_API_KEY: envKey },
    fsOptions: { files: { [filePath]: fs.files.get(filePath) } }
  });
  check('环境变量存在时 getApiKey 返回环境变量', withEnv.store.getApiKey() === envKey, withEnv.store.getApiKey());
  check('环境变量优先时 keySource 为 env', withEnv.store.getPublicSettings().keySource === 'env');
  check('环境变量优先时 persistence 标记为 env', withEnv.store.getPublicSettings().persistence === 'env');
  check(
    '环境变量优先时返回值里也没有环境变量的值',
    !JSON.stringify(withEnv.store.getPublicSettings()).includes(envKey)
  );

  // 环境变量非法时忽略它，回落到文件里的 Key
  const badEnv = build({
    env: { ZHIPU_API_KEY: 'short' },
    fsOptions: { files: { [filePath]: fs.files.get(filePath) } }
  });
  check('非法环境变量被忽略并回落到文件 Key', badEnv.store.getApiKey() === FAKE_KEY, badEnv.store.getApiKey());
  check('非法环境变量不会让 keySource 变成 env', badEnv.store.getPublicSettings().keySource === 'file');

  // 环境变量首尾空白会被 trim
  const padEnv = build({ env: { ZHIPU_API_KEY: `  ${envKey}  ` } });
  check('环境变量首尾空白被 trim', padEnv.store.getApiKey() === envKey);

  // 环境变量存在时保存新 Key 仍然成功，但要提示"环境变量优先"
  const savedWithEnv = withEnv.store.save({ apiKey: 'another-key-1234567890.qqqq' });
  check('环境变量存在时保存仍 ok', savedWithEnv.ok === true);
  check('环境变量存在时提示说明环境变量优先', /环境变量/.test(savedWithEnv.message), savedWithEnv.message);
  check('环境变量存在时 getApiKey 依然是环境变量', withEnv.store.getApiKey() === envKey);
}

/* ========================================================================== */
/* 5. 加密不可用 → 只本次会话保存，绝不写明文                                    */
/* ========================================================================== */

{
  const { store, fs, filePath } = build({ safeStorageOptions: { available: false } });
  const info = store.getStorageInfo();
  check('safeStorage 不可用时 storageAvailable 为 false', info.available === false);
  check('safeStorage 不可用时 persistence 为 session-only', info.persistence === 'session-only');

  // 只保存 Key、不带 model 字段：加密不可用时磁盘上不该出现任何配置文件
  const noModel = build({ safeStorageOptions: { available: false } });
  const noModelSaved = noModel.store.save({ apiKey: FAKE_KEY });
  check('加密不可用且只填 Key 时：不建配置文件', noModel.fs.files.size === 0, JSON.stringify([...noModel.fs.files.keys()]));
  check('加密不可用且只填 Key 时：提示说明只保存在内存', /内存/.test(noModelSaved.message), noModelSaved.message);
  check('加密不可用且只填 Key 时：Key 本会话可用', noModel.store.getApiKey() === FAKE_KEY);

  const saved = store.save({ apiKey: FAKE_KEY, model: 'glm-4.7-flash' });
  check('加密不可用时保存仍然 ok（本次会话生效）', saved.ok === true);
  check('加密不可用时 hasApiKey 仍为 true（本会话可用）', saved.settings.hasApiKey === true);
  check('加密不可用时 keySource 为 session', saved.settings.keySource === 'session', saved.settings.keySource);
  check('加密不可用时 persistence 为 session-only', saved.settings.persistence === 'session-only');
  check('加密不可用时提示里明确说明不会明文落盘', /不会明文落盘/.test(saved.message) && /会话/.test(saved.message), saved.message);
  check('加密不可用时 Key 在内存里仍可用', store.getApiKey() === FAKE_KEY);

  const onDisk = fs.files.get(filePath);
  const diskText = typeof onDisk === 'string' ? onDisk : '';
  check('加密不可用时磁盘上绝不出现 Key 明文', !diskText.includes(FAKE_KEY), diskText);
  check('加密不可用时磁盘上不出现 secret 部分', !diskText.includes('ABCDEFGHIJKLMNOP'));
  check('加密不可用时整个文件内容里没有 Key', !JSON.stringify([...fs.files.values()]).includes(FAKE_KEY));
  check('加密不可用时仍然写了配置文件（只写模型等非敏感项）', fs.files.has(filePath) && diskText.includes('glm-4.7-flash'));
  check('加密不可用时密文字段为空字符串', /"keyEncrypted":\s*""/.test(diskText), diskText);

  // 重新 load（模拟重启）：Key 应当丢失，而不是被读成明文
  const restarted = store.load();
  check('重启（重新 load）后 Key 丢失', store.getApiKey() === '' && store.getPublicSettings().hasApiKey === false);
  check('重启后不标记配置损坏（配置本身是合法的）', restarted.corrupted === false);
}

/* ========================================================================== */
/* 6. 加密抛异常 / 解密失败 的兜底                                              */
/* ========================================================================== */

{
  const { store, fs, filePath } = build({ safeStorageOptions: { failEncrypt: true } });
  const saved = store.save({ apiKey: FAKE_KEY });
  check('encryptString 抛异常时保存不崩且 ok', saved.ok === true);
  check('encryptString 抛异常时不落盘 Key', !JSON.stringify([...fs.files.values()]).includes(FAKE_KEY));
  check('encryptString 抛异常时状态是 session-only', saved.settings.persistence === 'session-only');
}

{
  // 磁盘上有一个无法解密的密文（换了 Windows 账户 / 文件被改）
  const foreignCipher = Buffer.from('enc:' + 'someone-elses-key-1234').toString('base64');
  const { store } = build({
    fsOptions: { files: { 'C:\\fake-userdata\\settings.json': JSON.stringify({ version: 1, model: 'glm-4.7-flash', keyEncrypted: foreignCipher, keyHash: 'x', updatedAt: 1 }) } },
    safeStorageOptions: { failDecrypt: true }
  });
  check('解密失败时按"未配置 Key"处理，不崩', store.getPublicSettings().hasApiKey === false, JSON.stringify(store.getPublicSettings()));
  check('解密失败时 getApiKey 返回空字符串', store.getApiKey() === '');
  check('解密失败不影响模型名读取', store.getPublicSettings().model === 'glm-4.7-flash');
}

{
  // 密文字段是被手改过的垃圾 → 直接当没有 Key
  const { store } = build({
    fsOptions: { files: { 'C:\\fake-userdata\\settings.json': JSON.stringify({ version: 1, model: 'glm-4.7-flash', keyEncrypted: '!!!not base64!!!' }) } }
  });
  check('非法密文字段被视为未配置 Key', store.getPublicSettings().hasApiKey === false);
}

/* ========================================================================== */
/* 7. 损坏 JSON 的端到端兜底                                                    */
/* ========================================================================== */

{
  const { store, fs, filePath } = build({
    fsOptions: { files: { 'C:\\fake-userdata\\settings.json': '{这不是 JSON' } }
  });
  const settings = store.getPublicSettings();
  check('损坏 JSON：不抛异常', true);
  check('损坏 JSON：回落默认模型', settings.model === DEFAULT_MODEL, settings.model);
  check('损坏 JSON：标记 configCorrupted', settings.configCorrupted === true);
  check('损坏 JSON：视为未配置 Key', settings.hasApiKey === false);

  const afterSave = store.save({ apiKey: FAKE_KEY });
  check('损坏 JSON 后仍能正常保存', afterSave.ok === true && afterSave.settings.hasApiKey === true);
  check('损坏 JSON 修复后 configCorrupted 清除', afterSave.settings.configCorrupted === false);
  check('损坏 JSON 被覆盖成合法配置', /"keyEncrypted":\s*"[A-Za-z0-9+/=]+"/.test(fs.files.get(filePath)));
}

{
  // 文件"存在但读不了"（权限 / 被占用）≠ 首次运行，必须标记为异常
  const readFailFs = createFakeFs({ files: { 'C:\\fake-userdata\\settings.json': '{}' }, failRead: true });
  const store = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: readFailFs,
    dirPath: 'C:\\fake-userdata',
    filePath: 'C:\\fake-userdata\\settings.json',
    env: {},
    clock: () => FIXED_NOW
  });
  check('读盘抛异常时不崩、按未配置处理', store.getPublicSettings().hasApiKey === false);
  check('读盘抛异常时标记为异常状态', store.getPublicSettings().configCorrupted === true);
  check('读盘抛异常时模型回落默认值', store.getPublicSettings().model === DEFAULT_MODEL);
}

{
  // 文件不存在 = 首次运行，不算损坏
  const emptyFs = createFakeFs();
  const store = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: emptyFs,
    dirPath: 'C:\\fake-userdata',
    filePath: 'C:\\fake-userdata\\settings.json',
    env: {},
    clock: () => FIXED_NOW
  });
  check('文件不存在时不标记为损坏', store.getPublicSettings().configCorrupted === false);
}

/* ========================================================================== */
/* 8. 写盘失败的降级                                                            */
/* ========================================================================== */

{
  const { store, fs } = build({ fsOptions: { failWrite: true } });
  const saved = store.save({ apiKey: FAKE_KEY });
  check('写盘失败时 save 不抛异常', typeof saved === 'object');
  check('写盘失败时 Key 仍在本次会话可用', store.getApiKey() === FAKE_KEY);
  check('写盘失败时提示说明"仅本次会话 / 写入失败"', /写入配置文件失败/.test(saved.message), saved.message);
  check('写盘失败时磁盘上没有 Key（连 .tmp 都没有）', !JSON.stringify([...fs.files.values()]).includes(FAKE_KEY));
}

{
  const { store, fs } = build({ fsOptions: { failRename: true } });
  const saved = store.save({ apiKey: FAKE_KEY });
  check('rename 失败时也不崩', typeof saved === 'object');
  check('rename 失败时残留的 .tmp 被清理', ![...fs.files.keys()].some((p) => p.endsWith('.tmp')), JSON.stringify([...fs.files.keys()]));
  check('rename 失败时最终文件没有出现', !fs.files.has('C:\\fake-userdata\\settings.json'));
  check('rename 失败时 Key 仍在本次会话可用', store.getApiKey() === FAKE_KEY);
}

/* ========================================================================== */
/* 9. 模型名保存 / 校验失败 / 显式清除                                          */
/* ========================================================================== */

{
  const { store, fs, filePath } = build();
  store.save({ apiKey: FAKE_KEY });

  const badModel = store.save({ model: 'bad model!' });
  check('非法模型名：ok=false 且带错误码', badModel.ok === false && badModel.error === 'invalid-model', JSON.stringify(badModel));
  check('非法模型名：给出简短中文提示', /模型名/.test(badModel.message), badModel.message);
  check('非法模型名：提示里不含 Key', !badModel.message.includes(FAKE_KEY));
  check('非法模型名：原有模型没被改掉', store.getPublicSettings().model === DEFAULT_MODEL);
  check('非法模型名：磁盘上的配置没有被写坏', /"model":\s*"glm-4\.7-flash"/.test(fs.files.get(filePath)));

  const goodModel = store.save({ model: 'glm-4.6-flash' });
  check('合法模型名保存成功', goodModel.ok === true && goodModel.settings.model === 'glm-4.6-flash');
  check('模型名落盘', /"model":\s*"glm-4\.6-flash"/.test(fs.files.get(filePath)));
  check('改模型不会丢掉 Key', store.getApiKey() === FAKE_KEY);

  const badKey = store.save({ apiKey: 'short' });
  check('非法 Key：ok=false 且错误码是 invalid-api-key', badKey.ok === false && badKey.error === 'invalid-api-key', JSON.stringify(badKey));
  check('非法 Key：原有 Key 没被清掉', store.getApiKey() === FAKE_KEY);
  check('非法 Key：返回值里不包含刚输入的非法值', !JSON.stringify(badKey).includes('short'));

  const cleared = store.save({ apiKey: CLEAR_KEY_SENTINEL });
  check('清除哨兵：Key 被清掉', store.getApiKey() === '' && cleared.settings.hasApiKey === false);
  check('清除哨兵：提示说明已清除', /清除/.test(cleared.message), cleared.message);
  check('清除哨兵：磁盘上的密文被清空', /"keyEncrypted":\s*""/.test(fs.files.get(filePath)));
  check('清除哨兵：磁盘上没有 Key 残留', !JSON.stringify([...fs.files.values()]).includes('1234567890abcdef'));
}

{
  // 空字符串 = "不改动"（不是清除）
  const { store } = build();
  store.save({ apiKey: FAKE_KEY });
  const touched = store.save({ apiKey: '', model: 'glm-4.7-flash' });
  check('空字符串 API Key 表示"不改动"', touched.ok === true && store.getApiKey() === FAKE_KEY, touched.message);
}

{
  // 多余字段一律忽略
  const { store, fs, filePath } = build();
  const result = store.save({ apiKey: FAKE_KEY, url: 'https://evil.example.com', endpoint: 'http://x', hasApiKey: true, keySource: 'env' });
  check('save 忽略 url / endpoint 等非白名单字段', result.ok === true);
  const onDisk = fs.files.get(filePath);
  check('磁盘上不会出现被塞进来的 url / endpoint', !JSON.stringify(onDisk).includes('evil.example.com'));
  check('磁盘上不会出现被塞进来的 keySource', !JSON.stringify(onDisk).includes('"keySource"'));
  check('Key 仍然按加密方式落盘', /"keyEncrypted":\s*"[A-Za-z0-9+/=]+"/.test(onDisk));

  // persist:false 只能由内部调用方使用；主进程侧会强制成 true（见 main.js 的白名单清洗）
  const memoryOnly = build();
  const skipped = memoryOnly.store.save({ apiKey: FAKE_KEY, persist: false });
  check('persist:false 时 Key 只在内存、磁盘上没有配置', skipped.ok === true && memoryOnly.fs.files.size === 0);
  check('persist:false 时 Key 在本次会话内仍然可用', memoryOnly.store.getApiKey() === FAKE_KEY);
}

/* ========================================================================== */
/* 10. resolveSafeStorage 适配器                                               */
/* ========================================================================== */

{
  const none = resolveSafeStorage(undefined);
  check('resolveSafeStorage(undefined) → 不可用', none.available === false && none.encrypt('x') === null && none.decrypt('x') === null);

  const partial = resolveSafeStorage({ isEncryptionAvailable: () => true });
  check('safeStorage 缺方法时视为不可用', partial.available === false);

  const throwing = resolveSafeStorage({
    isEncryptionAvailable() {
      throw new Error('boom');
    },
    encryptString: () => Buffer.from('x'),
    decryptString: () => 'x'
  });
  check('safeStorage.isEncryptionAvailable 抛异常时视为不可用（不冒泡）', throwing.available === false);

  const fake = resolveSafeStorage(createFakeSafeStorage());
  check('resolveSafeStorage 可用时 available=true', fake.available === true);
  check('resolveSafeStorage 记录后端名', fake.source === 'dpapi', fake.source);
  const cipher = fake.encrypt('hello-key');
  check('适配器加密结果是 base64 且不是明文', typeof cipher === 'string' && !cipher.includes('hello-key') && /^[A-Za-z0-9+/=]+$/.test(cipher));
  check('适配器能解密回来', fake.decrypt(cipher) === 'hello-key');
  check('适配器解密垃圾数据返回 null（不抛异常）', fake.decrypt('!!!') === null);
}

/* ========================================================================== */
/* 11. 纯 fake 集成：完整生命周期（保存 → 重启 → 读取 → 换 Key）                  */
/* ========================================================================== */

{
  const dirPath = 'C:\\fake-userdata-2';
  const filePath = path.join(dirPath, 'settings.json');
  const disk = {};

  // 第一次运行
  const firstFs = createFakeFs();
  const first = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: firstFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW
  });
  first.save({ apiKey: FAKE_KEY, model: 'glm-4.7-flash' });
  disk.settings = firstFs.files.get(filePath);
  check('（集成）第一次运行后磁盘上有配置', typeof disk.settings === 'string');

  // 模拟重启：把同一份磁盘内容交给新的 store
  const second = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: createFakeFs({ files: { [filePath]: disk.settings } }),
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 1000
  });
  check('（集成）重启后 Key 依然可用', second.getApiKey() === FAKE_KEY);
  check('（集成）重启后模型名保持', second.getPublicSettings().model === 'glm-4.7-flash');
  check('（集成）重启后 hasApiKey 为 true', second.getPublicSettings().hasApiKey === true);

  // 换一个 Key：旧 Key 不能留在磁盘上
  const newKey = 'fedcba0987654321.ZYXWVUTSRQPONMLK';
  const secondFs = createFakeFs({ files: { [filePath]: disk.settings } });
  const third = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: secondFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 2000
  });
  third.save({ apiKey: newKey });
  check('（集成）换 Key 后 getApiKey 返回新 Key', third.getApiKey() === newKey);
  const afterRotate = secondFs.files.get(filePath);
  check('（集成）换 Key 后磁盘上没有旧 Key 明文', !afterRotate.includes(FAKE_KEY));
  check('（集成）换 Key 后磁盘上也没有新 Key 明文', !afterRotate.includes(newKey));
}

/* ========================================================================== */
/* 12. 缺陷修复 F：session-only 换 Key 不能复活磁盘上的旧密文                     */
/* ========================================================================== */

{
  const dirPath = 'C:\\fake-userdata-f1';
  const filePath = path.join(dirPath, 'settings.json');

  // 第一次运行：safeStorage 可用，旧 Key 以密文落盘
  const diskFs = createFakeFs();
  const first = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: diskFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW
  });
  first.save({ apiKey: FAKE_KEY });
  const oldCipher = JSON.parse(diskFs.files.get(filePath)).keyEncrypted;
  check('（缺陷F 前置）磁盘上确实留下了旧密文', typeof oldCipher === 'string' && oldCipher.length > 0);

  // 第二次运行：safeStorage 暂时不可用，用户换了一个新 Key -> 只能 session-only
  const sessionFs = createFakeFs({ files: { [filePath]: diskFs.files.get(filePath) } });
  const second = createSettingsStore({
    safeStorage: createFakeSafeStorage({ available: false }),
    fs: sessionFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 1
  });
  const newKey = 'fedcba0987654321.ZYXWVUTSRQPONMLK';
  const sessionSaved = second.save({ apiKey: newKey });
  check('缺陷F：换 session-only Key 后 persistence 是 session-only', sessionSaved.settings.persistence === 'session-only', sessionSaved.settings.persistence);
  check('缺陷F：新 Key 在本次会话内可用', second.getApiKey() === newKey);
  const afterDisk = sessionFs.files.get(filePath);
  check('缺陷F：旧密文被"空 keyEncrypted"覆盖清除', /"keyEncrypted":\s*""/.test(afterDisk), afterDisk);
  check('缺陷F：磁盘上不再含旧密文', !afterDisk.includes(oldCipher));
  check('缺陷F：磁盘上也没有新 Key 明文', !afterDisk.includes(newKey));
  check('缺陷F：提示明确说明旧密文已清除', /旧密文已清除/.test(sessionSaved.message), sessionSaved.message);

  // 第三次运行：safeStorage 恢复可用（模拟下次重启）-> 旧 Key 绝不能复活
  const third = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: createFakeFs({ files: { [filePath]: afterDisk } }),
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 2
  });
  check('缺陷F：重启后旧 Key 不会复活', third.getApiKey() === '' && third.getPublicSettings().hasApiKey === false, third.getApiKey());
  check('缺陷F：重启后 keySource 是 none', third.getPublicSettings().keySource === 'none');
  check('缺陷F：重启后模型等非敏感项仍在', third.getPublicSettings().model === DEFAULT_MODEL);
}

{
  // 写盘失败 + 加密不可用：必须明确提示"无法清除旧密文"
  const dirPath = 'C:\\fake-userdata-f2';
  const filePath = path.join(dirPath, 'settings.json');
  const diskFs = createFakeFs();
  const first = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: diskFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW
  });
  first.save({ apiKey: FAKE_KEY });

  const failFs = createFakeFs({ files: { [filePath]: diskFs.files.get(filePath) }, failWrite: true });
  const second = createSettingsStore({
    safeStorage: createFakeSafeStorage({ available: false }),
    fs: failFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 1
  });
  const rotated = 'another-key-1234567890.qqqq';
  const saved = second.save({ apiKey: rotated });
  check('缺陷F：写盘失败时明确提示无法清除旧密文', /无法清除磁盘上的旧密文/.test(saved.message), saved.message);
  check('缺陷F：写盘失败时 Key 仍在本次会话可用', second.getApiKey() === rotated);
  check('缺陷F：写盘失败时磁盘上仍是旧密文、没有明文回退', failFs.files.get(filePath).includes('keyEncrypted') && !failFs.files.get(filePath).includes(rotated));

  // 加密可用但 rename 失败：提示"旧加密 Key 可能仍在"
  const failRenameFs = createFakeFs({ files: { [filePath]: diskFs.files.get(filePath) }, failRename: true });
  const third = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: failRenameFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 2
  });
  const rotated2 = 'third-key-1234567890.wwww';
  const saved2 = third.save({ apiKey: rotated2 });
  check('缺陷F：加密新 Key 写盘失败时提示旧 Key 可能仍在', /可能仍保留着上一次的加密 Key/.test(saved2.message), saved2.message);
  check('缺陷F：写盘失败后没有残留 .tmp', ![...failRenameFs.files.keys()].some((p) => p.endsWith('.tmp')));
}

{
  // 清除哨兵：磁盘密文真的被抹掉，且重启后不会复活
  const dirPath = 'C:\\fake-userdata-f3';
  const filePath = path.join(dirPath, 'settings.json');
  const diskFs = createFakeFs();
  const first = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: diskFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW
  });
  first.save({ apiKey: FAKE_KEY });
  const oldCipher = JSON.parse(diskFs.files.get(filePath)).keyEncrypted;

  const clearFs = createFakeFs({ files: { [filePath]: diskFs.files.get(filePath) } });
  const second = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: clearFs,
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 1
  });
  const cleared = second.save({ apiKey: CLEAR_KEY_SENTINEL });
  check('缺陷F：清除后内存里没有 Key', second.getApiKey() === '' && cleared.settings.hasApiKey === false);
  check('缺陷F：清除后磁盘旧密文被抹掉', !clearFs.files.get(filePath).includes(oldCipher) && /"keyEncrypted":\s*""/.test(clearFs.files.get(filePath)));

  const third = createSettingsStore({
    safeStorage: createFakeSafeStorage(),
    fs: createFakeFs({ files: { [filePath]: clearFs.files.get(filePath) } }),
    dirPath,
    filePath,
    env: {},
    clock: () => FIXED_NOW + 2
  });
  check('缺陷F：清除后重启 Key 不会复活', third.getApiKey() === '' && third.getPublicSettings().hasApiKey === false);
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('='.repeat(64));
console.log(`共 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项。`);
if (failed > 0) {
  console.log('');
  console.log('失败项：');
  for (const item of failures) console.log(`  × ${item}`);
}
process.exitCode = failed === 0 ? 0 : 1;
