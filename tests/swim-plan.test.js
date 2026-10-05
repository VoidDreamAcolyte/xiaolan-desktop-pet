'use strict';

/**
 * ============================================================================
 * 纯逻辑单元测试：游动路径规划（main/swim-plan.js）
 * ============================================================================
 *
 * 这条测试直接验证硬要求"不要把宠物移出可用区域"：
 *   - 正常窗口、贴边窗口、被拖到屏幕外的窗口、比工作区还大的窗口；
 *   - 多屏负坐标（副屏在主屏左边时 workArea.x 是负数）；
 *   - 起点 / 中点 / 终点位置、方向判定、时长；
 *   - 非法几何参数必须返回 null（调用方据此放弃移动，而不是算出 NaN 坐标）。
 *
 * 用法：node tests/swim-plan.test.js （或 npm run test:unit）
 * 退出码：0 = 全部通过；1 = 有失败项
 */

const path = require('node:path');

const {
  SWIM_STEP_MS,
  SWIM_DURATION_MS,
  SWIM_TRAVEL_PX,
  SWIM_DRIFT_PX,
  createSwimPlan,
  positionAt,
  isInsidePlan,
  clamp,
  isValidRect
} = require(path.join(__dirname, '..', 'main', 'swim-plan.js'));

/* -------------------------------------------------------------------------- */
/* 迷你断言框架                                                                */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${name}  ← ${detail}` : name);
}

/** 主屏工作区：1920×1040，任务栏在下方 */
const MAIN_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
/** 副屏在主屏左侧（负坐标）：这才是多屏最容易算错的情况 */
const LEFT_WORK_AREA = { x: -1920, y: 0, width: 1920, height: 1040 };

/* -------------------------------------------------------------------------- */
/* 1. 基础工具                                                                 */
/* -------------------------------------------------------------------------- */

check('clamp 正常夹取', clamp(5, 0, 10) === 5 && clamp(-5, 0, 10) === 0 && clamp(50, 0, 10) === 10);
check('clamp 对 NaN / Infinity 退回 min', clamp(NaN, 3, 9) === 3 && clamp(Infinity, 3, 9) === 9);
check('isValidRect 拒绝非法矩形', isValidRect(null) === false && isValidRect({ x: 0, y: 0, width: 0, height: 10 }) === false);
check('isValidRect 接受正常矩形', isValidRect(MAIN_WORK_AREA) === true);

/* -------------------------------------------------------------------------- */
/* 2. 右下角的窗口：往左游到左边界再回来                                        */
/* -------------------------------------------------------------------------- */

{
  const bounds = { x: 1560, y: 700, width: 360, height: 340 };
  const plan = createSwimPlan(bounds, MAIN_WORK_AREA);

  check('正常几何参数能算出游动计划', Boolean(plan));
  check('起点就是窗口当前位置', plan.originX === 1560 && plan.originY === 700, `${plan.originX},${plan.originY}`);
  check('右下角窗口判定为向左游，且只游一小段（不贴边）', plan.direction === 'left' && plan.targetX === 1560 - SWIM_TRAVEL_PX, `${plan.direction}@${plan.targetX}`);
  check('右下角在下半区 → 目标向上漂一段', plan.targetY === 700 - SWIM_DRIFT_PX, String(plan.targetY));
  check('可用范围上限考虑了窗口尺寸', plan.maxX === 1560 && plan.maxY === 700, `${plan.maxX},${plan.maxY}`);
  check('游动时长是单程两倍', plan.durationMs === SWIM_DURATION_MS && plan.durationMs === plan.halfDurationMs * 2);

  const at0 = positionAt(plan, 0);
  const atHalf = positionAt(plan, plan.durationMs / 2);
  const atEnd = positionAt(plan, plan.durationMs);

  check('t=0 在起点', at0.x === plan.originX && at0.y === plan.originY, JSON.stringify(at0));
  check('t=0.5 到达另一侧', atHalf.x === plan.targetX, JSON.stringify(atHalf));
  check('t=1 精确回到起点（游完不留偏移）', atEnd.x === plan.originX && atEnd.y === plan.originY, JSON.stringify(atEnd));

  // 逐帧检查：任何一个采样点都不能越出可用区域
  let outOfBounds = 0;
  for (let t = 0; t <= plan.durationMs; t += SWIM_STEP_MS) {
    const point = positionAt(plan, t);
    if (!isInsidePlan(plan, point)) outOfBounds += 1;
  }
  check('整段轨迹的每一帧都在可用区域内', outOfBounds === 0, `越界帧数：${outOfBounds}`);
  check('超过总时长后停在起点（不会继续跑）', positionAt(plan, plan.durationMs * 3).x === plan.originX);
  check('负数时间按 0 处理', positionAt(plan, -5000).x === plan.originX);
  check('NaN 时间按 0 处理', positionAt(plan, NaN).x === plan.originX);
}

/* -------------------------------------------------------------------------- */
/* 3. 左侧窗口：往右游到右边界再回来                                            */
/* -------------------------------------------------------------------------- */

{
  const bounds = { x: 40, y: 12, width: 360, height: 340 };
  const plan = createSwimPlan(bounds, MAIN_WORK_AREA);
  check('左半屏窗口往右游，且只游一小段（不贴边）', plan.direction === 'right' && plan.targetX === 40 + SWIM_TRAVEL_PX, `${plan.direction}@${plan.targetX}`);
  check('左上角在上半区 → 目标向下漂一段', plan.targetY === 12 + SWIM_DRIFT_PX, String(plan.targetY));
  check('可用范围上限仍然是整个工作区（限幅用途）', plan.maxX === 1560, String(plan.maxX));
  check('终点回到起点', positionAt(plan, plan.durationMs).x === 40);
}

/* -------------------------------------------------------------------------- */
/* 4. 边界情况：窗口在屏幕外、窗口比工作区还大、副屏负坐标                        */
/* -------------------------------------------------------------------------- */

{
  // 窗口被拖到主屏外面（左、上、右、下都试一遍）
  const cases = [
    { x: -900, y: 100, width: 360, height: 340, label: '左侧屏幕外' },
    { x: 3000, y: 100, width: 360, height: 340, label: '右侧屏幕外' },
    { x: 100, y: -600, width: 360, height: 340, label: '上方屏幕外' },
    { x: 100, y: 2000, width: 360, height: 340, label: '下方屏幕外' }
  ];
  for (const item of cases) {
    const plan = createSwimPlan(item, MAIN_WORK_AREA);
    check(
      `窗口在${item.label}时起点会被拉回可用区域`,
      plan.originX >= plan.minX && plan.originX <= plan.maxX && plan.originY >= plan.minY && plan.originY <= plan.maxY,
      `${plan.originX},${plan.originY}`
    );
    check(`窗口在${item.label}时整段轨迹仍然不越界`, isInsidePlan(plan, positionAt(plan, 0)) && isInsidePlan(plan, positionAt(plan, plan.durationMs / 2)));
  }
}

{
  // 窗口比工作区还大：不能算出负的可用宽度
  const bounds = { x: 0, y: 0, width: 3000, height: 2000 };
  const plan = createSwimPlan(bounds, MAIN_WORK_AREA);
  check('窗口比工作区大时可用宽度退化为 0', plan.maxX === plan.minX && plan.maxY === plan.minY, `${plan.maxX},${plan.maxY}`);
  check('窗口比工作区大时仍停在 workArea 左上角内', plan.originX === MAIN_WORK_AREA.x && plan.originY === MAIN_WORK_AREA.y);
  check('窗口比工作区大时起伏幅度被压到 0', plan.bobPx === 0, String(plan.bobPx));
  check('窗口比工作区大时每帧位置依然合法', isInsidePlan(plan, positionAt(plan, 1234)));
}

{
  // 副屏在主屏左边：workArea.x 是负数，必须原样保留负坐标
  const bounds = { x: -1500, y: 300, width: 360, height: 340 };
  const plan = createSwimPlan(bounds, LEFT_WORK_AREA);
  check('多屏负坐标下起点保持负坐标', plan.originX === -1500, String(plan.originX));
  check('多屏负坐标下可用范围也是负的', plan.minX === -1920 && plan.maxX === -360, `${plan.minX},${plan.maxX}`);
  check('副屏左半屏窗口往右游', plan.direction === 'right', plan.direction);

  let bad = 0;
  for (let t = 0; t <= plan.durationMs; t += SWIM_STEP_MS) {
    if (!isInsidePlan(plan, positionAt(plan, t))) bad += 1;
  }
  check('负坐标屏幕上的整段轨迹也不越界', bad === 0, `越界帧数：${bad}`);
}

{
  // 上下起伏也要被工作区高度限制住
  const tinyArea = { x: 0, y: 0, width: 800, height: 360 };
  const bounds = { x: 100, y: 10, width: 360, height: 340 };
  const plan = createSwimPlan(bounds, tinyArea);
  check('工作区很矮时起伏幅度被限制', plan.bobPx <= (plan.maxY - plan.minY) / 2 + 0.001, String(plan.bobPx));
  let bad = 0;
  for (let t = 0; t <= plan.durationMs; t += SWIM_STEP_MS) {
    if (!isInsidePlan(plan, positionAt(plan, t))) bad += 1;
  }
  check('矮工作区里整段轨迹不越界', bad === 0, `越界帧数：${bad}`);
}

/* -------------------------------------------------------------------------- */
/* 5. 非法输入必须返回 null（调用方据此放弃移动）                                */
/* -------------------------------------------------------------------------- */

{
  check('缺 bounds 返回 null', createSwimPlan(null, MAIN_WORK_AREA) === null);
  check('缺 workArea 返回 null', createSwimPlan({ x: 0, y: 0, width: 360, height: 340 }, null) === null);
  check('宽高为 0 返回 null', createSwimPlan({ x: 0, y: 0, width: 0, height: 340 }, MAIN_WORK_AREA) === null);
  check('NaN 坐标返回 null', createSwimPlan({ x: NaN, y: 0, width: 360, height: 340 }, MAIN_WORK_AREA) === null);
  check('workArea 缺字段返回 null', createSwimPlan({ x: 0, y: 0, width: 360, height: 340 }, { x: 0, y: 0 }) === null);
  check('plan 为 null 时 positionAt 返回 null', positionAt(null, 100) === null);
  check('plan 为 null 时 isInsidePlan 返回 false', isInsidePlan(null, { x: 0, y: 0 }) === false);
}

/* -------------------------------------------------------------------------- */
/* 6. 位置必须是整数（setPosition 不接受小数）                                   */
/* -------------------------------------------------------------------------- */

{
  const plan = createSwimPlan({ x: 101, y: 202, width: 360, height: 340 }, MAIN_WORK_AREA);
  let nonInteger = 0;
  for (let t = 0; t <= plan.durationMs; t += 7) {
    const point = positionAt(plan, t);
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) nonInteger += 1;
  }
  check('所有帧给出的都是整数坐标', nonInteger === 0, `非整数帧：${nonInteger}`);
}

/* -------------------------------------------------------------------------- */
/* 输出                                                                        */
/* -------------------------------------------------------------------------- */

console.log('');
console.log('游动路径单元测试');
console.log('='.repeat(64));
console.log(`共 ${passed + failures.length} 项，通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log('');
  for (const item of failures) {
    console.log(`[失败] ${item}`);
  }
}
process.exitCode = failures.length === 0 ? 0 : 1;
