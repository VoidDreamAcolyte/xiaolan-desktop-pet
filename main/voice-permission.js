'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 主进程：语音相关权限策略（阶段 4）
 * ============================================================================
 *
 * 背景（Electron 官方 Session 文档）：
 *   - **session 是窗口共享的**，多个 BrowserWindow 默认用同一个默认 session，
 *     因此在每个窗口上各注册一次权限处理器会**互相覆盖**（最后一个生效）。
 *     正确做法：**只注册一次**，在处理器里判断"请求来自哪个窗口 / 哪个页面 / 哪个 frame"。
 *   - 要完整处理权限，必须同时设置 `setPermissionRequestHandler` 和
 *     `setPermissionCheckHandler`（官方明确要求两个都设，否则同步检查路径会漏）。
 *   - 权限检查的 details 里带 `mediaType` / `requestingUrl` / `isMainFrame`。
 *
 * 需求（阶段 4 第 2 条）逐条落地 —— 只允许：
 *   ✅ 桌宠窗口（petWindow）的**主 frame**、本地入口页面（ENTRY_HTML）的
 *      **audio**（麦克风）权限；
 *   ❌ 设置窗口（settingsWindow）的任何权限；
 *   ❌ 任何子 frame（iframe / webview）；
 *   ❌ video（摄像头）；
 *   ❌ display-capture（屏幕采集，阶段 4 明确不做，也绝不允许）；
 *   ❌ 其它一切权限（通知 / 定位 / 剪贴板 / MIDI / HID / 串口 …）。
 *
 * 本模块只做"决策 + 注册"，不碰窗口实现细节：窗口身份与 URL 判定全部通过
 * 注入的 `context` 提供，因此单元测试可以直接喂"来自设置窗口的视频请求"这类组合，
 * 断言它被拒绝、且原因码明确。
 */

/** 权限决策的原因码（用于日志与断言；不含任何敏感信息） */
const PERMISSION_REASONS = Object.freeze({
  ALLOWED: 'allowed',
  NOT_PET_WINDOW: 'not-pet-window',
  BAD_URL: 'untrusted-url',
  NOT_MAIN_FRAME: 'not-main-frame',
  NOT_MEDIA: 'not-media',
  MEDIA_TYPE_MISSING: 'media-type-missing',
  VIDEO_DENIED: 'video-denied',
  AUDIO_ONLY: 'audio-only-ok',
  DISPLAY_DENIED: 'display-capture-denied'
});

/** 允许的媒体类型：**只有 audio** */
const ALLOWED_MEDIA_TYPES = Object.freeze(['audio']);

/**
 * 纯决策函数：请求来源 + 权限名 + details → 是否放行。
 *
 * @param {{
 *   source: {
 *     isPetWindow?: boolean,
 *     urlMatchesEntry?: boolean,
 *     isMainFrame?: boolean,
 *     isOwnedPetWindow?: boolean
 *   },
 *   permission?: string,
 *   details?: {mediaType?: string, requestingUrl?: string, isMainFrame?: boolean, securityOrigin?: string}
 * }} input
 * @returns {{allowed: boolean, reason: string}}
 */
function decideVoicePermission(input) {
  const value = input && typeof input === 'object' ? input : {};
  const source = value.source && typeof value.source === 'object' ? value.source : {};
  const details = value.details && typeof value.details === 'object' ? value.details : {};
  const permission = typeof value.permission === 'string' ? value.permission : '';

  // 1) 必须是桌宠窗口本身发起的（设置窗口 / 未知窗口一律拒绝）
  if (!source.isPetWindow && !source.isOwnedPetWindow) {
    return { allowed: false, reason: PERMISSION_REASONS.NOT_PET_WINDOW };
  }
  // 2) 必须停留在本地入口页面（file:// .../renderer/index.html）
  if (!source.urlMatchesEntry) {
    return { allowed: false, reason: PERMISSION_REASONS.BAD_URL };
  }
  // 3) 必须是主 frame（子 frame 一律拒绝；details.isMainFrame === false 也算子 frame）
  const detailsMainFrame = details.isMainFrame;
  if (source.isMainFrame === false || detailsMainFrame === false) {
    return { allowed: false, reason: PERMISSION_REASONS.NOT_MAIN_FRAME };
  }
  // 4) 屏幕采集无论什么情况都拒绝（阶段 4 不采集屏幕，红线）
  if (permission === 'display-capture' || permission === 'desktop-capture') {
    return { allowed: false, reason: PERMISSION_REASONS.DISPLAY_DENIED };
  }
  // 5) 只处理 media；其它权限（通知 / 定位 / 剪贴板 / HID …）全部拒绝
  if (permission !== 'media') {
    return { allowed: false, reason: PERMISSION_REASONS.NOT_MEDIA };
  }
  // 6) media 必须明确声明 mediaType（request handler 有时不给）——
  //    没给就拒绝，避免"没说清是音频还是视频"被默默放行
  const mediaType = typeof details.mediaType === 'string' ? details.mediaType : '';
  if (mediaType.length === 0) {
    return { allowed: false, reason: PERMISSION_REASONS.MEDIA_TYPE_MISSING };
  }
  if (mediaType === 'video' || mediaType === 'audio+video') {
    return { allowed: false, reason: PERMISSION_REASONS.VIDEO_DENIED };
  }
  if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return { allowed: false, reason: PERMISSION_REASONS.NOT_MEDIA };
  }
  return { allowed: true, reason: PERMISSION_REASONS.AUDIO_ONLY };
}

