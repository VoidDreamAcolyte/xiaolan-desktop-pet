'use strict';

/**
 * ============================================================================
 * 生成托盘图标 PNG（零依赖，纯 Node 内置模块）
 * ============================================================================
 *
 * 为什么需要它：
 *   Electron 的 Tray / nativeImage 不接受 SVG，必须给 PNG/ICO。为了不引入任何
 *   第三方图像库，这里用 Node 内置的 zlib 自己写一个最小的 PNG 编码器，
 *   把"小鱼"用矢量形状（椭圆 + 三角形 + 圆）光栅化出来。
 *
 * 与 tools/make-icons.ps1 的关系：
 *   两者画的是同一份设计（32×32 基准，深海蓝身体 + 大眼 + 小尾巴）。
 *   本脚本是默认入口（npm run icons），因为它不依赖 PowerShell；
 *   make-icons.ps1 是等价的 PowerShell 实现，供需要时对照或备用。
 *
 * 注意：托盘图标只是托盘按钮上的小图标；桌宠本体在 assets/fish.svg，
 *       永远是矢量，不会被这里的位图替代。
 *
 * 用法：node tools/make-icons.js
 * 产物：assets/tray-icon.png (32×32)、assets/tray-icon@2x.png (64×64)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'assets');
const SUPERSAMPLE = 4; // 每个像素 4×4 子采样，做抗锯齿

/* -------------------------------------------------------------------------- */
/* PNG 编码（RGBA8，无外部依赖）                                                */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * 计算 PNG 分块的 CRC32。
 * @param {Buffer} buf
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG 分块：长度 + 类型 + 数据 + CRC。
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * 把 RGBA 像素编码成 PNG 文件内容。
 * @param {Buffer} rgba 长度 = width * height * 4
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方式
  ihdr[11] = 0; // 滤波方式
  ihdr[12] = 0; // 非隔行

  // 每行前面加一个滤波字节（0 = 无滤波）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------------------- */
/* 极简矢量光栅化（在 32×32 设计坐标系里画，再按比例缩放）                       */
/* -------------------------------------------------------------------------- */

/** 深海蓝配色（与 assets/fish.svg 一致） */
const COLOR = {
  bodyTop: [27, 110, 168],
  bodyBottom: [6, 42, 73],
  fin: [12, 74, 118],
  eyeWhite: [246, 251, 255],
  pupil: [8, 36, 61]
};

/** 判断点是否在椭圆内 */
function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

/**
 * 判断点是否在三角形内（同向叉积法）。
 * @param {number[][]} tri 三个顶点 [[x,y],[x,y],[x,y]]
 */
