'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯函数模块：跑动（原 swim 游动）路径规划
 * ============================================================================
 *
 * 本模块【不依赖 Electron，也不 require 任何 Node 内置模块】，只做几何计算，
 * 因此可以被：
 *   - 主进程 main/main.js 引用（真正驱动 setPosition 动画）；
 *   - 裸 node 环境下的单元测试直接 require 并真正执行（tests/swim-plan.test.js）。
 *
 * 为什么要把几何计算单独拆出来：
 *   1. "不许把宠物移出可用区域"是一条硬要求，必须有可直接执行的测试来证明
 *      —— 包括窗口比工作区还大、窗口被拖到屏幕外、多屏负坐标等边界情况。
 *   2. 渲染层永远不传屏幕坐标，目标位置一律由主进程按"窗口当前 bounds +
 *      所在显示器 workArea"算出来，这里是唯一的计算入口。
 *
 * 跑动轨迹约定（2026-10-05 调整：游动改为跑动 + 迈步弹跳）：
 *   - 先判断小蓝当前在所在显示器工作区的左半还是右半；
 *   - 朝那一侧快跑一小段固定距离（不再横穿整个屏幕），再原路跑回出发点；
 *   - 纵向：上半区的往下跑一截、下半区的往上跑一截（同样限制距离）；
 *   - 全程带"迈步弹跳"（正弦按步频多次起伏），起点 / 中点 / 终点都精确回到原始位置。
 */

/** 动画帧间隔（毫秒）：约 60fps */
const SWIM_STEP_MS = 16;
/** 单程时长（毫秒）：用户反馈太快，950 → 1500（速度约 93px/s 的慢跑） */
const SWIM_HALF_DURATION_MS = 1500;
/** 一个完整来回的总时长（毫秒） */
const SWIM_DURATION_MS = SWIM_HALF_DURATION_MS * 2;
/** 单程水平跑动距离（像素）：小碎步冲刺（用户反馈范围大，260 → 140） */
const SWIM_TRAVEL_PX = 140;
/** 单程垂直漂移距离（像素）：跑动时顺便向下 / 向上挪一小截（120 → 70） */
const SWIM_DRIFT_PX = 70;
/** 跑动时的上下弹跳幅度（像素），实际会被工作区高度进一步限制 */
const SWIM_BOB_PX = 10;
/** 迈步弹跳的步频：一个来回里弹跳几个完整周期（整数保证中点 / 终点精确归位；6 周期 ≈ 500ms/步） */
const SWIM_BOUNCE_CYCLES = 6;

/**
 * 数值限幅：保证不会算出 NaN / Infinity 坐标。
 * 约定：非数字 / NaN → min；+Infinity → max；-Infinity → min；max < min 时退化为 min。
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value)) return min;
  if (max < min) return min;
  if (value === Infinity) return max;
  if (value === -Infinity) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 判断一个矩形是否是"可用几何"（宽高为正的有限数）。
 * @param {{x?: number, y?: number, width?: number, height?: number}} rect
 * @returns {boolean}
 */
