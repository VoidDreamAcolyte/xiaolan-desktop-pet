'use strict';

/**
 * 主进程与渲染进程共用的常量表（白名单式设计）。
 *
 * 设计原则：
 * 1. IPC 通道名集中在这里定义，主进程与 preload 都只引用本表，避免散落字符串写错。
 * 2. 通道是"白名单"：preload 只允许调用这里列出的 invoke 通道，
 *    渲染层无法凭借任意字符串去碰主进程的其它能力。
 * 3. 动作状态与菜单文案也集中在这里：preload 内部保留一份同步副本（沙箱下无法
 *    require 本地模块），一致性由 tests/smoke.test.js 逐项比对，漂移即失败。
 *
 * 阶段范围：
 *   - 阶段 1：窗口 / 托盘 / 菜单 / 拖拽 / 基础状态。
 *   - 阶段 2：完整动作状态机、饱食度、摸头 / 拖拽 / 游动等交互。
 *   - 阶段 3：**设置窗口 + 安全配置存储 + 智谱云端对话 API 基础**。
 *     桌宠窗口（pet）只多了一条只读的 `pet:report-settings-state`；
 *     设置窗口（settings）走独立的 SETTINGS_CHANNELS 通道组，两套通道互不通用。
 *   - 语音（ASR/TTS/VAD）、字幕、游戏陪玩、战术思路、战场报点仍属后续阶段，
 *     这里不做任何伪实现。
 */

/** 桌宠窗口：渲染层 → 主进程（invoke/handle，一问一答） */
const IPC_CHANNELS = Object.freeze({
  // 窗口拖拽：渲染层把"指针相对窗口的偏移"告诉主进程，主进程按屏幕坐标移动窗口
  DRAG_START: 'pet:drag-start',
  DRAG_MOVE: 'pet:drag-move',
  DRAG_END: 'pet:drag-end',
  // 右键：让主进程在光标处弹出与托盘一致的菜单
  SHOW_CONTEXT_MENU: 'pet:show-context-menu',
  // 鼠标穿透：按光标是否落在鱼身上，动态开关 ignoreMouseEvents
  SET_IGNORE_MOUSE_EVENTS: 'pet:set-ignore-mouse-events',
  // 渲染层把自己的状态（如 idle / hungry / sleep）回报给主进程，供托盘提示做只读联动
  REPORT_STATE: 'pet:report-state',
  /*
   * 游动请求（阶段 2 新增的最小 IPC）：
   * 渲染层【只发请求、不带任何坐标】，主进程自己读取窗口 bounds 与所在显示器
   * workArea，算出目标位置并限幅后动画 setPosition。这样渲染层无法把桌宠
   * 指到任意屏幕坐标，安全边界仍然由主进程掌握。
   */
  SWIM_REQUEST: 'pet:swim-request',
  /*
   * 阶段 3：桌宠窗口只读地问一句"现在有没有可用的 API Key"。
   * 返回值里只有布尔状态与来源标记，**没有 Key 本身**，也不含任何派生值；
   * 桌宠窗口既不能读设置全文，也不能改设置、更不能发起对话。
   */
  REPORT_SETTINGS_STATE: 'pet:report-settings-state',
  /*
   * 阶段 4（连续语音对话）：桌宠窗口的三条窄接口。
   *   - VOICE_TRANSCRIBE：把**已编码成 wav 的语音段**交给主进程识别
   *     （云端 GLM-ASR 优先，失败降级本地 faster-whisper）；
   *     渲染层拿不到 Key，也拿不到任何云端响应体；
   *   - VOICE_CHAT：把识别文本交给主进程的 zhipu-client（内置鱼设 system、30 字上限）；
   *     **没有 Key 时主进程直接返回 no-api-key，绝不联网**；
   *   - VOICE_SPEAK：请求合成一段语音（GLM-TTS → edge-tts → SAPI → 渲染层 speechSynthesis），
   *     成功时只返回 `{ok, provider, audioBytes, text}` —— audioBytes 是可播放的
   *     Uint8Array，**绝不返回本地文件路径**。临时音频的读取与删除全部在主进程内完成，
   *     因此这里**没有**"删除临时文件"通道，渲染层也就没有可删任意文件的接口。
   * 这三条都只允许"当前 petWindow 的主 frame + 本地 index.html"调用，
   * 设置窗口的 preload 里**没有**这些通道。
   */
  VOICE_TRANSCRIBE: 'pet:voice-transcribe',
  VOICE_CHAT: 'pet:voice-chat',
  VOICE_SPEAK: 'pet:voice-speak'
});

