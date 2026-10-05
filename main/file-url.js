'use strict';

/**
 * ============================================================================
 * 蓝色大肥鱼 —— 纯函数模块：file:// URL 归一化
 * ============================================================================
 *
 * 本模块【不依赖 Electron，也不 require 任何 Node 内置模块】，是一个纯粹的字符串
 * 函数，因此可以同时被：
 *   - 主进程 main/main.js 引用（判断导航 / IPC 来源是否是本地入口页面）；
 *   - 裸 node 环境下的烟测脚本直接 require 并真正执行（tests/smoke.test.js）。
 * 把纯函数从 main.js 拆出来的目的，就是让烟测能调用真实实现，
 * 而不是在测试文件里复制一份正则来"冒充"被测代码。
 *
 * 为什么需要归一化：
 *   Chromium 上报的 frame URL 与 Node 的 pathToFileURL() 生成的形式可能不一致 ——
 *   同一路径在 Windows 上会出现盘符大写/小写、空格等字符被百分号编码（%20）等差异。
 *   直接做字符串比较会误判，归一化之后再比较才可靠。
 */

/**
 * 把 file:// URL 归一化成可比较的形式：
 *   - 逐段做百分号解码，兼容路径里含中文 / 空格等被 URL 编码的字符；
 *   - Windows 盘符大小写不敏感，统一成小写；
 *   - 盘符写法统一成标准三斜杠形式 file:///d:/...（同时兼容 file://D:/ 这种两斜杠写法）；
 *   - 去掉结尾多余的斜杠。
 *
 * 注意：正则必须能匹配 file:///D:/... —— 这才是 pathToFileURL('D:/...') 的实际形式。
 * 早期写成 /^file:\/\/([A-Za-z]):/（少一个斜杠），标准三斜杠 URL 根本不匹配，
 * 盘符不会被小写化，于是 file:///D:/A%20B/x.html 与 file:///d:/A B/x.html
 * 会被判成两个不同的 URL，白名单校验随之失效。
 *
 * @param {unknown} url
 * @returns {string | null} 归一化结果；不是 file:// URL（或类型不对）时返回 null
 */
function normalizeFileUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;

  const decoded = url
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // 非法百分号序列：保留原样，后续比较自然不相等
        return segment;
      }
    })
    .join('/');

  const lowerDrive = decoded.replace(
    /^file:\/\/(\/?)([A-Za-z]):/,
    (_match, _slash, drive) => `file:///${drive.toLowerCase()}:`
  );
  return lowerDrive.replace(/\/+$/, '');
}

module.exports = { normalizeFileUrl };
