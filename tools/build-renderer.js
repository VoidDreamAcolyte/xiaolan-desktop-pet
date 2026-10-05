'use strict';

/**
 * ============================================================================
 * 把 assets/fish.svg 注入 renderer/index.html
 * ============================================================================
 *
 * 为什么需要这一步？
 *   - 美术资源要求是"独立、结构清楚的 SVG 文件"，方便单独编辑与预览；
 *   - 但 CSS 要驱动 SVG 内部元素（眼睛、鱼鳍、米粒…）的动画，最稳妥的方式是把
 *     SVG 内联进页面，而不是用 <img> 引用（<img> 里的 SVG 无法被外部 CSS 选中）。
 *
 * 因此：assets/fish.svg 是唯一事实来源，index.html 里只保留一对标记注释，
 * 由本脚本把 SVG 内联进去。改完 SVG 后运行：node tools/build-renderer.js
 *
 * 用法：
 *   node tools/build-renderer.js          写入 index.html
 *   node tools/build-renderer.js --check  只校验 index.html 里的内联 SVG 是否与源文件一致
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'assets', 'fish.svg');
const HTML_PATH = path.join(ROOT, 'renderer', 'index.html');

const MARKER_START = '<!-- FISH_SVG_START -->';
const MARKER_END = '<!-- FISH_SVG_END -->';

/**
 * 读取并规整 SVG：去掉 XML 声明，确保根标签带 id="fish-svg"。
 * @returns {string}
 */
function readSvg() {
  const raw = fs.readFileSync(SVG_PATH, 'utf8');

  if (/<image\b|<img\b|data:image\/png|data:image\/jpeg|\.png|\.jpg|\.jpeg/i.test(raw)) {
    throw new Error('fish.svg 里出现了位图引用：鱼本体必须全部是矢量绘制。');
  }

  let svg = raw.replace(/<\?xml[\s\S]*?\?>/g, '').trim();

  if (!/^<svg[\s>]/.test(svg)) {
    throw new Error('fish.svg 的根元素不是 <svg>。');
  }

  if (!/\bid="/.test(svg.slice(0, svg.indexOf('>')))) {
    svg = svg.replace('<svg ', '<svg id="fish-svg" ');
  }

  return svg;
}

/**
 * 把 SVG 压成单行并缩进，便于放回 HTML 且不破坏可读性。
 * @param {string} svg
 * @returns {string}
 */
function toInlineBlock(svg) {
  const oneLine = svg
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/> </g, '><');

  return `${MARKER_START}\n    ${oneLine}\n    ${MARKER_END}`;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const svg = readSvg();
  const html = fs.readFileSync(HTML_PATH, 'utf8');

  const startIndex = html.indexOf(MARKER_START);
  const endIndex = html.indexOf(MARKER_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`index.html 缺少 ${MARKER_START} / ${MARKER_END} 标记，无法注入 SVG。`);
  }

  const expectedBlock = toInlineBlock(svg);
  const currentBlock = html.slice(startIndex, endIndex + MARKER_END.length);

  if (checkOnly) {
    if (currentBlock !== expectedBlock) {
      console.error('[build-renderer] 内联 SVG 与 assets/fish.svg 不一致。请运行 node tools/build-renderer.js');
      process.exitCode = 1;
      return;
    }
    console.log('[build-renderer] 校验通过：index.html 内联 SVG 与 assets/fish.svg 一致。');
    return;
  }

  const nextHtml = html.slice(0, startIndex) + expectedBlock + html.slice(endIndex + MARKER_END.length);
  fs.writeFileSync(HTML_PATH, nextHtml, 'utf8');
  console.log(`[build-renderer] 已把 assets/fish.svg（${svg.length} 字符）注入 renderer/index.html。`);
}

main();
