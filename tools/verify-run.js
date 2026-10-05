'use strict';

/**
 * ============================================================================
 * 小蓝「跑动」功能专项自检（2026-10-05 游动改跑动）
 * ============================================================================
 * 检查四件事：
 *   A. 跑动几何（swim-plan.js）：速度 / 距离 / 步频符合"跑动"标准，
 *      全程逐帧不越界、整数坐标、终点精确归位、弹跳次数与步频一致。
 *   B. 渲染接线：state-swim + swim-left/right 确实驱动 girl-run 前倾颠簸动画
 *      与脚下扬尘，旧的鱼泳 keyframes 已清理干净。
 *   C. 资源一致性：index.html 注入的 SVG 与 assets/fish.svg 完全一致，
 *      尘埃符号仍在且默认隐藏。
 *   D. 文案：托盘标签 / 读屏文本已是「跑步」。
 *
 * 用法：node tools/verify-run.js   退出码 0 = 全部通过
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sp = require(path.join(ROOT, 'main', 'swim-plan.js'));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}  ← ${detail}` : name);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* -------------------------------------------------------------------------- */
/* A. 跑动几何                                                                  */
/* -------------------------------------------------------------------------- */

check('A1 单程时长 ≤ 1600ms（用户反馈放慢后的慢跑，不是冲刺也不是慢吞吞游）', sp.SWIM_HALF_DURATION_MS >= 1200 && sp.SWIM_HALF_DURATION_MS <= 1600, String(sp.SWIM_HALF_DURATION_MS));
check('A2 总时长 = 2 × 单程', sp.SWIM_DURATION_MS === sp.SWIM_HALF_DURATION_MS * 2);
check('A3 水平跑动距离在 100~180px（用户反馈后进一步收窄的小碎步冲刺）', sp.SWIM_TRAVEL_PX >= 100 && sp.SWIM_TRAVEL_PX <= 180, String(sp.SWIM_TRAVEL_PX));
check('A4 迈步步频 2~6 个周期', sp.SWIM_BOUNCE_CYCLES >= 2 && sp.SWIM_BOUNCE_CYCLES <= 6, String(sp.SWIM_BOUNCE_CYCLES));
check('A5 弹跳幅度 ≤ 14px（颠簸但不夸张）', sp.SWIM_BOB_PX > 0 && sp.SWIM_BOB_PX <= 14, String(sp.SWIM_BOB_PX));

/** 基准插值 y（不含弹跳分量） */
function baseYAt(plan, t) {
  const tt = Math.min(1, Math.max(0, t / plan.durationMs));
  const q = tt <= 0.5 ? tt / 0.5 : (tt - 0.5) / 0.5;
  const e = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
  return tt <= 0.5
    ? plan.originY + (plan.targetY - plan.originY) * e
    : plan.targetY + (plan.originY - plan.targetY) * e;
}

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const CASES = [
  ['右下角窗口', { x: 1560, y: 700, width: 360, height: 340 }],
  ['左上角窗口', { x: 40, y: 12, width: 360, height: 340 }],
  ['屏幕中央', { x: 780, y: 350, width: 360, height: 340 }],
  ['拖到屏幕外', { x: -900, y: 100, width: 360, height: 340 }],
  ['窗口比屏幕大', { x: 0, y: 0, width: 3000, height: 2000 }]
];

for (const [label, bounds] of CASES) {
  const plan = sp.createSwimPlan(bounds, workArea);
  check(`${label}：规划成功`, Boolean(plan));
  if (!plan) continue;

  let out = 0;
  let nonInt = 0;
  let maxFormulaErr = 0;
  const step = 8;
  for (let t = 0; t <= plan.durationMs; t += step) {
    const p = sp.positionAt(plan, t);
    if (!sp.isInsidePlan(plan, p)) out += 1;
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) nonInt += 1;
    // 迈步弹跳应严格等于 sin(2π·步频·t)·幅度，再经安全限幅（贴边窗口允许被夹回）
    const dy = p.y - baseYAt(plan, t);
    const baseHere = baseYAt(plan, t);
    const rawWant = Math.sin(2 * Math.PI * sp.SWIM_BOUNCE_CYCLES * (t / plan.durationMs)) * plan.bobPx;
    const clampedWant = Math.min(plan.maxY, Math.max(plan.minY, baseHere + rawWant)) - baseHere;
    maxFormulaErr = Math.max(maxFormulaErr, Math.abs(dy - clampedWant));
  }

  check(`${label}：全程逐帧不越界（8ms 采样）`, out === 0, `越界帧 ${out}`);
  check(`${label}：全程整数坐标`, nonInt === 0, `非整数帧 ${nonInt}`);
  check(
    `${label}：终点精确回到起点（跑完不留偏移）`,
    sp.positionAt(plan, plan.durationMs).x === plan.originX &&
      sp.positionAt(plan, plan.durationMs).y === plan.originY
  );
  const mid = sp.positionAt(plan, Math.round(plan.durationMs / 2));
  check(`${label}：中点到达目标侧`, mid.x === plan.targetX, JSON.stringify(mid));

  check(
    `${label}：弹跳严格按步频 ${sp.SWIM_BOUNCE_CYCLES} 起伏（误差 ≤ 1px）`,
    maxFormulaErr <= 1,
    `maxErr=${maxFormulaErr.toFixed(3)}px`
  );
}

