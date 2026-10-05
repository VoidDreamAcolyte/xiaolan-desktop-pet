'use strict';

/**
 * ============================================================================
 * 小蓝桌宠 —— 说明书验收脚本（tools/verify-manual.js）
 * ============================================================================
 *
 * 把《小蓝桌宠-试用说明书.html》里每一条可验证的承诺变成自动检查。
 * 说明书就是验收标准：改了任何功能，跑一遍这个脚本就知道有没有偏离说明书。
 *
 * 用法：node tools/verify-manual.js
 * 退出码：0 = 全部符合说明书；1 = 有偏差（见 [失败] 行）。
 *
 * 注意：这里是"代码审查型"检查（静态断言 + 纯函数验证），
 * 真实麦克风 / 云端 ASR / TTS 只有人工验收（见 tests/smoke.test.js 尾注）。
 */

const fs = require('node:fs');
const nodePath = require('node:path');

const ROOT = nodePath.join(__dirname, '..');
const read = (p) => fs.readFileSync(nodePath.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`[通过] ${name}`);
  } else {
    failed += 1;
    console.error(`[失败] ${name}${detail ? `  ← ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 第 1 节 启动与退出                                                          */
/* -------------------------------------------------------------------------- */

const mainJs = read('main/main.js');

check('说明书 1：启动 bat 存在', fs.existsSync(nodePath.join(ROOT, '启动蓝色大肥鱼.bat')));
check(
  '说明书 1：初始位置在右下角且用 workArea（自动避开任务栏）',
  /function computeInitialPosition/.test(mainJs) &&
    /area\.x \+ area\.width - size\.width/.test(mainJs) &&
    /workArea;/.test(mainJs)
);
check(
  '说明书 1：单实例（重复启动只唤到前台）',
  /requestSingleInstanceLock/.test(mainJs) && /app\.on\('second-instance'/.test(mainJs)
);
check(
  '说明书 1：点关闭只是收进托盘（close → hide）',
  /petWindow\.on\('close'[\s\S]{0,200}hide\(\)/.test(mainJs)
);
check(
  '说明书 4：托盘与身上右键共用同一份菜单模板（菜单完全一致）',
  /tray\.on\('right-click'[\s\S]{0,80}buildMenu\(\)/.test(mainJs) &&
    /function buildMenuTemplate\(\)/.test(mainJs) &&
    /function popupMenu\(\)[\s\S]{0,200}buildMenu\(\)/.test(mainJs)
);
check(
  '说明书 4：菜单里有「退出」（MENU_LABELS.QUIT）',
  /QUIT: '退出'/.test(read('main/ipc-channels.js')) && /label: MENU_LABELS\.QUIT/.test(mainJs)
);
check(
  '说明书 4：托盘左键唤出小蓝',
  /tray\.on\('click'[\s\S]{0,60}showPetWindow\(\)/.test(mainJs)
);
check(
  '说明书 4：托盘提示实时显示状态',
  /setToolTip\(`小蓝 · \$\{label\}`\)/.test(mainJs)
);

/* -------------------------------------------------------------------------- */
/* 第 2 节 跑动                                                                */
/* -------------------------------------------------------------------------- */

const sp = require(nodePath.join(ROOT, 'main', 'swim-plan.js'));
const rendererJs = read('renderer/renderer.js');
const css = read('renderer/styles.css');
const fishSvg = read('assets/fish.svg');
const indexHtml = read('renderer/index.html');

check(
  '说明书 2：每隔 3~6 分钟自动跑一段',
  rendererJs.includes('const SWIM_MIN_MS = 180000;') && rendererJs.includes('const SWIM_RANGE_MS = 180000;')
);
check(
  '说明书 2：小碎步慢跑约 140 像素、全程约 3 秒（用户反馈放慢后）',
  sp.SWIM_TRAVEL_PX === 140 && sp.SWIM_HALF_DURATION_MS === 1500 && sp.SWIM_DURATION_MS === 3000,
  `travel=${sp.SWIM_TRAVEL_PX}, half=${sp.SWIM_HALF_DURATION_MS}`
);
check(
  '说明书 2：跑完精确回到出发位置',
  (() => {
    const plan = sp.createSwimPlan({ x: 800, y: 400, width: 360, height: 340 }, { x: 0, y: 0, width: 1920, height: 1040 });
    const end = sp.positionAt(plan, plan.durationMs);
    return end.x === plan.originX && end.y === plan.originY;
  })()
);
check(
  '说明书 2：跑步动作 = 前倾 + 蹬地拉长/落地压扁（脚底为轴、500ms 慢跑步频）',
  /girl-run-right 0\.5s/.test(css) &&
    /transform-origin: 50% 94%/.test(css) &&
    /scale\(1\.05, 0\.94\)/.test(css) &&
    /scale\(0\.96, 1\.06\)/.test(css)
);
check(
  '说明书 2：脚下扬起小尘土（土色尘埃，不再是蓝色水泡）',
  /#e9dcc6/.test(fishSvg) && !/#a9e2ff|#c6ecff/.test(fishSvg)
);
check(
  '说明书 2：跑步途中拖拽立刻取消跑步',
  /cancelSwim\('dragging'\)/.test(mainJs)
);
check(
  '说明书 8/2：跑出屏幕会自动归位（起点拉回工作区）',
  /先归位，避免/.test(mainJs) || /originX[\s\S]{0,120}setPosition/.test(mainJs)
);

/* -------------------------------------------------------------------------- */
/* 第 3 节 摸一摸：互动部位                                                     */
/* -------------------------------------------------------------------------- */

check(
  '说明书 3：摸头（悬停/轻抚）→ 害羞',
  /pet: 'shy'/.test(rendererJs)
);
check(
  '说明书 3：8 秒内连摸 3 次头 → 开心地打招呼',
  /petComboTimes[\s\S]{0,80}8000/.test(rendererJs) && /petComboTimes\.length >= 3[\s\S]{0,80}userAction\('greet'\)/.test(rendererJs)
);
check(
  '说明书 3：反应池与说明书表格逐项一致',
  (() => {
    const m = rendererJs.match(/const TAP_POOLS = Object\.freeze\(\{[\s\S]*?\}\);/);
    if (!m) return false;
    const t = m[0];
    return (
      t.includes("head: ['pet', 'poke', 'greet']") &&
      t.includes("face: ['poke', 'pet', 'thinking']") &&
      t.includes("belly: ['happy', 'greet', 'poke']") &&
      t.includes("hands: ['greet', 'happy', 'pet']") &&
      t.includes("feet: ['flip', 'happy', 'poke']") &&
      t.includes("other: ['poke', 'thinking', 'flip']")
    );
  })()
);
check(
  '说明书 3：900ms 内三连击 → 翻身（盖过部位反应）',
  /tapTimes[\s\S]{0,60}900/.test(rendererJs) && /tapTimes\.length >= 3[\s\S]{0,60}userAction\('flip'\)/.test(rendererJs)
);
check(
  '说明书 3：按住 1.2 秒 → 歪头发呆思考',
  /const LONG_PRESS_MS = 1200;/.test(rendererJs)
);
check(
  '说明书 3：双击 → 踮脚打招呼',
  /function onDoubleClick[\s\S]{0,300}userAction\('greet'\)/.test(rendererJs)
);
check(
  '说明书 3：睡觉时点她 → 被叫醒',
  /function reactToTap[\s\S]{0,200}isSleeping\(\)[\s\S]{0,120}wakeFromMenu\(\)/.test(rendererJs)
);
check(
  '说明书 3：思考冒问号 / 拖动冒汗 / 生气怒气线 / 喂饭碗特效齐全（两个 SVG 同步）',
  ['think', 'sweat', 'angry-mark', 'bowl'].every((id) =>
    fishSvg.includes(`id="${id}"`) && indexHtml.includes(`id="${id}"`)
  )
);

/* -------------------------------------------------------------------------- */
/* 第 5 节 语音对话                                                            */
/* -------------------------------------------------------------------------- */

const turnTaking = read('renderer/logic/turn-taking.js');

check(
  '说明书 5：全局快捷键 Ctrl+Shift+V 开关麦克风',
  /globalShortcut\.register\('(CommandOrControl\+)?Ctrl\+Shift\+V'/.test(mainJs)
);
check(
  '说明书 5：麦克风默认开',
  rendererJs.includes('micEnabled: true,') || /micEnabled: true/.test(read('main/settings-store.js'))
);
check(
  '说明书 5：没配 Key 时头顶冒气泡引导去 open.bigmodel.cn',
  /去 open\.bigmodel\.cn 领个 Key/.test(turnTaking)
);

/* -------------------------------------------------------------------------- */
/* 第 6 节 设置页                                                              */
/* -------------------------------------------------------------------------- */

const settingsHtml = read('renderer/settings.html');

check(
  '说明书 6：设置页字段齐全（Key/模型/大小/麦克风/VAD 灵敏度/静音时长/音色/音量/字幕）',
  ['api-key', 'model', 'pet-scale', 'mic-enabled', 'vad-sensitivity', 'vad-silence', 'tts-voice', 'volume', 'subtitle-mode']
    .every((id) => settingsHtml.includes(`id="${id}"`))
);
check(
  '说明书 6：桌宠大小 50%~200%',
  /PET_SCALE_RANGE/.test(read('main/settings-store.js')) && /50/.test(settingsHtml) && /200/.test(settingsHtml)
);
check(
  '说明书 6：API Key 加密存储（safeStorage），不明文落盘',
  /safeStorage/.test(read('main/settings-store.js')) && /encryptString/.test(read('main/settings-store.js'))
);

/* -------------------------------------------------------------------------- */
/* 第 7 节 饱食度                                                              */
/* -------------------------------------------------------------------------- */

const fullness = require(nodePath.join(ROOT, 'renderer', 'logic', 'fullness.js'));

check(
  '说明书 7：约 14 分钟变蔫（每分钟掉 5 点、≤30 阈值）',
  fullness.FULLNESS.DECAY_PER_MINUTE === 5 && fullness.FULLNESS.HUNGRY_AT === 30 &&
    Math.ceil((100 - 30) / 5) === 14
);
check(
  '说明书 7：持续饿 3 分钟后生气',
  fullness.FULLNESS.ANGRY_AFTER_MS === 3 * 60000
);
check(
  '说明书 7：睡觉也不暂停下降（睡着的她也会饿）',
  !/sleep[\s\S]{0,200}pause/.test(read('renderer/logic/fullness.js'))
);

/* -------------------------------------------------------------------------- */
/* 第 8 节 常见问题                                                            */
/* -------------------------------------------------------------------------- */

check(
  '说明书 8：只有光标落在她身上才拦截鼠标（其余区域穿透）',
  /setIgnoreMouseEvents/.test(rendererJs)
);
check(
  '说明书 8：开场打招呼（主进程下发 + 900ms 兜底）',
  /greetFallbackTimer/.test(rendererJs) && /启动打招呼兜底/.test(rendererJs)
);

/* -------------------------------------------------------------------------- */
/* 结果                                                                        */
/* -------------------------------------------------------------------------- */

console.log('================================================================');
if (failed === 0) {
  console.log('说明书验收：全部符合 ✓');
  process.exit(0);
}
console.error(`说明书验收：${failed} 项偏离，请修上面 [失败] 的条目`);
process.exit(1);