function inTriangle(x, y, tri) {
  const [a, b, c] = tri;
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([x, y], a, b);
  const d2 = sign([x, y], b, c);
  const d3 = sign([x, y], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** 形状定义（设计坐标 32×32） */
const SHAPE = {
  body: { cx: 14, cy: 15.5, rx: 10, ry: 8.5 },
  fin: { cx: 19, cy: 22.5, rx: 4, ry: 2.5 },
  eyeLeft: { cx: 13, cy: 14.5, rx: 3, ry: 3.5 },
  eyeRight: { cx: 22, cy: 14.5, rx: 3, ry: 3.5 },
  pupilLeft: { cx: 13.1, cy: 15, rx: 1.5, ry: 1.8 },
  pupilRight: { cx: 22.1, cy: 15, rx: 1.5, ry: 1.8 },
  tailTop: [[5, 13], [0, 8], [5, 18]],
  tailBottom: [[5, 17], [0, 24], [5, 20]]
};

/**
 * 求某个设计坐标点的颜色（含透明度），不在任何形状上则返回 null。
 * @param {number} x
 * @param {number} y
 * @returns {number[] | null} [r, g, b, a]
 */
function samplePoint(x, y) {
  // 瞳孔
  if (inEllipse(x, y, SHAPE.pupilLeft.cx, SHAPE.pupilLeft.cy, SHAPE.pupilLeft.rx, SHAPE.pupilLeft.ry)) {
    return [...COLOR.pupil, 255];
  }
  if (inEllipse(x, y, SHAPE.pupilRight.cx, SHAPE.pupilRight.cy, SHAPE.pupilRight.rx, SHAPE.pupilRight.ry)) {
    return [...COLOR.pupil, 255];
  }
  // 眼白
  if (inEllipse(x, y, SHAPE.eyeLeft.cx, SHAPE.eyeLeft.cy, SHAPE.eyeLeft.rx, SHAPE.eyeLeft.ry)) {
    return [...COLOR.eyeWhite, 255];
  }
  if (inEllipse(x, y, SHAPE.eyeRight.cx, SHAPE.eyeRight.cy, SHAPE.eyeRight.rx, SHAPE.eyeRight.ry)) {
    return [...COLOR.eyeWhite, 255];
  }
  // 身体（带上下渐变）
  if (inEllipse(x, y, SHAPE.body.cx, SHAPE.body.cy, SHAPE.body.rx, SHAPE.body.ry)) {
    const top = SHAPE.body.cy - SHAPE.body.ry;
    const t = Math.min(1, Math.max(0, (y - top) / (SHAPE.body.ry * 2)));
    const r = Math.round(COLOR.bodyTop[0] + (COLOR.bodyBottom[0] - COLOR.bodyTop[0]) * t);
    const g = Math.round(COLOR.bodyTop[1] + (COLOR.bodyBottom[1] - COLOR.bodyTop[1]) * t);
    const b = Math.round(COLOR.bodyTop[2] + (COLOR.bodyBottom[2] - COLOR.bodyTop[2]) * t);
    return [r, g, b, 255];
  }
  // 小短鳍
  if (inEllipse(x, y, SHAPE.fin.cx, SHAPE.fin.cy, SHAPE.fin.rx, SHAPE.fin.ry)) {
    return [...COLOR.fin, 255];
  }
  // 小尾巴（两片三角）
  if (inTriangle(x, y, SHAPE.tailTop) || inTriangle(x, y, SHAPE.tailBottom)) {
    return [...COLOR.fin, 255];
  }
  return null;
}

/**
 * 渲染一张 size×size 的 RGBA 图标。
 * @param {number} size
 * @returns {Buffer}
 */
function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 32 / size; // 屏幕像素 → 设计坐标
  const sub = SUPERSAMPLE;
  const subWeight = 1 / (sub * sub);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // 子采样：把每个像素切成 sub×sub 份求平均，得到平滑边缘
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const dx = (px + (sx + 0.5) / sub) * scale;
          const dy = (py + (sy + 0.5) / sub) * scale;
          const color = samplePoint(dx, dy);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += color[3];
          }
        }
      }

      const offset = (py * size + px) * 4;
      const alpha = a * subWeight;
      if (alpha > 0) {
        // 用覆盖到的子样本数归一化颜色，避免边缘发黑
        const covered = a / 255;
        rgba[offset] = Math.round(r / covered);
        rgba[offset + 1] = Math.round(g / covered);
        rgba[offset + 2] = Math.round(b / covered);
        rgba[offset + 3] = Math.round(alpha);
      }
    }
  }

  return rgba;
}

/* -------------------------------------------------------------------------- */

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const targets = [
    { size: 32, name: 'tray-icon.png' },
    { size: 64, name: 'tray-icon@2x.png' }
  ];

  for (const target of targets) {
    const rgba = renderIcon(target.size);
    const png = encodePng(rgba, target.size, target.size);
    const file = path.join(OUT_DIR, target.name);
    fs.writeFileSync(file, png);
    console.log(`[icons] 已生成 ${file} (${target.size}x${target.size}, ${png.length} 字节)`);
  }
}

main();
