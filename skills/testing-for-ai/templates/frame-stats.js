'use strict';
/* ============================================================
 * frame-stats.js —— 零依赖「帧判定」工具（像素缓冲；**不假设通道顺序**）
 * ------------------------------------------------------------
 * 用途：给截图/离屏渲染的帧做**可机械判定**的三件事 ——
 *   L1 有效帧：非空、非纯色（防黑屏 / 白屏 / 空白页 / 旧帧）
 *   L2 ROI   ：指定矩形区域独立统计（防"整图有效但关键区空白"）
 *   L3 基线  ：两帧逐像素差率（防取景漂移 / 布局回归）
 *
 * 设计约束（照抄时别破坏）：
 *   1. 零第三方依赖 —— 只吃 Buffer（逐像素 4 字节，**不依赖通道身份**）。
 *   2. 阈值单源 —— 全部在 THRESHOLDS，禁止调用方再写第二套（SKILL B1）。
 *   3. 纯函数 —— 不碰文件、不碰 Electron；Electron 适配在 analyzeNativeImage。
 *
 * 自检（判别力证明，SKILL B4）：node frame-stats.js --selftest
 * ============================================================ */

const THRESHOLDS = Object.freeze({
  validFrame: Object.freeze({ minUnique: 8, minRange: 40, minVariance: 4 }), // L1
  roi: Object.freeze({ minUnique: 4, minRange: 24, minVariance: 2 }),        // L2
  baseline: Object.freeze({ maxDiffRatio: 0.02, channelTolerance: 8 }),      // L3
  sampleCap: 20000                                                          // 采样上限（控耗时）
});

/** 把矩形裁剪进画面内，避免越界读。 */
function clampRegion(region, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(region.x || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(region.y || 0)));
  const w = Math.max(0, Math.min(width - x, Math.floor(region.w || 0)));
  const h = Math.max(0, Math.min(height - y, Math.floor(region.h || 0)));
  return { x, y, w, h };
}

/**
 * 像素统计。buf = 像素缓冲（**不假设通道顺序**）；region 省略时统计整帧。
 * 返回 { px, n, unique, mean, variance, range }；n 为实际采样点数。
 */
function analyzeBgra(buf, width, height, opts) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('analyzeBgra: buf 必须是 Buffer');
  if (!(width > 0) || !(height > 0)) throw new RangeError('analyzeBgra: width/height 必须为正整数');
  if (buf.length < width * height * 4) {
    throw new RangeError('analyzeBgra: buf 长度 ' + buf.length + ' < ' + width * height * 4);
  }
  const o = opts || {};
  const region = clampRegion(o.region || { x: 0, y: 0, w: width, h: height }, width, height);
  const px = region.w * region.h;
  if (!px) return { px: 0, n: 0, unique: 0, mean: 0, variance: 0, range: 0 };
  const sampleCap = o.sampleCap || THRESHOLDS.sampleCap;
  const step = Math.max(1, Math.floor(px / sampleCap));
  const seen = new Set();
  let sum = 0, sumSq = 0, min = 255, max = 0, n = 0;
  for (let i = 0; i < px; i += step) {
    const x = region.x + (i % region.w);
    const y = region.y + Math.floor(i / region.w);
    const off = (y * width + x) * 4;
    const c0 = buf[off], c1 = buf[off + 1], c2 = buf[off + 2];   // 通道不命名为 r/g/b：本工具不依赖通道身份
    seen.add((c0 << 16) | (c1 << 8) | c2);   // 打包值只用于去重计数：任何排列都是双射，计数不变
    const v = (c0 + c1 + c2) / 3;   // 三通道均值（不是加权亮度）：对任何通道排列都不变
    sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    n++;
  }
  const mean = n ? sum / n : 0;
  return {
    px, n, unique: seen.size, mean,
    variance: n ? (sumSq / n) - mean * mean : 0,
    range: max - min
  };
}

/** 按规则判定统计结果 → { ok, reason }。rule 省略时用 THRESHOLDS.validFrame。 */
function judge(stats, rule) {
  const r = rule || THRESHOLDS.validFrame;
  if (!stats || !stats.px) return { ok: false, reason: '帧为空（px=0）' };
  if (stats.unique <= r.minUnique) {
    return { ok: false, reason: '疑似纯色帧：unique=' + stats.unique + ' ≤ ' + r.minUnique };
  }
  if (stats.range <= r.minRange) {
    return { ok: false, reason: '亮度范围过窄：range=' + Math.round(stats.range) + ' ≤ ' + r.minRange };
  }
  if (stats.variance <= r.minVariance) {
    return { ok: false, reason: '方差过低：variance=' + stats.variance.toFixed(1) + ' ≤ ' + r.minVariance };
  }
  return { ok: true, reason: 'unique=' + stats.unique + ' range=' + Math.round(stats.range)
    + ' variance=' + stats.variance.toFixed(1) };
}

