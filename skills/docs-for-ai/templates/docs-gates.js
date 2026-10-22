#!/usr/bin/env node
/* ============================================================
 * templates/docs-gates.js — 文档体系判定的**起步模板**（可整份拷进你的工程）
 * ------------------------------------------------------------
 * 它实现 `REFERENCE.md` §3 里最值得先上的判定 —— **6 个 check**
 * （`node scripts/docs-gates.js --selftest` 可复跑：临时工程里逐种注入，**必红项必须全红**；
 *   条数与结果由脚本自己现场统计打印，**本文不写死条数** —— 写死过就会漂）：
 *   ① 登记与家门（元信息块**四行齐备**才算合格；根/顶层白名单）
 *   ② 层取值表（`层` 必须在 `LAYER_ORDER` 内 —— 权威在 SKILL.md B3）
 *   ③ 悬挂登记（登记表里写的文档必须真的在磁盘上）
 *   ④ 归档缺横幅（归档文件开头必须有"我是历史"的标记；**递归**）
 *   ⑤ 工作目录无状态（工作产物区的直接子目录必须有 README）
 *   ⑥ 登记表与元信息一致（生成式登记表：手改表格 / 改元信息不重生成 ⇒ 红）
 * 其余判定（交接死指针 / 代码未入档 / 导航不可达 / 契约缺字段 / 章节断号 …）照 `REFERENCE.md` §3 逐条加。
 *
 * 用法：
 *   node scripts/docs-gates.js             # 校验（退出码 0/1，可直接挂进验证链）
 *   node scripts/docs-gates.js --write     # 从各文档头部元信息**生成**登记表
 *   node scripts/docs-gates.js --list      # 列出受管文档与判定状态；**同样参与门禁**（有不合格即退 1）
 *   node scripts/docs-gates.js --selftest  # 判别力自检：临时工程里逐种注入违规，必红项必须全红
 *
 * 设计要点（别改坏）：
 *   · 判定**只读文本**，应当毫秒级；
 *   · 报错必须**告诉人怎么改**（改哪个文件、跑哪条命令）；
 *   · **一次错误只报一两条消息** —— 为同一根因喷一屏消息，使用者会学会无视它；
 *   · 生成表与校验用**同一个渲染函数** —— 否则"过期"判不准；
 *   · **采不到真值 = 红** —— 文件读不出来时不许静默跳过（"跳过"会被当成"通过"）；
 *   · **检查模式与生成模式必须一致** —— `--write` 在同样的输入上也要拒绝；
 *   · **判定的适用条件不得由被检查方自己决定** —— 别写成"有 X 才检查"，删掉 X 就能静默关掉守卫。
 * ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------- 配置：改成你的工程（只改这一段） ---------------- */
const CFG = {
  root: path.resolve(__dirname, '..'),
  docsDir: 'docs',                          // 活跃文档目录
  /** 根目录下也算"受管文档"的入口文档（会要求元信息块、也会进登记表） */
  rootDocs: ['SKILL.md', 'README.md', 'CHANGELOG.md'],
  /** 登记表所在的文档（§5 那一节）与它的标记 */
  registryDoc: 'docs/ARCHITECTURE.md',
  regBegin: '<!-- BEGIN:registry-table',
  regEnd: '<!-- END:registry-table -->',
  /** 工作产物区（唯一杂物区：可整目录删） */
  workDir: '.review',
  /** 工具自建、不需要 README 声明死活的工作目录（如按需创建的记录目录） */
  workDirExempt: [],
  /** 归档族：只增不改、不进真值扫描，因此**不需要逐份登记**，但要带历史横幅。
   *  ⚠️ 递归扫描 `docs/` 时**必须**排除它们，否则归档里的每份文件都会被要求元信息块（假红一屏）。 */
  archiveDirs: ['docs/archive', 'docs/changelog'],
  archiveBannerRe: /勿作现状引用|历史快照|历史归档|ARCHIVED/,
  /** 根文件白名单（不含 rootDocs；把生成物、锁文件、配置都列上） */
  rootFiles: ['package.json', 'package-lock.json', '.gitignore'],
  /** 顶层目录白名单 */
  topDirs: ['docs', 'src', 'tests', 'scripts', '.git', '.review', 'node_modules'],
  /** 元信息块**必须齐备**的几行。放松（少要一行）请改这里 —— 改了就写进你的工程决策记录。 */
  requiredHeaderKeys: ['层', '作用', '不该写', '更新方式'],
  /** `docs/` 下允许存在的额外忽略前缀（生成物、第三方目录…）；空 = 什么也不忽略 */
  docsIgnore: []
};
const HEADER_KEYS = { '层': 'layer', '作用': 'purpose', '不该写': 'notWrite', '更新方式': 'update' };
/** 层的**取值表**：新增一个层要同批改这里 + SKILL.md B3 那一行（值不在表内 = 配置错误，不是文档错误） */
const LAYER_ORDER = ['入口', '治理', '契约', '设计', '记录', '归档'];
const HEAD_SCAN_LINES = 25;      // 元信息块必须在这个行数以内（横幅/元信息只有"在开头"才起作用）
const BANNER_SCAN_LINES = 8;     // 归档横幅只看前几行（只有开头才起作用）