/* -------------------------------------------------------------------------- */
/* B. 渲染接线                                                                  */
/* -------------------------------------------------------------------------- */

const css = read('renderer/styles.css');
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rendererJs = read('renderer/renderer.js');

check('B1 向右跑 → girl-run-right 动画（前倾 + 迈步颠簸）', /\.stage\.state-swim\.swim-right #fish-svg #pet-image\s*\{[^}]*animation:\s*girl-run-right/.test(css));
check('B2 向左跑 → girl-run-left 动画', /\.stage\.state-swim\.swim-left #fish-svg #pet-image\s*\{[^}]*animation:\s*girl-run-left/.test(css));
check('B3 girl-run-right 带前倾（rotate）与腾空（translateY 负值）', /@keyframes girl-run-right\s*\{[\s\S]*?translateY\(-\d+px\)[\s\S]*?rotate/.test(css));
check('B4 girl-run-left 前倾方向与右跑相反', (() => {
  const right = css.match(/@keyframes girl-run-right\s*\{([\s\S]*?)\n\}/);
  const left = css.match(/@keyframes girl-run-left\s*\{([\s\S]*?)\n\}/);
  if (!right || !left) return false;
  const rRotate = right[1].match(/rotate\((-?[\d.]+)deg\)/);
  const lRotate = left[1].match(/rotate\((-?[\d.]+)deg\)/);
  return Boolean(rRotate && lRotate && Number(rRotate[1]) > 0 && Number(lRotate[1]) < 0);
})());
check('B5 脚下扬尘 dust-drift 已接线', /\.stage\.state-swim #swim-trail \.trail\s*\{[^}]*animation:\s*dust-drift/.test(css));
check('B6 扬尘节奏（0.4~1.0s 循环，与跑步步频匹配）', (() => {
  const m = css.match(/animation:\s*dust-drift\s+([\d.]+)s/);
  return Boolean(m && Number(m[1]) >= 0.4 && Number(m[1]) <= 1.0);
})(), css.match(/animation:\s*dust-drift\s+[\d.]+s/));
check('B7 向左跑时扬尘镜像到右侧', /\.stage\.state-swim\.swim-left #swim-trail\s*\{[^}]*transform:\s*scaleX\(-1\)/.test(css));
check('B8 旧鱼泳 keyframes 已清理（fish-swim / tail-swim / trail-drift）', !/fish-swim-(right|left)|tail-swim|trail-drift/.test(css));
check('B9 渲染层保留 swim 状态类与朝向类逻辑', /'state-swim'/.test(rendererJs) && /applySwimDirection/.test(rendererJs) && /swim-left|swim-right/.test(rendererJs));
check('B10 跑动请求把主进程时长传给状态机', /machine\.request\('swim',\s*\{[\s\S]{0,80}duration:\s*result\.durationMs/.test(rendererJs));
check('B11 CSS 无 id 默认隐藏写法（特异度陷阱回归检查，忽略注释）', !/#fish-svg\s+#[\w-]+\s*\{[^}]*opacity:\s*0/.test(cssNoComment));

/* -------------------------------------------------------------------------- */
/* C. 资源一致性                                                                */
/* -------------------------------------------------------------------------- */

const fishSvg = read('assets/fish.svg').trim();
const html = read('renderer/index.html');
const start = html.indexOf('<!-- FISH_SVG_START -->');
const end = html.indexOf('<!-- FISH_SVG_END -->');
check('C1 index.html 存在 SVG 注入标记', start !== -1 && end !== -1 && end > start);
if (start !== -1 && end !== -1) {
  const injected = html.slice(html.indexOf('>', start) + 1, end).trim();
  check('C2 index.html 注入的 SVG 与 assets/fish.svg 完全一致', injected === fishSvg);
}
check('C3 尘埃符号 #swim-trail 存在且默认隐藏', /<g id="swim-trail" opacity="0">/.test(fishSvg));
const OLD_DUST_BLUES = ['#a9e2ff', '#c6ecff', '#d8f3ff', '#bfe9ff'];
const NEW_DUST_TANS = ['#e9dcc6', '#dfd0b6', '#d3c2a4', '#e5d7bf'];
const dustSeg = fishSvg.match(/<g id="swim-trail"[\s\S]*?<\/g>/);
check('C4 尘埃已是土黄配色（不再是蓝色水泡）', Boolean(dustSeg) && OLD_DUST_BLUES.every((c) => !dustSeg[0].includes(c)) && NEW_DUST_TANS.every((c) => dustSeg[0].includes(c)));
check('C5 扬尘位置在脚部高度（4 颗、y ≥ 300）', (() => {
  const seg = fishSvg.match(/<g id="swim-trail"[\s\S]*?<\/g>/);
  if (!seg) return false;
  const ys = [...seg[0].matchAll(/<circle class="trail[^"]*"[^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));
  return ys.length === 4 && ys.every((y) => y >= 300);
})());
check('C6 尾气在脚后方且逐渐升高（3 团、y 依次变小）', (() => {
  const seg = fishSvg.match(/<g id="swim-trail"[\s\S]*?<\/g>/);
  if (!seg) return false;
  const es = [...seg[0].matchAll(/<circle class="exhaust[^"]*"[^>]*cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  return (
    es.length === 3 &&
    es[0].x > es[1].x && es[1].x > es[2].x && // 越来越靠后
    es[0].y > es[1].y && es[1].y > es[2].y    // y 越来越小 = 越飘越高
  );
})());

/* -------------------------------------------------------------------------- */
/* D. 文案                                                                      */
/* -------------------------------------------------------------------------- */

const channels = read('main/ipc-channels.js');
check('D1 托盘标签：swim → 「跑步」', /swim:\s*'跑步'/.test(channels));
check('D2 读屏文本：swim → 「在跑步」', /swim:\s*'在跑步'/.test(rendererJs));
const machine = read('renderer/logic/state-machine.js');
check('D3 状态机 swim 兜底时长 ≥ 实际 3000ms（兜底不能比真实跑动先结束）', (() => {
  const m = machine.match(/swim:\s*Object\.freeze\(\{[^}]*duration:\s*(\d+)/);
  return Boolean(m && Number(m[1]) >= sp.SWIM_DURATION_MS);
})());

/* -------------------------------------------------------------------------- */
/* E. 眨眼移除（2026-10-05 按用户要求：眼睑覆盖层被看成脸上黑点，整体弃用）        */
/* -------------------------------------------------------------------------- */

check('E1 assets/fish.svg 已无 #blink 覆盖组', !/id="blink"/.test(fishSvg));
const htmlNoBlink = read('renderer/index.html');
check('E2 index.html 已无 #blink 覆盖组', !/id="blink"/.test(htmlNoBlink));
check('E3 renderer.js 已无眨眼覆盖逻辑（blinkGroup / syncBlinkOverlay / scheduleBlink）', !/blinkGroup|syncBlinkOverlay|scheduleBlink|BLINK_MIN_MS/.test(rendererJs));
check('E4 styles.css 已无 #blink 覆盖规则（忽略注释）', !/#blink\s*\{/.test(cssNoComment));
check('E5 .state-blink 仍保留规则（状态机状态存在，CSS 必须有可辨识规则）', /\.state-blink/.test(cssNoComment));

/* -------------------------------------------------------------------------- */
/* F. 点击反应多样性（2026-10-05 第二版：反应池轮换，杜绝"怎么点都一样"）         */
/* -------------------------------------------------------------------------- */

check('F1 点击反应改为按部位轮换的反应池（TAP_POOLS + pickTapAction）', /TAP_POOLS/.test(rendererJs) && /pickTapAction/.test(rendererJs));
check('F2 头部点击有独立识别（zoneKey = head，不再落进统一惊讶）', /zoneKey = 'head'/.test(rendererJs));
check('F3 反应池覆盖 头/脸/肚/手/脚/其它 六类', /head:\s*\[/.test(rendererJs) && /face:\s*\[/.test(rendererJs) && /belly:\s*\[/.test(rendererJs) && /hands:\s*\[/.test(rendererJs) && /feet:\s*\[/.test(rendererJs) && /other:\s*\[/.test(rendererJs));
check('F4 脸部命中区已纳入 zone 选择器', /#fish-svg #face/.test(rendererJs.match(/closest\('#fish-svg[^']*'\)/)[0]));

/* -------------------------------------------------------------------------- */
/* G. 点击打击感（2026-10-05：反应加强 + 爆星特效）                              */
/* -------------------------------------------------------------------------- */

check('G1 #tap-fx 爆星特效组已插入且默认隐藏（两个 SVG 同步）', fishSvg.includes('id="tap-fx" opacity="0"') && html.includes('id="tap-fx" opacity="0"'));
check('G2 爆星由 .pop 类触发、带独立 fade/pop 两段动画', /#tap-fx\.pop \{[^}]*animation:\s*tap-fade/.test(css) && /\.fx-burst \{[^}]*animation:\s*tap-pop/.test(css));
check('G3 渲染层已接线：playTapFx 用 getScreenCTM 换算落点并在 reactToTap 里调用', /function playTapFx/.test(rendererJs) && /getScreenCTM/.test(rendererJs) && /playTapFx\(x, y\)/.test(rendererJs));
check('G4 戳一戳幅度加大（jolt 含 -16px 位移与挤压拉伸）', /translateX\(-16px\) rotate\(-10deg\) scale\(1\.06, 0\.94\)/.test(css));
check('G5 蹦跳幅度加大（hop 腾空 22px + 落地压扁）', /translateY\(-22px\) scale\(0\.94, 1\.08\)/.test(css) && /scale\(1\.08, 0\.88\)/.test(css));
check('G6 害羞扭捏幅度加大（±5.5°）', /rotate\(5\.5deg\) scale\(1\.02, 0\.975\)/.test(css));
check('G7 打招呼踮脚幅度加大（腾空 16px + 压扁）', /translateY\(-16px\) scale\(0\.95, 1\.06\)/.test(css));

/* -------------------------------------------------------------------------- */
/* H. VPet 式灵动反馈（2026-10-05：台词气泡 / 自言自语 / 拖拽挣扎）               */
/* -------------------------------------------------------------------------- */

check('H1 互动台词池覆盖 8 种反应（poke/happy/pet/greet/flip/thinking/eat/wake）', ['poke', 'happy', 'pet', 'greet', 'flip', 'thinking', 'eat', 'wake'].every((k) => new RegExp(k + ':\\s*\\[').test(String(rendererJs.match(/REACTION_QUIPS[\s\S]*?\}\)/)))));
check('H2 动作被接受才冒台词（userAction 检查 result.accepted）', /result\.accepted/.test(rendererJs));
check('H3 自言自语定时器已接线（scheduleChatter 定义并在启动时调用）', /function scheduleChatter/.test(rendererJs) && /scheduleChatter\(\);\s*$/.test(rendererJs) || /scheduleChatter\(\);/.test(rendererJs));
check('H4 自言自语不会在睡觉时打扰（isSleeping 检查）', (() => { const m = rendererJs.match(/function scheduleChatter[\s\S]*?\n  \}/); return Boolean(m && m[0].includes('isSleeping')); })());
check('H5 拖拽会挣扎并冒抗议台词（dragged 请求 + dragged quip）', /machine\.request\('dragged'[^)]*\);\s*[\s\S]*?pickQuip\('dragged'\)/.test(rendererJs));
check('H6 拖拽挣扎动画落在人物图层（girl-wriggle）', /state-dragged #fish-svg #pet-image \{[^}]*animation: girl-wriggle/.test(css));
check('H7 闲置小动作池加入自娱自乐 greet（VPet 式自己玩）', /'thinking', 'thinking', 'flip', 'happy', 'greet', 'greet'/.test(rendererJs));

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('');
console.log('小蓝跑动专项自检');
console.log('='.repeat(64));
console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('');
  for (const item of failures) {
    console.log(`[失败] ${item}`);
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
