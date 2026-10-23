/**
 * E2E 真机验收探针（cycle-74 T-7409）——验证**插件自身接线**（非探针手工 restrict）。
 *
 * 与 a34-probe.js 的分工：
 *   - a34-probe.js：探针**自己**调 restrict，验证「restrict 在真机能收缩 scope」（机制级）；
 *   - 本探针：**不碰 restrict**，只建一个 cwd 指向 indexed 工作区的 agent，
 *     然后观察该 agent 的 scope 是否已被**插件自己的** agent/created 监听器收缩（集成级）。
 *     这才是「注册 → 生产 → 消费」闭环的端到端证据。
 *
 * 用法：
 *   1) 造 indexed 工作区 `<WS>/.cycles/config.yml` 含 `toolDisclosure: indexed`；
 *   2) 沙箱装本插件 + 本探针，探针 index.js 里把 WS 指向该工作区；
 *   3) 跑 `dsh --profile <sandbox> 'hi'`，读 result.json。
 *
 * 判据：`E2E_indexed_activated === true`（scope 内 anic 工具从 21 → 2，仅剩两个加载器）
 *       且日志出现 `agent disclosure: indexed: injected index + restricted 19 tools`。
 *
 * 两个实测教训（已修为契约）：
 *   1. **必须 rebuild dist**——宿主加载 dist/host.js，源码改了不重建则探针读到旧行为；
 *   2. `systemPrompt.section()` 的 `order` **必须是有限数字**（宿主硬校验），
 *      且注入与遮蔽必须**原子**（先注入后遮蔽），否则出现「只遮蔽未注入」的半途落地。
 */

// E2E 验收：验证**插件自身接线**（非探针手工 restrict）在 indexed 工作区上生效。
// 探针只建 agent 并观察：若插件的 agent/created 监听器已跑，则该 agent 的 scope 已被收缩。
import { writeFileSync } from 'node:fs';
export const inject = ['tools', 'agents', 'agentLoop'];
const OUT = 'D:/anic-e2e/result.json';
const LOADERS = ['anic_tool_detail', 'anic_tools_search'];
function flush(o) { try { writeFileSync(OUT, JSON.stringify(o, null, 2)); } catch (e) {} }
function names(s) {
  if (Array.isArray(s)) return s.map((x) => (x && x.name) || x);
  if (s && typeof s === 'object') return Object.keys(s);
  return [];
}
export function apply(ctx) {
  const out = { at: new Date().toISOString(), R: {} };
  const rec = (k, v) => { out.R[k] = v; flush(out); try { console.log('[e2e] ' + k + ' = ' + JSON.stringify(v)); } catch (e) {} };
  const run = async () => {
    try {
      const anic = names(ctx.tools.schemas()).filter((n) => String(n).startsWith('anic_')).sort();
      rec('global_anic_count', anic.length);
      if (anic.length !== 21) { rec('FATAL', 'need 21 anic tools, got ' + anic.length); return; }
      const WS = 'D:/anic-e2e/indexed-ws';
      await ctx.agentLoop.createAgent(ctx, {
        sessionId: 'e2e-' + String(Date.now()),
        meta: { cwd: WS },
        setup: (scopedCtx, agent) => {
          try {
            // 给插件的 agent/created 监听器一点时间（serial dispatch）——但 setup 里可能早于 announce。
            rec('setup_cwd_seen', String(agent.session && agent.session.header && agent.session.header.cwd || 'NONE'));
            const vis = names(scopedCtx.tools.schemas(agent)).filter((n) => String(n).startsWith('anic_')).sort();
            rec('E2E_anic_visible_in_setup', vis);
            rec('E2E_count_in_setup', vis.length);
          } catch (e) { rec('setup_err', String(e && e.message).slice(0, 200)); }
        },
      });
      rec('createAgent', 'ok');
      // announce 之后（publish 已 await）再回看：用 agents.list 取该 agent 的 scope
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const list = ctx.agents && ctx.agents.list ? ctx.agents.list() : [];
        rec('agents_list_count', list.length);
        const last = list[list.length - 1];
        if (last) {
          const vis2 = names(last.ctx.tools.schemas(last)).filter((n) => String(n).startsWith('anic_')).sort();
          rec('E2E_anic_visible_after_announce', vis2);
          rec('E2E_count_after_announce', vis2.length);
          rec('E2E_indexed_activated', vis2.length === 2 && LOADERS.every((l) => vis2.includes(l)));
        }
      } catch (e) { rec('post_err', String(e && e.message).slice(0, 200)); }
    } catch (e) { rec('createAgent_error', String(e && e.message).slice(0, 250)); }
  };
  run();
}