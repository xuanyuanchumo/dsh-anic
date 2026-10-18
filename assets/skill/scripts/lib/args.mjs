#!/usr/bin/env node
// lib/args.mjs — 统一 CLI 参数防护库（cycle-27，随技能 v2.1.0 分发）
//
// 背景：cycle-25 事故——各脚本手写 parseArgs 把未知旗标（--help/--bogus）静默推入
// 位置参数桶，init-workflow 曾因此在 CWD 脚手架出 `--help/` 目录（cycle-26 单点根治，
// 本轮收敛为全量共享库）。三防线：
//   ① --help/-h 短路：打印用法 exit 0（绝不落入位置参数桶）
//   ② 未知旗标拒绝：exit 1 报旗标名
//   ③ 位置参数数量契约 [min,max]：越界 exit 1 报实收数量与清单
// 附带：值旗标缺参拒绝；int/float 解析 NaN 拒绝；kebab 旗标名自动映射 camelCase。
//
// 职责边界：本库只做「形状防护」——业务语义校验（gate 名合法性、目录存在性等）
// 仍归各脚本。错误输出统一走 stderr，exit code：0=成功/帮助，1=拒绝。

function kebabToCamel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function fail(script, message, usage) {
  console.error(`[${script}] ${message}`);
  console.error(usage);
  process.exit(1);
}

/**
 * @param {string[]} argv - process.argv 原样传入
 * @param {object} spec
 *   script       脚本名（错误消息前缀）
 *   usage        用法串（--help 输出与错误尾行共用）
 *   flags        { '<kebab名>': { type: 'boolean'|'string'|'int'|'float', default } }
 *                例：{ 'max-retries': { type: 'int', default: 3 } } → args.maxRetries
 *   positionals  { min, max, name } — min===max 表示精确数量；0/0 表示不接受位置参数
 * @returns {{ _: string[] } & Record<string, unknown>}
 */
export function parseCliArgs(argv, spec) {
  const { script, usage, flags = {}, positionals } = spec;
  const args = { _: [] };
  for (const [name, def] of Object.entries(flags)) {
    // boolean 旗标缺省恒 false（显式 default 也生效——统一两来源）
    args[kebabToCamel(name)] = def.type === 'boolean' && def.default === undefined ? false : def.default;
  }
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--help' || tok === '-h') {
      console.log(usage);
      process.exit(0);
    }
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      const def = flags[name];
      if (!def) fail(script, `未知旗标: --${name}`, usage);
      const key = kebabToCamel(name);
      if (def.type === 'boolean') {
        args[key] = true;
        continue;
      }
      const raw = argv[++i];
      if (raw === undefined || raw.startsWith('--')) {
        fail(script, `旗标 --${name} 需要一个值`, usage);
      }
      if (def.type === 'int') {
        const v = parseInt(raw, 10);
        if (Number.isNaN(v)) fail(script, `旗标 --${name} 需要整数，收到: ${raw}`, usage);
        args[key] = v;
      } else if (def.type === 'float') {
        const v = parseFloat(raw);
        if (Number.isNaN(v)) fail(script, `旗标 --${name} 需要数值，收到: ${raw}`, usage);
        args[key] = v;
      } else {
        args[key] = raw;
      }
    } else {
      args._.push(tok);
    }
  }
  const { min, max, name: label } = positionals;
  const n = args._.length;
  const got = n > 0 ? `: ${args._.join(' ')}` : '';
  if (min === 0 && max === 0) {
    if (n > 0) fail(script, `不接受位置参数（请用旗标），收到 ${n} 个${got}`, usage);
  } else if (min === max) {
    if (n !== min) {
      fail(script, `只接受 ${min} 个位置参数（${label}），收到 ${n} 个${got}`, usage);
    }
  } else if (n < min || n > max) {
    fail(script, `位置参数数量不符：需要 ${min}..${max} 个（${label}），收到 ${n} 个${got}`, usage);
  }
  return args;
}
