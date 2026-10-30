/**
 * H1 敏感文件判定（cycle-89 修正）—— **设计令牌表不是凭据文件**。
 *
 * ## 被守卫的误报（实测）
 *
 * `SENSITIVE_PATTERNS` 含 `'token'`，而 `src/shared/tokens.ts` 与
 * `src/shared/hostTokens.ts` 都含 `token` 子串 → H1 判它们「敏感文件未受
 * .gitignore 保护」→ **熔断**（circuit=true）。
 *
 * 但这两个文件是**设计令牌表**（CSS 变量定义），里面**没有任何凭据**，
 * 且**应当入库**（不入库，插件就丢掉了主题系统）。
 *
 * 后果不止是「多一条告警」：H1 熔断会让 `anic_flows_hitl` 返回
 * `verdict: circuit` → 按协议应当**回退自主级**（L4 → L3）。
 * 为两个无害的样式文件回退整个自主级，是**假熔断**的典型代价。
 */
import { describe, expect, it } from 'vitest';
import { evaluateH1 } from '../../src/host/governance/hitlAudit.ts';

describe('H1：设计令牌表不判为敏感文件', () => {
  it('**tokens.ts / hostTokens.ts → 不熔断**（实测误报守卫）', () => {
    const r = evaluateH1(
      ['src/shared/tokens.ts', 'src/shared/hostTokens.ts'],
      'node_modules/\ndist/\n',
      [],
    );
    expect(r.passed).toBe(true);
    expect(r.circuit).toBe(false);
  });

  it('**真正的凭据文件仍被拦下**（守卫不能变哑）', () => {
    const r = evaluateH1(
      ['config/credentials.json', 'config/secrets.ts', 'api_key.env'],
      'node_modules/\ndist/\n',
      [],
    );
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.findings).toEqual(['config/credentials.json', 'config/secrets.ts', 'api_key.env']);
  });

  it('**token.json 仍被拦下**（白名单是精确匹配，不是子串豁免）', () => {
    const r = evaluateH1(['token.json'], 'node_modules/\n', []);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
  });

  it('**tokens.ts.bak 不被豁免**（精确文件名，不是前缀豁免）', () => {
    const r = evaluateH1(['tokens.ts.bak'], 'node_modules/\n', []);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
  });

  it('**mytokens.ts 不被豁免**', () => {
    const r = evaluateH1(['mytokens.ts'], 'node_modules/\n', []);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
  });

  it('设计令牌文件**已入库**（.gitignore 含该名）时也不报 —— 双重保险', () => {
    const r = evaluateH1(['src/shared/tokens.ts'], 'node_modules/\ntokens.ts\n', []);
    expect(r.passed).toBe(true);
  });

  it('`.env` 落盘未保护 → 仍熔断（另一条判据不受影响）', () => {
    const r = evaluateH1([], 'node_modules/\n', ['.env']);
    expect(r.passed).toBe(false);
    expect(r.circuit).toBe(true);
    expect(r.detail).toContain('Env files');
  });
});
