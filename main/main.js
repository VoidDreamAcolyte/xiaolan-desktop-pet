'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程入口
 *   （阶段 1 骨架 + 阶段 2 鱼体与交互 + 阶段 3 安全设置与智谱云端对话 API 基础）
 * ============================================================================
 *
 * 已实现（阶段 1）：
 *   - 无边框 / 透明 / 置顶 / 不占任务栏的桌宠窗口，按屏幕可用尺寸定位（避开任务栏，多屏 DPI 自适应）
 *   - 单实例锁：第二次启动不新开窗口，而是唤出并聚焦已有窗口
 *   - 系统托盘常驻：左键唤出窗口，右键用托盘 API 弹出与桌宠窗口右键菜单一致的菜单
 *   - 关闭窗口只隐藏到托盘，不退出进程；只有菜单里的「退出」才真正结束
 *   - 左键拖拽移动窗口、双击打招呼（由渲染层上报，主进程负责移动窗口）
 *   - 鼠标穿透联动：只有光标落在鱼身上才接收鼠标事件，其余透明区域不挡桌面操作
 *   - 安全渲染：nodeIntegration=false、contextIsolation=true、sandbox=true，preload 只暴露白名单 IPC
 *   - 拦截一切外链导航与新窗口请求，渲染层无法把应用带离本地页面
 *
 * 已实现（阶段 2：鱼体和交互）：
 *   - 游动（swim）：渲染层只能"请求游动一次"，主进程自己读窗口 bounds 与所在显示器
 *     workArea，规划"游到另一侧再游回来"的轨迹并限幅，用 setInterval 驱动 setPosition。
 *     （几何计算见 main/swim-plan.js，纯函数、可直接测试）
 *   - 喂饭：菜单「喂饭」下发 FEED 事件，渲染层负责饱食度重置 + eat→happy 串场。
 *   - 状态回报联动托盘 tooltip（只读展示，不是台词）。
 *
 * 本阶段新增（阶段 3：安全设置 + 智谱云端对话 API 基础）：
 *   - **设置窗口**：独立的普通窗口（不改桌宠窗口的尺寸 / 透明 / 置顶属性），
 *     只 `loadFile` 本地 renderer/settings.html；同样的导航拦截、新窗口拒绝、
 *     权限一律拒绝；设置窗口的 preload 是 main/settings-preload.js，只暴露设置相关的
 *     3 个窄接口，没有 pet 通道，也没有任何文字聊天通道。
 *   - **Key 只在主进程处理**：环境变量 ZHIPU_API_KEY 优先；设置页录入的 Key 用
 *     Electron safeStorage 加密后写入 userData 下的 settings.json；
 *     safeStorage 不可用时只在本次会话内临时保存并明确告知（绝不退回明文）。
 *     渲染层只拿得到 hasApiKey / keySource 这类状态，拿不到 Key 本身。
 *   - **可测试的智谱 OpenAI 兼容客户端**（main/zhipu-client.js）：endpoint 写死，
 *     不接受渲染层自定义 URL；15 秒超时 + 最多一次重试（只重试网络 / 超时 / 5xx /
 *     限流类错误，401 / 参数错误不重试）；fetch 通过依赖注入，纯 Node 测试可模拟。
 *   - **测试连接**：只有用户在设置页点按钮（或后续语音回合明确调用）才会联网；
 *     启动应用、打开桌宠、打开设置页都不会自动发请求。
 *
 * 本阶段新增（阶段 4：连续语音对话闭环）：
 *   - **免按键连续语音对话**：麦克风默认开，渲染层用 getUserMedia(仅 audio，
 *     强制 echoCancellation / noiseSuppression / autoGainControl) + 纯 JS VAD
 *     自动断句，把语音段编码成 16kHz 单声道 WAV 后经窄 IPC 交给主进程识别。
 *   - **权限只开一条缝**：session 权限处理器只注册一次（session 是窗口共享的，
 *     不能按窗口各注册一次），并且只允许 petWindow 主 frame + 本地 index.html 的
 *     `audio` 权限；设置窗口、子 frame、video、display-capture 与其它权限一律拒绝。
 *     见 main/voice-permission.js。
 *   - **ASR**：云端 GLM-ASR（multipart、model=glm-asr-2512、stream=false，
 *     不手动设置 Content-Type 让 fetch 补 boundary）→ 失败降级本地 faster-whisper
 *     （仅 CPU / 仅 nvidia-smi 空闲显存 > 1.5GB，没装包/模型优雅返回 unavailable）；
 *     **无 Key 时完全不联网**，只用本地识别，且识别结果绝不发给聊天模型。
 *   - **TTS**：GLM-TTS（JSON、response_format=wav、音色可配）→ edge-tts
 *     （execFile 固定可执行文件 + argv、文本走 stdin、**绝不用 shell**）→
 *     Windows SAPI（同样 execFile powershell + 固定脚本、文本 base64 走 stdin）→
 *     渲染层 speechSynthesis 兜底（设置音量并处理 onstart/onend/onerror）。
 *     合成产物只在**主进程内**"写 → 读成受限 Uint8Array → 无条件删除"，
 *     渲染层通过 IPC 只拿到音频字节，**绝不拿到本地路径、也不使用 fetch/file URL**。
 *   - **回合管理**：用户停说 → ASR → 对话（内置鱼设 system、30 字上限）→ TTS →
 *     播放结束且 micEnabled 才重新开麦；**TTS 播放期间一定停止采集**（防回环）。
 *   - **轻量提示**：错误与麦克风状态只走鱼头顶气泡，绝不弹错误窗、不打断动画。
 *   - **启动自检**：有 Key 才发**一次**最小对话请求；缺 Key 不联网；
 *     无效 Key 时本地识别照常工作，只是不再发聊天调用。
 *   - **全局 Ctrl+Shift+V**：只做麦克风开关，注册失败（被别的程序占用）时降级提示。
 *
 * 【明确未实现】（后续阶段再做，绝不在此处伪实现）：
 *   - 唤醒词门控（阶段 5，默认关）
 *   - 游戏陪玩 / 战术思路 / 战场报点 / 屏幕采集 / 本地人形检测
 *   - 鼠标穿透开关、开机自启、桌面快捷方式与安装器
 *
 * 阶段 4 **绝不**增加屏幕采集、桌面捕获、游戏内存读取或进程注入行为；
 * 也**没有**任何自由文字聊天面板 —— 只有真实音频触发对话。
 *
 * 仅使用 Electron + Node 内置模块，不引入任何框架或额外运行时依赖。
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  dialog,
  nativeImage,
  safeStorage,
  globalShortcut
} = require('electron');

const {
  IPC_CHANNELS,
  SETTINGS_CHANNELS,
  PET_EVENTS,
  SETTINGS_EVENTS,
  PET_STATES,
  STATE_LABELS,
  MENU_IDS,
  MENU_LABELS,
  PHASE_NOTICE
} = require('./ipc-channels');
// file URL 归一化是无 Electron 依赖的纯函数，单独成模块以便烟测直接调用真实实现
const { normalizeFileUrl } = require('./file-url');
// 游动路径规划同样是纯函数模块：几何与限幅逻辑可被裸 node 单元测试直接验证
const { SWIM_STEP_MS, createSwimPlan, positionAt } = require('./swim-plan');
// 设置存储与云端客户端：都通过依赖注入隔离 Electron / 网络，可被裸 node 单元测试完整覆盖
const { createSettingsStore, CLEAR_KEY_SENTINEL, SETTINGS_ERROR_MESSAGES } = require('./settings-store');
const { createZhipuClient, CHAT_ENDPOINT, DEFAULT_TIMEOUT_MS } = require('./zhipu-client');
// 阶段 4：语音链路。云端 ASR / TTS 都只在这里被调用，API Key 绝不离开主进程。
const { createAsrClient } = require('./asr-client');
const { createTtsClient } = require('./tts-client');
// TTS 临时音频只在主进程内"读成受限二进制 + 无条件删除"，绝不把路径交给渲染层
const { createVoiceAudioPayload, MAX_AUDIO_BYTES } = require('./voice-audio-payload');
const { createNativeSpeech } = require('./native-speech');
const { createLocalTranscriber } = require('./local-whisper');
const { installVoicePermissionHandlers, decideVoicePermission } = require('./voice-permission');

/** 主窗口尺寸（逻辑像素）：只比鱼本体略大，透明区域通过鼠标穿透让给桌面 */
const WINDOW_SIZE = Object.freeze({ width: 360, height: 340 });
/** 窗口距离屏幕右下角的留白 */
const WORKAREA_MARGIN = Object.freeze({ right: 28, bottom: 12 });

/** 设置窗口尺寸（普通窗口，固定大小，可最小化但不最大化） */
const SETTINGS_WINDOW_SIZE = Object.freeze({ width: 780, height: 780 });

/** 允许加载的页面（白名单，用于导航拦截与 IPC 来源校验） */
const ENTRY_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const SETTINGS_HTML = path.join(__dirname, '..', 'renderer', 'settings.html');

/** @type {BrowserWindow | null} */
let petWindow = null;
/** @type {BrowserWindow | null} 设置窗口（同时只允许一个，重复点击只聚焦） */
let settingsWindow = null;
/** @type {Tray | null} */
let tray = null;
/** 是否正在退出（区分"关闭到托盘"与"真正退出"） */
let isQuitting = false;
/** 拖拽状态：记录窗口左上角相对光标屏幕坐标的偏移 */
let dragOffset = null;
/**
 * 当前正在进行的游动动画；null 表示没有游动。
 * 结构：{ plan, startedAt, timer }，timer 是 setInterval 句柄。
 * @type {{ plan: ReturnType<typeof createSwimPlan>, startedAt: number, timer: NodeJS.Timeout | 0 } | null}
 */