/* ---------------- 元信息块：解析 / 收集 ---------------- */

/** 解析头部 `<!-- registry … -->` 块。返回 null（没有块）或 `{ meta, missing }`（有块，缺哪几行也带出来）。 */
function parseHeaderBlock(text) {
  const head = String(text).split(/\r?\n/).slice(0, HEAD_SCAN_LINES).join('\n');
  const m = /<!--\s*registry([\s\S]*?)-->/.exec(head);
  if (!m) return null;
  const meta = {};
  m[1].split(/\r?\n/).forEach((l) => {
    const mm = /^\s*([^:：]+)[:：]\s*(.+?)\s*$/.exec(l);
    if (mm && HEADER_KEYS[mm[1].trim()]) meta[HEADER_KEYS[mm[1].trim()]] = mm[2];
  });
  const missing = CFG.requiredHeaderKeys.filter((k) => !meta[HEADER_KEYS[k]]);
  return { meta, missing };
}

/** 合格 = 有块 **且四行齐备**（`requiredHeaderKeys`）。缺任何一行都会返回 null，
 *  具体缺哪几行由 `parseHeaderBlock().missing` 给出（报错要说准，别把"缺两行"说成"没有块"）。 */
function parseDocHeader(text) {
  const b = parseHeaderBlock(text);
  return (b && b.missing.length === 0) ? b.meta : null;
}

/** 递归收集 `docs/` 下的 .md（**跳过归档族与 docsIgnore**）+ 根入口文档，返回相对路径表 */
function collectRels(root) {
  const skip = CFG.archiveDirs.concat(CFG.docsIgnore)
    .map((d) => d.replace(/\/+$/, '') + '/');
  const out = [];
  const walk = (abs, rel) => {
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) { return; }                                   // 目录读不出来：交给下面按文件报（不静默吞掉整棵子树）
    for (const e of items) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) {
        if (!skip.some((p) => (r + '/').startsWith(p))) walk(path.join(abs, e.name), r);
      } else if (/\.md$/.test(e.name)) {
        out.push(r);
      }
    }
  };
  const dd = path.join(root, CFG.docsDir);
  if (fs.existsSync(dd)) walk(dd, CFG.docsDir);
  CFG.rootDocs.forEach((f) => out.push(f));
  return [...new Set(out)].sort();
}

/** 收集受管文档与它们的**判定状态**。
 *  state: ok | no-header（没有块） | partial（有块但缺行） | missing（磁盘上没有） | unreadable（读不出来） */
function collectDocs(root) {
  return collectRels(root).map((rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return { rel, state: 'missing' };
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (e) { return { rel, state: 'unreadable', code: e.code || '?', text: '' }; }
    const b = parseHeaderBlock(text);
    if (!b) return { rel, state: 'no-header', text };
    if (b.missing.length) return { rel, state: 'partial', text, gaps: b.missing };
    return { rel, state: 'ok', text, meta: b.meta };
  });
}

/* ---------------- 登记表：渲染 / 生成 / 校验 ---------------- */

/** 从元信息渲染登记表（纯函数：生成与校验共用它） */
function renderRegistryTable(entries) {
  const rows = entries.filter((e) => e.state === 'ok').sort((a, b) => {
    const la = LAYER_ORDER.indexOf(a.meta.layer), lb = LAYER_ORDER.indexOf(b.meta.layer);
    // 非法层正常到不了这里（checkLayers 已判红）；保留作防御，避免生成器在未校验输入上乱序
    return (la < 0 ? 99 : la) - (lb < 0 ? 99 : lb) || a.rel.localeCompare(b.rel);
  });
  const lines = ['| 层 | 文档 | 作用（存在的唯一理由） | 不该写什么 | 更新方式 |',
    '|----|------|---------------------|-----------|---------|'];
  rows.forEach((e) => lines.push('| ' + [e.meta.layer, '`' + e.rel + '`', e.meta.purpose,
    e.meta.notWrite, e.meta.update].join(' | ') + ' |'));
  // 归档族：规则相同 ⇒ 前缀行统一覆盖，不逐份声明
  CFG.archiveDirs.forEach((d) => lines.push('| 归档 | `' + d + '/*` | 历史（回溯用） | —（**勿作现状引用**） | 只增不改（必须带历史横幅） |'));
  return lines.join('\n');
}

