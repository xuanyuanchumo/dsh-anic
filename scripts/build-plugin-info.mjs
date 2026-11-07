/**
 * 构建期信息生成器（cycle-111）—— package.json（唯一事实源）→ src/client/info/pluginInfo.ts。
 *
 * ## 为什么入库生成物
 *
 * 客户端契约测试与 typecheck 读的是 src/client/info/pluginInfo.ts；若生成物
 * 不入库，测试就必须先跑构建（顺序耦合、CI 慢、沙箱冒烟断链）。生成物入库 +
 * 版本同步契约测试（tests/contract/pluginInfoContract.test.ts）对比
 * package.json ⇒ 漏跑生成只会红测试，不会让面板显示陈旧版本。
 *
 * @usage node scripts/build-plugin-info.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const repoUrl = String(pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');
const issues = String(pkg.bugs?.url ?? `${repoUrl}/issues`);
const name = String(pkg.name);
const outPath = join(root, 'src', 'client', 'info', 'pluginInfo.ts');

const banner = `/**
 * 插件信息（cycle-111 · PluginInfoPanel 数据面）—— 构建期生成的**纯静态常量**。
 *
 * ## 为什么是生成文件（committed，不 gitignore）
 *
 * package.json 是版本号的唯一事实源。客户端 bundle 无法直接读 package.json
 * （打包边界：tsdown 不内联 JSON import 进 CJS 产物的可靠形态依赖宿主解析），
 * 所以构建脚本（\`scripts/build-plugin-info.mjs\`）读 package.json 生成此模块。
 * 生成物**入库**：① typecheck/契约测试/沙箱冒烟不依赖构建脚本先跑（测试即
 * 编译，生成文件缺席会假红）；② 版本同步测试对比生成物与 package.json，
 * 漂移即红（跑 \`pnpm run build\` 会顺手重新生成）。
 *
 * ## 改动纪律
 *
 * 本文件**只由脚本生成**，手工编辑会被下次构建覆盖——要改字段形状改
 * \`scripts/build-plugin-info.mjs\` 的模板，要改版本号改 package.json。
 */

/** 插件静态信息（构建期单一事实源投影；形状见 buildPluginInfo）。 */
export interface PluginInfo {
  /** 插件名（package.json name）。 */
  name: string;
  /** 插件版本（package.json version——发版三锚同步：package.json / CHANGELOG / dist）。 */
  version: string;
  /** 仓库主页（反馈入口跳转目标族）。 */
  homepage: string;
  /** 仓库 URL（API 形态 https，浏览器可直达）。 */
  repository: string;
  /** Issue 反馈入口。 */
  issues: string;
  /** npm 包页。 */
  npm: string;
  /** 文档根（仓库内 docs/anic/ 在 GitHub 的路径）。 */
  docs: string;
  /** 构建时间戳（ISO；锚定 package.json mtime——源变化才前进，保证生成器幂等）。 */
  builtAt: string;
}

export const PLUGIN_INFO: PluginInfo = `;

// builtAt 锚定 package.json 的 mtime（而非 Date.now()）：仓库状态不变 ⇒ 产物字节
// 不变（幂等），package.json 真被改过 ⇒ 时间戳才前进。Date.now() 会让每次构建都
// 产生 diff，污染版本同步契约测试的"漂移即红"语义。
const builtAt = statSync(join(root, 'package.json')).mtime.toISOString();

const data = JSON.stringify({
  name,
  version: String(pkg.version),
  homepage: String(pkg.homepage ?? `${repoUrl}#readme`),
  repository: repoUrl,
  issues,
  npm: `https://www.npmjs.com/package/${name}`,
  docs: `${repoUrl}/tree/main/docs/anic`,
  builtAt,
}, null, 2)
  // 同源契约豁免标记（cycle-111）：URL 字段是「跳转目标数据」（用户点击外链，
  // 系统浏览器接管），不是 fetch 目标——逐行打 anic-url-data 标记，clientSameOrigin
  // 契约认标记跳过。JSON.stringify 缩进两格 ⇒ 打标后仍保持合法 TS 对象字面量。
  .split('\n')
  .map((l) => (/": "https?:/.test(l) ? `${l.replace(/,$/, ',')} // anic-url-data（跳转目标，非 fetch）` : l))
  .join('\n');

writeFileSync(outPath, `${banner}${data};\n`, 'utf8');
console.log(`[build-plugin-info] ${name}@${String(pkg.version)} -> ${outPath}`);
