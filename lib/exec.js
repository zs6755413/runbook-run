'use strict';

const { spawnSync } = require('child_process');

function evaluateExpect(expect, result, out) {
  if (!expect) return { ok: result.code === 0, reason: result.code === 0 ? '' : `命令退出码 ${result.code}` };

  if (typeof expect.exitCode === 'number') {
    if (result.code !== expect.exitCode) {
      return { ok: false, reason: `期望退出码 ${expect.exitCode}，实际 ${result.code}` };
    }
  }

  if (expect.contains) {
    if (out.indexOf(expect.contains) === -1) {
      return { ok: false, reason: `输出里没有找到「${expect.contains}」` };
    }
  }

  if (expect.notContains) {
    if (out.indexOf(expect.notContains) !== -1) {
      return { ok: false, reason: `输出里不应出现「${expect.notContains}」，但它出现了` };
    }
  }

  if (expect.regex) {
    let re;
    try {
      re = new RegExp(expect.regex, 'm');
    } catch (e) {
      return { ok: false, reason: `正则写错了：${e.message}` };
    }
    if (!re.test(out)) return { ok: false, reason: `输出不匹配 /${expect.regex}/` };
  }

  if (typeof expect.exitCode !== 'number' && result.code !== 0) {
    return { ok: false, reason: `命令退出码 ${result.code}` };
  }

  return { ok: true, reason: '' };
}

function runStep(step, opts) {
  const started = Date.now();

  if (step.manual) {
    return {
      ok: true,
      manual: true,
      code: null,
      out: '',
      err: '',
      ms: 0,
      expect: { ok: true, reason: '' }
    };
  }

  const result = spawnSync(step.run, {
    shell: true,
    encoding: 'utf8',
    timeout: opts.timeoutMs || 60000,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env
  });

  const out = String(result.stdout || '');
  const err = String(result.stderr || '');
  const combined = out + (err ? '\n' + err : '');
  const code = result.status === null ? -1 : result.status;

  const judged = evaluateExpect(step.expect, { code, err, out }, combined);

  return {
    ok: judged.ok,
    manual: false,
    code,
    out,
    err,
    ms: Date.now() - started,
    expect: judged,
    timedOut: result.error && result.error.code === 'ETIMEDOUT'
  };
}

module.exports = { runStep, evaluateExpect };