let swimAnimation = null;

/**
 * 设置存储（阶段 3）。
 * 构造即从 userData/settings.json 读一次配置；Key 在里面是加密态，明文只留在内存。
 * @type {ReturnType<typeof createSettingsStore> | null}
 */
let settingsStore = null;
/**
 * 智谱客户端（阶段 3）。fetch 用全局内置实现（Electron 主进程自带 Node 的 fetch），
 * 不引入任何第三方 SDK。
 * @type {ReturnType<typeof createZhipuClient> | null}
 */
let zhipuClient = null;

/* -------------------------------------------------------------------------- */
/* 阶段 4：语音链路的运行时状态（全部只在主进程内存里）                          */
/* -------------------------------------------------------------------------- */

/** @type {ReturnType<typeof createAsrClient> | null} */
let asrClient = null;
/** @type {ReturnType<typeof createTtsClient> | null} */
let ttsClient = null;
/**
 * TTS 临时音频的读取器（阶段 4 安全集成修复）。
 * 负责"校验路径在 tempDir 内 → 限制大小 → 读成 Uint8Array → 无条件删除"，
 * 渲染层只会通过 IPC 拿到音频字节，拿不到任何本地路径。
 * @type {ReturnType<typeof createVoiceAudioPayload> | null}
 */
let voiceAudioPayload = null;
/** @type {ReturnType<typeof createNativeSpeech> | null} */
let nativeSpeech = null;
/** @type {ReturnType<typeof createLocalTranscriber> | null} */
let localTranscriber = null;
/**
 * 最近的对话上下文（**只保留最近 6 条，只在内存里，绝不写盘、绝不进日志**）。
 * 数组元素形如 `{role: 'user'|'assistant', content: string}`。
 * @type {Array<{role: string, content: string}>}
 */
let voiceHistory = [];
/** 对话上下文最大条数（需求：只保留最近少量 history，<=6） */
const VOICE_HISTORY_MAX = 6;
/**
 * 启动时或最近一次调用得到的 API Key 有效性判断结果。
 * 'unknown'（还没测过 / 缺 Key 不测）| 'valid' | 'invalid'
 * 只存在本次会话内存里，不写盘、不回传 Key。
 * @type {'unknown'|'valid'|'invalid'}
 */
let apiKeyStatus = 'unknown';
/** 是否已经做过启动自检（保证"启动时如有 Key 只做一次最小请求"） */
let apiKeyCheckStarted = false;
/** 全局快捷键是否注册成功（失败要降级提示，不能崩溃） */
let voiceShortcutRegistered = false;
/**
 * 麦克风开关的当前状态（主进程侧只做"提示与快捷键"，
 * 真正的采集在渲染层，但两边必须保持一致，所以由主进程作为单一事实来源）。
 */
let micEnabled = true;

/* -------------------------------------------------------------------------- */
/* 单实例锁：第二次启动只唤出已有窗口                                          */
/* -------------------------------------------------------------------------- */

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // 说明：拿不到锁说明已有实例在运行。本进程直接退出，由已有实例的
  // 'second-instance' 事件负责把窗口显示出来（见下方监听）。
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二次启动：通知现有实例显示并聚焦，绝不新开窗口
    if (app.isReady()) {
      showPetWindow();
    } else {
      app.whenReady().then(() => showPetWindow());
    }
  });

  app.whenReady().then(bootstrap).catch((error) => {
    // 启动失败必须留下明确日志，不能静默变成"什么都没发生"
    console.error('[启动] 初始化失败：', error);
    app.quit();
  });
}

/* -------------------------------------------------------------------------- */
/* 启动流程                                                                    */
/* -------------------------------------------------------------------------- */

function bootstrap() {
  setupSettings();       // 先建存储与客户端，后续 IPC 才能用
  setupVoice();          // 阶段 4：ASR / TTS / 本机语音 / 本地识别（全部只在主进程）
  registerIpcHandlers();
  registerSettingsIpcHandlers();
  createPetWindow();
  setupVoicePermissions(); // 权限处理器必须在页面开始申请麦克风之前装好，且只装一次
  createTray();
  registerVoiceShortcut(); // 全局 Ctrl+Shift+V：失败只提示，不崩溃
  runStartupKeyCheck();    // 有 Key 才做一次最小有效性检查；缺 Key 绝不联网

  app.on('activate', () => {
    // macOS 习惯：点 Dock 图标重新显示（Windows 上一般不触发，保留以兼容）
    if (BrowserWindow.getAllWindows().length === 0) {
      createPetWindow();
    } else {
      showPetWindow();
    }
  });
}

/**
 * 初始化语音链路（阶段 4）。
 *
 * 只做**本地初始化**：没有任何网络请求、没有打开麦克风、没有加载任何本地模型。
 * 本地 faster-whisper 的加载被推迟到"云端识别真的失败"那一刻，
 * 而且要经过 nvidia-smi 显存检查（>1.5GB 才允许）。
 */
function setupVoice() {
  nativeSpeech = createNativeSpeech({
    fs: require('node:fs')
  });

  localTranscriber = createLocalTranscriber({
    fs: require('node:fs'),
    nativeSpeech,
    // 模型放在 userData 下：用户手动下载的模型放这里，代码**绝不自动下载**
    modelDir: path.join(app.getPath('userData'), 'whisper-models'),
    preferredModel: 'base'
  });

  asrClient = createAsrClient({
    fetchImpl: typeof fetch === 'function' ? fetch : null,
    fs: require('node:fs'),
    getApiKey: () => (settingsStore ? settingsStore.getApiKey() : ''),
    localTranscriber,
    // 需求：原始 WAV 只暂存到 app.getPath('temp') 的子目录
    tempDir: path.join(app.getPath('temp'), 'blue-fat-fish-voice')
  });

  ttsClient = createTtsClient({
    fetchImpl: typeof fetch === 'function' ? fetch : null,
    fs: require('node:fs'),
    getApiKey: () => (settingsStore ? settingsStore.getApiKey() : ''),
    getVoice: () => getPublicSettings().ttsVoice,
    // 需求：TTS 产物放 userData/temp 并清理
    tempDir: path.join(app.getPath('userData'), 'temp'),
    // edge-tts：execFile 固定可执行文件 + argv，文本走 stdin，**没有 shell**
    runEdgeTts: (text, targetFile) => nativeSpeech.runEdgeTts(text, targetFile),
    // Windows SAPI：execFile powershell + 固定脚本，文本 base64 走 stdin
    runNativeTts: (text, targetFile) => nativeSpeech.runNativeTts(text, targetFile)
  });

  // TTS 临时音频读取器：复用 ttsClient 的 tempDir，保证"写"与"读+删"落在同一个目录
  voiceAudioPayload = createVoiceAudioPayload({
    fs: require('node:fs'),
    tempDir: ttsClient.getTempDir(),
    maxBytes: MAX_AUDIO_BYTES
  });

  const micEnabledFromStore = getPublicSettings().micEnabled;
  micEnabled = micEnabledFromStore !== false;

  // 启动时清理上次异常退出可能残留的 TTS 临时产物（best-effort，不影响启动）
  try {
    const removed = ttsClient.cleanupTemp();
    if (removed > 0) console.log(`[语音] 已清理 ${removed} 个残留的临时音频文件`);
  } catch {
    // 清理失败不重要
  }
}

/**
 * 安装语音权限策略（阶段 4）。
 *
 * 关键（Electron 官方 Session 文档）：
 *   - session **是窗口共享的**，不能在每个 BrowserWindow 上各注册一次（会互相覆盖）；
 *   - 要完整处理权限必须**同时**设置 request 与 check 两个 handler；
 *   - 所以这里只在默认 session 上装一次，具体放行与否交给纯函数
 *     `decideVoicePermission`（只允许 petWindow 的主 frame + 本地 index.html 的 audio）。
 */
function setupVoicePermissions() {
  const defaultSession = petWindow && !petWindow.isDestroyed() ? petWindow.webContents.session : null;
  if (!defaultSession) return;

  const result = installVoicePermissionHandlers({
    session: defaultSession,
    isPetWebContents: (id) => Boolean(petWindow && !petWindow.isDestroyed() && id === petWindow.webContents.id),
    matchesEntryUrl: (url) => isLocalEntryUrl(url),
    isMainFrameOf: (id, frame) => {
      if (!petWindow || petWindow.isDestroyed() || id !== petWindow.webContents.id) return false;
      try {
        const mainFrame = petWindow.webContents.mainFrame;
        return frame === mainFrame || (frame && frame.frameTreeNodeId === mainFrame.frameTreeNodeId);
      } catch {
        return false;
      }
    }
  });

  if (!result.installed) {
    // 装不上就保持"全部拒绝"的保守姿态（绝不放行任何权限）
    console.warn('[安全] 语音权限策略未能安装，将继续拒绝所有权限申请。');
  } else {
    console.log('[语音] 权限策略已安装：只允许桌宠窗口主 frame 的麦克风（audio）');
  }
}

/**
 * 注册全局快捷键 Ctrl+Shift+V（麦克风开关）。
 *
 * 需求：快捷键被其它程序占用时**要降级提示而不能崩溃**。
 * globalShortcut.register 在失败时返回 false（不抛异常），这里据此分支：
 *   - 成功：正常用；
 *   - 失败：打日志 + 在鱼头顶给一条轻量气泡（菜单里仍然可以开关麦克风）。
 */
