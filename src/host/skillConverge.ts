/**
 * 技能自收敛（cycle-104）—— 插件激活时把 live 副本拉齐到发行源。
 *
 * ## 为什么需要它（本轮取证的缺口，不是假想需求）
 *
 * `.cycles/cycle-104-evidence/baseline-findings.md` §1 的实证链：
 *   1. 提交 `fdc42a2` 改了 `assets/skill/scripts/fact-base-verify.mjs`（+271 行），
 *      **没有**重装 `.dsh/skills/ai-native-iteration-cycle/`（live 副本仍是 3040 B 的旧版）；
 *   2. `anic_status` 如实报 `skillIntegrity.ok=false` / `dualTrack="live-diverged"`；
 *   3. 跑一次 `pnpm run test` 之后漂移**自行消失**——因为
 *      `tests/unit/{bootstrapEngineIntegration,bootstrapOrchestrator,flowTrackerIntegration,
 *      native,skillDrift}.test.ts` 调用了 `autoInstallSkill()`，整体覆盖了 live 副本。
 *
 * 换句话说：**修复 live 副本的能力只存在于测试里**。真实宿主里
 * `src/index.ts` 的 `apply()` 从不调用 `autoInstallSkill`/`verifySkillInstall`
 * （六处 effect 逐一核对），P9 探针（`selfCheckRoute.ts:169`）也只报告不收敛。
 * 于是发行源升级后运行面永远落后——这与本插件「技能自进化」的定位直接矛盾。
 *
 * ## 设计的三条硬约束
 *
 * 1. **幂等**：in-sync 时必须零写入（不能每次都重写 69 个文件——那会让 mtime 抖动，
 *    干扰 `computeBuildRevision` 之类的 mtime 判据）。
 * 2. **只修差异**：复用 `repairSkillInstall`（它已实现「只重装 mismatch 文件、extras 不删」），
 *    绝不在这里造第二套复制逻辑。
 * 3. **失败不阻断激活**：与 `runReloadHandshake` 同纪律——自愈是附加项，
 *    抛异常会把整条 fiber 拖垮（`c.effect` 的清理链一起失效）。
 *
 * ## 为什么收敛结果要回传
 *
 * 「修好了」本身也是可观测事实：面板/org-status 需要能回答
 * 「这次启动有没有发生收敛、修了几个文件」。只写日志等于没有读数（本仓
 * cycle-101 已确立「无出口的读数 = 没有读数」）。故返回结构化 `ConvergeOutcome`。
 */
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifySkillInstall, repairSkillInstall, type SkillVerifyResult } from './skillIntegrity.ts';
import { autoInstallSkill, inlineSkillRoot } from './skillInvoker.ts';

/** 收敛结论的持久化文件（`.cycles/` 旁路，与 reload-history.json 同族）。 */
export const SKILL_CONVERGE_FILE = 'skill-converge.json';

/** 持久化的收敛记录（ConvergeOutcome + 时间戳）。 */
export type PersistedConverge = ConvergeOutcome & { at: string };

/**
 * 把收敛结论写到 `.cycles/skill-converge.json`（原子覆盖，单实例语义）。
 *
 * 为什么走文件而不是 ctx 内存挂载：本仓 cycle-81 实证「路由模块读不到
 * index.ts 模块的内存值」（hotReload 当时就用了 `.cycles` 旁路文件）。收敛
 * 读数的消费方（anic_status / 面板 / 路由）在不同模块实例里，文件是唯一
 * 跨实例可见的通道；且失败不影响激活（写不进就写不进，下次激活再试）。
 *
 * 审计语义：每次激活覆盖写（只保留最近一次结论）。历史轨迹由调用方
 * （index.ts 的 effect）在需要时追加，本函数不承担。
 */
export function persistConvergeOutcome(cyclesDir: string, outcome: ConvergeOutcome): boolean {
  try {
    const record: PersistedConverge = { ...outcome, at: new Date().toISOString() };
    writeFileSync(join(cyclesDir, SKILL_CONVERGE_FILE), JSON.stringify(record, null, 2) + '\n', 'utf-8');
    return true;
  } catch {
    return false; // 读数持久化失败不阻断激活（纪律 ③ 的对称面）
  }
}

