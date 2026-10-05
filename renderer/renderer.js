'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 渲染层逻辑（阶段 2：鱼体与交互）
 * ============================================================================
 *
 * 职责：
 *   1. 把纯逻辑模块（renderer/logic/state-machine.js）的状态机接到 DOM 上：
 *      可见状态 → .state-* 类，持久模式 → .mode-* 类，两个类各驱动一层 SVG 动画。
 *   2. 交互：左键拖拽（dragged）、单击（poke）、双击（greet）、右键菜单、
 *      鼠标在鱼头上停留 / 滑动（pet）、鼠标穿透联动。
 *   3. 随机行为：随机眨眼、每隔几十秒随机小动作（发呆 / 翻肚皮 / 开心）、
 *      每隔数分钟随机游动（只在窗口可见、非 sleep、没有直接交互时）。
 *   4. 饱食度：纯逻辑模块（renderer/logic/fullness.js）+ localStorage 时间戳持久化，
 *      情绪（idle / hungry / angry）驱动持久模式；菜单喂饭重置到 100 并串 eat → happy。
 *   5. 与主进程的通信全部通过 window.blueFatFish（preload 白名单接口），
 *      游动只发"请求"不带坐标，坐标与限幅由主进程负责。
 *
 * 本文件不接触任何 Node 能力，也没有任何网络请求。
 *
 * 阶段 3 边界（云 API 已接入主进程，但桌宠窗口仍然不联网）：
 *   智谱 API Key 的读取 / 保存 / 测试连接 / 云端对话全部属于**设置窗口**
 *   （renderer/settings.html + main/settings-preload.js），桌宠窗口的 preload 里
 *   一个 settings 通道都没有。这里只保留一个只读的 `bridge.reportSettingsState()`，
 *   而且**阶段 3 不会主动调用它**：启动时不检查 Key、不发任何网络请求，
 *   免得没配置 Key 的机器一开机就被提示打扰（密钥检查留到后续语音对话阶段）。
 *   本文件依旧没有任何"文字聊天面板"，也不存在"用文字冒充语音"的分支。
 *
 * 关于"说话"（重要，别在这里加伪功能）：
 *   需求要求说话默认走语音、文字气泡只在开启字幕时显示。语音属于后续阶段，
 *   所以本阶段既不放假语音，也不显示任何可见文字气泡 —— 屏幕上不会出现"台词"。
 *   只保留 #a11y-status 这个 .sr-only 的无障碍状态文本（读屏可见、屏幕不可见），
 *   并提供 beginSpeech()/endSpeech() 作为后续 TTS 驱动 talking 口型的接口。
 *   情绪变化等自动事件**只能改这段不可见文本，绝不触发 talking**：
 *   没有声音却张嘴 = "无声说话"，同样违反需求。talking 只由明确 TTS hook 驱动。
 */

