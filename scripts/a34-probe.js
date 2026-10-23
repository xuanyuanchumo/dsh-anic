/**
 * A3/A4/A6 **真机验收**探针（cycle-74）——在真实宿主上验证渐进式披露的按需激活。
 *
 * 为什么需要它（区别于契约测试）：契约测试用**受控桩**验证判定路径；
 * 本探针在**真实宿主**上验证「restrict 真的收缩了 scope 视图」——这是桩无法覆盖的那一半。
 *
 * 用法（沙箱，绝不启停主力宿主）：
 *   npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile sb-a34 add "link:<repo>"
 *   npx -y @deepseek-ai/dsh@0.2.1-rc.2 plugin --profile sb-a34 add "file:<本目录>"
 *   cp scripts/a34-probe.js ~/.dsh/profiles/sb-a34/node_modules/anic-a34-probe/index.js
 *   npx -y @deepseek-ai/dsh@0.2.1-rc.2 --profile sb-a34 'hi'
 *   结果写入 D:/anic-a34/result.json
 *
 * 为什么建 agent 不需要凭据：`createAgent` 只准备会话 + 跑 setup + publish，
 * 发布路径经 `setupAndPublish` → `publish()` → `agents.announce()` 发射 `agent/created`；
 * **不发起任何 LLM 请求**（凭据只在真正的对话轮需要）。
 *
 * 验收判据（全部为 true 才算过）：
 *   A3  激活后 19 个非加载器工具**逐 id 缺席**，2 个加载器仍在；
 *   A4  加载器 schema 在激活前后**深度相等**（特权工具不被削弱）；
 *   A6  幂等：disposer 恢复 = 原集合；二次 restrict = 同一集合；
 *   全局视图不受 scope 影响。
 */

// A3/A4/A6 真机验收（cycle-74 P0 修复后具备条件）：在真实宿主上对**真实 21 个** anic 工具
// 验证 restrict 激活：A3 逐 id 缺席、A4 加载器 schema 等价、A6 幂等。
import { writeFileSync } from 'node:fs';
export const inject = ['tools', 'agents', 'agentLoop'];
const OUT = 'D:/anic-a34/result.json';
const LOADERS = ['anic_tool_detail', 'anic_tools_search'];
function flush(o) { try { writeFileSync(OUT, JSON.stringify(o, null, 2)); } catch (e) {} }
function names(s) {
  if (Array.isArray(s)) return s.map((x) => (x && x.name) || x);
  if (s && typeof s === 'object') return Object.keys(s);
  return [];
}
export function apply(ctx) {
  const out = { at: new Date().toISOString(), R: {} };
  const rec = (k, v) => { out.R[k] = v; flush(out); try { console.log('[a34] ' + k + ' = ' + JSON.stringify(v)); } catch (e) {} };
  const run = async () => {
    try {
      const glob = names(ctx.tools.schemas());
      const anic = glob.filter((n) => String(n).startsWith('anic_')).sort();
      rec('global_anic_count', anic.length);
      rec('global_anic_ids', anic);
      if (anic.length !== 21) { rec('FATAL', 'expected 21 anic tools, got ' + anic.length); return; }
      const deny = anic.filter((n) => !LOADERS.includes(n));
      rec('deny_count', deny.length);
      // A4 所需：激活前取加载器的 schema 快照（从注册面）
      const schemaOf = (agent, name) => {
        const ss = ctx.tools.schemas(agent);
        const arr = Array.isArray(ss) ? ss : Object.values(ss || {});
        return arr.find((x) => x && x.name === name) || null;
      };
      await ctx.agentLoop.createAgent(ctx, {
        sessionId: 'a34-' + String(Date.now()),
        setup: (scopedCtx, agent) => {
          try {
            const before = names(scopedCtx.tools.schemas(agent));
            rec('A3_before_anic_count', before.filter((n) => String(n).startsWith('anic_')).length);
            const loaderSchemaBefore = LOADERS.map((n) => [n, schemaOf(agent, n)]);
            const d1 = scopedCtx.tools.restrict({ deny });
            rec('restrict_returns_disposer', typeof d1 === 'function');
            const after = names(scopedCtx.tools.schemas(agent));
            const afterAnic = after.filter((n) => String(n).startsWith('anic_')).sort();
            rec('A3_after_anic_ids', afterAnic);
            rec('A3_pass_all_denied_hidden', deny.every((n) => !after.includes(n)));
            rec('A3_pass_loaders_visible', LOADERS.every((n) => after.includes(n)));
            rec('A3_hidden_count', deny.filter((n) => !after.includes(n)).length);
            // A4：激活后加载器 schema 与激活前**深度相等**（特权工具不被削弱）
            const loaderSchemaAfter = LOADERS.map((n) => [n, schemaOf(agent, n)]);
            const eq = LOADERS.every((n) => JSON.stringify(loaderSchemaBefore.find((x) => x[0] === n)[1]) === JSON.stringify(loaderSchemaAfter.find((x) => x[0] === n)[1]));
            rec('A4_pass_loader_schema_unchanged', eq);
            // A6：幂等——disposer 恢复后集合回到激活前；再次 restrict 得同一集合
            if (typeof d1 === 'function') d1();
            const restored = names(scopedCtx.tools.schemas(agent)).filter((n) => String(n).startsWith('anic_')).sort();
            rec('A6_restored_anic_count', restored.length);
            rec('A6_pass_restore_exact', JSON.stringify(restored) === JSON.stringify(anic));
            const d2 = scopedCtx.tools.restrict({ deny });
            const again = names(scopedCtx.tools.schemas(agent)).filter((n) => String(n).startsWith('anic_')).sort();
            rec('A6_pass_second_apply_same', JSON.stringify(again) === JSON.stringify(afterAnic));
            if (typeof d2 === 'function') d2();
            rec('global_unaffected', names(ctx.tools.schemas()).filter((n) => String(n).startsWith('anic_')).length);
          } catch (e) { rec('setup_error', String(e && e.message).slice(0, 300)); }
        },
      });
      rec('createAgent', 'ok');
    } catch (e) { rec('createAgent_error', String(e && e.message).slice(0, 300)); }
  };
  run();
}