/** 读取最近一次收敛结论（无文件 / 解析失败 ⇒ null，绝不猜）。 */
export function readConvergeOutcome(cyclesDir: string): PersistedConverge | null {
  try {
    const raw = readFileSync(join(cyclesDir, SKILL_CONVERGE_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedConverge;
    if (typeof parsed.action !== 'string' || typeof parsed.installedDir !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 一次自收敛的结论（可序列化，供路由/面板消费）。 */
export interface ConvergeOutcome {
  /** 收敛动作类别：not-installed / installed-fresh / repaired / in-sync / skipped / failed。 */
  action: 'not-installed' | 'installed-fresh' | 'repaired' | 'in-sync' | 'skipped' | 'failed';
  /** live 副本目录（绝对路径）。 */
  installedDir: string;
  /** 本次真正重写/复制的文件数（in-sync 时恒 0，这是幂等的可断言面）。 */
  repairedCount: number;
  /** 被修的文件清单（最多保留前 20 条，避免读数无限膨胀）。 */
  repaired: string[];
  /** 收敛后的复验结果（failed 时为 null——没有成功就无法断言）。 */
  verify: SkillVerifyResult | null;
  /** 参与判定的发行源目录（inline 不可用时为 null）。 */
  inlineDir: string | null;
  /** 失败原因（仅 action='failed' 时有值）。 */
  error?: string;
}

/** 从工作区根推导 live 副本目录（与 skillInvoker/selfCheckRoute 同一口径）。 */
export function installedSkillDirOf(workspaceRoot: string): string {
  return join(workspaceRoot, '.dsh', 'skills', 'ai-native-iteration-cycle');
}

/** 收敛结果 → 一行人类可读摘要（日志/面板共用，不写第二套措辞）。 */
export function describeConverge(o: ConvergeOutcome): string {
  switch (o.action) {
    case 'not-installed':
      return 'skill not installed (nothing to converge)';
    case 'installed-fresh':
      return 'skill freshly installed (first activation)';
    case 'in-sync':
      return o.verify ? `skill in-sync (${String(o.verify.checked)} files, live=${o.verify.liveVersion ?? '?'})` : 'skill in-sync';
    case 'repaired':
      return `skill converged: ${String(o.repairedCount)} file(s) repaired → ${o.verify?.dualTrack ?? 'unknown'}`;
    case 'skipped':
      return 'skill convergence skipped (inline distribution source unavailable)';
    case 'failed':
      return `skill convergence failed: ${o.error ?? 'unknown'}`;
  }
}

/**
 * 收敛 live 技能副本到发行源。
 *
 * 决策表（四象限，每格都有单测）：
 *
 * | live 状态            | 动作             | 写入 |
 * |----------------------|------------------|------|
 * | SKILL.md 不存在      | autoInstallSkill | 全量 |
 * | 存在 + 验证 ok       | 不动作           | 0    |
 * | 存在 + 有 mismatch   | repairSkillInstall | 仅差异 |
 * | inline 源不可用      | skipped          | 0    |
 *
 * 纯过程（无 ctx、无日志副作用），失败以 `action:'failed'` 表达而**不抛**，
 * 由调用方决定是否 warn——这样它既能在激活期安全调用，也能被单测直接驱动。
 */
export function convergeSkill(workspaceRoot: string): ConvergeOutcome {
  const installedDir = installedSkillDirOf(workspaceRoot);

  let inlineDir: string | null = null;
  try {
    inlineDir = inlineSkillRoot();
  } catch {
    inlineDir = null;
  }

  // ① 未安装：直接装（首次激活的引导路径，与 anic_install 同构落点）
  if (!existsSync(join(installedDir, 'SKILL.md'))) {
    try {
      const r = autoInstallSkill(workspaceRoot);
      if (!r.installed) {
        return {
          action: 'failed', installedDir, repairedCount: 0, repaired: [],
          verify: null, inlineDir, error: r.error ?? 'autoInstallSkill returned installed=false',
        };
      }
      const verify = inlineDir ? verifySkillInstall(installedDir, inlineDir) : null;
      return {
        action: 'installed-fresh', installedDir,
        repairedCount: verify?.checked ?? 0, repaired: [], verify, inlineDir,
      };
    } catch (e) {
      return {
        action: 'failed', installedDir, repairedCount: 0, repaired: [],
        verify: null, inlineDir, error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ② 发行源不可用：无从对比 ⇒ 如实 skipped（绝不猜、绝不拿 live 当权威）
  if (inlineDir === null || !existsSync(inlineDir)) {
    return { action: 'skipped', installedDir, repairedCount: 0, repaired: [], verify: null, inlineDir };
  }

  // ③ 已安装：先验后修（in-sync 必须零写入——幂等的可断言面）
  try {
    const before = verifySkillInstall(installedDir, inlineDir);
    if (before.ok) {
      return { action: 'in-sync', installedDir, repairedCount: 0, repaired: [], verify: before, inlineDir };
    }
    const { repaired, verify } = repairSkillInstall(installedDir, inlineDir);
    return {
      action: 'repaired', installedDir,
      repairedCount: repaired.length,
      repaired: repaired.slice(0, 20), // 有界读数：只留前 20 条，避免 JSON 无限膨胀
      verify, inlineDir,
    };
  } catch (e) {
    return {
      action: 'failed', installedDir, repairedCount: 0, repaired: [],
      verify: null, inlineDir, error: e instanceof Error ? e.message : String(e),
    };
  }
}