(function () {
  // preload 未注入时直接报错退出，避免"看起来能用实际不能用"的假象
  const bridge = window.blueFatFish;
  if (!bridge) {
    throw new Error('[renderer] 未检测到 preload 注入的 window.blueFatFish，页面无法与主进程通信。');
  }
  const logic = window.BFFLogic;
  if (!logic || !logic.stateMachine || !logic.fullness) {
    throw new Error('[renderer] 纯逻辑模块未加载：需要先加载 logic/state-machine.js 与 logic/fullness.js。');
  }

  const { createStateMachine, STATE_NAMES } = logic.stateMachine;
  const fullnessLogic = logic.fullness;
  // 阶段 4：语音链路的纯逻辑模块（与 node 单元测试跑的是同一份实现）
  const voiceLogic = logic.vad && logic.wav && logic.turnTaking ? logic : null;

  /* ---------------------------------------------------------------------- */
  /* DOM 引用                                                                */
  /* ---------------------------------------------------------------------- */

  const stage = document.getElementById('stage');
  const a11yStatus = document.getElementById('a11y-status');
  const fishSvg = document.getElementById('fish-svg');
  const eyesGroup = document.getElementById('eyes');
  // 人物形象（2026-10-05 形象替换）：按状态切换表情图，缺图自动回退基础图
  const petImage = document.getElementById('pet-image');
  // 眨眼覆盖层已按用户要求整体移除（2026-10-05）：覆盖层反复被看成脸上"黑点"，弃用
  // 阶段 4：字幕 / 状态气泡（默认隐藏）
  const speechBubble = document.getElementById('speech-bubble');
  const speechBubbleText = document.getElementById('speech-bubble-text');

  /* ---------------------------------------------------------------------- */
  /* 常量                                                                    */
  /* ---------------------------------------------------------------------- */

  /** 所有可见状态类：切换状态时先整组移除，保证同一时刻只有一个动作在播 */
  const STATE_CLASSES = Object.freeze([
    'state-idle',
    'state-blink',
    'state-eat',
    'state-happy',
    'state-hungry',
    'state-sleep',
    'state-talking',
    'state-thinking',
    'state-dragged',
    'state-poke',
    'state-pet',
    'state-swim',
    'state-flip',
    'state-greet',
    'state-angry',
    'state-wake'
  ]);

  /** 持久模式类：驱动"底色"动画（漂浮 / 发蔫 / 抖动 / 睡觉呼吸） */
  const MODE_CLASSES = Object.freeze(['mode-idle', 'mode-hungry', 'mode-angry', 'mode-sleep']);

  /** 游动朝向类 */
  const SWIM_DIR_CLASSES = Object.freeze(['swim-left', 'swim-right']);

  /** 表情图清单：base 是基础形象；其余为表情变体（文件缺失时自动回退 base） */
  const EXPRESSION_FILES = Object.freeze({
    base: 'pet-girl.png',
    happy: 'pet-girl-happy.png',
    angry: 'pet-girl-angry.png',
    sleepy: 'pet-girl-sleepy.png',
    shy: 'pet-girl-shy.png',
    surprised: 'pet-girl-surprised.png',
    talking: 'pet-girl-talking.png',
    eating: 'pet-girl-eating.png',
    effort: 'pet-girl-effort.png'
  });

  /** 可见状态 → 表情：只在有明确表情图时才换，避免无谓的图切换 */
  const STATE_EXPRESSION = Object.freeze({
    greet: 'happy',
    happy: 'happy',
    wake: 'happy',
    pet: 'shy',
    poke: 'surprised',
    talking: 'talking',
    eat: 'eating',
    angry: 'angry',
    dragged: 'angry',
    sleep: 'sleepy',
    swim: 'effort'
  });

  /** 可交互元素：只有落在这些图形上才认为"光标在她身上" */
  const INTERACTIVE_SELECTOR =
    '#fish-svg #body, #fish-svg #tail, #fish-svg #fins, #fish-svg #eyes, #fish-svg #mouth, #fish-svg #bowl, ' +
    '#fish-svg #face, #fish-svg #belly, #fish-svg #hands, #fish-svg #feet';

  /** 单击（未拖动）触发 poke 的最长按压时间；超过也算"按住戳" */
  const CLICK_MAX_MS = 350;
  /** 长按（没拖动）触发"疑惑"的时长 */
  const LONG_PRESS_MS = 1200;
  /** 连点计数窗口内的时间戳（三连击 → flip） */
  let tapTimes = [];
  /** 点击爆星特效组（SVG 里的 #tap-fx）与其收尾定时器 */
  const tapFxGroup = document.getElementById('tap-fx');
  let tapFxTimer = 0;
  /** 长按是否已触发过 thinking（松手时不再重复反应） */
  let longPressFired = false;
  /** 长按定时器 */
  let longPressTimer = 0;
  /** 鼠标穿透探测的节流间隔 */
  const HOVER_PROBE_MS = 70;

  /** 拖拽判定的最小位移（像素） */
  const DRAG_DISTANCE_PX = 4;

  /** 鼠标在鱼头上停留多久触发 pet（毫秒） */
  const PET_DWELL_MS = 700;
  /** 鼠标在鱼头上滑动多少像素触发 pet */
  const PET_SWIPE_PX = 60;
  /** 两次 pet 之间的冷却（毫秒），避免连续刷屏 */
  const PET_COOLDOWN_MS = 2600;

  /** 随机小动作间隔范围（毫秒）：发呆 / 翻肚皮 / 开心 */
  const IDLE_ACTION_MIN_MS = 45000;
  const IDLE_ACTION_RANGE_MS = 65000;
  /** 随机游动间隔范围（毫秒）：约 3~6 分钟 */
  const SWIM_MIN_MS = 180000;
  const SWIM_RANGE_MS = 180000;

  /* ---- 互动台词 & 自言自语（参考 Steam《虚拟桌宠模拟器》VPet 的灵动感） ---- */

  /** 各反应对应的台词气泡池：动作被接受时随机冒一句 */
  const REACTION_QUIPS = Object.freeze({
    poke: ['别戳啦！', '哇！吓我一跳', '干嘛戳我～', '哼，再戳要生气了', '咦？！'],
    happy: ['嘿嘿嘿～', '好痒好痒！', '哈哈哈，再来再来', '开心到飞起～'],
    pet: ['摸摸头…好舒服', '唔…有点害羞', '头发要被摸乱啦', '再摸一下也可以哦'],
    greet: ['你好呀～', '嗨！今天也要加油哦', '看到你真开心', '嘿嘿，挥手手'],
    flip: ['哇啊啊——', '转晕了…晕…', '再来一次！再来一次！'],
    thinking: ['让我想想…', '唔…这是个好问题', '（努力思考中）', '嗯……然后呢？'],
    eat: ['嗷呜，好吃！', '谢谢投喂～', '还要还要！', '饭饭最香了'],
    wake: ['唔…我睡着了吗？', '哈欠…我起来啦', '叫我有什么事呀～'],
    dragged: ['放我下来！', '哇，要飞起来啦', '哇啊啊，救命——']
  });

  /** 闲置自言自语池：长时间没互动时随机冒一条（不算语音回复，纯气氛） */
  const IDLE_CHATTER = Object.freeze([
    '桌面上好安静呀…',
    '陪我玩嘛～',
    '（盯着鼠标光标看）',
    '要不要说说话呀？',
    '今天心情不错！',
    '（在数屏幕上的图标）',
    '有话就跟小蓝说哦～'
  ]);

  /** 自言自语间隔范围（毫秒）：约 2~5 分钟 */
  const CHATTER_MIN_MS = 120000;
  const CHATTER_RANGE_MS = 180000;

  /**
   * 从反应台词池里随机挑一句（池不存在或为空返回空串）。
   * @param {string} action
   * @returns {string}
   */
  function pickQuip(action) {
    const pool = REACTION_QUIPS[action];
    if (!pool || pool.length === 0) return '';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ---- 阶段 4：连续语音对话 ---- */

  /** VAD 正常运行时的扫描间隔（毫秒）：约 50Hz，足够细又不烧 CPU */
  const VAD_FRAME_MS = 20;
  /** 30 秒没人说话后进入低采样监测的扫描间隔（毫秒）：约 10Hz，省 CPU */
  const VAD_IDLE_FRAME_MS = 100;
  /** 语音段最长 30 秒（与官方 ASR 限制一致；超了由 VAD 自动切段） */
  const VAD_MAX_SEGMENT_MS = 30000;
  /** 语音段编码后字节上限（官方文件上限 25MB，留出余量） */
  const VAD_MAX_SEGMENT_BYTES = 20 * 1024 * 1024;
  /** 气泡默认显示时长：字幕跟语音同步，状态提示短暂显示 */
  const BUBBLE_CAPTION_MS = 6000;
  const BUBBLE_NOTICE_MS = 3200;

  /** 状态 → 读屏用的中文说明（不可见文字，不是屏幕气泡） */
  const STATE_A11Y_TEXT = Object.freeze({
    idle: '待机',
    blink: '眨了下眼',
    eat: '在吃白米饭（她的最爱）',
    happy: '很开心',
    hungry: '肚子饿了',
    sleep: '睡着了',
    talking: '在说话（语音尚未接入）',
    thinking: '在发呆',
    dragged: '被拖着走',
    poke: '被戳了一下',
    pet: '被摸头了',
    swim: '在跑步',
    flip: '翻了个身',
    greet: '在打招呼',
    angry: '饿得生气了',
    wake: '醒过来了'
  });

  /* ---------------------------------------------------------------------- */
  /* 运行时状态                                                              */
  /* ---------------------------------------------------------------------- */

  /** 已应用的可见状态类（null 表示还没应用过） */
  let currentVisible = null;
  /** 已应用的持久模式类 */
  let appliedMode = null;
  /** 指针交互数据 */
  let pointerState = null;
  /** 定时器句柄 */
  let idleActionTimer = 0;
  let swimTimer = 0;
  let chatterTimer = 0;
  let petDwellTimer = 0;
  let greetFallbackTimer = 0;
  /** 鼠标穿透探测节流 */
  let lastHoverProbe = 0;
  /** 最近一次上报给主进程的穿透状态，避免重复 IPC */
  let lastIgnoreSent = null;
  /** 摸头：当前悬停在鱼头上的轨迹 */
  let headDwell = null;
  /** 摸头：是否已经"离开鱼头重新计数"（防止悬停不动时无限触发） */
  let petArmed = true;
  /** 摸头：上次触发时间 */
  let lastPetAt = 0;
  /** 连摸计时（8 秒窗口内摸满 3 次触发 greet） */
  let petComboTimes = [];
  /** 本次游动朝向（left / right） */
  let swimDirection = null;
  /** 主进程是否已经下发过启动打招呼（避免重复打招呼） */
  let greetSeen = false;

  /* ---- 阶段 4：语音链路运行时状态 ---- */

  /** AudioContext（只建一次；关麦时 suspend，退出时 close） */
  let audioContext = null;
  /** 麦克风 MediaStream（关麦时必须 stop 掉每条 track） */
  let micStream = null;
  /** 分析节点：用来每一帧取 RMS 喂给 VAD */
  let analyserNode = null;
  /** 取时域样本的复用缓冲 */
  let analyserBuffer = null;
  /** MediaRecorder（录 webm/opus，断句后解码成 16kHz 单声道 wav） */
  let mediaRecorder = null;
  /** 当前语音段收集到的数据块 */
  let recordedChunks = [];
  /** 当前语音段累积的编码字节数（VAD 的体积上限判定用） */
  let recordedBytes = 0;
  /** VAD 扫描定时器 */
  let vadTimer = 0;
  /** 当前扫描间隔（正常 / 低采样） */
  let vadFrameMs = VAD_FRAME_MS;
  /** 最近一次"还没人说话"的计时起点（用于 30 秒空闲判定） */
  let lastVoiceSeenAt = Date.now();
  /** 是否已经进入低采样空闲监测 */
  let vadLowRate = false;
  /** 气泡隐藏定时器 */
  let bubbleTimer = 0;
  /** 语音设置（由主进程下发；默认值与设置存储一致） */
  let voiceSettings = {
    micEnabled: true,
    vadSensitivity: 0.5,
    vadSilenceMs: 800,
    ttsVoice: 'tongtong',
    volume: 0.8,
    subtitleMode: false
  };
  /** 正在播放的 TTS 音频（ObjectURL 用完必须 revoke） */
  let activeAudio = null;
  let activeAudioUrl = null;
  /** 正在播放的 WebAudio 源节点与增益节点 */
  let activeSource = null;
  let activeGain = null;
  /** 回合管理器（阶段 4 的免按键连续对话） */
  let turnTaking = null;
  /** 本地 VAD 实例 */
  let vad = null;

  /* ---------------------------------------------------------------------- */
  /* 状态机接线                                                              */
  /* ---------------------------------------------------------------------- */

  const machine = createStateMachine({
    onChange: (visible, info) => applyVisibleState(visible, info),
    onActionEnd: (name) => {
      // 吃完 → 开心：这是"喂饭"闭环的最后一段
      if (name === 'eat') {
        machine.request('happy', { source: 'system' });
      }
    }
  });

  /**
   * 把状态机的可见状态 / 持久模式映射到 DOM 类上。
   * @param {string} visible
   * @param {{reason?: string, previous?: string}} info
   */
  function applyVisibleState(visible, info) {
    const reason = info && typeof info.reason === 'string' ? info.reason : '';
    const base = machine.getBase();
    const stateChanged = visible !== currentVisible;
    const isRestart = reason.indexOf('restart') === 0;

    // 持久模式的类只在真的变了的时候动，避免每次眨眼都重启漂浮动画（会看到一顿）
    if (base !== appliedMode) {
      stage.classList.remove(...MODE_CLASSES);
      stage.classList.add('mode-' + base);
      appliedMode = base;
    }

    if (stateChanged) {
      stage.classList.remove(...STATE_CLASSES);
      // 触发一次重排：同一个状态连续触发时动画也能从头播
      void stage.offsetWidth;
      stage.classList.add('state-' + visible);
      currentVisible = visible;
    } else if (isRestart) {
      stage.classList.remove('state-' + visible);
      void stage.offsetWidth;
      stage.classList.add('state-' + visible);
    }

    applySwimDirection();
    applyExpression(visible);

    // 无障碍状态文本：屏幕上看不见，只给读屏用（不是台词气泡）
    const text = STATE_A11Y_TEXT[visible] || visible;
    a11yStatus.textContent = '当前状态：' + text;

    // 只读回报给主进程（托盘 tooltip）
    Promise.resolve(bridge.reportState(visible)).catch(() => {});
  }

  /** 游动时给舞台加上朝向类（CSS 用它决定鱼身倾斜与水泡方向） */
  function applySwimDirection() {
    stage.classList.remove(...SWIM_DIR_CLASSES);
    if (machine.getVisible() === 'swim' && swimDirection) {
      stage.classList.add('swim-' + swimDirection);
    }
  }

  /** 表情图探测结果缓存：true=可用，false=文件缺失（永久回退基础图） */
  const expressionAvailability = Object.create(null);

  /**
   * 按可见状态切换人物表情图。
   * 表情文件缺失时探测一次即永久回退基础图，绝不反复加载坏路径。
   * @param {string} visible 状态机当前可见状态
   */
  function applyExpression(visible) {
    if (!petImage) return;
    const key = STATE_EXPRESSION[visible] || 'base';
    const file = EXPRESSION_FILES[key] || EXPRESSION_FILES.base;
    if (petImage.getAttribute('href') === file) return;

    if (key === 'base' || expressionAvailability[key]) {
      petImage.setAttribute('href', file);
      petImage.setAttribute('xlink:href', file);
      return;
    }
    if (expressionAvailability[key] === false) {
      applyExpression('base-fallback');
      return;
    }
    // 首次使用该表情：先探测文件是否真的存在
    const probe = new Image();
    probe.onload = () => {
      expressionAvailability[key] = true;
      // 探测期间状态可能已经变了，只有仍然需要这个表情时才切换
      if ((STATE_EXPRESSION[machine.getVisible()] || 'base') === key) {
        petImage.setAttribute('href', file);
        petImage.setAttribute('xlink:href', file);
      }
    };
    probe.onerror = () => {
      expressionAvailability[key] = false;
      if (petImage.getAttribute('href') !== EXPRESSION_FILES.base) {
        applyExpression('base-fallback');
      }
    };
    probe.src = file;
  }

  /**
   * 只更新无障碍状态文本（不改变动作、不播口型）。
   *
   * 阶段 2 没有 TTS：这里**绝不**触发 talking。需求要求"说话默认走语音、禁止只有
   * 文字 / 无声说话"，如果在情绪变化时自动切 talking，鱼就会无声张嘴 —— 那正是
   * 本条修复要根除的行为。后续真实语音到位后，由明确的 TTS hook 调用 beginSpeech()
   * 驱动 talking，而不是由 announce() 猜一个时长。
   * @param {string} text 读屏文本（屏幕上不可见）
   */
  function announce(text) {
    const visible = machine.getVisible();
    const visibleText = STATE_A11Y_TEXT[visible] || visible;
    a11yStatus.textContent = text ? `当前状态：${visibleText}。${text}` : `当前状态：${visibleText}`;
  }

  /**
   * 用户直接交互触发的动作。
   * 睡着的鱼被直接碰：先把持久模式切回"当前情绪"（饿了就继续饿着，不硬编码 idle），
   * 这样睡觉既不会被 idle 顶掉，醒了以后情绪也不会丢。
   * @param {string} name
   * @param {{duration?: number}} [options]
   */
  function userAction(name, options) {
    if (machine.isSleeping()) {
      machine.setBase(fullness.getMood(), { source: 'user' });
    }
    const result = machine.request(name, Object.assign({ source: 'user' }, options || {}));
    // 互动台词气泡（VPet 桌宠模拟器风格）：动作被接受就随机冒一句
    if (result && result.accepted) {
      const quip = pickQuip(name);
      if (quip) showBubble(quip, 'info', 2200);
    }
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* 饱食度                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * localStorage 适配器：任何一次访问失败（沙箱限制 / 配额 / 隐私模式）都静默降级，
   * 只影响"跨次启动记忆"，绝不让桌宠本体报错。
   * 存储内容只有饱食度与两个时间戳，不含任何密钥或隐私数据。
   * @param {string} key
   */
  function createLocalStorageAdapter(key) {
    let memory = null;
    return {
      read() {
        try {
          const value = window.localStorage.getItem(key);
          return value === null ? memory : value;
        } catch (error) {
          return memory;
        }
      },
      write(text) {
        memory = text;
        try {
          window.localStorage.setItem(key, text);
        } catch (error) {
          // 降级为仅内存：本次会话仍然有效
        }
      },
      clear() {
        memory = null;
        try {
          window.localStorage.removeItem(key);
        } catch (error) {
          // 忽略
        }
      }
    };
  }

  const MOOD_A11Y_TEXT = Object.freeze({
    idle: '肚子饱饱的',
    hungry: '肚子饿了，想吃白米饭',
    angry: '饿太久了，有点生气'
  });

  const fullness = fullnessLogic.createFullness({
    storage: createLocalStorageAdapter(fullnessLogic.FULLNESS.STORAGE_KEY),
    clock: () => Date.now(),
    tickMs: fullnessLogic.FULLNESS.TICK_MS,
    onChange: (info) => {
      const moodText = MOOD_A11Y_TEXT[info.mood] || '';
      // 睡觉期间：饱食度照常随真实时间下降，但既不切持久模式、也不做任何会吵醒鱼的动作。
      // 状态机已把"睡觉中 mood 改持久模式"收紧为拒绝，这里依然提前 return，保持语义清晰。
      if (machine.isSleeping()) {
        announce(moodText);
        return;
      }
      machine.setBase(info.mood, { source: 'mood' });
      // 情绪变化只更新不可见的 aria-live 文本（读屏可读、屏幕不可见）。
      // 阶段 2 没有 TTS，绝不在这里触发 talking：否则会出现"无声张嘴"，
      // 违反需求「表达默认走语音、禁止只有文字 / 无声说话」。
      announce(moodText);
    }
  });

  /** 菜单「喂饭」：重置饱食度 → 播 eat（约 3 秒）→ 状态机自动串到 happy */
  function feedFromMenu() {
    if (machine.isSleeping()) {
      machine.setBase(fullness.getMood(), { source: 'user' });
    }
    fullness.feed();
    const result = machine.request('eat', { source: 'user' });
    if (!result.accepted) {
      // 理论上不会发生（eat 是最高优先级的用户动作之一），留个日志方便排查
      console.warn('[喂饭] eat 未被接受：', result.reason);
    }
    announce('吃到白米饭了');
    return result;
  }

  /** 菜单「睡觉」 */
  function sleepFromMenu() {
    const result = machine.setBase('sleep', { source: 'user' });
    if (result.accepted) {
      announce('睡着了');
    }
    return result;
  }

  /** 菜单「叫醒」：醒来的底色 = 当前情绪（饿着醒来会继续 hungry / angry） */
  function wakeFromMenu() {
    if (machine.isSleeping()) {
      machine.setBase(fullness.getMood(), { source: 'user' });
    }
    const result = machine.request('wake', { source: 'user' });
    announce('醒过来了');
    if (result && result.accepted) {
      const quip = pickQuip('wake');
      if (quip) showBubble(quip, 'info', 2200);
    }
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /* 跑动：只发请求，坐标与限幅全在主进程                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * 请求主进程跑动一次，并在渲染层播对应的 run 跑步动画。
   * @param {'random'|'user'|'system'} source
   */
  function requestSwim(source) {
    if (!canRunRandom()) return;
    clearSwimDirection();
    Promise.resolve(bridge.requestSwim())
      .then((result) => {
        if (!result || result.ok !== true) return;
        // 请求期间可能被拖拽 / 隐藏打断，这里再确认一次
        if (!canRunRandom()) return;
        const accepted = machine.request('swim', {
          source: source || 'user',
          duration: result.durationMs
        });
        if (accepted.accepted) {
          swimDirection = result.direction === 'left' ? 'left' : 'right';
          applySwimDirection();
        }
      })
      .catch(() => {
        // IPC 失败（窗口刚好被销毁等）不需要打扰用户，安静跳过
      });
  }

  function clearSwimDirection() {
    swimDirection = null;
    stage.classList.remove(...SWIM_DIR_CLASSES);
  }

  /* ---------------------------------------------------------------------- */
  /* 随机行为调度                                                            */
  /* ---------------------------------------------------------------------- */

  /** 随机动作是否允许：窗口可见、没有直接交互、状态机也没在忙 / 没在睡觉 */
  function canRunRandom() {
    if (document.hidden) return false;
    if (pointerState) return false;
    return machine.canRunRandom();
  }

  function scheduleIdleAction() {
    window.clearTimeout(idleActionTimer);
    idleActionTimer = window.setTimeout(() => {
      idleActionTimer = 0;
      if (canRunRandom()) {
        // 发呆多一点，偶尔翻个身 / 自己开心一下 / 自己挥挥手（VPet 式自娱自乐）
        const pool = ['thinking', 'thinking', 'flip', 'happy', 'greet', 'greet'];
        const pick = pool[Math.floor(Math.random() * pool.length)];
        machine.request(pick, { source: 'random' });
      }
      scheduleIdleAction();
    }, IDLE_ACTION_MIN_MS + Math.random() * IDLE_ACTION_RANGE_MS);
  }

  /** 闲置自言自语：长时间没互动时随机冒一条台词气泡（睡觉 / 忙时不打扰） */
  function scheduleChatter() {
    window.clearTimeout(chatterTimer);
    chatterTimer = window.setTimeout(() => {
      chatterTimer = 0;
      if (canRunRandom() && !machine.isSleeping()) {
        const pick = IDLE_CHATTER[Math.floor(Math.random() * IDLE_CHATTER.length)];
        showBubble(pick, 'info', 2600);
      }
      scheduleChatter();
    }, CHATTER_MIN_MS + Math.random() * CHATTER_RANGE_MS);
  }

  function scheduleSwim() {
    window.clearTimeout(swimTimer);
    swimTimer = window.setTimeout(() => {
      swimTimer = 0;
      requestSwim('random');
      scheduleSwim();
    }, SWIM_MIN_MS + Math.random() * SWIM_RANGE_MS);
  }

  /* ---------------------------------------------------------------------- */
  /* 鼠标穿透联动                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * 判断屏幕坐标是否落在鱼的实际图形上。
   * 说明：窗口开启了 forward 的 setIgnoreMouseEvents，所以即使处于穿透状态，
   * 渲染层依然能收到 mousemove。
   * @param {number} x
   * @param {number} y
   */
  function isOverFish(x, y) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return false;
    }
    const target = document.elementFromPoint(x, y);
    return Boolean(target && target.closest && target.closest(INTERACTIVE_SELECTOR));
  }

  /**
   * 按点击部位给出反应（2026-10-05 第二版：反应池轮换）。
   *
   * 第一版的问题：头 / 脸 / 胸口这一大片最容易点到的地方全映射到同一个
   * poke（惊讶），用户怎么点都是同一个反应。现在每个部位配一个反应池，
   * 连续点同一个部位会轮流换动作，不同部位之间也各有偏好：
   *   - 睡觉时点她 → 被叫醒（wake）
   *   - 900ms 内连点 3 下 → 被点晕了，转个圈（flip）
   *   - 头 → 害羞（pet）→ 惊讶（poke）→ 打招呼（greet）轮换
   *   - 脸 → 惊讶（poke）→ 害羞（pet）→ 歪头疑问（thinking）轮换
   *   - 肚子 → 咯吱笑（happy）→ 打招呼（greet）→ 惊讶（poke）轮换
   *   - 手 → 挥手打招呼（greet）→ 开心（happy）→ 害羞（pet）轮换
   *   - 脚 → 转圈（flip）→ 开心（happy）→ 惊讶（poke）轮换
   *   - 其它 → 惊讶 / 疑问 / 转圈轮换
   */
  const TAP_POOLS = Object.freeze({
    head: ['pet', 'poke', 'greet'],
    face: ['poke', 'pet', 'thinking'],
    belly: ['happy', 'greet', 'poke'],
    hands: ['greet', 'happy', 'pet'],
    feet: ['flip', 'happy', 'poke'],
    other: ['poke', 'thinking', 'flip']
  });

  /** 每个部位已轮换到的反应下标（连续点同一部位时依次换动作） */
  const tapZoneIndex = Object.create(null);

  function pickTapAction(zoneKey) {
    const pool = TAP_POOLS[zoneKey] || TAP_POOLS.other;
    const idx = tapZoneIndex[zoneKey] || 0;
    tapZoneIndex[zoneKey] = (idx + 1) % pool.length;
    return pool[idx];
  }

  /**
   * 点击打击特效：在点击位置炸开一圈星星光环（tap-pop 动画由 CSS 提供）。
   * 屏幕坐标 → SVG 用户坐标用 getScreenCTM 逆矩阵换算，窗口缩放后依然落点准确。
   */
  function playTapFx(x, y) {
    if (!tapFxGroup) return;
    const svg = document.getElementById('fish-svg');
    if (!svg || typeof svg.getScreenCTM !== 'function') return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const loc = pt.matrixTransform(ctm.inverse());
    tapFxGroup.setAttribute('transform', 'translate(' + loc.x.toFixed(1) + ' ' + loc.y.toFixed(1) + ')');
    tapFxGroup.classList.remove('pop');
    void tapFxGroup.getBoundingClientRect(); // 强制重排，保证连点时动画能重新触发
    tapFxGroup.classList.add('pop');
    window.clearTimeout(tapFxTimer);
    tapFxTimer = window.setTimeout(() => tapFxGroup.classList.remove('pop'), 520);
  }

  function reactToTap(x, y) {
    playTapFx(x, y);
    if (machine.isSleeping()) {
      wakeFromMenu();
      return;
    }
    const now = window.performance.now();
    tapTimes = tapTimes.filter((t) => now - t < 900);
    tapTimes.push(now);
    if (tapTimes.length >= 3) {
      tapTimes = [];
      userAction('flip');
      return;
    }
    const target = document.elementFromPoint(x, y);
    const zone = target && target.closest
      ? target.closest('#fish-svg #feet, #fish-svg #hands, #fish-svg #belly, #fish-svg #face')
      : null;
    let zoneKey = 'other';
    if (zone) {
      zoneKey = zone.id;
    } else if (isOverHead(x, y)) {
      // 点在头上（#eyes 命中区）——第一版这里会落进"其它"里变成惊讶
      zoneKey = 'head';
    }
    userAction(pickTapAction(zoneKey));
  }

  /**
   * 判断是否落在"鱼头"范围（眼睛一带）。
   * 用眼睛元素的实际矩形外扩一点算出来，缩放 / 位置变化都不会算错。
   * @param {number} x
   * @param {number} y
   */
  function isOverHead(x, y) {
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const target = document.elementFromPoint(x, y);
    if (!target || !target.closest) return false;
    if (target.closest('#fish-svg #eyes')) return true;
    if (!target.closest(INTERACTIVE_SELECTOR)) return false;

    const rect = eyesGroup ? eyesGroup.getBoundingClientRect() : null;
    if (!rect || rect.height <= 0) {
      return y < window.innerHeight * 0.5;
    }
    const padX = rect.width * 0.5;
    const padTop = rect.height * 1.2;
    const padBottom = rect.height * 0.6;
    return (
      x >= rect.left - padX &&
      x <= rect.right + padX &&
      y >= rect.top - padTop &&
      y <= rect.bottom + padBottom
    );
  }

  /**
   * 通知主进程开关鼠标穿透，做去重避免频繁 IPC。
   * @param {boolean} ignore
   */
  function requestIgnoreMouse(ignore) {
    if (lastIgnoreSent === ignore) return;
    lastIgnoreSent = ignore;
    Promise.resolve(bridge.setIgnoreMouseEvents(ignore)).catch(() => {});
  }

  function handleHoverProbe(clientX, clientY) {
    const now = window.performance.now();
    if (now - lastHoverProbe < HOVER_PROBE_MS) return;
    lastHoverProbe = now;

    // 拖拽中必须保持可接收鼠标事件
    if (pointerState && pointerState.dragging) {
      requestIgnoreMouse(false);
      return;
    }
    requestIgnoreMouse(!isOverFish(clientX, clientY));
  }

  /* ---------------------------------------------------------------------- */
  /* 摸头（pet）：在鱼头上停留或来回滑动                                      */
  /* ---------------------------------------------------------------------- */

  function clearPetDwell(rearm) {
    if (petDwellTimer) {
      window.clearTimeout(petDwellTimer);
      petDwellTimer = 0;
    }
    headDwell = null;
    if (rearm !== false) {
      petArmed = true;
    }
  }

  function triggerPet() {
    const now = window.performance.now();
    if (!petArmed) return;
    if (pointerState) return;
    if (now - lastPetAt < PET_COOLDOWN_MS) return;

    petArmed = false;
    lastPetAt = now;
    clearPetDwell(false);
    // 连摸彩蛋：8 秒内摸满 3 次，她开心地跟你打招呼
    petComboTimes = petComboTimes.filter((t) => now - t < 8000);
    petComboTimes.push(now);
    if (petComboTimes.length >= 3) {
      petComboTimes = [];
      userAction('greet');
      return;
    }
    userAction('pet');
  }

  /**
   * 每次鼠标移动时更新"摸头"判定：
   *   - 在鱼头上停留超过 PET_DWELL_MS → pet
   *   - 在鱼头上滑动累计超过 PET_SWIPE_PX → pet
   * 触发后必须先把鼠标移出鱼头才会再次计数，避免悬停不动时反复触发。
   */
  function trackPetHover(clientX, clientY) {
    if (pointerState) {
      clearPetDwell(false);
      return;
    }
    if (!isOverHead(clientX, clientY)) {
      clearPetDwell();
      return;
    }
    if (!headDwell) {
      headDwell = { x: clientX, y: clientY, travelled: 0 };
      petDwellTimer = window.setTimeout(() => {
        petDwellTimer = 0;
        triggerPet();
      }, PET_DWELL_MS);
      return;
    }
    headDwell.travelled += Math.hypot(clientX - headDwell.x, clientY - headDwell.y);
    headDwell.x = clientX;
    headDwell.y = clientY;
    if (headDwell.travelled >= PET_SWIPE_PX) {
      triggerPet();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 指针交互：拖拽 / 双击 / 戳                                              */
  /* ---------------------------------------------------------------------- */

  function onPointerDown(event) {
    // 只处理左键；右键交给 contextmenu 处理
    if (event.button !== 0) return;
    const target = event.target;
    if (!target || !target.closest || !target.closest(INTERACTIVE_SELECTOR)) return;

    event.preventDefault();
    clearPetDwell(false);
    stage.classList.add('is-dragging');
    // 先无条件取消穿透，保证后续 pointermove 不会丢
    requestIgnoreMouse(false);

    pointerState = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      // 指针相对窗口左上角的偏移：拖拽时用它换算窗口位置
      offsetX: event.clientX,
      offsetY: event.clientY,
      startedAt: window.performance.now(),
      dragging: false,
      moved: false
    };

    try {
      fishSvg.setPointerCapture(event.pointerId);
    } catch (error) {
      // 个别环境下 setPointerCapture 可能失败，不影响后续逻辑（主进程按屏幕坐标移动）
    }

    // 长按（1.2s 不动不拖）→ 她疑惑你在干什么
    longPressFired = false;
    if (longPressTimer) window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0;
      if (pointerState && !pointerState.dragging && !pointerState.moved) {
        longPressFired = true;
        userAction('thinking');
      }
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event) {
    // 非拖拽状态：做穿透探测 + 摸头判定
    if (!pointerState || pointerState.pointerId !== event.pointerId) {
      handleHoverProbe(event.clientX, event.clientY);
      trackPetHover(event.clientX, event.clientY);
      return;
    }

    const dxScreen = Math.abs(event.screenX - pointerState.startScreenX);
    const dyScreen = Math.abs(event.screenY - pointerState.startScreenY);
    const movedEnough = dxScreen > DRAG_DISTANCE_PX || dyScreen > DRAG_DISTANCE_PX;

    if (movedEnough) {
      pointerState.moved = true;
    }

    if (!pointerState.dragging && movedEnough) {
      pointerState.dragging = true;
      // 开始拖拽：长按"疑惑"计时作废
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = 0;
      }
      // 拖拽开始：主进程负责移动窗口（并会顺手停掉正在进行的游动），
      // 渲染层切成 dragged 状态（挣扎扭动 + 冒汗）。
      Promise.resolve(bridge.dragStart({ dx: pointerState.offsetX, dy: pointerState.offsetY })).catch(() => {});
      if (machine.getVisible() === 'swim') {
        clearSwimDirection();
      }
      machine.request('dragged', { source: 'user' });
      // 拖拽台词：被拎起来要抗议（VPet 式挣扎反馈）
      const dragQuip = pickQuip('dragged');
      if (dragQuip) showBubble(dragQuip, 'info', 1600);
    }

    if (pointerState.dragging) {
      Promise.resolve(bridge.dragMove({ x: event.screenX, y: event.screenY })).catch(() => {});
    }
  }

  function onPointerUp(event) {
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;

    const heldMs = window.performance.now() - pointerState.startedAt;
    const wasDragging = pointerState.dragging;
    const moved = pointerState.moved;

    try {
      fishSvg.releasePointerCapture(event.pointerId);
    } catch (error) {
      // 忽略：可能未成功捕获过指针
    }

    stage.classList.remove('is-dragging');
    pointerState = null;

    if (wasDragging) {
      Promise.resolve(bridge.dragEnd()).catch(() => {});
      // 松手：退出 dragged，回落到当前持久模式（情绪不会被拖拽改掉）
      machine.releaseHold();
      // 拖拽结束后恢复穿透判断，并按当前光标位置决定是否继续拦截
      lastIgnoreSent = null;
      requestIgnoreMouse(!isOverFish(event.clientX, event.clientY));
      return;
    }

    // 没怎么动 + 按得不久 = 点了一下：按部位给不同反应（长按已触发过反应的除外）
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
    if (!longPressFired) {
      if (!moved && heldMs <= CLICK_MAX_MS) {
        reactToTap(event.clientX, event.clientY);
      } else if (heldMs > CLICK_MAX_MS && !moved) {
        // 长时间按住但没移动：也算被戳（避免"按住不放"什么反应都没有）
        reactToTap(event.clientX, event.clientY);
      }
    }
  }

  function onPointerCancel(event) {
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;
    stage.classList.remove('is-dragging');
    pointerState = null;
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
    Promise.resolve(bridge.dragEnd()).catch(() => {});
    machine.releaseHold();
    lastIgnoreSent = null;
    requestIgnoreMouse(true);
  }

  /**
   * 双击鱼的可见图形：触发打招呼。
   * 注意：双击也必须是"非拖拽"，所以这里判断指针是否已经进入拖拽态。
   */
  function onDoubleClick(event) {
    const target = event.target;
    if (!target || !target.closest || !target.closest(INTERACTIVE_SELECTOR)) return;
    event.preventDefault();
    if (pointerState && pointerState.dragging) return;
    userAction('greet');
  }

  /** 右键：弹出与托盘完全一致的菜单 */
  function onContextMenu(event) {
    event.preventDefault();
    Promise.resolve(bridge.showContextMenu()).catch(() => {});
  }

  /* ---------------------------------------------------------------------- */
  /* 事件绑定                                                                */
  /* ---------------------------------------------------------------------- */

  document.addEventListener('pointerdown', onPointerDown, { passive: false });
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('dblclick', onDoubleClick);
  document.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerleave', () => clearPetDwell());

  // 页面隐藏（收进托盘）/ 关闭前：结束拖拽、停掉短暂动作、把饱食度落盘
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    clearPetDwell();
    if (pointerState) {
      pointerState = null;
      stage.classList.remove('is-dragging');
      Promise.resolve(bridge.dragEnd()).catch(() => {});
      machine.releaseHold();
      lastIgnoreSent = null;
      requestIgnoreMouse(true);
    }
    // 隐藏时把正在播的动作收回底色（不会改情绪，也不会把睡着的鱼吵醒）
    machine.cancelAction('hidden');
    fullness.save();
    // 阶段 4：**不主动停麦** —— 需求要求"窗口收进托盘时语音仍按 micEnabled 运行"。
    // 但会把正在播的语音停掉，并把语音段录制缓冲清干净（避免把隐藏期间的声音
    // 拼进下一段）。想彻底静音请用菜单「语音对话」或设置页关掉麦克风。
    stopPlayback();
    resetRecording();
  });

  window.addEventListener('pagehide', () => {
    machine.cancelAction('pagehide');
    machine.dispose();
    fullness.save();
    // 阶段 4：真正退出时必须清干净（麦克风 track / AudioContext / 录制器 / 定时器 / ObjectURL）
    disposeVoice();
  });

  // 主进程下发的动作（托盘菜单 / 启动打招呼 / 窗口复位）
  bridge.onAction((state, options) => {
    const duration = options && Number.isFinite(options.durationMs) ? options.durationMs : undefined;

    switch (state) {
      case 'idle':
        // 主进程在"窗口收进托盘"时下发：只回收正在播的动作，回到底色。
        // 绝不把持久模式改成 idle —— 否则睡觉会被 idle 顶掉、饿着的鱼会突然不饿。
        machine.cancelAction('main-idle');
        return;
      case 'sleep':
        sleepFromMenu();
        return;
      case 'wake':
        wakeFromMenu();
        return;
      case 'eat':
        // 主进程若直接下发 eat（非 FEED 事件），按"吃饭动画"处理，不重置饱食度
        userAction('eat', { duration });
        return;
      case 'swim':
        requestSwim('system');
        return;
      case 'greet':
        greetSeen = true;
        userAction('greet', { duration });
        return;
      default:
        userAction(state, { duration });
    }
  });

  // 主进程下发的「喂饭」：饱食度重置 100 → eat → happy
  bridge.onFeed(() => {
    feedFromMenu();
  });

  /* ---------------------------------------------------------------------- */
  /* 阶段 4：语音事件订阅（全部是主进程 → 渲染层的窄通知）                        */
  /* ---------------------------------------------------------------------- */

  // 轻量气泡（错误 / 麦克风状态）：默认可见，但绝不弹窗、绝不打断动画
  if (typeof bridge.onVoiceBubble === 'function') {
    bridge.onVoiceBubble((payload) => {
      const kind = payload.kind === 'error' ? 'error' : payload.kind === 'warn' ? 'warn' : 'info';
      showBubble(payload.text, kind);
    });
  }

  // 开关麦克风（菜单「语音对话」/ 全局 Ctrl+Shift+V）
  if (typeof bridge.onVoiceToggleMic === 'function') {
    bridge.onVoiceToggleMic((payload) => {
      if (!turnTaking) return;
      const want = payload && payload.micEnabled === true;
      turnTaking.setMicEnabled(want).then((result) => {
        if (result && result.ok && result.enabled) {
          lastVoiceSeenAt = Date.now();
          vadLowRate = false;
          scheduleVadTick();
        }
      });
    });
  }

  // 语音设置变更（设置页保存后主进程广播；只含非敏感字段）
  if (typeof bridge.onVoiceSettings === 'function') {
    bridge.onVoiceSettings((settings) => {
      applyVoiceSettings(settings);
    });
  }

  // 主进程要求用本机 speechSynthesis 播报（三级降级的最后一级）
  if (typeof bridge.onVoiceSpeakText === 'function') {
    bridge.onVoiceSpeakText((payload) => {
      // 这里不会与回合管理器抢麦：主进程走到这条路径时回合已经在 speaking 状态
      speakWithSpeechSynthesis(payload.text).catch(() => {});
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 阶段 4：字客气泡（默认只显示错误 / 麦克风状态；字幕模式才显示回复）           */
  /* ---------------------------------------------------------------------- */

  /**
   * 显示一条气泡。
   *
   * 需求约束：**回复默认只通过语音说出**，文字气泡只有在设置里打开「字幕模式」
   * 之后才显示；只有"错误提示 / 麦克风状态"允许默认可见。
   * 所以：
   *   - `kind === 'caption'`（跟随语音的字幕）**必须** `caption !== false` 才显示；
   *   - 错误 / 警告 / 状态提示可以默认显示，但都是轻量气泡，绝不弹窗。
   *
   * @param {string} text
   * @param {'caption'|'info'|'warn'|'error'} kind
   * @param {number} [durationMs]
   */
  function showBubble(text, kind, durationMs) {
    if (!speechBubble || !speechBubbleText) return;
    if (typeof text !== 'string' || text.length === 0) return;
    const isCaption = kind === 'caption';
    if (isCaption && voiceSettings.subtitleMode !== true) {
      // 字幕模式没打开：语音照播，但不显示这段文字
      return;
    }

    speechBubbleText.textContent = text;
    speechBubble.classList.remove('bubble-hidden', 'bubble-caption', 'bubble-info', 'bubble-warn', 'bubble-error');
    speechBubble.classList.add('bubble-' + (isCaption ? 'caption' : kind || 'info'));
    speechBubble.setAttribute('aria-hidden', 'false');

    if (bubbleTimer) {
      window.clearTimeout(bubbleTimer);
      bubbleTimer = 0;
    }
    const ms = Number.isFinite(durationMs)
      ? durationMs
      : isCaption
        ? BUBBLE_CAPTION_MS
        : BUBBLE_NOTICE_MS;
    bubbleTimer = window.setTimeout(() => {
      bubbleTimer = 0;
      hideBubble();
    }, ms);
  }

  /** 隐藏气泡（不是删除 DOM，只是加回隐藏类） */
  function hideBubble() {
    if (!speechBubble) return;
    speechBubble.classList.add('bubble-hidden');
    speechBubble.setAttribute('aria-hidden', 'true');
    if (speechBubbleText) speechBubbleText.textContent = '';
  }

  /* ---------------------------------------------------------------------- */
  /* 阶段 4：音频采集（getUserMedia + Analyser + MediaRecorder）                */
  /* ---------------------------------------------------------------------- */

  /**
   * 建立 / 恢复 AudioContext 与麦克风流。
   *
   * 硬性要求（需求）：
   *   - **只取音频**：`{audio: {...}}`，并且强制
   *     `echoCancellation / noiseSuppression / autoGainControl` 全为 true，
   *     用来压制扬声器回声（防鱼"自言自语"）与键盘背景音；
   *   - 权限被拒 / 没有设备：返回明确原因，由上层给一次轻量提示（不反复弹框）。
   *
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function acquireMic() {
    if (micStream && micStream.active) return { ok: true };
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return { ok: false, reason: 'no-device' };
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
    } catch (error) {
      const name = error && error.name ? String(error.name) : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { ok: false, reason: 'permission-denied' };
      }
      return { ok: false, reason: 'mic-error' };
    }

    try {
      if (!audioContext) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        audioContext = new Ctor();
      }
      if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
        await audioContext.resume();
      }
      const source = audioContext.createMediaStreamSource(micStream);
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0;
      analyserBuffer = new Float32Array(analyserNode.fftSize);
      source.connect(analyserNode);
    } catch (error) {
      return { ok: false, reason: 'audio-graph-failed' };
    }

    return { ok: true };
  }

  /** 彻底停掉麦克风与音频图（TTS 播放前、关麦、退出时都调用） */
  function releaseMic() {
    stopRecorder();
    try {
      if (micStream) {
        for (const track of micStream.getTracks()) {
          track.stop();
        }
      }
    } catch (error) {
      // 忽略
    }
    micStream = null;
    analyserNode = null;
    analyserBuffer = null;
    if (vad) vad.stop(Date.now());
    if (audioContext && typeof audioContext.suspend === 'function') {
      Promise.resolve(audioContext.suspend()).catch(() => {});
    }
  }

  /** 重置当前语音段的录制缓冲 */
  function resetRecording() {
    recordedChunks = [];
    recordedBytes = 0;
  }

  /** 开始录制这一段的 webm 分片 */
  function startRecorder() {
    resetRecording();
    if (typeof window.MediaRecorder !== 'function' || !micStream) return false;
    try {
      mediaRecorder = new window.MediaRecorder(micStream);
      mediaRecorder.ondataavailable = (event) => {
        if (event && event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
          recordedBytes += event.data.size;
        }
      };
      mediaRecorder.start(120);
      return true;
    } catch (error) {
      mediaRecorder = null;
      return false;
    }
  }

  /** 停止录制（把最后一片也交出来） */
  function stopRecorder() {
    if (!mediaRecorder) return;
    const recorder = mediaRecorder;
    mediaRecorder = null;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch (error) {
      // 忽略
    }
  }

  /**
   * 把录到的 webm 分片解码 → 单声道 → 16kHz → WAV。
   *
   * **绝不把 webm 直接上传**：智谱 ASR 只接受 wav / mp3（官方限制），
   * 所以这里必须走解码 + 重采样 + WAV 编码。
   *
   * @param {number} durationMs
   * @returns {Promise<{bytes: Uint8Array, durationMs: number} | null>}
   */
  async function encodeSegmentToWav(durationMs) {
    if (!voiceLogic || recordedChunks.length === 0 || !audioContext) return null;
    const blob = new Blob(recordedChunks, { type: recordedChunks[0].type || 'audio/webm' });
    resetRecording();
    if (!blob || blob.size === 0) return null;

    let audioBuffer = null;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } catch (error) {
      // 解码失败（极少见）：不提交这一段，安静回到监听
      return null;
    }
    if (!audioBuffer || audioBuffer.length === 0) return null;

    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c += 1) {
      channels.push(audioBuffer.getChannelData(c));
    }
    const mono = voiceLogic.wav.mixToMono(channels);
    const resampled = voiceLogic.wav.resampleLinear(mono, audioBuffer.sampleRate, voiceLogic.wav.TARGET_SAMPLE_RATE);
    const bytes = voiceLogic.wav.encodeWav(resampled, voiceLogic.wav.TARGET_SAMPLE_RATE);
    return {
      bytes,
      durationMs: Number.isFinite(durationMs) ? durationMs : Math.round((resampled.length / voiceLogic.wav.TARGET_SAMPLE_RATE) * 1000)
    };
  }

  /** 构造本地 VAD（灵敏度与静音毫秒来自设置） */
  function createLocalVad() {
    if (!voiceLogic) return null;
    return voiceLogic.vad.createVad({
      config: {
        sensitivity: voiceSettings.vadSensitivity,
        silenceMs: voiceSettings.vadSilenceMs,
        maxSegmentMs: VAD_MAX_SEGMENT_MS,
        maxBytes: VAD_MAX_SEGMENT_BYTES
      }
    });
  }

  /** VAD 事件 → 采集动作 */
  async function handleVadEvents(result) {
    for (const event of result.events) {
      if (event.type === 'speech-start') {
        lastVoiceSeenAt = Date.now();
        startRecorder();
      } else if (event.type === 'segment-end') {
        if (event.accepted !== true) {
          // 无效片段（太短 / 没人声）：直接丢弃，绝不当作一次用户发言
          resetRecording();
          stopRecorder();
          continue;
        }
        const durationMs = event.durationMs;
        stopRecorder();
        // 停止录制后 ondataavailable 还会异步补最后一片，稍等一下再编码
        await new Promise((resolve) => window.setTimeout(resolve, 60));
        const encoded = await encodeSegmentToWav(durationMs);
        if (encoded && turnTaking) {
          await turnTaking.onSpeechEnd({ bytes: encoded.bytes, durationMs: encoded.durationMs, accepted: true, reason: event.reason });
        }
      } else if (event.type === 'idle-enter') {
        vadLowRate = true;
        vadFrameMs = VAD_IDLE_FRAME_MS;
        if (turnTaking) turnTaking.notifyIdle('idle-enter');
      } else if (event.type === 'wakeup') {
        vadLowRate = false;
        vadFrameMs = VAD_FRAME_MS;
        if (turnTaking) turnTaking.notifyIdle('wakeup');
      }
    }
  }

  /** VAD 扫描的一帧：取 RMS → 喂 VAD → 处理事件 */
  function vadTick() {
    if (vadTimer) return;
    if (!vad || !analyserNode || !analyserBuffer) return;
    try {
      analyserNode.getFloatTimeDomainData(analyserBuffer);
    } catch (error) {
      return;
    }
    const rms = voiceLogic.wav.computeRms(analyserBuffer);
    const now = Date.now();
    // 30 秒没人说话 → 降采样；一旦有人声立刻恢复
    if (!vadLowRate && !vad.isSpeaking() && now - lastVoiceSeenAt > 30000) {
      // 真正的状态迁移由 VAD 内部按 idleAfterMs 决定，这里只做兜底频率调整
      vadFrameMs = VAD_IDLE_FRAME_MS;
    }
    const result = vad.feed({
      level: rms,
      bytes: 0,
      timestampMs: now
    });
    if (result.events.length > 0) {
      Promise.resolve(handleVadEvents(result)).catch(() => {});
    }
    scheduleVadTick();
  }

  /** 按当前频率安排下一次扫描 */
  function scheduleVadTick() {
    if (vadTimer) {
      window.clearTimeout(vadTimer);
      vadTimer = 0;
    }
    const interval = vadLowRate ? VAD_IDLE_FRAME_MS : vadFrameMs;
    vadTimer = window.setTimeout(() => {
      vadTimer = 0;
      vadTick();
    }, interval);
  }

  /** 停掉扫描定时器 */
  function stopVadLoop() {
    if (vadTimer) {
      window.clearTimeout(vadTimer);
      vadTimer = 0;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 阶段 4：语音回合的四个副作用（识别 / 对话 / 合成 / 播放）                     */
  /* ---------------------------------------------------------------------- */

  /**
   * 三级 TTS 的最后一级：Chromium 本机 speechSynthesis。
   * 必须设置音量，并处理 onstart / onend / onerror，**绝不静默只显示文字**。
   *
   * @param {string} text
   * @returns {Promise<{ok: boolean, code?: string, provider: string}>}
   */
  function speakWithSpeechSynthesis(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
        resolve({ ok: false, code: 'not-available', provider: 'speechSynthesis' });
        return;
      }
      let utterance = null;
      try {
        utterance = new window.SpeechSynthesisUtterance(text);
        utterance.volume = Math.min(1, Math.max(0, Number(voiceSettings.volume)));
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.lang = 'zh-CN';
      } catch (error) {
        resolve({ ok: false, code: 'not-available', provider: 'speechSynthesis' });
        return;
      }

      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      utterance.onstart = () => {
        beginSpeech(estimatedSpeechMs(text));
      };
      utterance.onend = () => {
        endSpeech();
        finish({ ok: true, provider: 'speechSynthesis' });
      };
      utterance.onerror = () => {
        endSpeech();
        finish({ ok: false, code: 'speech-failed', provider: 'speechSynthesis' });
      };
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch (error) {
        endSpeech();
        finish({ ok: false, code: 'speech-failed', provider: 'speechSynthesis' });
      }
    });
  }

  /** 粗略估算中文语音时长（毫秒）：给 talking 动作一个时长，播完会显式 endSpeech */
  function estimatedSpeechMs(text) {
    const chars = Array.from(text).length;
    return Math.max(900, Math.min(20000, chars * 220 + 600));
  }

  /** 把音量设置夹到 [0,1]（非法值按 0.8 处理） */
  function clampVolume(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : 0.8;
  }

  /**
   * 把主进程回传的音频字节转成一份独立的 ArrayBuffer 拷贝。
   * 只接受 Uint8Array / ArrayBuffer；其它类型一律视为无效（绝不隐式转换）。
   * 用鸭子类型判断，兼容跨 contextBridge / realm 的 Uint8Array 视图。
   * @param {unknown} bytes
   * @returns {ArrayBuffer | null}
   */
  function toAudioArrayBuffer(bytes) {
    if (!bytes || typeof bytes !== 'object') return null;
    // 用 Object.prototype.toString 而不是 instanceof，兼容跨 realm 的视图 / 缓冲
    if (Object.prototype.toString.call(bytes) === '[object ArrayBuffer]') {
      return bytes.slice(0);
    }
    if (typeof bytes.byteLength !== 'number' || typeof bytes.byteOffset !== 'number') return null;
    if (Object.prototype.toString.call(bytes.buffer) !== '[object ArrayBuffer]') return null;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  /**
   * 播放主进程合成的音频（GLM-TTS / edge-tts / SAPI）。
   *
   * 安全与资源约定（本次安全集成修复的重点）：
   *   - **只接收 audioBytes（Uint8Array）**，不再接收任何文件路径；
   *   - 不做 fetch、不用 file:// URL、不发任何网络请求（页面 CSP 仍是 connect-src 'none'）；
   *   - 优先 WebAudio 解码播放；解码失败再退回 Blob + ObjectURL 的 <audio> 兜底；
   *   - 播放期间驱动 talking 口型（beginSpeech），播放结束 / 出错 / 被打断才 endSpeech；
   *   - 每条路径都释放 AudioBufferSource / GainNode / ObjectURL，绝不泄漏。
   *
   * @param {unknown} bytes
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  async function playAudioBytes(bytes) {
    const arrayBuffer = toAudioArrayBuffer(bytes);
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return { ok: false, code: 'bad-audio' };

    // 1) 优先 WebAudio：能用同一个音量设置，且不需要创建 ObjectURL
    let decoded = null;
    try {
      if (!audioContext) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (typeof Ctor !== 'function') throw new Error('no-audiocontext');
        audioContext = new Ctor();
      }
      // decodeAudioData 会 detach 传入的 ArrayBuffer，所以传一份拷贝
      decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    } catch (error) {
      decoded = null;
    }
    if (decoded) return playDecodedBuffer(decoded);

    // 2) WebAudio 解码失败 → Blob + ObjectURL 兜底（仍是本地内存，不联网）
    return playWithAudioElement(arrayBuffer);
  }

  /**
   * 用已解码的 AudioBuffer 播放；onended / start 失败 / stop 都会释放节点并结束 talking。
   * @param {AudioBuffer} decoded
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  function playDecodedBuffer(decoded) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let source = null;
      let gain = null;
      try {
        gain = audioContext.createGain();
        gain.gain.value = clampVolume(voiceSettings.volume);
        source = audioContext.createBufferSource();
        source.buffer = decoded;
        source.connect(gain);
        gain.connect(audioContext.destination);
      } catch (error) {
        finish({ ok: false, code: 'play-failed' });
        return;
      }

      /** 释放本次播放的节点（幂等；不清 onended，保证 stop() 时等待者能收尾） */
      const release = () => {
        if (activeSource === source) activeSource = null;
        if (activeGain === gain) activeGain = null;
        try {
          source.disconnect();
        } catch (error) {
          // 忽略
        }
        try {
          gain.disconnect();
        } catch (error) {
          // 忽略
        }
      };

      activeSource = source;
      activeGain = gain;
      source.onended = () => {
        release();
        endSpeech();
        finish({ ok: true });
      };

      beginSpeech(Math.round(decoded.duration * 1000));
      try {
        source.start(0);
      } catch (error) {
        // start 失败时 onended 不会触发，手动走结束路径
        release();
        endSpeech();
        finish({ ok: false, code: 'play-failed' });
      }
    });
  }

  /**
   * 用 <audio> + ObjectURL 兜底播放（WebAudio 解码失败时）。
   * 每条结束路径都会 revoke ObjectURL 并 endSpeech，绝不泄漏。
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<{ok: boolean, code?: string}>}
   */
  function playWithAudioElement(arrayBuffer) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanupActiveAudio();
        endSpeech();
        resolve(result);
      };

      try {
        const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const element = new Audio();
        activeAudio = element;
        activeAudioUrl = url;
        element.volume = clampVolume(voiceSettings.volume);
        // 先按保守估计进入 talking，元数据到位后按真实时长校正；拿不到就保持估计值
        beginSpeech(8000);
        element.onloadedmetadata = () => {
          const seconds = Number(element.duration);
          if (Number.isFinite(seconds) && seconds > 0) {
            beginSpeech(Math.round(seconds * 1000));
          }
        };
        element.onended = () => finish({ ok: true });
        element.onerror = () => finish({ ok: false, code: 'play-failed' });
        element.src = url;
        const playPromise = element.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => finish({ ok: false, code: 'play-failed' }));
        }
      } catch (error) {
        finish({ ok: false, code: 'play-failed' });
      }
    });
  }

  /** 释放 <audio> 与 ObjectURL（绝不泄漏） */
  function cleanupActiveAudio() {
    if (activeAudio) {
      try {
        activeAudio.onended = null;
        activeAudio.onerror = null;
        activeAudio.onloadedmetadata = null;
        activeAudio.pause();
        activeAudio.removeAttribute('src');
        activeAudio.load();
      } catch (error) {
        // 忽略
      }
      activeAudio = null;
    }
    if (activeAudioUrl) {
      try {
        URL.revokeObjectURL(activeAudioUrl);
      } catch (error) {
        // 忽略
      }
      activeAudioUrl = null;
    }
  }

  /** 停掉正在播放的音频（窗口隐藏 / 退出 / 回合被打断时）；每条路径都释放资源 */
  function stopPlayback() {
    if (activeSource) {
      const source = activeSource;
      // 保留 onended：stop() 会异步触发它，让等待播放的 Promise 正常收尾
      try {
        source.stop();
      } catch (error) {
        // 忽略
      }
      try {
        source.disconnect();
      } catch (error) {
        // 忽略
      }
      activeSource = null;
    }
    if (activeGain) {
      try {
        activeGain.disconnect();
      } catch (error) {
        // 忽略
      }
      activeGain = null;
    }
    cleanupActiveAudio();
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (error) {
      // 忽略
    }
    // 播放被主动打断时也要退出 talking，避免鱼一直张嘴
    endSpeech();
  }

  /**
   * 回合管理器注入的三个副作用。
   * 全部只走 preload 的窄接口（window.blueFatFish），**渲染层拿不到 Key**。
   */
  const voicePipelines = {
    async transcribe(bytes, meta) {
      const result = await bridge.voiceTranscribe(bytes, meta);
      return result && typeof result === 'object' ? result : { ok: false, code: 'internal-error' };
    },
    async chat(text) {
      const result = await bridge.voiceChat(text);
      if (result && typeof result === 'object') return result;
      return { ok: false, code: 'internal-error' };
    },
    async speak(text) {
      // 字幕（若开启）在回合管理器里已经显示；这里只负责"真的发出声音"
      let syn = null;
      try {
        syn = await bridge.voiceSpeak(text);
      } catch (error) {
        syn = null;
      }

      // 主进程成功时只回传 audioBytes（Uint8Array）；preload 已做白名单归一化
      if (syn && syn.ok === true && syn.audioBytes) {
        const played = await playAudioBytes(syn.audioBytes);
        if (played.ok) return { ok: true, provider: syn.provider || 'glm-tts' };
        // 音频播不出来 → 继续往最后一级降级（临时文件早已由主进程删除）
      }

      // 三级兜底：Chromium 本机 speechSynthesis（设置音量 + onstart/onend/onerror）
      return speakWithSpeechSynthesis(text);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* 阶段 4：把 VAD / 回合管理器接起来                                          */
  /* ---------------------------------------------------------------------- */

  function setupVoiceLoop(initialMicEnabled) {
    if (!voiceLogic) {
      // 纯逻辑模块缺失时安静降级：桌宠本体照常，但没有语音能力
      console.warn('[语音] 纯逻辑模块未加载，语音链路已禁用。');
      return;
    }

    turnTaking = voiceLogic.turnTaking.createTurnTaking({
      mic: {
        start: () => acquireMic(),
        pause: () => {
          stopVadLoop();
          releaseMic();
        },
        resume: () => acquireMic(),
        close: () => {
          stopVadLoop();
          releaseMic();
          stopPlayback();
        }
      },
      pipelines: voicePipelines,
      captionEnabled: () => voiceSettings.subtitleMode === true,
      onCaption: (text) => showBubble(text, 'caption'),
      onBubble: (payload) => {
        // 错误 / 麦克风状态提示允许默认显示（需求第 5 条）
        const kind = payload.kind === 'error' ? 'error' : payload.kind === 'warn' ? 'warn' : 'info';
        showBubble(payload.text, kind);
      }
    });

    vad = createLocalVad();
    // 麦克风默认开：启动即持续监听，不需要用户按键启动每一句话
    turnTaking.setMicEnabled(initialMicEnabled !== false).then((result) => {
      if (result && result.ok && result.enabled) {
        lastVoiceSeenAt = Date.now();
        vadFrameMs = VAD_FRAME_MS;
        vadLowRate = false;
        scheduleVadTick();
      }
    });
  }

  /** 语音设置变化：同步到采集侧（VAD 参数 / 音量 / 字幕 / 开关） */
  function applyVoiceSettings(next) {    if (!next || typeof next !== 'object') return;
    const previousMic = voiceSettings.micEnabled;
    voiceSettings = Object.assign({}, voiceSettings, next);
    if (vad) {
      vad.reset({
        sensitivity: voiceSettings.vadSensitivity,
        silenceMs: voiceSettings.vadSilenceMs,
        maxSegmentMs: VAD_MAX_SEGMENT_MS,
        maxBytes: VAD_MAX_SEGMENT_BYTES
      });
    }
    if (turnTaking && voiceSettings.micEnabled !== previousMic) {
      turnTaking.setMicEnabled(voiceSettings.micEnabled).then((result) => {
        if (result && result.ok && result.enabled) {
          lastVoiceSeenAt = Date.now();
          scheduleVadTick();
        }
      });
    }
    // 字幕模式被关掉时立刻把字幕气泡收起来（避免"关了还在显示"）
    if (voiceSettings.subtitleMode !== true && speechBubble && speechBubble.classList.contains('bubble-caption')) {
      hideBubble();
    }
  }

  /**
   * 彻底释放语音链路的一切资源（页面关闭 / 退出时调用）。
   *
   * 逐项对应需求「正常关闭 / 错误时清理」：
   *   MediaStream tracks → AudioContext → MediaRecorder → ObjectURL → 定时器；
   *   另外把回合管理器标记为 disposed，避免"播放结束后又自动恢复监听"。
   */
  function disposeVoice() {
    stopVadLoop();
    try {
      if (turnTaking) turnTaking.dispose();
    } catch (error) {
      // 忽略
    }
    turnTaking = null;
    stopRecorder();
    resetRecording();
    releaseMic();
    stopPlayback();
    if (audioContext && typeof audioContext.close === 'function') {
      Promise.resolve(audioContext.close()).catch(() => {});
    }
    audioContext = null;
    vad = null;
    hideBubble();
  }

  /* ---------------------------------------------------------------------- */
  /* 后续阶段接口：语音（TTS）驱动 talking 口型                               */
  /* ---------------------------------------------------------------------- */

  /**
   * TTS 开始播报时调用：进入 talking 状态，嘴型循环。
   * 本阶段没有语音，所以这里不播放任何假声音，也不显示文字气泡。
   * **这是唯一允许请求 talking 的入口**：情绪变化 / 状态播报一律只改不可见文本，
   * 不会走到这里，避免无声张嘴。
   * @param {number} durationMs 预计播报时长（毫秒）
   */
  function beginSpeech(durationMs) {
    return machine.request('talking', { source: 'system', duration: durationMs });
  }

  /** TTS 播报结束 / 被打断时调用：退出 talking，回到底色 */
  function endSpeech() {
    return machine.cancelAction('speech-end');
  }

  /* ---------------------------------------------------------------------- */
  /* 启动                                                                    */
  /* ---------------------------------------------------------------------- */

  // 1) 先把状态机当前状态映射到 DOM（此时是 idle + mode-idle）
  applyVisibleState(machine.getVisible(), { reason: 'init', previous: null });

  // 2) 恢复饱食度：按存储里的时间戳补算离线下降，并据此切到 hungry / angry
  const restored = fullness.load();
  if (restored.mood !== 'idle' && !machine.isSleeping()) {
    machine.setBase(restored.mood, { source: 'mood' });
  }
  fullness.start();

  // 3) 随机行为调度（眨眼调度已随眨眼功能一起移除）
  scheduleIdleAction();
  scheduleSwim();
  scheduleChatter();

  // 4) 启动打招呼兜底：主进程正常会下发 greet，这里只兜底一次
  greetFallbackTimer = window.setTimeout(() => {
    greetFallbackTimer = 0;
    if (!greetSeen && machine.getVisible() === 'idle' && !machine.getAction()) {
      machine.request('greet', { source: 'system' });
    }
  }, 900);

  // 5) 初始按"穿透"处理：等光标真正移到鱼身上再拦截
  lastIgnoreSent = null;
  requestIgnoreMouse(true);

  /*
   * 6) 阶段 4：启动连续语音对话链路。
   *
   * - 麦克风默认开：`reportSettingsState()` 是**同步缓存查询**（不联网、不读盘、
   *   不弹任何提示），拿到开关后直接开始持续监听 —— 不需要用户按键启动每一句话；
   * - 缺 Key 也照常开麦：本地识别仍可用，只是识别结果不会发给聊天模型；
   * - 设备 / 权限被拒时只给一次轻量气泡，绝不反复弹框。
   */
  try {
    const voiceState = bridge.reportSettingsState();
    if (voiceState && typeof voiceState === 'object') {
      voiceSettings.micEnabled = voiceState.micEnabled !== false;
    }
  } catch (error) {
    // 拿不到就按"默认开"处理（需求：micEnabled 默认 true）
  }
  setupVoiceLoop(voiceSettings.micEnabled);

  // 供人工排查使用（不是对外 API）
  window.__bffDebug = Object.freeze({
    getState: () => machine.getVisible(),
    getSnapshot: () => machine.getSnapshot(),
    getFullness: () => ({ value: fullness.getValue(), mood: fullness.getMood() }),
    getStateNames: () => STATE_NAMES.slice(),
    setState: (name, options) => userAction(name, options),
    setBase: (name) => machine.setBase(name, { source: 'user' }),
    sleep: sleepFromMenu,
    wake: wakeFromMenu,
    feed: feedFromMenu,
    swim: () => requestSwim('user'),
    say: beginSpeech,
    endSpeech,
    isOverFish,
    isOverHead,
    // ---- 阶段 4：语音链路的人工排查入口（只读状态 + 手动开关麦）----
    getVoiceState: () => ({
      micEnabled: voiceSettings.micEnabled,
      turnState: turnTaking ? turnTaking.getState() : 'disabled',
      vad: vad ? vad.snapshot() : null,
      lowRate: vadLowRate,
      subtitleMode: voiceSettings.subtitleMode,
      volume: voiceSettings.volume,
      ttsVoice: voiceSettings.ttsVoice,
      vadSensitivity: voiceSettings.vadSensitivity,
      vadSilenceMs: voiceSettings.vadSilenceMs
    }),
    setSubtitleMode: (on) => {
      voiceSettings.subtitleMode = on === true;
      return voiceSettings.subtitleMode;
    },
    toggleMic: () => (turnTaking ? turnTaking.toggleMic() : Promise.resolve({ ok: false, reason: 'disabled' })),
    showBubble: (text, kind) => showBubble(text, kind || 'info')
  });
})();