/** 两帧逐像素差率（0–1）。任一通道差 > tolerance 记为一个"差异像素"。 */
function diffRatio(bufA, bufB, opts) {
  const o = opts || {};
  const tol = o.channelTolerance === undefined ? THRESHOLDS.baseline.channelTolerance : o.channelTolerance;
  if (!Buffer.isBuffer(bufA) || !Buffer.isBuffer(bufB)) throw new TypeError('diffRatio: 需要两个 Buffer');
  if (bufA.length !== bufB.length) {
    throw new RangeError('diffRatio: 尺寸不一致（' + bufA.length + ' vs ' + bufB.length + '）—— 取景漂移')
  }
  const pixels = bufA.length / 4;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 4) {
    if (Math.abs(bufA[i] - bufB[i]) > tol
      || Math.abs(bufA[i + 1] - bufB[i + 1]) > tol
      || Math.abs(bufA[i + 2] - bufB[i + 2]) > tol) diff++;
  }
  return { ratio: pixels ? diff / pixels : 0, diffPixels: diff, pixels };
}

/** Electron 适配：把 NativeImage 变成 { bmp, width, height }（无 Electron 时不调用）。 */
function analyzeNativeImage(img) {
  if (!img || typeof img.getSize !== 'function') throw new TypeError('analyzeNativeImage: 需要 NativeImage');
  const size = img.getSize();
  // Electron 44+ 用 toBitmap()；getBitmap() 已弃用（会打 DeprecationWarning）。保留回退以兼容旧版。
  const bmp = typeof img.toBitmap === 'function' ? img.toBitmap() : img.getBitmap();
  return { bmp, width: size.width, height: size.height };
}

module.exports = { THRESHOLDS, clampRegion, analyzeBgra, judge, diffRatio, analyzeNativeImage };

/* ---------------- 自检：判别力证明（node frame-stats.js --selftest） ---------------- */
function selftest() {
  const W = 200, H = 120;
  const make = (fill) => {
    const buf = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = fill(x, y), off = (y * W + x) * 4;
        buf[off] = c.b; buf[off + 1] = c.g; buf[off + 2] = c.r; buf[off + 3] = 255;
      }
    }
    return buf;
  };
  const black = make(() => ({ r: 0, g: 0, b: 0 }));
  const white = make(() => ({ r: 255, g: 255, b: 255 }));
  // 真实界面感的帧：带文字/边框/面板的渐变噪点
  const ui = make((x, y) => ({ r: (x * 7 + y * 3) % 256, g: (x * 3 + y * 11) % 256, b: (x * 13 + y * 5) % 256 }));
  const uiShifted = make((x, y) => ({ r: ((x + 12) * 7 + y * 3) % 256, g: ((x + 12) * 3 + y * 11) % 256, b: ((x + 12) * 13 + y * 5) % 256 }));
  const blankRoi = (() => { // 整图有效，但左下角一块是纯白（模拟"关键区空白"）
    const buf = Buffer.from(ui);
    for (let y = 60; y < 100; y++) {
      for (let x = 20; x < 90; x++) {
        const off = (y * W + x) * 4;
        buf[off] = 255; buf[off + 1] = 255; buf[off + 2] = 255;
      }
    }
    return buf;
  })();

  const cases = [
    ['L1 全黑帧必须红', !judge(analyzeBgra(black, W, H), THRESHOLDS.validFrame).ok],
    ['L1 全白帧必须红', !judge(analyzeBgra(white, W, H), THRESHOLDS.validFrame).ok],
    ['L1 真实帧必须绿', judge(analyzeBgra(ui, W, H), THRESHOLDS.validFrame).ok],
    ['L2 空白 ROI 必须红', !judge(analyzeBgra(blankRoi, W, H, { region: { x: 20, y: 60, w: 70, h: 40 } }), THRESHOLDS.roi).ok],
    ['L2 同图非空 ROI 必须绿', judge(analyzeBgra(blankRoi, W, H, { region: { x: 100, y: 10, w: 60, h: 40 } }), THRESHOLDS.roi).ok],
    ['L3 位移 12px 必须超差率', diffRatio(ui, uiShifted).ratio > THRESHOLDS.baseline.maxDiffRatio],
    ['L3 同帧差异为 0', diffRatio(ui, Buffer.from(ui)).ratio === 0]
  ];

  let bad = 0;
  console.log('frame-stats 自检（判别力证明）');
  console.log('─'.repeat(52));
  for (const [name, pass] of cases) {
    if (!pass) bad++;
    console.log((pass ? '✓ ' : '✗ ') + name);
  }
  const s = analyzeBgra(ui, W, H);
  console.log('─'.repeat(52));
  console.log('参考：真实感帧 unique=' + s.unique + ' range=' + Math.round(s.range) + ' variance=' + s.variance.toFixed(1));
  console.log('参考：全黑帧 ' + JSON.stringify(judge(analyzeBgra(black, W, H))));
  if (bad) { console.error('\n自检失败：' + bad + ' 条'); process.exit(1); }
  console.log('\n自检通过：' + cases.length + '/' + cases.length);
}

if (require.main === module && process.argv.includes('--selftest')) selftest();