/**
 * 设置窗口：渲染层 → 主进程（invoke/handle）。
 *
 * 与桌宠窗口的 IPC_CHANNELS 刻意分开成两组：
 *   - 桌宠窗口的 preload 里根本没有这些通道，设置窗口的 preload 里也没有 pet 通道；
 *   - 主进程侧两套通道分别用不同的来源校验（isTrustedPetSender / isTrustedSettingsSender），
 *     即使某一侧的页面被注入脚本，也拿不到另一侧的通道。
 */
const SETTINGS_CHANNELS = Object.freeze({
  // 读取非敏感设置（模型名 / 是否已配置 Key / Key 来源 / 存储可用性 + 阶段 4 语音设置）
  GET_SETTINGS: 'settings:get',
  // 保存设置（只接受 apiKey / model / 语音设置白名单字段，长度与类型严格校验）
  SAVE_SETTINGS: 'settings:save',
  // 显式触发一次最小对话请求：用户点「测试连接」才会调用，启动/打开页面都不会自动发。
  // 只返回 ok / model / latencyMs / 安全错误码，**绝不返回模型生成的正文**。
  TEST_CONNECTION: 'settings:test-connection',
  /*
   * 阶段 4：只改语音设置（麦克风开关 / VAD 灵敏度 / 静音毫秒 / GLM-TTS 音色 / 音量 / 字幕模式）。
   * 与 SAVE_SETTINGS 分开是为了**不碰 Key**：保存语音设置时连 apiKey 字段都不会经过这条通道。
   */
  SET_VOICE_SETTINGS: 'settings:set-voice'
});

/** 桌宠窗口：主进程 → 渲染层（send/on，单向通知） */
const PET_EVENTS = Object.freeze({
  // 触发一个可见动作状态，payload: { state: '...', durationMs?: number }
  ACTION: 'pet:action',
  /*
   * 喂饭（阶段 2 新增）：payload 为空。
   * 与 ACTION('eat') 分开是因为喂饭除了播 eat 动画，还必须把饱食度重置到 100
   * 并串起 eat → happy，是一条完整的业务事件，不只是"播个动画"。
   */
  FEED: 'pet:feed',
  /*
   * 阶段 4：语音相关单向通知。
   *   - VOICE_BUBBLE：轻量气泡（错误 / 麦克风状态）；payload 只有 {text, kind, caption}
   *   - VOICE_TOGGLE_MIC：菜单「语音对话」或全局 Ctrl+Shift+V 触发的"开关麦克风"
   *   - VOICE_SETTINGS：语音设置变更（只含非敏感字段）
   *   - VOICE_SPEAK_TEXT：要求渲染层用本机 speechSynthesis 播报（三级降级的最后一级）
   * 这些事件都**不带 Key、不带音频二进制、不带任意路径**。
   */
  VOICE_BUBBLE: 'pet:voice-bubble',
  VOICE_TOGGLE_MIC: 'pet:voice-toggle-mic',
  VOICE_SETTINGS: 'pet:voice-settings',
  VOICE_SPEAK_TEXT: 'pet:voice-speak-text'
});

/** 设置窗口：主进程 → 渲染层（send/on，单向通知） */
const SETTINGS_EVENTS = Object.freeze({
  // 设置变更通知（主进程保存成功后广播），payload 为非敏感设置快照
  CHANGED: 'settings:changed'
});