/**
 * 只注册一次语音权限处理器。
 *
 * @param {{
 *   session: object,
 *   isPetWebContents?: (webContentsId: number) => boolean,
 *   matchesEntryUrl?: (url: string) => boolean,
 *   isMainFrameOf?: (webContentsId: number, frame: unknown) => boolean,
 *   logger?: {warn?: Function}
 * }} deps
 * @returns {{installed: boolean, requestHandler: Function, checkHandler: Function, decisions: object[]}}
 */
function installVoicePermissionHandlers(deps) {
  const options = deps || {};
  const session = options.session;
  const isPetWebContents = typeof options.isPetWebContents === 'function' ? options.isPetWebContents : () => false;
  const matchesEntryUrl = typeof options.matchesEntryUrl === 'function' ? options.matchesEntryUrl : () => false;
  const isMainFrameOf = typeof options.isMainFrameOf === 'function' ? options.isMainFrameOf : () => false;
  const logger = options.logger || console;
  /** 最近若干条决策（仅供诊断 / 测试读取，不含任何音频或密钥） */
  const decisions = [];

  /** 把 webContents 归一化成 id（不同 Electron 版本可能给包装对象） */
  const idOf = (webContents) => {
    if (!webContents) return -1;
    if (typeof webContents === 'number') return webContents;
    const id = Number(webContents.id);
    return Number.isFinite(id) ? id : -1;
  };

  /**
   * 把 Electron 给的各种参数统一归一化成 decideVoicePermission 的输入。
   * 注意：check handler 的签名是 (webContents, permission, requestingOrigin, details)，
   * 没有 frame 参数；request handler 的签名是 (webContents, permission, callback, details)。
   * 两者都要处理，且都要判 mediaType / requestingUrl / isMainFrame。
   */
  function buildSource(webContents, details, frame) {
    const id = idOf(webContents);
    const url = details && typeof details.requestingUrl === 'string'
      ? details.requestingUrl
      : details && typeof details.securityOrigin === 'string'
        ? details.securityOrigin
        : '';
    const mainFrame = frame
      ? isMainFrameOf(id, frame)
      : details && typeof details.isMainFrame === 'boolean'
        ? details.isMainFrame !== false
        : true;
    return {
      isPetWindow: isPetWebContents(id),
      urlMatchesEntry: matchesEntryUrl(url),
      isMainFrame: mainFrame
    };
  }

  function record(permission, details, decision) {
    const entry = {
      permission: permission,
      mediaType: details && typeof details.mediaType === 'string' ? details.mediaType : '',
      allowed: decision.allowed,
      reason: decision.reason
    };
    decisions.push(entry);
    if (decisions.length > 40) decisions.shift();
    if (!decision.allowed) {
      // 只记"权限名 + 原因码"，绝不记 URL 里的查询串或任何内容
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[安全] 已拒绝权限（${permission || 'unknown'}）：${decision.reason}`);
      }
    }
    return entry;
  }

  const requestHandler = (webContents, permission, callback, details) => {
    try {
      const info = details && typeof details === 'object' ? details : {};
      const decision = decideVoicePermission({
        source: buildSource(webContents, info, null),
        permission: permission,
        details: info
      });
      record(permission, info, decision);
      callback(decision.allowed === true);
    } catch (error) {
      // 决策异常时一律拒绝（fail-closed），绝不因为内部错误放行权限
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[安全] 权限决策异常，已按拒绝处理。');
      }
      try {
        callback(false);
      } catch {
        // 忽略
      }
    }
  };

  const checkHandler = (webContents, permission, requestingOrigin, details) => {
    try {
      const info = details && typeof details === 'object' ? details : {};
      const merged = Object.assign({ requestingUrl: requestingOrigin }, info);
      const decision = decideVoicePermission({
        source: buildSource(webContents, merged, null),
        permission: permission,
        details: merged
      });
      record(permission, merged, decision);
      return decision.allowed === true;
    } catch {
      return false;
    }
  };

  if (!session || typeof session.setPermissionRequestHandler !== 'function' || typeof session.setPermissionCheckHandler !== 'function') {
    return { installed: false, requestHandler, checkHandler, decisions };
  }

  // 两个 handler 都在**同一个 session 上注册一次**：设置窗与桌宠窗共享 session，
  // 所以绝不能按窗口分别注册（会互相覆盖）。
  session.setPermissionRequestHandler(requestHandler);
  session.setPermissionCheckHandler(checkHandler);

  return { installed: true, requestHandler, checkHandler, decisions };
}

module.exports = {
  PERMISSION_REASONS,
  ALLOWED_MEDIA_TYPES,
  decideVoicePermission,
  installVoicePermissionHandlers
};