function registerVoiceShortcut() {
  try {
    voiceShortcutRegistered = globalShortcut.register('Ctrl+Shift+V', () => {
      toggleMicFromMain('shortcut');
    });
  } catch (error) {
    voiceShortcutRegistered = false;
    console.warn('[语音] 注册全局快捷键失败：', error && error.message ? error.message : 'unknown');
  }

  if (!voiceShortcutRegistered) {
    console.warn('[语音] Ctrl+Shift+V 已被其它程序占用，麦克风开关请用右键菜单「语音对话」');
    // 等窗口加载完再提示，避免气泡在页面就绪前丢失
    setTimeout(() => {
      sendToPet(PET_EVENTS.VOICE_BUBBLE, {
        text: PHASE_NOTICE.SHORTCUT_TAKEN,
        kind: 'warn',
        caption: false
      });
    }, 1200);
  }
}

/**
 * 读取麦克风开关的当前运行时状态（**同步返回，不需要 IPC**）。
 * 渲染层启动时用它初始化；之后的变化通过 VOICE_SETTINGS / VOICE_TOGGLE_MIC 事件推送。
 * 只暴露一个布尔值，没有任何其它信息。
 * @returns {boolean}
 */
function isMicEnabled() {
  return micEnabled === true;
}

/**
 * 启动时做一次**最小的 API Key 有效性检查**（需求第 10 条）。
 *
 * 约束：
 *   - **只在有 Key 时才发**这一次请求，缺 Key 时完全不联网；
 *   - 只发一次（`apiKeyCheckStarted` 守卫），复用已有 chat 客户端的 15 秒超时 + 一次重试；
 *   - **不录音内容**：请求体只是一句固定的「你好」；
 *   - 结果只存本次会话的内存标记；失败（网络错误）不影响桌宠动画，
 *     无效 Key 只是让"识别结果不发聊天"并给一条轻提示。
 */
function runStartupKeyCheck() {
  if (apiKeyCheckStarted) return;
  apiKeyCheckStarted = true;

  const settings = getPublicSettings();
  if (!settings.hasApiKey) {
    apiKeyStatus = 'unknown';
    return;
  }
  if (!zhipuClient) return;

  Promise.resolve()
    .then(() => zhipuClient.chat('你好', {}))
    .then((result) => {
      if (result && result.ok === true) {
        apiKeyStatus = 'valid';
        console.log('[语音] 启动自检：API Key 可用（只发了一次最小请求，没有录音内容）');
        return;
      }
      const code = result && result.code ? result.code : 'unknown';
      if (code === 'auth-failed' || code === 'invalid-key' || code === 'forbidden') {
        apiKeyStatus = 'invalid';
        console.warn('[语音] 启动自检：API Key 无效或已过期（本地语音识别仍然可用）');
        notifyPetBubble('我还没大脑，去 open.bigmodel.cn 领个 Key 呀', 'warn');
      } else {
        // 网络类错误：不代表 Key 无效，保持 unknown，绝不打扰用户
        apiKeyStatus = 'unknown';
        console.warn('[语音] 启动自检没连上（网络问题，不代表 Key 无效）：', code);
      }
    })
    .catch(() => {
      apiKeyStatus = 'unknown';
    });
}

/**
 * 往鱼头顶发一条轻量气泡（只在渲染层显示，不弹窗、不阻塞动画）。
 * @param {string} text
 * @param {'info'|'warn'|'error'} kind
 */
function notifyPetBubble(text, kind) {
  if (typeof text !== 'string' || text.length === 0) return;
  sendToPet(PET_EVENTS.VOICE_BUBBLE, {
    text: text.slice(0, 200),
    kind: kind || 'info',
    caption: false
  });
}

/**
 * 初始化设置存储与智谱客户端（阶段 3）。
 *
 * 只做本地初始化：**这里不发任何网络请求**。启动阶段不校验 Key，
 * 避免没配置 Key 的机器一开机就被打扰（Key 有效性检查留到后续语音对话阶段）。
 */
function setupSettings() {
  settingsStore = createSettingsStore({
    safeStorage,
    fs: require('node:fs'),
    dirPath: app.getPath('userData'),
    filePath: path.join(app.getPath('userData'), 'settings.json'),
    env: process.env,
    clock: () => Date.now()
  });

  const storage = settingsStore.getStorageInfo();
  // 只打印"是否可用 / 后端名"，不打印任何 Key 内容
  console.log(
    `[设置] 配置文件：${settingsStore.getConfigPath()}（safeStorage 可用=${storage.available}，后端=${storage.backend}）`
  );

  zhipuClient = createZhipuClient({
    // Electron 主进程里的全局 fetch（Node 内置），注入进来让测试可以完全模拟
    fetchImpl: typeof fetch === 'function' ? fetch : null,
    getApiKey: () => (settingsStore ? settingsStore.getApiKey() : ''),
    // 传函数而不是字符串：设置页改了模型名之后下一次请求就生效，不用重建客户端
    model: () => getPublicSettings().model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: 1
  });
}

/* -------------------------------------------------------------------------- */
/* 窗口创建与定位                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 桌宠窗口当前应有的尺寸：基准尺寸 × 用户设置的缩放倍率（petScale，0.5~2）。
 * 页面里的 SVG 用 viewBox 等比绘制，窗口变大内容就整体放大，无需改渲染层。
 * @param {number} [scale] 缩放倍率；缺省读当前设置
 * @returns {{width: number, height: number}}
 */
function getPetWindowSize(scale) {
  const s = typeof scale === 'number' && Number.isFinite(scale) ? scale : getPublicSettings().petScale;
  const clamped = Math.min(2, Math.max(0.5, s));
  return {
    width: Math.round(WINDOW_SIZE.width * clamped),
    height: Math.round(WINDOW_SIZE.height * clamped)
  };
}

/**
 * 按屏幕可用区域（已扣除任务栏）计算初始位置：贴右下角。
 * 用 workArea 而不是屏幕整体尺寸，保证不会被任务栏盖住；多屏 / 缩放场景下
 * 使用鼠标所在屏幕，符合"桌宠出现在用户正在用的那块屏"的直觉。
 * @returns {{x: number, y: number}}
 */
function computeInitialPosition() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const size = getPetWindowSize();

  const x = area.x + area.width - size.width - WORKAREA_MARGIN.right;
  const y = area.y + area.height - size.height - WORKAREA_MARGIN.bottom;

  // 兜底：屏幕异常小的时候也要保证窗口在可见区域内
  return {
    x: Math.max(area.x, x),
    y: Math.max(area.y, y)
  };
}

function createPetWindow() {
  const { x, y } = computeInitialPosition();
  const petSize = getPetWindowSize();

  petWindow = new BrowserWindow({
    width: petSize.width,
    height: petSize.height,
    x,
    y,
    // 无边框 + 透明背景：只有鱼本体悬浮在桌面上
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 始终置顶，并且不出现在任务栏 / Alt+Tab 列表里
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '小蓝',
    // 渲染层安全配置：禁用 Node 集成、启用上下文隔离、启用沙箱
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // 本阶段不加载任何远程内容，仅本地页面
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 阶段 1 不需要背景节流相关特性，保持默认即可
      backgroundThrottling: true
    }
  });

  // 置顶层级用 screen-saver，避免被普通置顶窗口（如播放器）压住
  petWindow.setAlwaysOnTop(true, 'screen-saver');

  hardenWebContents(petWindow.webContents, ENTRY_HTML);

  petWindow.loadFile(ENTRY_HTML);

  // 页面就绪后再显示，避免出现白/黑闪烁（透明窗口尤其明显）
  petWindow.once('ready-to-show', () => {
    showPetWindow();
  });

  petWindow.on('close', (event) => {
    // 关闭窗体只收进托盘，不退出进程；真正退出走托盘/右键菜单的「退出」
    if (!isQuitting) {
      event.preventDefault();
      cancelSwim('window-hidden');
      petWindow.hide();
      // 复位到待机：渲染层会忽略"睡觉中的 idle 复位"，不会把睡着的鱼吵醒
      sendAction('idle');
    }
  });

  // 窗口被隐藏（收进托盘）时停止游动并复位位置，避免在隐藏状态下继续移动
  petWindow.on('hide', () => {
    cancelSwim('window-hidden');
  });

  petWindow.on('closed', () => {
    cancelSwim('window-closed');
    petWindow = null;
  });

  return petWindow;
}