function isValidRect(rect) {
  if (!rect || typeof rect !== 'object') return false;
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

/**
 * 根据"窗口当前 bounds"和"所在显示器 workArea"规划一次来回跑动。
 *
 * 关键点（安全边界）：
 *   - 所有可用的 x/y 都经过 clamp，窗口任何时刻都不会越出 workArea；
 *   - 窗口比工作区还大时 maxX/maxY 退化成 minX/minY，仍然停留在 workArea 左上角内；
 *   - 窗口当前在屏幕外时，origin 会被拉回工作区内（先归位再跑）。
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds 窗口当前 bounds（屏幕坐标）
 * @param {{x: number, y: number, width: number, height: number}} workArea 显示器工作区
 * @returns {null | {
 *   originX: number, originY: number, targetX: number, targetY: number,
 *   minX: number, maxX: number, minY: number, maxY: number,
 *   direction: 'left' | 'right', durationMs: number, halfDurationMs: number, bobPx: number,
 *   bounceCycles: number
 * }} 规划结果；几何参数非法时返回 null（调用方必须按失败处理，不做任何移动）
 */
function createSwimPlan(bounds, workArea) {
  if (!isValidRect(bounds) || !isValidRect(workArea)) return null;

  const minX = workArea.x;
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - bounds.width);
  const minY = workArea.y;
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - bounds.height);

  const originX = clamp(bounds.x, minX, maxX);
  const originY = clamp(bounds.y, minY, maxY);

  // 用窗口中心与工作区中心比较，决定"往哪边跑"
  const windowCenterX = originX + bounds.width / 2;
  const areaCenterX = workArea.x + workArea.width / 2;
  const fromLeftHalf = windowCenterX <= areaCenterX;
  const direction = fromLeftHalf ? 'right' : 'left';
  // 只跑一小段固定距离（不是贴到屏幕边），并夹回可用范围
  const targetX = clamp(
    fromLeftHalf ? originX + SWIM_TRAVEL_PX : originX - SWIM_TRAVEL_PX,
    minX,
    maxX
  );

  // 纵向：上半区的往下跑、下半区的往上跑，同样只挪一小段并夹回可用范围
  const windowCenterY = originY + bounds.height / 2;
  const areaCenterY = workArea.y + workArea.height / 2;
  const fromUpperHalf = windowCenterY <= areaCenterY;
  const targetY = clamp(
    fromUpperHalf ? originY + SWIM_DRIFT_PX : originY - SWIM_DRIFT_PX,
    minY,
    maxY
  );

  // 弹跳幅度不能超过可用纵向空间的一半，否则会顶出工作区
  const bobPx = Math.max(0, Math.min(SWIM_BOB_PX, (maxY - minY) / 2));

  return Object.freeze({
    originX,
    originY,
    targetX,
    targetY,
    minX,
    maxX,
    minY,
    maxY,
    direction,
    durationMs: SWIM_DURATION_MS,
    halfDurationMs: SWIM_HALF_DURATION_MS,
    bobPx,
    bounceCycles: SWIM_BOUNCE_CYCLES
  });
}

/**
 * 缓入缓出（smoothstep 风格），让起步与收尾不那么生硬。
 * @param {number} t 0~1
 * @returns {number}
 */
function easeInOut(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * 计算跑动进行到 elapsedMs 时窗口应该在的位置。
 *
 * 轨迹：0 → 半程跑到（targetX, targetY）→ 全程回到起点；纵向在"起点↔目标"的
 * 插值之上再叠加按步频起伏的"迈步弹跳"（bounceCycles 个完整周期，因此
 * 起点 / 中点 / 终点都精确落位，跑完不留偏移）。
 *
 * @param {ReturnType<typeof createSwimPlan>} plan
 * @param {number} elapsedMs 从跑动开始算起的毫秒数
 * @returns {null | {x: number, y: number}} 整数屏幕坐标；plan 非法时返回 null
 */
function positionAt(plan, elapsedMs) {
  if (!plan) return null;

  const total = plan.durationMs;
  const t = clamp(!Number.isFinite(elapsedMs) ? 0 : elapsedMs / total, 0, 1);

  let x;
  let y;
  if (t <= 0.5) {
    const p = easeInOut(t / 0.5);
    x = plan.originX + (plan.targetX - plan.originX) * p;
    y = plan.originY + (plan.targetY - plan.originY) * p;
  } else {
    const p = easeInOut((t - 0.5) / 0.5);
    x = plan.targetX + (plan.originX - plan.targetX) * p;
    y = plan.targetY + (plan.originY - plan.targetY) * p;
  }
  // 迈步弹跳：整数的周期数保证起点 / 中点 / 终点仍在插值位置上
  const cycles = Number.isFinite(plan.bounceCycles) && plan.bounceCycles > 0 ? plan.bounceCycles : 1;
  y += Math.sin(2 * Math.PI * cycles * t) * plan.bobPx;

  // 最后再夹一次：即使 easing / 正弦出现意外数值，也绝不允许越界
  return {
    x: Math.round(clamp(x, plan.minX, plan.maxX)),
    y: Math.round(clamp(y, plan.minY, plan.maxY))
  };
}

/**
 * 判断一个点是否落在规划出来的可用区域内（测试与主进程都可用来做断言）。
 * @param {ReturnType<typeof createSwimPlan>} plan
 * @param {{x: number, y: number}} point
 * @returns {boolean}
 */
function isInsidePlan(plan, point) {
  if (!plan || !point) return false;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= plan.minX &&
    point.x <= plan.maxX &&
    point.y >= plan.minY &&
    point.y <= plan.maxY
  );
}

module.exports = {
  SWIM_STEP_MS,
  SWIM_HALF_DURATION_MS,
  SWIM_DURATION_MS,
  SWIM_TRAVEL_PX,
  SWIM_DRIFT_PX,
  SWIM_BOB_PX,
  SWIM_BOUNCE_CYCLES,
  clamp,
  isValidRect,
  createSwimPlan,
  easeInOut,
  positionAt,
  isInsidePlan
};