function writeRegistryTable(root, opts) {
  const quiet = !!(opts && opts.quiet);
  const p = path.join(root, CFG.registryDoc);
  if (!fs.existsSync(p)) { console.error('✗ 登记表文档不存在：' + CFG.registryDoc); return false; }
  const md = fs.readFileSync(p, 'utf8');
  const entries = collectDocs(root);
  const bad = entries.filter((e) => e.state !== 'ok');
  if (bad.length) {
    console.error('✗ 有 ' + bad.length + ' 份受管文档不合格，**拒绝生成**（生成模式与检查模式必须一致）：');
    describeProblems(bad).forEach((m) => console.error('   ' + m));
    return false;
  }
  const s = md.indexOf(CFG.regBegin), e = md.indexOf(CFG.regEnd);
  if (s < 0 || e < s) {
    console.error('✗ ' + CFG.registryDoc + ' 里找不到成对标记：' + CFG.regBegin + ' … ' + CFG.regEnd);
    return false;
  }
  const headLine = md.slice(0, md.indexOf('\n', s) + 1);
  fs.writeFileSync(p, md.slice(0, s) + headLine.slice(headLine.indexOf(CFG.regBegin))
    + '\n' + renderRegistryTable(entries) + '\n' + md.slice(e), 'utf8');
  if (!quiet) console.log('已生成 ' + CFG.registryDoc + ' 的登记表（来源：' + entries.length + ' 份文档的头部元信息 + '
    + CFG.archiveDirs.length + ' 行归档前缀）');
  return true;}

/** 把"不合格文档"翻成人话（一次错误一条消息，各自指路） */
function describeProblems(entries) {
  return entries.map((e) => {
    if (e.state === 'missing') {
      return '[missing] ' + e.rel + ' —— 磁盘上没有这份受管文档。要么建它，要么把它从 `CFG.rootDocs` 移除';
    }
    if (e.state === 'unreadable') {
      return '[unreadable] ' + e.rel + ' —— 读不出来（' + e.code + '）。**采不到真值＝红**，不许静默跳过';
    }
    if (e.state === 'partial') {
      return '[partial] ' + e.rel + ' —— 元信息块缺：' + e.gaps.join('、')
        + '（`CFG.requiredHeaderKeys` 要求齐备；补完跑 `node scripts/docs-gates.js --write`）';
    }
    return '[no-header] ' + e.rel + ' —— 缺头部元信息块 `<!-- registry 层/作用/不该写/更新方式 -->` —— '
      + '登记表由它生成；补完跑 `node scripts/docs-gates.js --write`';
  });
}

/* ---------------- 判定 ---------------- */

/** ① 登记与家门 + 根/顶层白名单 */
function checkHomes(root, entries) {
  const problems = [];
  const bad = entries.filter((e) => e.state !== 'ok');
  describeProblems(bad).forEach((msg, i) => problems.push({ kind: bad[i].state === 'partial' ? 'partial' : bad[i].state, rel: bad[i].rel, msg: msg.replace(/^\[[a-z-]+\] /, '') }));
  const rootFiles = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const allowedFiles = new Set([...CFG.rootDocs, ...CFG.rootFiles]);
  rootFiles.forEach((f) => {
    if (!allowedFiles.has(f)) problems.push({
      kind: 'junk', rel: f,
      msg: '工程根出现了白名单外的文件 —— 三条路：① 工作产物 → `' + CFG.workDir + '/`；'
        + '② 要长期存在 → `' + CFG.docsDir + '/` 并补头部元信息；③ 一次性旧稿 → `' + CFG.archiveDirs[0] + '/`'
    });
  });
  const topDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  topDirs.forEach((d) => {
    if (!CFG.topDirs.includes(d)) problems.push({
      kind: 'junk', rel: d + '/', msg: '顶层目录不在白名单里 —— 要么加进白名单（并说明用途），要么移走'
    });
  });
  return problems;
}