/**
 * 创建设置窗口（阶段 3）。
 *
 * 安全与结构要点：
 *   - **普通窗口**：有边框、可调整大小以外的一切照旧；**不改桌宠窗口的**尺寸 / 透明 /
 *     置顶 / 跳任务栏属性，两套窗口彼此独立；
 *   - 同样是 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，
 *     preload 换成 settings-preload.js（只暴露设置相关通道）；
 *   - 只 `loadFile(SETTINGS_HTML)`，并做和桌宠窗口一样的导航拦截 / 新窗口拒绝 /
 *     权限拒绝（设置窗口不需要任何系统权限）；
 *   - 同时只允许一个设置窗口：重复点菜单只聚焦已有窗口。
 */
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WINDOW_SIZE.width,
    height: SETTINGS_WINDOW_SIZE.height,
    minWidth: 640,
    minHeight: 560,
    // 普通窗口：有边框、可以缩放、出现在任务栏里
    frame: true,
    transparent: false,
    backgroundColor: '#f4f9fd',
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    show: false,
    title: '小蓝 · 设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      allowRunningInsecureContent: false,
      webviewTag: false,
      // 显式关掉"由 Chromium 直接开新窗口"，只认我们自己的 setWindowOpenHandler
      nativeWindowOpen: false
    }
  });

  // 设置窗口不需要菜单栏（文件/编辑那些默认项在这里没有意义）
  settingsWindow.setMenuBarVisibility(false);

  hardenWebContents(settingsWindow.webContents, SETTINGS_HTML);

  settingsWindow.loadFile(SETTINGS_HTML);

  settingsWindow.once('ready-to-show', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

/**
 * 打开设置窗口（菜单「设置」）。
 * 说明：**只打开窗口，不做任何网络请求、不读 Key 明文到界面**。
 */
function openSettingsWindow() {
  return createSettingsWindow();
}

/**
 * 加固 webContents：拦截外链导航、新窗口、与 webview 附加。
 * 桌宠窗口与设置窗口都只需要渲染本地页面，任何"走出去"的行为都直接拒绝。
 *
 * 关于权限（阶段 4 的重要变化）：
 *   **这里不再注册任何权限处理器**。原因是 Electron 的 session 是窗口共享的，
 *   在这里按窗口注册会互相覆盖（设置窗口最后创建就会把桌宠窗口的策略顶掉）。
 *   权限统一由 `setupVoicePermissions()` 在默认 session 上**只注册一次**，
 *   具体策略见 main/voice-permission.js（只允许 petWindow 主 frame 的 audio）。
 * @param {Electron.WebContents} webContents
 * @param {string} allowedHtml 这个窗口唯一允许停留的本地页面
 */
function hardenWebContents(webContents, allowedHtml) {
  // 1) 拦截页面内导航：只允许停留在自己的本地页面
  webContents.on('will-navigate', (event, url) => {
    if (!isLocalUrlFor(url, allowedHtml)) {
      event.preventDefault();
      console.warn('[安全] 已拦截导航请求：', url);
    }
  });

  // 2) 拦截新窗口（window.open / target=_blank）：一律不开，交给系统浏览器也不允许
  webContents.setWindowOpenHandler(({ url }) => {
    console.warn('[安全] 已拦截新窗口请求：', url);
    return { action: 'deny' };
  });

  // 3) 拒绝 webview 附加（本应用根本不需要 webview）
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/**
 * 判断 URL 是否等于某个允许加载的本地页面（兼容 file:// 的 URL 编码差异）。
 * 具体归一化规则见 main/file-url.js（纯函数模块，烟测会直接调用它做可执行检查）。
 * @param {string} url
 * @param {string} allowedHtml 允许的本地 HTML 绝对路径
 * @returns {boolean}
 */
function isLocalUrlFor(url, allowedHtml) {
  const actual = normalizeFileUrl(url);
  if (!actual) return false;
  try {
    return actual === normalizeFileUrl(pathToFileURL(allowedHtml).href);
  } catch {
    return false;
  }
}

/**
 * 判断 URL 是否是我们允许的桌宠本地入口页面。
 * @param {string} url
 * @returns {boolean}
 */
function isLocalEntryUrl(url) {
  return isLocalUrlFor(url, ENTRY_HTML);
}

/**
 * 判断 URL 是否是我们允许的本地设置页面。
 * @param {string} url
 * @returns {boolean}
 */
function isLocalSettingsUrl(url) {
  return isLocalUrlFor(url, SETTINGS_HTML);
}

/* -------------------------------------------------------------------------- */
/* 显示 / 隐藏                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 显示并聚焦桌宠窗口。
 * @param {{announce?: boolean}} [options] announce 传 false 时不额外下发 greet，
 *   用于「睡觉」这类"先唤出窗口再切动作"的场景，避免 greet 与目标动作抢动画。
 */
function showPetWindow(options) {
  const announce = !options || options.announce !== false;

  if (!petWindow || petWindow.isDestroyed()) {
    // 窗口被意外销毁时补建一个，保证托盘左键始终有效
    createPetWindow();
    return;
  }
  if (!petWindow.isVisible()) {
    petWindow.show();
  }
  if (petWindow.isMinimized()) {
    petWindow.restore();
  }
  petWindow.setAlwaysOnTop(true, 'screen-saver');
  // 唤出时重置鼠标穿透为"穿透"状态，由渲染层按光标位置重新决定，
  // 避免用户上次拖拽到一半时状态残留导致点不到鱼。
  setIgnoreMouseEvents(true);
  petWindow.focus();
  if (announce) {
    sendAction('greet');
  }
}

/**
 * 向渲染层发送一条消息；页面尚未加载完时等加载完成再补发。
 * 首次启动时窗口可能已 show 但页面里的事件监听还没注册（ready-to-show 早于
 * 脚本执行完毕），此时直接 send 会丢消息，所以这里统一做"等加载"处理。
 * @param {string} channel 必须是 PET_EVENTS 里登记过的通道
 * @param {unknown} [payload]
 */
function sendToPet(channel, payload) {
  if (!petWindow || petWindow.isDestroyed()) return;

  const webContents = petWindow.webContents;
  if (webContents.isLoading()) {
    webContents.once('did-finish-load', () => {
      // 再让出一轮事件循环，确保渲染层脚本已完成监听注册
      setTimeout(() => {
        if (petWindow && !petWindow.isDestroyed()) {
          petWindow.webContents.send(channel, payload);
        }
      }, 30);
    });
    return;
  }

  webContents.send(channel, payload);
}

/**
 * 向设置窗口发送一条消息（页面没加载完就等加载完再发）。
 * @param {string} channel 必须是 SETTINGS_EVENTS 里登记过的通道
 * @param {unknown} [payload]
 */
function sendToSettings(channel, payload) {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;

  const webContents = settingsWindow.webContents;
  if (webContents.isLoading()) {
    webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send(channel, payload);
        }
      }, 30);
    });
    return;
  }

  webContents.send(channel, payload);
}

/**
 * 下发一个动作状态。
 * @param {string} state 必须是 PET_STATES 白名单里的状态
 * @param {{durationMs?: number}} [options] 可选时长覆盖（游动等由主进程决定时长的动作）
 */
function sendAction(state, options) {
  if (!PET_STATES.includes(state)) {
    console.warn('[状态] 拒绝下发未登记的动作状态：', state);
    return;
  }
  const payload = { state };
  if (options && Number.isFinite(options.durationMs)) {
    payload.durationMs = Math.round(options.durationMs);
  }
  if (options && typeof options.flavor === 'string' && options.flavor) {
    // flavor：同一名动作的变体台词标记（如 taunt + zako = 杂鱼嘲讽）
    payload.flavor = options.flavor;
  }
  sendToPet(PET_EVENTS.ACTION, payload);
}

/**
 * 下发「喂饭」事件：渲染层负责把饱食度重置到 100，并串起 eat → happy。
 * 与 sendAction('eat') 分开，是因为喂饭还带着"重置饱食度"的业务语义。
 */
function sendFeed() {
  sendToPet(PET_EVENTS.FEED);
}

/**
 * 开关鼠标穿透。
 * forward: true 让渲染层仍能收到 mousemove，从而判断光标是否回到鱼身上。
 * @param {boolean} ignore
 */
function setIgnoreMouseEvents(ignore) {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  }
}

/* -------------------------------------------------------------------------- */
/* 跑动（原 swim 游动）：主进程独占的窗口移动动画                                */
/* -------------------------------------------------------------------------- */

/**
 * 请求跑动一次：从当前所在显示器工作区的一侧快跑到另一侧附近，再跑回原处。
 *
 * 安全边界（重要）：
 *   - 渲染层不传任何坐标，目标位置完全由主进程按"窗口当前 bounds + 所在显示器
 *     workArea"计算（main/swim-plan.js 纯函数），并逐帧再次限幅；
 *   - 窗口不在可用工作区里（被拖到屏幕外）时先把起点拉回工作区内；
 *   - 窗口隐藏 / 被销毁 / 正在被拖拽时直接拒绝，不启动动画。
 *
 * @returns {{ok: boolean, reason?: string, durationMs?: number, direction?: 'left'|'right'}}
 */
function requestSwim() {
  if (!petWindow || petWindow.isDestroyed()) return { ok: false, reason: 'no-window' };
  if (!petWindow.isVisible()) return { ok: false, reason: 'hidden' };
  if (dragOffset) return { ok: false, reason: 'dragging' };

  const bounds = petWindow.getBounds();
  // 用 getDisplayMatching 而不是光标位置：不需要读取光标，也不会把宠物算到别的屏幕上
  const display = screen.getDisplayMatching(bounds);
  const plan = createSwimPlan(bounds, display.workArea);
  if (!plan) return { ok: false, reason: 'bad-geometry' };

  // 已有跑动先干净收尾（复位到它自己的起点），再开始新的一次
  cancelSwim('restart');

  // 起点可能因用户拖拽落在工作区外：先归位，避免"从屏幕外跑回来"
  if (bounds.x !== plan.originX || bounds.y !== plan.originY) {
    petWindow.setPosition(plan.originX, plan.originY);
  }

  swimAnimation = { plan, startedAt: Date.now(), timer: 0 };
  swimAnimation.timer = setInterval(stepSwim, SWIM_STEP_MS);
  stepSwim();

  console.log(`[跑步] 开始：向${plan.direction === 'right' ? '右' : '左'}，时长 ${plan.durationMs}ms`);
  return { ok: true, durationMs: plan.durationMs, direction: plan.direction };
}

