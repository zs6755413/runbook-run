'use strict';

const fs = require('fs');

const DANGEROUS = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/, why: '递归删除根目录' },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, why: '递归强制删除' },
  { re: /\bmkfs(\.\w+)?\b/, why: '格式化文件系统' },
  { re: /\bdd\s+if=.*\bof=\/dev\//, why: '直接写入块设备' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: />\s*\/etc\//, why: '覆盖系统配置' },
  { re: /\bchmod\s+-R\s+777\s+\//, why: '递归放开根目录权限' },
  { re: /\bshutdown\b|\breboot\b|\binit\s+0\b/, why: '关机或重启' }
];

function detectDanger(cmd) {
  const hits = [];
  for (const d of DANGEROUS) {
    if (d.re.test(cmd)) hits.push(d.why);
  }
  return hits;
}

function subst(value, vars, where) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`${where} 里用到了未定义的变量 {{${key}}}`);
    }
    return String(vars[key]);
  });
}

function loadRunbook(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读不了清单文件：${e.code || e.message}`);
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`清单不是合法 JSON：${e.message}`);
  }

  if (!doc.name) throw new Error('清单缺少 name 字段');
  if (!Array.isArray(doc.steps) || !doc.steps.length) throw new Error('清单缺少 steps，或者 steps 是空的');

  const vars = doc.vars || {};
  const seen = new Set();
  const steps = [];

  doc.steps.forEach((s, idx) => {
    const at = `第 ${idx + 1} 步`;
    if (!s.id) throw new Error(`${at} 缺少 id`);
    if (seen.has(s.id)) throw new Error(`${at} 的 id「${s.id}」与前面的重复`);
    seen.add(s.id);
    if (!s.title) throw new Error(`${at}（${s.id}）缺少 title`);

    const manual = s.manual === true;
    if (!manual && !s.run) throw new Error(`${at}（${s.id}）既不是 manual，也没有 run 命令`);

    const run = manual ? '' : subst(s.run, vars, `${at} 的 run`);
    const rollback = s.rollback ? subst(s.rollback, vars, `${at} 的 rollback`) : '';

    steps.push({
      index: idx + 1,
      id: String(s.id),
      title: subst(s.title, vars, `${at} 的 title`),
      note: s.note ? subst(s.note, vars, `${at} 的 note`) : '',
      run,
      rollback,
      manual,
      expect: s.expect || null,
      danger: manual ? [] : detectDanger(run)
    });
  });

  return {
    name: doc.name,
    note: doc.note || '',
    vars,
    steps,
    source: file
  };
}

module.exports = { loadRunbook, detectDanger, subst };
