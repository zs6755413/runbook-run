#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadRunbook } = require('../lib/loader.js');
const { runStep } = require('../lib/exec.js');

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[36m'
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function c(code, s) { return useColor ? code + s + C.reset : String(s); }

function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    );
    w += wide ? 2 : 1;
  }
  return w;
}

function indent(text, prefix, width) {
  return String(text).split('\n').map((line) => prefix + line.slice(0, width || 200)).join('\n');
}

function help() {
  console.log(`runbook-run —— 低频运维清单执行器

用法
  node bin/runbook.js <runbook.json> [选项]

选项
  --list           只列出步骤，不执行
  --dry-run        展示将要做什么，不执行任何命令
  --yes            不逐步确认（manual 步骤仍然只提示）
  --only <id>      只执行指定 id 的步骤（可重复）
  --force          允许执行被判定为危险的命令
  --timeout <ms>   单步超时，默认 60000
  --log <file>     把执行记录写成 JSONL
  --no-color       关闭颜色
  -h, --help       显示帮助

清单格式
  {
    "name": "TLS 证书轮换",
    "vars": { "domain": "www.example.com" },
    "steps": [
      {
        "id": "precheck",
        "title": "确认当前证书到期时间",
        "run": "openssl s_client -servername {{domain}} -connect {{domain}}:443 </dev/null",
        "expect": { "contains": "notAfter" },
        "note": "记下这个日期",
        "rollback": "cp -a {{certDir}}/fullchain.pem.bak {{certDir}}/fullchain.pem"
      },
      { "id": "backup", "title": "备份旧证书", "manual": true }
    ]
  }

交互
  回车 = 执行   s = 跳过   q = 退出
  非交互环境（比如 CI）必须加 --yes

退出码
  0  全部完成或跳过
  1  某一步失败，执行已停止
  2  清单或参数有问题`);
}

function buildSteps(rb, onlyIds) {
  if (!onlyIds.length) return rb.steps;
  const picked = rb.steps.filter((s) => onlyIds.indexOf(s.id) !== -1);
  const missing = onlyIds.filter((id) => !rb.steps.some((s) => s.id === id));
  if (missing.length) {
    throw new Error(`清单里没有这些步骤：${missing.join('、')}`);
  }
  return picked;
}

function printList(rb) {
  console.log(`\n${c(C.bold, rb.name)}`);
  if (rb.note) console.log(c(C.dim, '  ' + rb.note));
  console.log(c(C.dim, `  ${rb.steps.length} 步  ·  ${path.basename(rb.source)}\n`));

  const idW = Math.max(10, ...rb.steps.map((s) => strWidth(s.id) + 2));
  for (const s of rb.steps) {
    const kind = s.manual ? c(C.yellow, 'manual') : 'cmd   ';
    const danger = s.danger.length ? c(C.red, ' !') : '';
    console.log(`  ${String(s.index).padStart(2)}  ${kind}  ${s.id.padEnd(idW)}${s.title}${danger}`);
  }
  console.log('');
}