/** 游动动画的一帧：按经过时间算出窗口位置并套用 */
function stepSwim() {
  if (!swimAnimation) return;
  try {
    if (!petWindow || petWindow.isDestroyed()) {
      cancelSwim('window-gone');
      return;
    }
    const elapsed = Date.now() - swimAnimation.startedAt;
    if (elapsed >= swimAnimation.plan.durationMs) {
      finishSwim();
      return;
    }
    const point = positionAt(swimAnimation.plan, elapsed);
    if (point) {
      petWindow.setPosition(point.x, point.y);
    }
  } catch (error) {
    // 任何异常都必须停下并复位，绝不让定时器继续跑
    console.error('[游动] 动画异常：', error);
    cancelSwim('error');
  }
}

/** 游动正常结束：清理定时器，并把窗口放回起点（轨迹终点本就是起点，这里再兜一次） */
function finishSwim() {
  if (!swimAnimation) return;
  const { plan } = swimAnimation;
  clearSwimTimer();
  swimAnimation = null;
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setPosition(plan.originX, plan.originY);
  }
  console.log('[跑步] 结束，已复位到起点');
}

/**
 * 取消游动：清理定时器并复位到本次游动的起点（同样经过 workArea 限幅）。
 * 触发场景：窗口隐藏 / 窗口销毁 / 应用退出 / 开始拖拽 / 新的游动请求 / 动画异常。
 * @param {string} reason 仅用于日志
 */
function cancelSwim(reason) {
  if (!swimAnimation) return;
  const { plan } = swimAnimation;
  clearSwimTimer();
  swimAnimation = null;
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.setPosition(plan.originX, plan.originY);
  }
  if (reason !== 'restart') {
    console.log('[游动] 已取消：', reason);
  }
}

/** 只清理定时器，不动位置 */
function clearSwimTimer() {
  if (swimAnimation && swimAnimation.timer) {
    clearInterval(swimAnimation.timer);
    swimAnimation.timer = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* 托盘与菜单                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 生成一个极简的占位托盘图标（深海蓝色块），仅在正式图标缺失时使用。
 * 注意：Tray 构造函数不接受空图像，所以这里必须给一张真实可用的图。
 * @returns {Electron.NativeImage}
 */
function createPlaceholderTrayIcon() {
  const size = 32;
  const canvas = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    canvas[i * 4] = 0x0d; // R
    canvas[i * 4 + 1] = 0x4a; // G
    canvas[i * 4 + 2] = 0x78; // B
    canvas[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    // 兜底：图标文件缺失时用占位图标，保证托盘与菜单功能仍然可用
    // （正式图标由 tools/make-icons.js 生成，见 README）
    console.warn('[托盘] 未找到 assets/tray-icon.png，使用占位图标。可运行 npm run icons 生成。');
    image = createPlaceholderTrayIcon();
  }

  tray = new Tray(image);
  tray.setToolTip('小蓝 · 桌宠（连续语音对话）');
  // 左键单击：唤出桌宠（Windows 上 click 即左键）
  tray.on('click', () => showPetWindow());
  // 右键：用 Tray 自身的弹出 API，并复用同一份菜单模板。
  // 为什么不用 Menu.popup({ window: petWindow })：窗口可能已经被收进托盘（隐藏）
  // 甚至被销毁，把一个隐藏窗口当作 owner 传进去会让菜单弹不出来或定位异常。
  // tray.popUpContextMenu 由托盘负责弹出，窗口隐藏时依然稳定可用。
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));

  // 注：这里不调用 tray.setContextMenu，是为了让左键与右键行为可控，
  // 同时保证右键弹出的菜单与窗口右键菜单是同一份模板。
}

/**
 * 基于共用模板构建一个菜单对象（托盘右键 + 窗口右键共用，行为完全一致）。
 * @returns {Electron.Menu}
 */
function buildMenu() {
  return Menu.buildFromTemplate(buildMenuTemplate());
}

/**
 * 构建菜单模板（托盘右键 + 窗口右键共用，行为完全一致）。
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildMenuTemplate() {
  return [
    {
      id: MENU_IDS.FEED,
      label: MENU_LABELS.FEED,
      click: () => {
        // 先唤出窗口（用 announce:false 跳过 greet，避免打招呼和吃饭抢动画），
        // 再下发喂饭事件：渲染层把饱食度重置到 100，播 eat 约 3 秒后转 happy。
        showPetWindow({ announce: false });
        sendFeed();
      }
    },
    {
      id: MENU_IDS.SLEEP,
      label: MENU_LABELS.SLEEP,
      click: () => {
        // 窗口可能已经被收进托盘：必须先唤出再切 sleep，
        // 否则睡觉动画发生在隐藏窗口里，用户从托盘点「睡觉」什么也看不到。
        // 用 announce:false 跳过 greet，避免打招呼和睡觉两个动作抢动画。
        showPetWindow({ announce: false });
        sendAction('sleep');
      }
    },
    {
      id: MENU_IDS.WAKE,
      label: MENU_LABELS.WAKE,
      click: () => {
        showPetWindow();
        sendAction('wake');
      }
    },
    { type: 'separator' },
    {
      id: MENU_IDS.TAUNT,
      label: MENU_LABELS.TAUNT,
      click: () => {
        // 「看游戏输了」：唤出窗口 + 下发 taunt 动作（zako 变体 → 杂鱼台词）
        showPetWindow({ announce: false });
        sendAction('taunt', { flavor: 'zako' });
      }
    },
    {
      id: MENU_IDS.CHAT,
      label: MENU_LABELS.CHAT,
      // 阶段 4：菜单「语音对话」= **麦克风开关**（不再弹说明框）。
      // 连续语音对话默认免按键：开着麦直接说话就会自动断句、识别、回复、播报；
      // 这个菜单项与全局 Ctrl+Shift+V 都只是"想安静时关掉 / 再打开"的备用方式。
      click: () => toggleMicFromMain('menu')
    },
    {
      id: MENU_IDS.SETTINGS,
      label: MENU_LABELS.SETTINGS,
      // 阶段 3：「设置」是真功能 —— 打开独立的本地设置窗口（不联网、不发请求）
      click: () => openSettingsWindow()
    },
    { type: 'separator' },
    {
      id: MENU_IDS.QUIT,
      label: MENU_LABELS.QUIT,
      click: () => quitApp()
    }
  ];
}

/**
 * 窗口（鱼身）右键菜单：与托盘右键共用同一份模板，但走 Menu.popup。
 * 注意：这里**不传 x/y** —— 官方 Menu.popup 在省略坐标时默认在当前鼠标指针位置弹出。
 * 之前把截图用的"光标屏幕坐标"直接当作窗口坐标传进 menu.popup，
 * 两者坐标系不同，菜单会弹到错误的位置；去掉冗余坐标后菜单会落在光标附近。
 *
 * 只给可见的 petWindow 传 owner：该方法仅由渲染层 IPC（SHOW_CONTEXT_MENU）触发，
 * 此刻窗口必然是可见的。托盘右键不走这里（见 createTray，用 tray.popUpContextMenu）。
 */
function popupMenu() {
  const menu = buildMenu();
  const options = {};
  if (petWindow && !petWindow.isDestroyed()) {
    options.window = petWindow;
  }
  menu.popup(options);
}

/**
 * 打开 / 关闭麦克风（菜单「语音对话」与全局 Ctrl+Shift+V 共用）。
 *
 * 主进程是麦克风开关的"单一事实来源"（全局快捷键可能在窗口隐藏时被按下）。
 * 但**这次开关只是本次会话的临时选择，不写回设置文件** ——
 * 需求里"默认开"指的是启动时的默认值；用户想永久关掉请去设置页关。
 * 真正的采集在渲染层，所以这里：
 *   1. 翻转主进程记录的状态；
 *   2. 给渲染层下发 TOGGLE_MIC（渲染层据此 start / stop 采集）；
 *   3. 气泡文案由渲染层的回合管理器统一给（避免两处文案漂移）。
 *
 * @param {'menu'|'shortcut'} source 仅用于日志
 */
function toggleMicFromMain(source) {
  const next = micEnabled !== true;
  micEnabled = next;
  sendToPet(PET_EVENTS.VOICE_TOGGLE_MIC, { micEnabled: next });
  console.log(`[语音] 麦克风已${next ? '打开' : '关闭'}（${source}）`);
  return next;
}

/**
 * 「语音对话」菜单的说明：阶段 4 起「语音对话」是实功能（麦克风开关）。
 *
 * 这条提示只保留给"确实还没做的能力"（陪玩 / 报应等后续阶段），
 * 由 PHASE_NOTICE.CHAT 提供文案；它**不会**打开麦克风、也不会发送任何用户内容。
 * 保留该函数是为了让"后续阶段说明"这条路径继续存在（烟测会检查它）。
 */
