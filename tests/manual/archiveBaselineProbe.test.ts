/**
 * 基线重置**探针**（cycle-86）。
 *
 * ## 为什么默认 dryRun，且真写必须显式开环境变量
 *
 * 本文件第一版直接 `dryRun: false`。它落在 `tests/**` 扫描域里 ⇒ **每次全量测试都会
 * 真的执行基线重置**：cycle-86（刚建、任务清单已填完）被当场搬进 `.cycles/archive/`，
 * 后续 eval/gate 只能落到更旧的 cycle-83 上。
 *
 * 这是一条真实的破坏性缺陷，不是"探针有点吵"：测试套件对**用户工作区**产生了
 * 不可预期的写副作用（且看上去一切绿）。处置按本仓既有纪律：
 *   - 默认只读（dryRun），自动运行永远是 no-op；
 *   - 真写必须显式 `ANIC_ARCHIVE_EXECUTE=1`（与 `--live` 同一模式：危险动作要人按下去）。
 *
 * 运行方式：
 *   预览   node node_modules/vitest/vitest.mjs run tests/manual/archiveBaselineProbe.test.ts
 *   执行   ANIC_ARCHIVE_EXECUTE=1 node node_modules/vitest/vitest.mjs run tests/manual/archiveBaselineProbe.test.ts
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { archiveBaseline } from '../../src/host/runtime/artifactArchiveBaseline.ts';

describe('archive baseline probe（默认只读）', () => {
  it('预览归档/保留清单；仅当 ANIC_ARCHIVE_EXECUTE=1 才真写', () => {
    const execute = process.env.ANIC_ARCHIVE_EXECUTE === '1';
    const cyclesDir = join(process.cwd(), '.cycles');
    /**
     * cycle-87：支持 `names` / `includeIncomplete` 三个 env 开关，用于**定点封存**
     * 历史脏目录（cycle-1/16/75/83 这类"任务表为空/缺失"的轮）。
     *
     * 为什么用环境变量而不是改默认行为：一次性运维动作不该有常驻代码路径；
     * 三个开关组合起来已经能表达"封存哪些、是否含未完成"，而默认态仍然是只读。
     */
    const namesEnv = process.env.ANIC_ARCHIVE_NAMES;
    const names = namesEnv === undefined || namesEnv.trim() === ''
      ? undefined
      : namesEnv.split(',').map((n) => n.trim()).filter((n) => n !== '');
    const includeIncomplete = process.env.ANIC_ARCHIVE_INCLUDE_INCOMPLETE === '1';
    const r = archiveBaseline(cyclesDir, {
      dryRun: !execute,
      ...(names === undefined ? {} : { names }),
      ...(includeIncomplete ? { includeIncomplete } : {}),
      actor: execute ? 'probe:archive-baseline(execute)' : 'probe:archive-baseline(dry-run)',
    });
    if (names !== undefined) console.log('[probe] names=', names.join(','));
    if (includeIncomplete) console.log('[probe] includeIncomplete= true');
    console.log('[probe] execute=', execute, 'ok=', r.ok, 'alreadyArchived=', r.alreadyArchived);
    console.log('[probe] archive count=', r.archived.length, '→', r.archived.join(', '));
    console.log('[probe] kept count=', r.kept.length);
    for (const k of r.kept) console.log(`[probe] kept ${k.name}: ${k.reason} — ${k.detail}`);
    console.log('[probe] ledger=', JSON.stringify(r.ledger));
    expect(r.dryRun).toBe(!execute);
    // 自动运行（未开 ENV）必须**零副作用**：dryRun 时账本读数必为 unchanged 且无归档动作
    if (!execute) expect(r.archived.length === 0 || r.ledger?.unchanged !== false).toBe(true);
  });
});
