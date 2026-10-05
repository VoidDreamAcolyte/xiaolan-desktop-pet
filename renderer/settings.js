'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 设置页逻辑（阶段 3：安全设置 + 智谱云端对话 API 基础）
 * ============================================================================
 *
 * 职责：
 *   1. 从主进程读取**非敏感**设置（模型名 / 是否已配置 Key / Key 来源 / 存储可用性）并渲染；
 *   2. 让用户录入或替换 API Key、修改模型名，保存后**立刻清空输入框**并只显示"已配置"；
 *   3. 「测试连接」：用户点按钮时才发一次最小对话请求，结果就地显示（一次性，不用 alert），
 *      只显示连接成功 / 失败，**不显示模型生成的回复文本**。
 *
 * 这里**绝对不能**做的事：
 *   - 不碰 Node / require / process / fs（页面跑在 sandbox + contextIsolation 里，
 *     也根本没有这些能力）；
 *   - 不从主进程拿 Key、不把 Key 写进 DOM（输入框的值只在点按钮那一刻通过窄接口传给主进程，
 *     保存成功后立即清空）；
 *   - 不自己发网络请求（CSP 的 connect-src 'none' 也把这条路封死了）；
 *   - 打开页面时不自动联网（没有开机自检、没有 onload 请求）；
 *   - **不提供任何文字聊天面板 / 自由文本输入**：阶段 3 没有可见文字聊天入口，
 *     也不把文本回复冒充成语音。
 */