function showVoicePhaseNotice() {
  const options = {
    type: 'info',
    title: '小蓝',
    message: PHASE_NOTICE.CHAT_DIALOG_TITLE,
    detail: PHASE_NOTICE.CHAT,
    buttons: ['去设置里配置 Key', '知道了'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };

  const owner = petWindow && !petWindow.isDestroyed() ? petWindow : null;
  const promise = owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  Promise.resolve(promise)
    .then((result) => {
      if (result && result.response === 0) {
        openSettingsWindow();
      }
    })
    .catch(() => {
      // 对话框异常不影响桌宠本体
    });
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

/* -------------------------------------------------------------------------- */
/* IPC 来源校验                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 通用的"主 frame + 本地页面"校验。
 *
 * @param {Electron.IpcMainInvokeEvent} event
 * @param {() => Electron.BrowserWindow | null} getWindow 取目标窗口
 * @param {(url: string) => boolean} isAllowedUrl 该窗口唯一允许的本地页面判定
 * @returns {boolean}
 */
function isTrustedMainFrame(event, getWindow, isAllowedUrl) {
  try {
    const target = getWindow();
    if (!target || target.isDestroyed()) return false;
    if (!event || !event.sender) return false;

    const webContents = target.webContents;
    // 用 id 比较，避免不同包装对象导致误判
    if (event.sender.id !== webContents.id) return false;

    const senderFrame = event.senderFrame;
    if (!senderFrame) return false;

    // 必须是主 frame：既比较对象本身，也比较 frameTreeNodeId（兼容包装对象不同一）
    const mainFrame = webContents.mainFrame;
    const isMainFrame =
      senderFrame === mainFrame ||
      (typeof senderFrame.frameTreeNodeId === 'number' &&
        senderFrame.frameTreeNodeId === mainFrame.frameTreeNodeId);
    if (!isMainFrame) return false;

    return isAllowedUrl(senderFrame.url);
  } catch (error) {
    console.warn('[安全] IPC 来源校验异常：', error);
    return false;
  }
}

/**
 * IPC 来源校验（桌宠窗口）：只接受"当前 petWindow 的主 frame"发来的调用，
 * 且 frame URL 必须是本地入口页面（ENTRY_HTML）。iframe / 被导航到别处的页面 /
 * 已销毁窗口 / 设置窗口发来的消息一律拒绝。
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function isTrustedSender(event) {
  return isTrustedMainFrame(event, () => petWindow, isLocalEntryUrl);
}

/**
 * IPC 来源校验（设置窗口，阶段 3）：只接受"当前 settingsWindow 的主 frame"发来的调用，
 * 且 frame URL 必须是本地设置页面（SETTINGS_HTML）。
 *
 * 为什么单独一条：设置通道能读写配置、能触发云端请求，比桌宠通道更敏感；
 * 两者用不同的窗口 + 不同的 URL 判定，任何一侧被注入都拿不到另一侧的能力。
 * @param {Electron.IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function isTrustedSettingsSender(event) {
  return isTrustedMainFrame(event, () => settingsWindow, isLocalSettingsUrl);
}

/**
 * 注册一个带"来源校验 + 异常兜底"的 IPC handler：
 *   - 来源不合法：直接返回 false，绝不执行任何操作；
 *   - handler 内部抛错：记录日志并返回 false，异常绝不冒泡到主进程事件循环。
 *
 * 注意：**整个项目里只有两个 `ipcMain.handle` 调用点**，就是下面这两个包装函数
 * （桌宠窗口一个、设置窗口一个）。任何新通道都必须经其中之一注册，
 * 烟测会静态断言这一点，避免有人绕过来源校验直接注册 handler。
 *
 * @param {string} channel
 * @param {(event: Electron.IpcMainInvokeEvent) => boolean} verify 来源校验函数
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown} handler
 */
function handleFromPetWindow(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    try {
      if (!isTrustedSender(event)) {
        console.warn('[安全] 已拒绝来源不可信的 IPC 调用：', channel);
        return false;
      }
      const result = handler(event, ...args);
      return result === undefined ? true : result;
    } catch (error) {
      console.error(`[IPC] 处理 ${channel} 时发生异常：`, error);
      return false;
    }
  });
}

/**
 * 设置窗口版本的包装（来源校验换成 isTrustedSettingsSender，其余完全一致）。
 * @param {string} channel
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown} handler
 */