/**
 * 可触发的动作状态白名单（16 个：需求里的 15 个 + wake）。
 * 主进程与 preload 都按这张表过滤，渲染层无法被塞进未知状态，
 * 也不会出现"CSS 里写了但永远触发不到"的占位状态。
 */
const PET_STATES = Object.freeze([
  'idle',
  'blink',
  'eat',
  'happy',
  'hungry',
  'sleep',
  'talking',
  'thinking',
  'dragged',
  'poke',
  'pet',
  'swim',
  'flip',
  'greet',
  'angry',
  'wake',
  'shake',
  'taunt'
]);

/** 状态 → 托盘提示用的简体中文短标签（只用于托盘 tooltip，不是台词、不显示气泡） */
const STATE_LABELS = Object.freeze({
  idle: '待机',
  blink: '眨眼',
  eat: '吃饭',
  happy: '开心',
  hungry: '饿了',
  sleep: '睡觉',
  talking: '说话',
  thinking: '发呆思考',
  dragged: '被拖拽',
  poke: '被戳',
  pet: '被摸头',
  swim: '跑步',
  flip: '翻肚皮',
  greet: '打招呼',
  angry: '生气',
  wake: '醒来',
  shake: '摇头',
  taunt: '吐舌头'
});

/** 菜单项 id：托盘右键菜单与窗口右键菜单共用同一套 id，保证行为完全一致 */
const MENU_IDS = Object.freeze({
  FEED: 'feed',
  SLEEP: 'sleep',
  WAKE: 'wake',
  CHAT: 'chat',
  SETTINGS: 'settings',
  QUIT: 'quit'
});

/** 菜单文案（简体中文，与需求说明书的菜单项对齐） */
const MENU_LABELS = Object.freeze({
  FEED: '喂饭',
  SLEEP: '睡觉',
  WAKE: '叫醒',
  CHAT: '语音对话',
  SETTINGS: '设置',
  QUIT: '退出'
});

/**
 * 功能未到位时的安全提示文案（点击后只做说明，不做伪功能）。
 *
 * 阶段 4 的边界：
 *   - 「设置」是真功能（打开设置窗口）；
 *   - 「语音对话」在阶段 4 变成了**真功能**：它只负责"打开 / 关闭麦克风"，
 *     不再弹说明框（连续语音对话默认免按键，菜单/快捷键只做开关）。
 *     因此 PHASE_NOTICE.CHAT 只保留给"确实还没做的能力"（陪玩 / 报点等后续阶段）使用。
 */
const PHASE_NOTICE = Object.freeze({
  CHAT: '「语音对话」现在是**麦克风开关**：默认开着，直接说话就会自动断句、识别、回复并播报。'
    + '菜单项与全局快捷键 Ctrl+Shift+V 都只是开 / 关麦克风的备用方式。\n\n'
    + '阶段 4 仍然**不做**：唤醒词门控（阶段 5）、游戏陪玩 / 屏幕截图、战术思路、战场报点、'
    + '安装器 / 自启 / 桌面快捷方式。也**绝不会**采集屏幕、注入游戏进程或读取游戏内存。\n\n'
    + '没有配置 API Key 时不会向聊天模型发送任何内容，只在鱼头顶气泡提示去 open.bigmodel.cn 领 Key。',
  CHAT_DIALOG_TITLE: '语音对话 —— 麦克风开关',
  SETTINGS_DIALOG_TITLE: '设置',
  // 全局快捷键被别的程序占用时的降级提示（需求：不崩溃，只说明）
  SHORTCUT_TAKEN: 'Ctrl+Shift+V 被别的程序占用了…想开关麦克风就用右键菜单里的「语音对话」吧',
  SHORTCUT_TAKEN_TITLE: '全局快捷键注册失败'
});

module.exports = {
  IPC_CHANNELS,
  SETTINGS_CHANNELS,
  PET_EVENTS,
  SETTINGS_EVENTS,
  PET_STATES,
  STATE_LABELS,
  MENU_IDS,
  MENU_LABELS,
  PHASE_NOTICE
};