/** ② 层取值表：`层` 必须在 `LAYER_ORDER` 内（权威在 SKILL.md B3） */
function checkLayers(entries) {
  const problems = [];
  entries.filter((e) => e.state === 'ok').forEach((e) => {
    if (LAYER_ORDER.indexOf(e.meta.layer) < 0) problems.push({
      kind: 'layer', rel: e.rel,
      msg: '元信息的 `层` 不在取值表内：`' + e.meta.layer + '`；取值表 = ' + LAYER_ORDER.join(' / ')
        + '。值不在表内 = **配置错误**（不是文档错误）：要么改文档的层，要么把新层加进 LAYER_ORDER ——'
        + ' 新增层要**同批**改 SKILL.md B3 的取值表那一行'
    });
  });
  return problems;
}

/** ③ 悬挂登记：登记表里写了、磁盘上没有 */
function checkDangling(root, registryText) {
  const problems = [];
  registryText.split('\n').filter((l) => /^\|/.test(l)).forEach((l) => {
    // 取"**整格就是一个 code span**"的那一格（不写死列序号：列序被改也不至于静默漏判）
    const cell = l.split('|').map((c) => c.trim()).find((c) => /^`[^`]+`$/.test(c));
    if (!cell) return;
    const rel = cell.slice(1, -1);
    if (rel.includes('*')) return;                       // 归档族前缀：不逐份判
    if (!fs.existsSync(path.join(root, rel))) problems.push({
      kind: 'dangling', rel, msg: '登记表声明了这份文档，但磁盘上不存在 —— 从表里去掉，或把文件补回来'
    });
  });
  return problems;
}

/** ④ 归档缺横幅（**递归**：归档子目录里的文件也算归档） */
function checkArchiveBanners(root) {
  const problems = [];
  const walk = (abs, rel) => {
    let items;
    try { items = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (e) {
      problems.push({ kind: 'banner', rel,
        msg: '归档目录读不出来（' + (e.code || '?') + '）—— **采不到真值＝红**，不许静默跳过' });
      return;
    }
    for (const e of items) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) { walk(path.join(abs, e.name), r); continue; }   // 递归
      if (!/\.(md|html?)$/i.test(e.name)) continue;
      let head;
      try { head = fs.readFileSync(path.join(abs, e.name), 'utf8').split(/\r?\n/).slice(0, BANNER_SCAN_LINES).join(' '); }
      catch (err) {
        problems.push({ kind: 'banner', rel: r,
          msg: '读不出来（' + (err.code || '?') + '）—— **采不到真值＝红**，不许静默跳过' });
        continue;
      }
      if (!CFG.archiveBannerRe.test(head)) problems.push({
        kind: 'banner', rel: r,
        msg: '归档文件开头没有「历史」横幅 —— 归档仍会被 grep 到；请在开头加一行'
          + '（HTML 用注释）：`> ⚠️ 历史归档（YYYY-MM）：不是现状、勿据此改动`'
      });
    }
  };
  CFG.archiveDirs.forEach((d) => { const abs = path.join(root, d); if (fs.existsSync(abs)) walk(abs, d); });
  return problems;
}

/** ⑤ 工作目录无状态（工作产物区的直接子目录必须有 README —— 只查一层，是刻意的） */
function checkWorkDirs(root) {
  const problems = [];
  const abs = path.join(root, CFG.workDir);
  if (!fs.existsSync(abs)) return problems;
  fs.readdirSync(abs, { withFileTypes: true }).forEach((e) => {
    if (!e.isDirectory() || CFG.workDirExempt.includes(e.name)) return;
    if (!fs.existsSync(path.join(abs, e.name, 'README.md'))) problems.push({
      kind: 'workdir', rel: CFG.workDir + '/' + e.name + '/',
      msg: '工作目录没有 README.md 声明死活 —— 补三行（主题 / 开始日期 / 状态：在飞|已收口|已废弃），'
        + '否则接手者无法判断它能否删除'
    });
  });
  return problems;
}

/** ⑥ 登记表与元信息一致（手改表格或改了元信息没重生成） */
function checkRegistryFresh(root, registryText, entries) {
  const problems = [];
  if (!entries.some((e) => e.state === 'ok')) return problems;   // 尚未采用元信息 ⇒ 不判（避免把无关工程变红）
  const s = registryText.indexOf(CFG.regBegin), e = registryText.indexOf(CFG.regEnd);
  if (s < 0 || e < s) {
    problems.push({ kind: 'registry', rel: CFG.registryDoc, msg: '找不到登记表标记（应成对出现）' });
    return problems;
  }
  const actual = registryText.slice(registryText.indexOf('\n', s) + 1, e).replace(/^\s+|\s+$/g, '');
  const want = renderRegistryTable(entries).replace(/^\s+|\s+$/g, '');
  if (actual !== want) {
    const a = actual.split('\n'), w = want.split('\n');
    let at = 0; while (at < a.length && at < w.length && a[at] === w[at]) at++;
    problems.push({ kind: 'registry-stale', rel: CFG.registryDoc,
      msg: '登记表与各文档头部元信息不一致（第 ' + (at + 1) + ' 行起）—— 跑 `node scripts/docs-gates.js --write`\n'
        + '     磁盘: ' + String(a[at] === undefined ? '(表结束)' : a[at]).slice(0, 70)
        + '\n     应为: ' + String(w[at] === undefined ? '(表结束)' : w[at]).slice(0, 70) });
  }
  return problems;
}

/** 全部判定（纯函数，给定 root；`--selftest` 也用它） */
function runChecks(root) {
  const regPath = path.join(root, CFG.registryDoc);
  if (!fs.existsSync(regPath)) {
    return [{ kind: 'registry', rel: CFG.registryDoc,
      msg: '登记表文档不存在：' + CFG.registryDoc + '（先建它，或在 CFG 里改路径）' }];
  }
  const registryText = fs.readFileSync(regPath, 'utf8');
  const entries = collectDocs(root);
  return [].concat(
    checkHomes(root, entries),
    checkLayers(entries),
    checkDangling(root, registryText),
    checkArchiveBanners(root),
    checkWorkDirs(root),
    checkRegistryFresh(root, registryText, entries)
  );
}

/* ---------------- CLI ---------------- */
function main() {
  const root = CFG.root;
  if (process.argv.includes('--selftest')) process.exit(selftest());
  const entries = collectDocs(root);
  const bad = entries.filter((e) => e.state !== 'ok');

  if (process.argv.includes('--list')) {
    entries.forEach((e) => console.log('  ' + (e.state === 'ok' ? '✓' : '✗') + ' ' + e.rel
      + (e.state === 'ok' ? '  [' + e.meta.layer + '] ' + e.meta.purpose : '  ← ' + e.state)));
    if (bad.length) {
      console.log('✗ ' + bad.length + ' 份受管文档不合格 ⇒ 本模式**同样参与门禁**（退出码 1）');
      describeProblems(bad).forEach((m) => console.log('   ' + m));
      process.exitCode = 1;
    }
    return;
  }
  if (process.argv.includes('--write')) process.exit(writeRegistryTable(root) ? 0 : 1);

  const problems = runChecks(root);
  console.log('== 文档体系判定 ==');
  if (!problems.length) {
    console.log('✓ 登记与家门 / 层取值表 / 悬挂登记 / 归档横幅 / 工作目录状态 / 登记表一致性 —— 全部通过'
      + '（' + entries.length + ' 份受管文档）');
    return;
  }
  console.log('✗ 发现 ' + problems.length + ' 处问题：');
  problems.forEach((p) => console.log('   [' + p.kind + '] ' + p.rel + ' —— ' + p.msg));
  console.error('\n文档体系判定失败');
  process.exit(1);
}

/* ---------------- 判别力自检：临时工程里注入违规，必须全红 ---------------- */

function selftest() {
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gates-selftest-'));
  const w = (rel, s) => { const p = path.join(fx, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); };
  const hdr = (layer, extra) => '<!-- registry\n层: ' + layer + '\n作用: 占位作用\n'
    + (extra === false ? '' : '不该写: 占位\n更新方式: 占位\n') + '-->\n';
  const build = () => {
    fs.rmSync(fx, { recursive: true, force: true }); fs.mkdirSync(fx, { recursive: true });
    w('package.json', '{}\n'); w('.gitignore', 'x\n');
    w('README.md', '# P\n' + hdr('入口')); w('SKILL.md', '# S\n' + hdr('入口')); w('CHANGELOG.md', '# C\n' + hdr('记录'));
    w('docs/RULES.md', '# R\n' + hdr('治理'));
    w(CFG.registryDoc, '# A\n' + hdr('设计') + '\n' + CFG.regBegin + '（勿手改）-->\n\n' + CFG.regEnd + '\n');
    w('docs/archive/old.md', '> 历史归档（2026-01）：不是现状\n\n旧\n');
    w(CFG.workDir + '/wip/README.md', '状态: 在飞\n');
    ['src', 'tests', 'scripts'].forEach((d) => fs.mkdirSync(path.join(fx, d), { recursive: true }));
    writeRegistryTable(fx, { quiet: true });   // 基线必须是"表已生成"的合规态，否则基线自己就红
  };
  const kinds = (root) => [...new Set(runChecks(root).map((p) => p.kind))];
  const cases = [
    ['基线（无注入）', () => {}, 'GREEN'],
    ['元信息只写两行（缺 不该写/更新方式）', () => w('docs/RULES.md', '# R\n' + hdr('治理', false)), 'partial'],
    ['层不在取值表内', () => w('docs/RULES.md', '# R\n' + hdr('乱写')), 'layer'],
    ['docs 子目录里的 .md 无元信息', () => w('docs/sub/deep.md', '# 深\n'), 'no-header'],
    ['归档子目录里的文件无横幅', () => w('docs/archive/sub/old.md', '# 无横幅\n'), 'banner'],
    ['受管的根文档不存在', () => fs.rmSync(path.join(fx, 'SKILL.md')), 'missing'],
    ['归档里放一个**目录**名叫 ghost.md', () => fs.mkdirSync(path.join(fx, 'docs/archive/ghost.md'), { recursive: true }), 'GREEN'],
    ['手改登记表', () => { const p = path.join(fx, CFG.registryDoc); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('| 治理 |', '| 契约 |'), 'utf8'); }, 'registry-stale']
  ];
  console.log('== 判别力自检（临时工程：' + fx + '；跑完即删）==');
  let ok = true;
  let expectRed = 0, gotRed = 0, expectGreen = 0, gotGreen = 0;
  for (const [label, mutate, expectKind] of cases) {
    build();
    const base = runChecks(fx);
    if (base.length) { console.log('BASELINE-NOT-GREEN  ' + label + ' :: ' + base.map((p) => p.kind).join(',')); ok = false; continue; }
    mutate();
    const got = kinds(fx);
    const pass = expectKind === 'GREEN' ? got.length === 0 : got.includes(expectKind);
    if (expectKind === 'GREEN') { expectGreen++; if (pass) gotGreen++; }
    else { expectRed++; if (pass) gotRed++; }
    if (!pass) ok = false;
    console.log((pass ? (expectKind === 'GREEN' ? 'GREEN(expected)' : 'RED(' + expectKind + ')') : '**MISSED**').padEnd(20) + ' ' + label);
  }
  // 生成模式与检查模式必须一致
  build();
  w('docs/RULES.md', '# R\n' + hdr('治理', false));
  expectRed++;
  const writeOk = writeRegistryTable(fx, { quiet: true });
  if (writeOk) { ok = false; console.log('**MISSED**'.padEnd(20) + ' 有不合格文档时 --write 必须拒绝'); }
  else { gotRed++; console.log('RED(refused)'.padEnd(20) + ' 有不合格文档时 --write 拒绝生成（两路径一致）'); }
  // `--list` 的判据：有不合格文档 ⇒ 必须置失败退出码（否则挂进 CI 会假绿）
  expectRed++;
  const listBlocking = collectDocs(fx).some((e) => e.state !== 'ok');
  if (!listBlocking) { ok = false; console.log('**MISSED**'.padEnd(20) + ' --list 的失败判据'); }
  else { gotRed++; console.log('RED(blocking)'.padEnd(20) + ' 有不合格文档 ⇒ --list 判据为真（退出码置 1）'); }
  fs.rmSync(fx, { recursive: true, force: true });
  // ⚠️ 这里的条数**必须由上面的数组现场数出来**，不许写死 —— 我写死过一次：头注释与这一行各写了一个数，
  // 而且两个数互不相同（都不对）。同一个病：**声明 ≠ 实现**。注意本条注释也**不留字面数字**。
  console.log('\n判别力：必红项 ' + gotRed + '/' + expectRed + ' 判红 · 负例 ' + gotGreen + '/' + expectGreen
    + ' 保持绿 ' + (ok ? '✔' : '✗ 存在漏检'));
  return ok ? 0 : 1;
}

if (require.main === module) main();
module.exports = {
  CFG, parseHeaderBlock, parseDocHeader, collectRels, collectDocs, renderRegistryTable, writeRegistryTable,
  describeProblems, runChecks, checkHomes, checkLayers, checkDangling, checkArchiveBanners, checkWorkDirs,
  checkRegistryFresh, selftest, LAYER_ORDER
};