function confirm(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      const a = String(answer).trim().toLowerCase();
      if (a === 'q' || a === 'quit') resolve('quit');
      else if (a === 's' || a === 'skip') resolve('skip');
      else resolve('run');
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    file: '',
    list: false,
    dry: false,
    yes: false,
    force: false,
    only: [],
    timeoutMs: 60000,
    log: ''
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--dry-run') opts.dry = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--only') opts.only.push(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10) || 60000;
    else if (a === '--log') opts.log = argv[++i] || '';
    else if (a === '--no-color') process.env.NO_COLOR = '1';
    else if (a === '-h' || a === '--help') { help(); return 0; }
    else opts.file = a;
  }

  if (!opts.file) { help(); return 2; }

  let rb;
  try {
    rb = loadRunbook(opts.file);
  } catch (e) {
    process.stderr.write(`清单加载失败：${e.message}\n`);
    return 2;
  }

  let steps;
  try {
    steps = buildSteps(rb, opts.only);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    return 2;
  }

  if (opts.list) {
    printList(rb);
    return 0;
  }

  const interactive = process.stdin.isTTY && !opts.yes && !opts.dry;
  if (!interactive && !opts.yes && !opts.dry) {
    process.stderr.write('当前不是交互终端，请加 --yes 明确表示要执行，或者用 --dry-run 先看一遍。\n');
    return 2;
  }

  const dangerous = steps.filter((s) => s.danger.length);
  if (dangerous.length && !opts.force && !opts.dry) {
    console.log(c(C.red, '\n有步骤包含危险命令：'));
    for (const s of dangerous) {
      console.log(`  ${s.id}: ${s.danger.join('、')}`);
      console.log(c(C.dim, `    ${s.run}`));
    }
    console.log(c(C.yellow, '\n确认无误请加 --force 重新执行。\n'));
    return 2;
  }

  console.log('');
  console.log(c(C.bold, rb.name));
  if (rb.note) console.log(c(C.dim, rb.note));
  const varList = Object.keys(rb.vars);
  if (varList.length) {
    console.log(c(C.dim, '变量：' + varList.map((k) => `${k}=${rb.vars[k]}`).join('  ')));
  }
  console.log(c(C.dim, `${steps.length} 步` + (opts.dry ? '  ·  dry-run，不会执行任何命令' : '')));
  console.log('');

  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const records = [];
  let failed = false;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const progress = `[${i + 1}/${steps.length}]`;

    console.log(c(C.blue, `${progress}`) + ' ' + c(C.bold, s.title) + c(C.dim, `  (${s.id})`));

    if (s.note) console.log(c(C.dim, '  ' + s.note.replace(/\n/g, '\n  ')));

    if (s.manual) {
      console.log(c(C.yellow, '  需要人工操作，命令不在清单里。'));
      if (opts.dry) {
        console.log(c(C.dim, '  [dry-run] 跳过'));
        console.log('');
        records.push({ step: s.id, title: s.title, status: 'manual-dry', ms: 0 });
        continue;
      }
      if (interactive) {
        const act = await confirm(rl, '  做完了按回车，s 跳过，q 退出：');
        if (act === 'quit') { console.log(c(C.dim, '\n已退出。')); break; }
        if (act === 'skip') {
          console.log(c(C.dim, '  已跳过'));
          console.log('');
          records.push({ step: s.id, title: s.title, status: 'skipped', ms: 0 });
          continue;
        }
      }
      console.log(c(C.green, '  记为已完成'));
      console.log('');
      records.push({ step: s.id, title: s.title, status: 'manual-ok', ms: 0 });
      continue;
    }

    console.log(c(C.dim, '  $ ' + s.run));
    if (s.expect) {
      const parts = [];
      if (s.expect.contains) parts.push(`包含「${s.expect.contains}」`);
      if (s.expect.notContains) parts.push(`不包含「${s.expect.notContains}」`);
      if (s.expect.regex) parts.push(`匹配 /${s.expect.regex}/`);
      if (typeof s.expect.exitCode === 'number') parts.push(`退出码 ${s.expect.exitCode}`);
      if (parts.length) console.log(c(C.dim, '  判定：' + parts.join('，')));
    }

    if (opts.dry) {
      console.log(c(C.dim, '  [dry-run] 跳过'));
      if (s.rollback) console.log(c(C.dim, '  回滚命令：' + s.rollback));
      console.log('');
      records.push({ step: s.id, title: s.title, status: 'dry', ms: 0 });
      continue;
    }

    if (interactive) {
      const act = await confirm(rl, '  回车执行，s 跳过，q 退出：');
      if (act === 'quit') { console.log(c(C.dim, '\n已退出。')); break; }
      if (act === 'skip') {
        console.log(c(C.dim, '  已跳过'));
        console.log('');
        records.push({ step: s.id, title: s.title, status: 'skipped', ms: 0 });
        continue;
      }
    }

    const r = runStep(s, opts);

    if (r.out) console.log(indent(r.out.trimEnd(), c(C.dim, '  │ '), 160));
    if (r.err) console.log(indent(r.err.trimEnd(), c(C.red, '  │ '), 160));

    if (r.ok) {
      console.log(c(C.green, `  ok`) + c(C.dim, `  ${r.ms}ms`));
      records.push({ step: s.id, title: s.title, status: 'ok', code: r.code, ms: r.ms });
    } else {
      console.log(c(C.red, `  fail`) + c(C.dim, `  ${r.expect.reason || ''}  ${r.ms}ms`));
      records.push({ step: s.id, title: s.title, status: 'fail', code: r.code, ms: r.ms, reason: r.expect.reason });

      if (s.rollback) {
        console.log('');
        console.log(c(C.yellow, '  回滚命令（需要你手动执行）：'));
        console.log(c(C.dim, '  $ ' + s.rollback));
      }
      console.log('');
      console.log(c(C.red, `  在「${s.title}」这一步停下，后面的步骤没有执行。`));
      failed = true;
      console.log('');
      break;
    }

    console.log('');
  }

  if (rl) rl.close();

  const ok = records.filter((r) => r.status === 'ok' || r.status === 'manual-ok').length;
  const skipped = records.filter((r) => r.status === 'skipped').length;
  const dry = records.filter((r) => r.status === 'dry' || r.status === 'manual-dry').length;

  console.log(c(C.dim, '─'.repeat(52)));
  if (opts.dry) {
    console.log(`dry-run 结束：${dry} 步已展示，没有执行任何命令。`);
  } else if (failed) {
    console.log(`已停止：${ok} 步完成，${skipped} 步跳过，1 步失败。`);
  } else {
    console.log(`完成：${ok} 步完成${skipped ? `，${skipped} 步跳过` : ''}。`);
  }

  if (opts.log) {
    const stamp = new Date().toISOString();
    const lines = records.map((r) => JSON.stringify({
      ts: stamp,
      runbook: rb.name,
      ...r
    }));
    fs.appendFileSync(opts.log, lines.join('\n') + '\n', 'utf8');
    console.log(c(C.dim, `记录已追加到 ${opts.log}`));
  }

  console.log('');
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`未捕获异常：${e.stack || e.message}\n`);
  process.exit(2);
});