(function () {
  const api = window.blueFatFishSettings;
  if (!api) {
    // preload 没注入说明窗口配置出了问题：直接在页面上说明，不静默失败
    const status = document.getElementById('global-status');
    if (status) {
      status.className = 'hint state-error';
      status.textContent = '设置桥接未注入：无法与主进程通信，请重新打开设置窗口。';
    }
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* DOM 引用                                                                */
  /* ---------------------------------------------------------------------- */

  const keyInput = document.getElementById('api-key');
  const keyState = document.getElementById('key-state');
  const keySourceHint = document.getElementById('key-source-hint');
  const modelInput = document.getElementById('model');
  const saveButton = document.getElementById('save-button');
  const clearButton = document.getElementById('clear-button');
  const testButton = document.getElementById('test-button');
  const testResult = document.getElementById('test-result');
  const configPath = document.getElementById('config-path');
  const endpointText = document.getElementById('endpoint');
  const globalStatus = document.getElementById('global-status');
  // 阶段 4：语音设置控件
  const micEnabledInput = document.getElementById('mic-enabled');
  const vadSensitivityInput = document.getElementById('vad-sensitivity');
  const vadSilenceInput = document.getElementById('vad-silence');
  const ttsVoiceSelect = document.getElementById('tts-voice');
  const volumeInput = document.getElementById('volume');
  const subtitleModeInput = document.getElementById('subtitle-mode');
  const petScaleInput = document.getElementById('pet-scale');
  const petScaleValue = document.getElementById('pet-scale-value');
  const saveVoiceButton = document.getElementById('save-voice-button');
  const voiceResult = document.getElementById('voice-result');

  /* ---------------------------------------------------------------------- */
  /* 小工具                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * 往元素里写**纯文本**结果（绝不用 innerHTML，杜绝把云端返回当 HTML 渲染）。
   * @param {HTMLElement | null} element
   * @param {string} text
   * @param {'ok'|'warn'|'error'|'info'} kind
   */
  function setResult(element, text, kind) {
    if (!element) return;
    element.textContent = text;
    element.className = 'result state-' + (kind || 'info');
  }

  /**
   * 全局状态行（一次性提示，不弹窗、不刷屏）。
   * @param {string} text
   * @param {'ok'|'warn'|'error'|'info'} kind
   */
  function setGlobalStatus(text, kind) {
    if (!globalStatus) return;
    globalStatus.textContent = text;
    globalStatus.className = 'hint state-' + (kind || 'info');
  }

  /**
   * 把按钮临时置灰，避免重复点击造成并发请求。
   * @param {HTMLButtonElement | null} button
   * @param {boolean} busy
   * @param {string} busyText
   * @param {string} idleText
   */
  function setBusy(button, busy, busyText, idleText) {
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? busyText : idleText;
  }

  /**
   * 渲染 Key 状态。**只显示状态，绝不回显 Key 本身**。
   * @param {object} settings
   */
  function renderKeyState(settings) {
    if (!settings || typeof settings !== 'object') return;

    if (settings.hasApiKey && settings.keySource === 'env') {
      keyState.textContent = '状态：已配置（来源：环境变量 ZHIPU_API_KEY，它优先于这里填写的 Key）';
      keyState.className = 'hint state-ok';
      keySourceHint.textContent = '环境变量的值不会显示在这里，也不会被写进配置文件。';
      return;
    }

    if (settings.hasApiKey && settings.persistence === 'encrypted') {
      keyState.textContent = '状态：已配置（本机已用 safeStorage 加密保存，重启后仍然有效）';
      keyState.className = 'hint state-ok';
      keySourceHint.textContent = '要更换 Key，直接在输入框粘贴新的再点「保存设置」；输入框平时是空的。';
      return;
    }

    if (settings.hasApiKey && settings.persistence === 'session-only') {
      keyState.textContent = '状态：已配置（仅本次会话）';
      keyState.className = 'hint state-warn';
      keySourceHint.textContent =
        '本机 safeStorage 加密不可用，Key 只保存在内存里，关闭应用后需要重新填写 —— 这是刻意的：宁可不保存，也不明文落盘。';
      return;
    }

    keyState.textContent = '状态：未配置';
    keyState.className = 'hint state-warn';
    keySourceHint.textContent =
      '到 open.bigmodel.cn（智谱开放平台）注册并申请免费档 Key，粘贴到这里保存即可；也可以设置系统环境变量 ZHIPU_API_KEY。';
  }

  /**
   * 渲染设置（模型名 + 存储信息）。
   * @param {object} settings
   */
  function renderSettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    if (typeof settings.model === 'string' && settings.model.length > 0 && document.activeElement !== modelInput) {
      modelInput.value = settings.model;
    }
    if (modelInput && (!modelInput.value || modelInput.value.trim().length === 0)) {
      modelInput.value = typeof settings.defaultModel === 'string' ? settings.defaultModel : 'glm-4.7-flash';
    }

    if (configPath && typeof settings.configPath === 'string' && settings.configPath.length > 0) {
      configPath.textContent = settings.configPath;
    }

    // 请求地址：**只读展示**主进程写死的 endpoint。这里只是显示，改不了它。
    if (endpointText && typeof settings.endpoint === 'string' && settings.endpoint.length > 0) {
      endpointText.textContent = settings.endpoint;
    }

    renderKeyState(settings);
    renderVoiceSettings(settings);

    if (settings.configCorrupted === true) {
      setGlobalStatus('检测到配置文件损坏，已重置为默认设置（损坏的文件不会被读回来）。', 'warn');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 阶段 4：语音设置的渲染与保存                                              */
  /* ---------------------------------------------------------------------- */

  /** GLM-TTS 官方系统音色 → 中文名（与 main/settings-store.js 的白名单一致） */
  const VOICE_LABELS = Object.freeze({
    tongtong: 'tongtong（彤彤，默认）',
    chuichui: 'chuichui（吹吹）',
    xiaochen: 'xiaochen（小陈）',
    jam: 'jam',
    kazi: 'kazi',
    douji: 'douji',
    luodo: 'luodo'
  });

  const DEFAULT_VOICE_OPTIONS = Object.freeze(['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo']);

  /**
   * 填充音色下拉（选项来自主进程下发的只读白名单，界面无法自造音色）。
   * @param {string[]} options
   */
  function renderVoiceOptions(options) {
    if (!ttsVoiceSelect) return;
    const list = Array.isArray(options) && options.length > 0 ? options : DEFAULT_VOICE_OPTIONS;
    const existing = ttsVoiceSelect.options.length;
    // 已经渲染过且选项完全一致就不重建（避免把用户刚选的值冲掉）
    let same = existing === list.length;
    if (same) {
      for (let i = 0; i < list.length; i += 1) {
        if (ttsVoiceSelect.options[i].value !== list[i]) {
          same = false;
          break;
        }
      }
    }
    if (same) return;
    ttsVoiceSelect.textContent = '';
    for (const voice of list) {
      const option = document.createElement('option');
      option.value = voice;
      option.textContent = VOICE_LABELS[voice] || voice;
      ttsVoiceSelect.appendChild(option);
    }
  }

  /**
   * 渲染语音设置到控件（只在用户没有正在编辑该控件时覆盖）。
   * @param {object} settings
   */
  function renderVoiceSettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    renderVoiceOptions(settings.voiceOptions);

    const range = settings.vadSilenceRange && typeof settings.vadSilenceRange === 'object'
      ? settings.vadSilenceRange
      : { min: 400, max: 1500 };
    if (vadSilenceInput) {
      vadSilenceInput.min = String(range.min);
      vadSilenceInput.max = String(range.max);
    }

    if (micEnabledInput && document.activeElement !== micEnabledInput) {
      micEnabledInput.checked = settings.micEnabled !== false;
    }
    if (vadSensitivityInput && document.activeElement !== vadSensitivityInput) {
      vadSensitivityInput.value = String(Number.isFinite(Number(settings.vadSensitivity)) ? settings.vadSensitivity : 0.5);
    }
    if (vadSilenceInput && document.activeElement !== vadSilenceInput) {
      vadSilenceInput.value = String(Number.isFinite(Number(settings.vadSilenceMs)) ? settings.vadSilenceMs : 800);
    }
    if (volumeInput && document.activeElement !== volumeInput) {
      volumeInput.value = String(Number.isFinite(Number(settings.volume)) ? settings.volume : 0.8);
    }
    if (subtitleModeInput && document.activeElement !== subtitleModeInput) {
      subtitleModeInput.checked = settings.subtitleMode === true;
    }
    if (petScaleInput && document.activeElement !== petScaleInput) {
      const scalePct = Number.isFinite(Number(settings.petScale)) ? Math.round(settings.petScale * 100) : 100;
      petScaleInput.value = String(scalePct);
      if (petScaleValue) petScaleValue.textContent = `${scalePct}%`;
    }
    if (ttsVoiceSelect && typeof settings.ttsVoice === 'string') {
      ttsVoiceSelect.value = settings.ttsVoice;
    }
  }

  /**
   * 保存语音设置。
   *
   * 这条路**完全不碰 Key**：只调用 preload 的 setVoiceSettings（主进程侧也只接受
   * 语音白名单字段）。非法值在 preload 里就会本地报错，不会调用主进程。
   */
  async function onSaveVoice() {
    const patch = {};
    if (micEnabledInput) patch.micEnabled = micEnabledInput.checked === true;
    if (vadSensitivityInput) patch.vadSensitivity = Number(vadSensitivityInput.value);
    if (vadSilenceInput) patch.vadSilenceMs = Number(vadSilenceInput.value);
    if (ttsVoiceSelect && ttsVoiceSelect.value) patch.ttsVoice = ttsVoiceSelect.value;
    if (volumeInput) patch.volume = Number(volumeInput.value);
    if (subtitleModeInput) patch.subtitleMode = subtitleModeInput.checked === true;
    if (petScaleInput && Number.isFinite(Number(petScaleInput.value))) {
      patch.petScale = Number(petScaleInput.value) / 100;
    }

    setBusy(saveVoiceButton, true, '保存中…', '保存语音设置');
    try {
      const result = await api.setVoiceSettings(patch);
      if (result && result.settings) {
        current = result.settings;
        renderSettings(result.settings);
      }
      if (result && result.ok) {
        setResult(voiceResult, result.message || '语音设置已保存。', 'ok');
      } else {
        setResult(voiceResult, (result && result.message) || '语音设置保存失败。', 'error');
      }
    } catch {
      setResult(voiceResult, '保存失败：无法与主进程通信。', 'error');
    } finally {
      setBusy(saveVoiceButton, false, '保存中…', '保存语音设置');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 读取设置（只读，不联网）                                                 */
  /* ---------------------------------------------------------------------- */

  /** 当前已知的非敏感设置（用于判断"输入框里是否有待保存的新 Key"） */
  let current = null;

  async function refreshSettings() {
    try {
      const settings = await api.getSettings();
      if (!settings || typeof settings !== 'object') {
        setGlobalStatus('读取设置失败：返回内容不合法。', 'error');
        return;
      }
      current = settings;
      renderSettings(settings);
      setGlobalStatus('准备就绪（打开本页不会联网，只有你点按钮时才发请求）。', 'info');
    } catch {
      setGlobalStatus('读取设置失败，请重新打开设置窗口。', 'error');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 保存 / 清除                                                             */
  /* ---------------------------------------------------------------------- */

  async function onSave() {
    const draftKey = keyInput ? keyInput.value : '';
    const model = modelInput ? modelInput.value : '';

    const patch = { model: model };
    if (typeof draftKey === 'string' && draftKey.trim().length > 0) {
      patch.apiKey = draftKey;
    }

    setBusy(saveButton, true, '保存中…', '保存设置');
    try {
      const result = await api.saveSettings(patch);
      if (keyInput) keyInput.value = '';
      if (result && result.settings) {
        current = result.settings;
        renderSettings(result.settings);
      }
      if (result && result.ok) {
        setGlobalStatus(result.message || '设置已保存。', 'ok');
      } else {
        setGlobalStatus((result && result.message) || '保存失败，请检查输入。', 'error');
      }
    } catch {
      if (keyInput) keyInput.value = '';
      setGlobalStatus('保存失败：无法与主进程通信。', 'error');
    } finally {
      setBusy(saveButton, false, '保存中…', '保存设置');
    }
  }

  async function onClear() {
    setBusy(clearButton, true, '清除中…', '清除本机保存的 Key');
    try {
      // 清除用哨兵值：主进程明确区分"没填（保持原样）"与"要删掉"
      const result = await api.saveSettings({ apiKey: '\u0000CLEAR\u0000' });
      if (keyInput) keyInput.value = '';
      if (result && result.settings) {
        current = result.settings;
        renderSettings(result.settings);
      }
      setGlobalStatus((result && result.message) || '已清除本机保存的 API Key。', 'info');
    } catch {
      setGlobalStatus('清除失败：无法与主进程通信。', 'error');
    } finally {
      setBusy(clearButton, false, '清除中…', '清除本机保存的 Key');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 测试连接（只有用户点击才会调用）                                          */
  /* ---------------------------------------------------------------------- */

  async function onTest() {
    const draftKey = keyInput ? keyInput.value.trim() : '';
    setBusy(testButton, true, '请求中…（最长约 30 秒）', '测试连接');
    setResult(testResult, '正在向智谱发起一次最小对话请求…', 'info');
    try {
      const options = draftKey.length > 0 ? { apiKey: draftKey } : {};
      const result = await api.testConnection(options);
      if (result && result.ok === true) {
        const latency = Number.isFinite(result.latencyMs) ? `${result.latencyMs} ms` : '未知';
        // 只显示"连接成功/失败"，**不显示模型生成的任何回复文本**
        setResult(testResult, `连接成功：模型 ${result.model} 可用（耗时 ${latency}）。`, 'ok');
        setGlobalStatus('测试连接成功。', 'ok');
      } else {
        setResult(testResult, `连接失败：${(result && result.message) || '未知错误'}（错误码 ${(result && result.code) || 'unknown'}）`, 'error');
        setGlobalStatus('测试连接失败，按上面的提示处理即可。', 'warn');
      }
    } catch {
      setResult(testResult, '连接失败：无法与主进程通信。', 'error');
    } finally {
      setBusy(testButton, false, '请求中…（最长约 30 秒）', '测试连接');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 事件绑定（没有自动触发，全部是用户显式点击）                                */
  /* ---------------------------------------------------------------------- */

  if (saveButton) saveButton.addEventListener('click', onSave);
  if (clearButton) clearButton.addEventListener('click', onClear);
  if (testButton) testButton.addEventListener('click', onTest);
  // 阶段 4：语音设置保存（与 Key 完全分开的一条路）
  if (saveVoiceButton) saveVoiceButton.addEventListener('click', onSaveVoice);

  // 桌宠大小：输入实时更新百分比显示，确认（回车 / 失焦）后立即单独保存生效
  if (petScaleInput) {
    petScaleInput.addEventListener('input', () => {
      const value = Number(petScaleInput.value);
      if (petScaleValue && Number.isFinite(value)) {
        petScaleValue.textContent = `${Math.round(value)}%`;
      }
    });
    petScaleInput.addEventListener('change', async () => {
      const scalePct = Math.round(Number(petScaleInput.value));
      if (!Number.isFinite(scalePct)) return;
      const clamped = Math.min(200, Math.max(50, scalePct));
      petScaleInput.value = String(clamped);
      if (petScaleValue) petScaleValue.textContent = `${clamped}%`;
      try {
        const result = await api.setVoiceSettings({ petScale: clamped / 100 });
        if (result && result.ok && result.settings) {
          current = result.settings;
          setResult(voiceResult, `桌宠大小已调整为 ${clamped}%。`, 'ok');
        } else {
          setResult(voiceResult, (result && result.message) || '桌宠大小保存失败。', 'error');
        }
      } catch {
        setResult(voiceResult, '保存失败：无法与主进程通信。', 'error');
      }
    });
  }

  // 在输入框里按回车 = 点对应的按钮，少一次鼠标移动
  if (keyInput) {
    keyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onSave();
      }
    });
  }
  if (modelInput) {
    modelInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onSave();
      }
    });
  }

  // 主进程保存成功后广播（例如将来从别处改了设置，这里同步刷新）
  api.onSettingsChanged((settings) => {
    current = settings;
    renderSettings(Object.assign({}, current, settings));
  });

  // 只读拉一次当前设置：不发任何网络请求
  refreshSettings();
})();
