/**
 * 自举按钮反馈状态机（P0-2：原实现 `void fetch(...)` —— 零反馈，
 * 失败时用户完全无感；成功与否都不可区分）。
 *
 * 特性模块制（12 §3.1）：面板组件只编排分区，本模块持有四态状态机。
 * idle → running → ok（幂等提示）/ failed（错误 + 重试语义）。
 */
import { useCallback, useState } from 'react';
import { t } from '../../i18n.ts';

const SELF_INIT_URL = '/anic/self/init';

export type SelfInitPhase = 'idle' | 'running' | 'ok' | 'failed';

export interface SelfInitState {
  phase: SelfInitPhase;
  note: string;
  /** running 时由面板禁用按钮（防双击）；failed 由面板切换「重试」文案。 */
  onSelfInit: () => Promise<void>;
}

/**
 * POST /anic/self/init 的四态反馈 hook。
 *
 * 409 + ANIC_ROUTE_SELF_INIT_ALREADY = 工作区已有 canonical 配置
 * （docs/anic/12 §2.3 refuse-to-rerun）。从按钮视角这是成功态：
 * 目标（存在 .cycles/config.yml）已达成，不是失败 —— 显示「已初始化」。
 */
export function useSelfInit(): SelfInitState {
  const [phase, setPhase] = useState<SelfInitPhase>('idle');
  const [note, setNote] = useState('');

  const onSelfInit = useCallback(async (): Promise<void> => {
    if (phase === 'running') return;
    setPhase('running');
    setNote('');
    try {
      const res = await fetch(SELF_INIT_URL, { method: 'POST' });
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        if (body?.error?.code === 'ANIC_ROUTE_SELF_INIT_ALREADY') {
          setPhase('ok');
          setNote(t('panel.selfInitAlready'));
          return;
        }
      }
      const detail = res.ok ? `（${String(res.status)}）` : `（HTTP ${String(res.status)}）`;
      setPhase(res.ok ? 'ok' : 'failed');
      setNote(res.ok ? t('panel.selfInitOk', { detail }) : t('panel.selfInitFailed', { error: `HTTP ${String(res.status)}` }));
    } catch (e) {
      setPhase('failed');
      setNote(t('panel.selfInitFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [phase]);

  return { phase, note, onSelfInit };
}
