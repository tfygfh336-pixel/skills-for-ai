'use strict';
/* ============================================================
 * vision-assertions.js —— 三级视觉断言骨架（模板，拷进工程后按 TODO 接线）
 * ------------------------------------------------------------
 * 配套：frame-stats.js（零依赖像素统计，阈值单源）
 * 用法（在视觉断言步里）：
 *     const { runVision } = require('./vision-assertions');
 *     runVision([...], { getFrame, projectRoot }).then(ok => process.exit(ok ? 0 : 1));
 *
 * 三级对应的"抓得住/抓不住"边界，见 skill 的 REFERENCE.md §2.3：
 *   L1 有效帧  → 黑屏/白屏/空白/旧帧
 *   L2 ROI    → "整图有效但关键区空白"
 *   L3 基线   → 取景漂移、布局回归（**基线必须由人确认过的运行产生**）
 *   L4 记录   → AI 读图结论是否与当前帧绑定（哈希），防张冠李戴
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { THRESHOLDS, analyzeBgra, judge, diffRatio, analyzeNativeImage } = require('./frame-stats');

/** 帧 → { bmp, width, height }。Electron 传 NativeImage；其它栈自行适配成 BGRA Buffer。 */
function toFrame(shot) {
  return shot && shot.bmp ? shot : analyzeNativeImage(shot);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ---------------- L0/L1：产物存在 + 有效帧 ---------------- */

/**
 * @param name    断言名（写清"什么必须成立"）
 * @param getFrame () => NativeImage | {bmp,width,height}
 * @param savePath 可选：把本次帧落盘（供人/AI 读图）
 */
function validFrameAssertion({ name, getFrame, savePath }) {
  return {
    name: name || 'L1 有效帧：截图非空、非纯色（防黑屏/白屏/旧帧）',
    run: async () => {
      const img = await getFrame();
      const f = toFrame(img);
      if (savePath && img && typeof img.toPNG === 'function') {
        fs.mkdirSync(path.dirname(savePath), { recursive: true });
        fs.writeFileSync(savePath, img.toPNG());
      }
      const stats = analyzeBgra(f.bmp, f.width, f.height);
      const j = judge(stats, THRESHOLDS.validFrame);
      return { ok: j.ok, text: f.width + 'x' + f.height + ' ' + j.reason };
    }
  };
}

/* ---------------- L2：关键区域独立判定 ---------------- */

/**
 * @param region {x,y,w,h} 逻辑像素矩形（注意与设备像素比的关系，见 REFERENCE §4）
 */
function roiAssertion({ name, getFrame, region, rule }) {
  return {
    name: name || ('L2 ROI：区域 ' + JSON.stringify(region) + ' 非空白'),
    run: async () => {
      const f = toFrame(await getFrame());
      const stats = analyzeBgra(f.bmp, f.width, f.height, { region });
      const j = judge(stats, rule || THRESHOLDS.roi);
      return { ok: j.ok, text: JSON.stringify(region) + ' ' + j.reason };
    }
  };
}

/* ---------------- L3：基线差率 ---------------- */

/**
 * @param baselinePath 基线 PNG 的**原始 BGRA 缓冲**（推荐 .raw，避免引入 PNG 解码依赖）
 *                     —— 生成方式：跑一次确认无误的运行，把 toBitmap() 的 Buffer 原样落盘。
 */
function baselineAssertion({ name, getFrame, baselinePath, rule }) {
  return {
    name: name || 'L3 基线差率：与基线帧的差异像素占比不超阈值（防取景漂移）',
    run: async () => {
      const r = rule || THRESHOLDS.baseline;
      const f = toFrame(await getFrame());
      const base = fs.readFileSync(baselinePath);
      const d = diffRatio(base, f.bmp, { channelTolerance: r.channelTolerance });
      const ok = d.ratio <= r.maxDiffRatio;
      return {
        ok,
        text: '差率=' + (d.ratio * 100).toFixed(2) + '%（上限 ' + (r.maxDiffRatio * 100) + '%）'
          + ' 差异像素=' + d.diffPixels + '/' + d.pixels
      };
    }
  };
}

/* ---------------- L4：AI 读图记录与当前帧绑定 ---------------- */

/**
 * 校验读图产物：verdict 非 ok 时**必须**让交付可见（本断言负责拦住"记了异常还报全绿"）。
 * 产物样例见 templates/vision-record.example.json。
 */
function recordAssertion({ name, recordPath, pngPath }) {
  return {
    name: name || 'L4 读图记录：结论与当前 PNG 哈希绑定，且无未处理异常',
    run: async () => {
      if (!fs.existsSync(recordPath)) {
        return { ok: false, text: '读图记录缺失：' + recordPath + '（采不到 = 红，不许跳过）' };
      }
      const rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (pngPath && fs.existsSync(pngPath)) {
        const now = sha256File(pngPath);
        if (rec.sha256 !== now) {
          return { ok: false, text: '记录绑定的哈希与当前截图不一致（记录=' + String(rec.sha256).slice(0, 12)
            + '… 当前=' + now.slice(0, 12) + '…）—— 结论已过期，重新读图' };
        }
      }
      const bad = Object.entries(rec.checklist || {})
        .filter(([, v]) => v && v.verdict && v.verdict !== 'ok' && v.verdict !== 'missing')
        .map(([k, v]) => k + '=' + v.verdict);
      if (bad.length) return { ok: false, text: '读图发现异常未处理：' + bad.join(', ') };
      return { ok: true, text: 'verdict=' + rec.verdict + ' 哈希一致' };
    }
  };
}

/* ---------------- 运行器：exit 0/1 契约 ---------------- */

async function runVision(assertions, ctx) {
  const results = [];
  for (const a of assertions) {
    try {
      const r = await a.run(ctx);
      results.push({ name: a.name, ok: !!r.ok, text: String((r && r.text) || '') });
    } catch (err) {
      // 抛错 = 红，绝不静默跳过（SKILL A5：采不到真值 = 红，"跳过"不得伪装成"通过"）
      results.push({ name: a.name, ok: false, text: 'THREW: ' + ((err && err.message) || err) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n==== VISION RESULTS ====');
  results.forEach((r) => console.log('[' + (r.ok ? 'PASS' : 'FAIL') + '] ' + r.name + ' :: ' + r.text));
  console.log('==== ' + (results.length - failed.length) + '/' + results.length + ' passed ====');
  return failed.length === 0;
}

module.exports = {
  validFrameAssertion, roiAssertion, baselineAssertion, recordAssertion, runVision,
  sha256File, toFrame
};

/* TODO（接入一个工程时按顺序做）：
 * 1) 把 L1 接上：getFrame = () => win.webContents.capturePage()（Electron）
 * 2) 跑一次，把 PNG 交给 AI 读图确认画面正确 → 这是"人确认过的运行"
 * 3) 用它与基线比对生成 baseline.raw（toBitmap() 原样落盘）
 * 4) 注入坏帧验证判别力：全黑 / 全白 / 平移 N 像素 / 关键区涂白 → 对应断言必须红
 * 5) 把 L4 的 recordPath 指到 .review/vision/ 下的产物，并保证哈希绑定
 */
