/**
 * 守卫族命名注册表（cycle-58 T-5801——doc18 #9 收口）。
 *
 * 六守卫声明源四册交叉：doc03 §3 模块表（G-DEP/G-FEAT/G-IND/G-REG 落位）+
 * doc12 §3.2 守卫族表 + doc13 §4（G-TOGGLE）+ doc09 §7（三条守卫纪律：
 * 反向自检、样例拼接构造、扫描集非空下限）。
 *
 * 本测试落两条守卫纪律的机械面：
 * 1. 命名可查性——每个 G-* 守卫都有以守卫名命名的 describe 块（「名可查」
 *    是 doc18 #9 的原始诉求：语义近似测试存在但 grep 守卫名找不到，等于
 *    守卫不存在）；
 * 2. 守卫语义实断言——G-FEAT/G-SINGLE/G-REG/G-TOGGLE/G-DEP 各至少一条
 *    真实机械断言（非仅命名占位）。
 *
 * 扫描集非空下限纪律：每条扫描的目录集必须存在且非空（空集上扫描恒绿
 *    是假守卫——independenceGuard 同款教训）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

/** 递归收集 .ts 文件（含测试——守卫语义对测试域同样成立）。 */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTs(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const ALL_TS = collectTs(SRC);
const CLIENT_FEATURES = join(SRC, 'client', 'features');
const FEATURES_DIRS = existsSync(CLIENT_FEATURES)
  ? readdirSync(CLIENT_FEATURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

describe('G-FEAT 特性边界守卫（跨特性深 import 禁止）', () => {
  it('扫描集非空下限：features/ 至少 6 个特性域（空集恒绿是假守卫）', () => {
    expect(FEATURES_DIRS.length).toBeGreaterThanOrEqual(6);
  });

  it('零跨特性 import：features/<域>/ 内不得出现 from 加 ../<其他域>/ 的跨域路径（cycle-58 清零后回归钉）', () => {
    const violations: string[] = [];
    for (const d of FEATURES_DIRS) {
      for (const f of collectTs(join(CLIENT_FEATURES, d))) {
        const rel = f.slice(SRC.length + 1).replaceAll(String.fromCharCode(92), '/');
        // 允许 '..' 上跳到 components/i18n 等共享层；禁止进入兄弟特性域
        const m = readFileSync(f, 'utf8').match(/from '\.\.\/([a-z][a-z0-9]*)\//g) ?? [];
        for (const hit of m) {
          const target = hit.slice("from '../".length, -1);
          if (FEATURES_DIRS.includes(target)) violations.push(`${rel} -> ../${target}/`);
        }
      }
    }
    expect(violations, violations.join('; ')).toEqual([]);
  });

  it('共享工具落位：components/fetchJson.ts 与 components/panelTypes.ts 存在（跨域共享的中立层）', () => {
    expect(existsSync(join(SRC, 'client', 'components', 'fetchJson.ts'))).toBe(true);
    expect(existsSync(join(SRC, 'client', 'components', 'panelTypes.ts'))).toBe(true);
  });
});

describe('G-SINGLE 单实现守卫（关键符号第二定义扫描）', () => {
  it('扫描集非空下限：src/ 下 .ts 文件 ≥ 80（空集恒绿是假守卫）', () => {
    expect(ALL_TS.length).toBeGreaterThanOrEqual(80);
  });

  it.each([
    'isObjectLike',
    'fetchJsonGuarded',
    'syncTelemetryCounts',
    'buildWorkflowSnapshot',
    'createScoped',
    'atomicWriteFileSync',
  ])('%s 全仓只允许一处 export 定义（唯一实现在源文件，re-export 垫片不计）', (symbol) => {
    const defs: string[] = [];
    for (const f of ALL_TS) {
      const s = readFileSync(f, 'utf8');
      // export function/class/const 定义形态（interface/type 上移共享层非本守卫域）
      const re = new RegExp(`^export (?:async )?(?:function|const|class) ${symbol}\\b`, 'm');
      if (re.test(s)) defs.push(f.slice(ROOT.length + 1).replaceAll(String.fromCharCode(92), '/'));
    }
    expect(defs, `${symbol} 定义于: ${defs.join('; ')}`).toHaveLength(1);
  });
});

describe('G-REG 注册表守卫（FlowRegistry 注册项 schema 版本）', () => {
  it('FlowRegistry 落位 host/flows/registry.ts（五注册表已文档降级 doc18 #2，不复活——registry/ 目录不存在）', () => {
    expect(existsSync(join(SRC, 'host', 'flows', 'registry.ts'))).toBe(true);
    // 契约：registry 目录不存在（五注册表架构未落地——doc18 #2 文档降级处置）
    expect(existsSync(join(SRC, 'host', 'registry'))).toBe(false);
  });

  it('FlowDescriptor 注册即静态校验（validateDescriptor 拒绝非法描述子——「注册项必须带 schema」的收窄语义）', () => {
    const s = readFileSync(join(SRC, 'host', 'flows', 'registry.ts'), 'utf8');
    // 注册面：validateDescriptor 先于 set（坏描述子不进入运行期）
    expect(s).toMatch(/validateDescriptor\(descriptor\)/);
    expect(s).toMatch(/problems\.length > 0/);
    // 同 id 首个胜出 + no-op disposer（HMR 安全——KB R12 同款裁决）
    expect(s).toMatch(/registry\.has\(descriptor\.id\)/);
  });

  it('FlowDescriptor 形状契约携带 states/transitions/persistence 必填字段（contracts.ts 单一事实源）', () => {
    const s = readFileSync(join(SRC, 'host', 'flows', 'contracts.ts'), 'utf8');
    for (const field of ['id: string', 'labelKey: string', 'states: readonly S[]', 'initial: S', 'transitions: readonly FlowTransition<S>[]', 'persistence: FlowPersistence']) {
      expect(s).toContain(field);
    }
  });
});

describe('G-TOGGLE 特性开关注册守卫', () => {
  it('流程域目录存在且描述子注册表/校验器可寻址（host/flows/ 拓扑面）', () => {
    const flowsDir = join(SRC, 'host', 'flows');
    expect(existsSync(flowsDir)).toBe(true);
    const files = readdirSync(flowsDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain('registry.ts');
    expect(files).toContain('contracts.ts');
  });

  it('开关读取契约在 routeContext（flow.selfInit 默认 enabled——关闭=降级不是拆除）', () => {
    const s = readFileSync(join(SRC, 'host', 'routes', 'routeContext.ts'), 'utf8');
    expect(s).toMatch(/flow\.selfInit/);
    expect(s).toMatch(/\?\? true/);
  });
});

describe('G-DEP 依赖方向守卫（L0-L5 单向依赖）', () => {
  it('分层目录拓扑存在（runtime/routes/evolution/client 四层可寻址——空集恒绿是假守卫）', () => {
    for (const layer of ['host/runtime', 'host/routes', 'host/evolution', 'client']) {
      const p = join(SRC, layer);
      expect(existsSync(p) && statSync(p).isDirectory(), `${layer} 分层目录缺失`).toBe(true);
    }
  });

  it('client 不 import host（渲染层零反向依赖宿主实现——L5→L0 铁律的可机械子集）', () => {
    const violations: string[] = [];
    for (const f of collectTs(join(SRC, 'client'))) {
      const s = readFileSync(f, 'utf8');
      if (/from '[^']*\/host\//.test(s) || /from '\.\.\/\.\.\/host\//.test(s)) {
        violations.push(f.slice(SRC.length + 1).replaceAll(String.fromCharCode(92), '/'));
      }
    }
    expect(violations, violations.join('; ')).toEqual([]);
  });
});