function handleFromSettingsWindow(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    try {
      if (!isTrustedSettingsSender(event)) {
        console.warn('[安全] 已拒绝来源不可信的设置 IPC 调用：', channel);
        return false;
      }
      const result = handler(event, ...args);
      return result === undefined ? true : result;
    } catch (error) {
      console.error(`[IPC] 处理设置通道 ${channel} 时发生异常：`, error);
      return false;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* IPC 处理（桌宠窗口，与 main/preload.js 暴露的白名单一一对应）                 */
/* -------------------------------------------------------------------------- */

function registerIpcHandlers() {
  // 开始拖拽：渲染层给出"指针相对窗口左上角"的偏移，后续按屏幕坐标移动
  handleFromPetWindow(IPC_CHANNELS.DRAG_START, (_event, offset) => {
    if (!petWindow || petWindow.isDestroyed()) return false;
    const dx = Number(offset && offset.dx);
    const dy = Number(offset && offset.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    // 用户开始拖拽时立刻停止游动，避免"自动动画"和"手动拖拽"同时抢窗口位置
    cancelSwim('dragging');
    dragOffset = { dx, dy };
    // 拖拽期间必须接收真实鼠标事件，否则指针移出窗口就丢事件
    setIgnoreMouseEvents(false);
    return true;
  });

  // 拖拽移动：把光标屏幕坐标换算成窗口左上角坐标
  handleFromPetWindow(IPC_CHANNELS.DRAG_MOVE, (_event, point) => {
    if (!petWindow || petWindow.isDestroyed() || !dragOffset) return false;
    const px = Number(point && point.x);
    const py = Number(point && point.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
    petWindow.setPosition(Math.round(px - dragOffset.dx), Math.round(py - dragOffset.dy));
    return true;
  });

  // 结束拖拽
  handleFromPetWindow(IPC_CHANNELS.DRAG_END, () => {
    dragOffset = null;
    setIgnoreMouseEvents(true);
    return true;
  });

  // 右键菜单：在光标处弹出与托盘一致的菜单（坐标交给 Electron 默认处理）
  handleFromPetWindow(IPC_CHANNELS.SHOW_CONTEXT_MENU, () => {
    popupMenu();
    return true;
  });

  // 鼠标穿透联动：渲染层判断光标是否在鱼身上
  handleFromPetWindow(IPC_CHANNELS.SET_IGNORE_MOUSE_EVENTS, (_event, ignore) => {
    setIgnoreMouseEvents(Boolean(ignore));
    return true;
  });

  /*
   * 游动请求：刻意不接收任何参数。
   * 目标位置、限幅、时长全部由主进程 requestSwim() 内部计算，渲染层即使被注入
   * 恶意脚本也无法指定屏幕坐标；返回 { ok, durationMs, direction } 供渲染层
   * 决定 play 多久的 swim 动画。
   */
  handleFromPetWindow(IPC_CHANNELS.SWIM_REQUEST, () => requestSwim());

  // 渲染层状态回报（只读用途：托盘 tooltip 展示当前动作）。
  //
  // 安全联动（阶段 2 修复）：requestSwim() 会先在主进程启动 6 秒窗口动画，
  // 渲染层随后才请求 swim 并回报 'swim'。如果游动期间动作被用户打断
  // （poke / pet / sleep …），状态机会切走并在下一次回报里给出非 swim 状态；
  // 此时主进程若不收手，就会继续 setInterval 移动窗体，而渲染层已经没有 swim
  // 动画 —— 鱼会"无人驾驶"地滑过屏幕。所以在白名单校验通过后：
  //   state === 'swim' → 启动报告，绝不能自取消；
  //   state !== 'swim' → 有游动动画就按起点复位并清理定时器。
  // 注意：这里只接收一个状态字符串，绝不接收任何坐标（坐标仍由主进程自算）。
  handleFromPetWindow(IPC_CHANNELS.REPORT_STATE, (_event, state) => {
    if (typeof state === 'string' && PET_STATES.includes(state)) {
      console.log('[状态] 渲染层当前状态：', state);
      updateTrayTooltip(state);
      if (state !== 'swim' && swimAnimation) {
        cancelSwim('state-changed');
      }
    }
    return true;
  });

  /*
   * 阶段 3：桌宠窗口只读地问"现在有没有可用的 Key"。
   * 返回值只有布尔状态与来源标记 —— **没有 Key、也没有任何派生值**；
   * 阶段 3 桌宠渲染层**不会主动调用它**（启动密钥检查留到后续语音对话阶段），
   * 这里先把只读接口留好，保证桌宠窗口永远拿不到"读设置 / 改设置 / 发对话"的能力。
   */
  handleFromPetWindow(IPC_CHANNELS.REPORT_SETTINGS_STATE, () => {
    const settings = getPublicSettings();
    // 只回状态位：有没有 Key / Key 从哪来 / 启动自检结论 / 能不能真的聊天。
    // **没有 Key、没有密文、没有任何派生值，也绝不回传转录或回复内容。**
    return {
      hasApiKey: settings.hasApiKey,
      keySource: settings.keySource,
      apiKeyStatus,
      chatAvailable: settings.hasApiKey && apiKeyStatus !== 'invalid',
      micEnabled: isMicEnabled()
    };
  });

  /*
   * 阶段 4：连续语音对话的三条窄接口。
   *
   * 全部经 handleFromPetWindow 包装 —— 只接受"当前 petWindow 的主 frame +
   * 本地 index.html"的调用；设置窗口的 preload 里没有这些通道，注入脚本也拿不到。
   *
   * 注意：**没有"删除临时文件"通道**。TTS 临时音频的读取与删除都在主进程内完成
   * （见 handleVoiceSpeak / voice-audio-payload.js），渲染层拿不到路径，也就没有
   * 可被滥用来删任意文件的接口。
   */
  handleFromPetWindow(IPC_CHANNELS.VOICE_TRANSCRIBE, (_event, payload) => handleVoiceTranscribe(payload));
  handleFromPetWindow(IPC_CHANNELS.VOICE_CHAT, (_event, payload) => handleVoiceChat(payload));
  handleFromPetWindow(IPC_CHANNELS.VOICE_SPEAK, (_event, payload) => handleVoiceSpeak(payload));
}

/* -------------------------------------------------------------------------- */
/* IPC 处理（阶段 4：语音链路，全部只在 petWindow 主 frame 下可用）              */
/* -------------------------------------------------------------------------- */

/**
 * 识别一段语音（渲染层已经把它编码成 16kHz 单声道 WAV）。
 *
 * 安全与需求要点：
 *   - 只接受 Uint8Array，别的类型直接拒绝（不做隐式转换）；
 *   - 体积 / 时长预检由 asr-client 负责（>25MB 或 >30s 直接拒绝，绝不发出去）；
 *   - **无 Key 时 asr-client 完全不联网**，只尝试本地 faster-whisper，
 *     返回的 `chat:false` 会阻止上层把识别结果发给聊天模型；
 *   - 返回给渲染层的只有识别文本与短错误码，**没有 Key、没有云端响应体**。
 *
 * @param {{bytes?: unknown, durationMs?: number, format?: string}} [payload]
 */
async function handleVoiceTranscribe(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  if (!asrClient) return { ok: false, code: 'internal-error', chat: getPublicSettings().hasApiKey };

  let bytes = null;
  if (input.bytes instanceof Uint8Array) {
    bytes = input.bytes;
  } else if (input.bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(input.bytes);
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(input.bytes)) {
    bytes = new Uint8Array(input.bytes);
  }
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, code: 'no-audio', chat: getPublicSettings().hasApiKey };
  }

  const durationMs = Number(input.durationMs);
  const result = await asrClient.transcribe(bytes, {
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    // 只认 wav；webm 之类的格式绝不直接上传（需求明令禁止）
    format: typeof input.format === 'string' ? input.format : 'wav'
  });

  // 识别失败但确实是"Key 无效"时，顺手把会话内标记更新掉（下次不再发聊天）
  if (!result.ok && (result.code === 'auth-failed' || result.code === 'forbidden')) {
    apiKeyStatus = 'invalid';
  }
  return result;
}

/**
 * 把识别文本发给云端对话（已有 zhipu-client：内置鱼设 system + 30 字上限）。
 *
 * **没有 Key 时这里直接返回 no-api-key，绝不联网**（需求第 5 / 10 条）。
 * 历史只在内存里保留最近 6 条，不写盘、不记录日志。
 *
 * @param {{text?: string, history?: unknown}} [payload]
 */
async function handleVoiceChat(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length === 0 || text.length > 1000) {
    return { ok: false, code: 'bad-request', message: '这条内容没法发出去。' };
  }

  const settings = getPublicSettings();
  if (!settings.hasApiKey) {
    // 需求：无 Key 时本地识别结果绝不发聊天 API
    return { ok: false, code: 'no-api-key', message: '还没有配置 API Key。' };
  }
  if (apiKeyStatus === 'invalid') {
    return { ok: false, code: 'auth-failed', message: 'API Key 无效或已过期。' };
  }
  if (!zhipuClient) {
    return { ok: false, code: 'internal-error', message: '云端客户端还没就绪。' };
  }

  // 历史：优先用渲染层给的（已裁剪），否则用主进程自己维护的最近 6 条
  const history = Array.isArray(input.history) && input.history.length > 0
    ? input.history
    : voiceHistory;

  const result = await zhipuClient.chat(text, { history });
  if (result && result.ok === true) {
    apiKeyStatus = 'valid';
    // 只保留最近 VOICE_HISTORY_MAX 条（<=6），只在内存里
    voiceHistory = voiceHistory
      .concat([{ role: 'user', content: text }, { role: 'assistant', content: result.content }])
      .slice(-VOICE_HISTORY_MAX);
    return { ok: true, text: result.content, model: result.model, attempts: result.attempts };
  }

  const code = result && result.code ? result.code : 'internal-error';
  if (code === 'auth-failed' || code === 'forbidden') apiKeyStatus = 'invalid';
  return {
    ok: false,
    code,
    message: (result && result.message) || '云端对话失败。',
    attempts: result && result.attempts
  };
}

/**
 * 合成一段语音（GLM-TTS → edge-tts → SAPI → 渲染层 speechSynthesis）。
 *
 * 安全集成（修复）：合成产物是主进程 `userData/temp` 下的临时 wav。
 *   - 主进程读取成受限二进制后**无条件删除**临时文件（见 voice-audio-payload.js），
 *     **绝不把 file / path 返回给渲染层**；
 *   - 成功时只返回 `{ok:true, provider, audioBytes, text}`，
 *     `audioBytes` 是可直接播放的 Uint8Array（结构化克隆，不做 base64 膨胀）；
 *   - 空文本 / 合成失败 / 读取失败 / 过大 / 序列化异常都统一走
 *     `fallback:'speechSynthesis'`，由渲染层本机语音播报 ——
 *     绝不白屏、绝不抛异常、绝不静默只显示文字。
 *
 * @param {{text?: string}} [payload]
 */
async function handleVoiceSpeak(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length === 0) {
    return { ok: false, code: 'empty-text', fallback: 'speechSynthesis' };
  }
  if (!ttsClient) {
    return { ok: false, code: 'internal-error', fallback: 'speechSynthesis', text };
  }

  const result = await ttsClient.synthesize(text, { allowFallback: true });
  if (!result || result.ok !== true) {
    // 合成失败：只回安全错误码 + 兜底标记；文本回带一次，方便渲染层播同一段内容
    return {
      ok: false,
      code: (result && result.code) || 'internal-error',
      message: result && result.message,
      fallback: 'speechSynthesis',
      text
    };
  }

  // 合成成功：读取器负责"校验路径 → 限制大小 → 读成 Uint8Array → 无论成败都删除文件"
  if (!voiceAudioPayload) {
    // 读取器缺失时也必须清掉临时文件，不能把路径回传渲染层
    if (typeof ttsClient.removeTemp === 'function') ttsClient.removeTemp(result.file);
    return { ok: false, code: 'internal-error', fallback: 'speechSynthesis', text };
  }

  const audio = voiceAudioPayload.consume(result.file);
  if (!audio.ok) {
    // 读取 / 超限 / 空音频：consume 的 finally 已删除临时文件。
    // 极端情况下路径没通过白名单校验（正常不会发生，因为 result.file 由主进程
    // tts-client 自己生成），这里对这条主进程自产路径再兜一次 best-effort 删除，
    // 确保"绝不残留临时音频"，同时依然不把任何路径回传渲染层。
    if (typeof result.file === 'string' && typeof ttsClient.removeTemp === 'function') {
      ttsClient.removeTemp(result.file);
    }
    return {
      ok: false,
      code: audio.code || 'read-failed',
      fallback: 'speechSynthesis',
      text
    };
  }

  // 只返回播放所需的最小字段：绝不含 file / path / 本地目录
  return {
    ok: true,
    provider: typeof result.provider === 'string' ? result.provider : 'glm-tts',
    audioBytes: audio.bytes,
    text
  };
}

/**
 * 取当前非敏感设置快照（存储未就绪时给一个安全的空壳，绝不抛异常）。
 * @returns {object}
 */
function getPublicSettings() {
  if (!settingsStore) {
    return {
      model: 'glm-4.7-flash',
      defaultModel: 'glm-4.7-flash',
      hasApiKey: false,
      keySource: 'none',
      persistence: 'none',
      storageAvailable: false,
      configPath: '',
      configCorrupted: false,
      updatedAt: 0,
      // 阶段 4 语音设置的安全默认值（存储未就绪时也绝不抛异常）
      micEnabled: true,
      vadSensitivity: 0.5,
      vadSilenceMs: 800,
      ttsVoice: 'tongtong',
      volume: 0.8,
      subtitleMode: false,
      voiceOptions: ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'],
      defaultVoice: 'tongtong',
      vadSilenceRange: { min: 400, max: 1500 }
    };
  }
  return settingsStore.getPublicSettings();
}

/**
 * 广播设置变更到设置窗口（只发非敏感字段）。
 */
function broadcastSettingsChanged() {
  const settings = getPublicSettings();
  const payload = {
    model: settings.model,
    hasApiKey: settings.hasApiKey,
    keySource: settings.keySource,
    persistence: settings.persistence
  };
  sendToSettings(SETTINGS_EVENTS.CHANGED, payload);
}

/**
 * 广播语音设置变更到**桌宠窗口**（阶段 4）。
 *
 * 只发语音白名单字段：麦克风开关 / VAD 灵敏度 / 静音毫秒 / GLM-TTS 音色 / 音量 /
 * 字幕模式。**没有任何 Key、没有路径、没有音频数据。**
 */
function broadcastVoiceSettingsChanged() {
  const settings = getPublicSettings();
  sendToPet(PET_EVENTS.VOICE_SETTINGS, {
    micEnabled: settings.micEnabled,
    vadSensitivity: settings.vadSensitivity,
    vadSilenceMs: settings.vadSilenceMs,
    ttsVoice: settings.ttsVoice,
    volume: settings.volume,
    subtitleMode: settings.subtitleMode
  });
  micEnabled = settings.micEnabled !== false;
}

