/**
 * 插件根目录解析（布局自适应，cycle-15 P0-DIR-ROOT）。
 *
 * 背景：真机宿主加载的是单文件 bundle `dist/host.js`（离仓库根仅一层深），而
 * 源码布局是 `src/host/routes/*.ts`（三层深）——固定层级的 `../../` 推导只能
 * 在一种布局下正确。真实宿主实测暴露两处：
 *   - truthAuditRoute 的 `resolve(file, '../../../')` 在 dist 下解析到仓库父
 *     目录（T1-T4 全 MISSING、version vunknown——审计了 D:\Projects\TraeProjects\），
 *     在源码布局下又落到 src/（两种布局全错，从未正确工作过）；
 *   - routes/index.ts 双向自举的 `new URL('../../../', …)` 在 dist 下多弹一层。
 * 而 skillInvoker 的哨兵探测（多级 up + init-workflow.mjs 存在性检查）从未出错。
 *
 * 解法：标记驱动向上查找——从 import.meta.url 逐级向上，找到
 * `package.json` 且 `name === "dsh-anic"` 的目录即为根。对任意打包深度、
 * 开发布局、junction 安装（profile node_modules 链接）都稳定；找不到返回 ''
 * （调用方须显式失败，绝不静默审计错误目录——本轮的核心教训）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'dsh-anic';
/** 向上查找层数上限：足够覆盖任何合理的 bundle 深度，同时防止走尽盘符。 */
const MAX_WALK_UP = 10;

/** 从 startDir 逐级向上找 name=dsh-anic 的 package.json；找不到返回 null。 */
function findPluginRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
        if (pkg.name === PLUGIN_NAME) return dir;
      } catch {
        // 损坏的 package.json —— 当作无标记，继续向上
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // 盘符根仍未找到
    dir = parent;
  }
  return null;
}

/**
 * 解析插件根目录（布局自适应）。
 *
 * @param startUrl 起始文件 URL（默认 import.meta.url；测试可注入模拟两种布局）
 * @returns 根目录绝对路径；找不到标记时返回 ''（调用方必须显式处理，不得静默降级）
 */
export function resolvePluginRoot(startUrl?: string): string {
  const base = startUrl ?? import.meta.url;
  let startDir: string;
  try {
    startDir = dirname(fileURLToPath(base));
  } catch {
    return '';
  }
  return findPluginRoot(startDir) ?? '';
}

/**
 * 插件 assets 子目录（assets/skill、assets/agents）。
 *
 * @param asset 'skill' | 'agents'
 * @returns 目录绝对路径；根未解析时返回 ''（与旧 defaultAgentCardsDir 缺省语义一致：
 *   调用方以 falsy 跳过注册）
 */
export function pluginAssetDir(asset: 'skill' | 'agents', startUrl?: string): string {
  const root = resolvePluginRoot(startUrl);
  return root ? join(root, 'assets', asset) : '';
}