/**
 * 把"临时草稿 Key"从 IPC 参数里取出来并归类（可选）。
 *
 * 语义与 preload 侧完全一致，是第二道防线：
 *   - 字段缺失 / 空字符串 / 纯空白 → `{kind:'absent'}`：本次请求用已保存的 Key；
 *   - 非空但不合法（长度不对 / 控制字符 / 哨兵）→ `{kind:'invalid'}`：
 *     调用方必须**直接报错，绝不回落到已保存的 Key / 环境变量**
 *     （否则"测试连接"测的是另一个 Key，属于误测）；
 *   - 合法 → `{kind:'valid', value}`。
 *
 * 草稿 Key 只用于本次请求，绝不写盘、绝不写日志、也绝不出现在返回值里。
 * @param {unknown} payload
 * @returns {{kind: 'absent'|'invalid'|'valid', value?: string}}
 */
function pickDraftKey(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'absent' };
  if (!Object.prototype.hasOwnProperty.call(payload, 'apiKey')) return { kind: 'absent' };
  const raw = payload.apiKey;
  if (typeof raw !== 'string' || raw.trim().length === 0) return { kind: 'absent' };
  // 哨兵只对"保存 / 清除"有意义，不能拿去测连接
  if (raw === CLEAR_KEY_SENTINEL) return { kind: 'invalid' };
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return { kind: 'invalid' };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 512) return { kind: 'invalid' };
  return { kind: 'valid', value: trimmed };
}

/**
 * 在"已保存的 Key"之外，允许本次请求临时用一个草稿 Key。
 * @param {string} draftKey
 * @returns {ReturnType<typeof createZhipuClient> | null}
 */
function makeClientForRequest(draftKey) {
  if (!zhipuClient) return null;
  if (!draftKey) return zhipuClient;
  // 只覆盖 getApiKey，其它（endpoint / 模型 / 超时 / 重试）完全不变
  return createZhipuClient({
    fetchImpl: typeof fetch === 'function' ? fetch : null,
    getApiKey: () => draftKey,
    model: () => getPublicSettings().model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: 1
  });
}

function registerSettingsIpcHandlers() {
  // 读取非敏感设置：没有 Key、没有密文、没有任何派生值
  handleFromSettingsWindow(SETTINGS_CHANNELS.GET_SETTINGS, () => getPublicSettings());

  /*
   * 保存设置。
   * 参数是白名单式的：只认 apiKey / model 两个字段，其余全部丢弃；
   * 类型 / 长度 / 字符集都在 settings-store 里再校验一次（双层防御）。
   * 返回值里只有非敏感快照与一句中文提示 —— 绝不含 Key。
   */
  handleFromSettingsWindow(SETTINGS_CHANNELS.SAVE_SETTINGS, (_event, patch) => {
    if (!settingsStore) {
      return { ok: false, settings: getPublicSettings(), error: 'not-ready', message: '设置存储还没就绪。' };
    }

    const input = patch && typeof patch === 'object' ? patch : {};
    const sanitized = {};
    if (Object.prototype.hasOwnProperty.call(input, 'model')) sanitized.model = input.model;
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) sanitized.apiKey = input.apiKey;
    // persist 只允许主进程自己决定，不接受渲染层传 false 来"跳过落盘"
    sanitized.persist = true;

    const result = settingsStore.save(sanitized);

    // 模型名变了要让客户端跟上（客户端每次请求都会读最新模型）
    if (result.ok) {
      broadcastSettingsChanged();
      console.log('[设置] 已更新：模型=', result.settings.model, '来源=', result.settings.keySource);
    }
    return result;
  });

  /*
   * 测试连接：**只有用户点「测试连接」才会走到这里**。
   * 发一次最小对话请求（约 1 个 token 的输入），验证 Key / 模型 / 网络是否可用。
   * 无论成功失败都只回一段简短中文信息：
   *   - 成功时只有 ok / model / latencyMs，**绝不返回模型生成的正文**
   *     （阶段边界：没有可见文字聊天面板，也不把文本冒充语音）；
   *   - 失败时只有安全错误码 + 固定中文短语，绝不回显上游响应体或 Key；
   *   - 草稿 Key 非空但不合法时直接失败，不回落、不联网。
   */
  handleFromSettingsWindow(SETTINGS_CHANNELS.TEST_CONNECTION, async (_event, payload) => {
    const draft = pickDraftKey(payload);
    if (draft.kind === 'invalid') {
      return {
        ok: false,
        code: 'invalid-api-key',
        message: SETTINGS_ERROR_MESSAGES['invalid-api-key'],
        model: '',
        latencyMs: 0
      };
    }

    const client = makeClientForRequest(draft.kind === 'valid' ? draft.value : '');
    if (!client) {
      return { ok: false, code: 'internal-error', message: '云端客户端还没就绪。', model: '', latencyMs: 0 };
    }

    const startedAt = Date.now();
    const model = client.getModel();
    const result = await client.chat('你好', {});
    const latencyMs = Date.now() - startedAt;

    if (result.ok) {
      // 注意：**不带 result.content** —— UI 只显示"连接成功/失败"，不显示生成文本
      return { ok: true, code: 'ok', message: '连接成功。', model: result.model, latencyMs };
    }
    return { ok: false, code: result.code, message: result.message, model, latencyMs, attempts: result.attempts };
  });

  /*
   * 阶段 4：只改语音设置（麦克风开关 / VAD 灵敏度 / 静音毫秒 / GLM-TTS 音色 / 音量 / 字幕模式）。
   *
   * 与 SAVE_SETTINGS 分开的两条理由：
   *   1. **完全不碰 Key**：这里只透传语音白名单字段，连 apiKey 都不会出现在入参里；
   *   2. 语音设置改完必须同时通知桌宠窗口（它才是真正开麦 / 播放的一方）。
   * 非法值由 settings-store 明确报错（不会静默回落，避免"看起来改成功了"）。
   */
  handleFromSettingsWindow(SETTINGS_CHANNELS.SET_VOICE_SETTINGS, (_event, patch) => {
    if (!settingsStore) {
      return { ok: false, settings: null, error: 'not-ready', message: '设置存储还没就绪。' };
    }
    const input = patch && typeof patch === 'object' ? patch : {};
    const sanitized = {};
    const allowedVoiceKeys = ['micEnabled', 'vadSensitivity', 'vadSilenceMs', 'ttsVoice', 'volume', 'subtitleMode', 'petScale'];
    for (const key of allowedVoiceKeys) {
      if (Object.prototype.hasOwnProperty.call(input, key)) sanitized[key] = input[key];
    }
    // persist 只允许主进程决定，不接受渲染层传 false 来"跳过落盘"
    sanitized.persist = true;

    const result = settingsStore.save(sanitized);
    if (result.ok) {
      // 大小变了立刻调整桌宠窗口（SVG viewBox 等比缩放，内容自动跟上）
      applyPetScale(getPublicSettings().petScale);
      broadcastVoiceSettingsChanged();
      broadcastSettingsChanged();
      console.log('[语音] 设置已更新：麦克风=', getPublicSettings().micEnabled, '静音=', getPublicSettings().vadSilenceMs, 'ms');
    }
    return result;
  });
}

/**
 * 应用桌宠大小设置：调整桌宠窗口尺寸并夹回所在屏幕工作区。
 * 游动计划里缓存的是旧窗口尺寸下的坐标，缩放前先取消进行中的游动。
 * @param {number} scale 缩放倍率（0.5~2）
 */
function applyPetScale(scale) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const size = getPetWindowSize(scale);
  const bounds = petWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const area = display.workArea;
  // 左上角为锚点缩放，再把整窗夹回工作区（不飘出屏幕、不被任务栏挡住）
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - size.width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - size.height);
  cancelSwim('pet-scale-changed');
  petWindow.setBounds({ x, y, width: size.width, height: size.height });
}

/**
 * 用当前状态刷新托盘提示（纯只读联动，不显示任何台词气泡）。
 * @param {string} state
 */
function updateTrayTooltip(state) {
  if (!tray || tray.isDestroyed()) return;
  const label = STATE_LABELS[state] || state;
  tray.setToolTip(`小蓝 · ${label}`);
}

/* -------------------------------------------------------------------------- */
/* 进程级兜底：窗口全关也不退出（托盘常驻由用户显式退出）                        */
/* -------------------------------------------------------------------------- */

app.on('window-all-closed', () => {
  // Windows 上关掉窗口不应结束进程，桌宠要留在托盘里。
  // 真正的退出只由 quitApp() 触发，这里不再调用 app.quit()。
});

app.on('before-quit', () => {
  isQuitting = true;
  // 退出前必须停掉游动定时器，避免进程退出时残留 setInterval
  cancelSwim('app-quit');

  /*
   * 阶段 4 清理（需求：退出时清掉麦克风、音频、临时文件与定时器）：
   *   - 注销全局快捷键（不注销会残留到下一次启动）；
   *   - 让渲染层停掉 MediaStream / AudioContext（它跟随窗口关闭自然结束，
   *     这里再补一条显式停止采集的指令，保证"窗口还活着但已退出"的中间态也断采）；
   *   - 清掉临时音频目录里的产物（成功 / 失败都删）；
   *   - 清空内存里的对话历史（不写盘）。
   */
  try {
    if (voiceShortcutRegistered) {
      globalShortcut.unregister('Ctrl+Shift+V');
      voiceShortcutRegistered = false;
    }
    globalShortcut.unregisterAll();
  } catch {
    // 注销失败不影响退出
  }

  sendToPet(PET_EVENTS.VOICE_TOGGLE_MIC, { micEnabled: false, shutdown: true });

  try {
    if (ttsClient) ttsClient.cleanupTemp();
  } catch {
    // 清理失败不重要
  }

  // 对话历史只在内存里，退出即丢弃（这里显式清空，避免被任何残留引用持有）
  voiceHistory = [];
});
