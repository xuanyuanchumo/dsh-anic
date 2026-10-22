/**
 * mcp-server.mjs 命令注入回归守卫（cycle-72 P0-SEC-MCP-ARGV）。
 *
 * 被守卫的缺陷（assets/skill/scripts/mcp-server.mjs 旧 :33）：
 *   execSync(`node "${scriptPath}" "${projectDir}" ${scriptArgs.join(' ')}`)
 * 把 projectDir 与工具参数**拼进 shell 命令行**。引号不是防线——值里的 `"`
 * 自身即可闭合引号并追加任意命令。主平台 Windows 上「路径含空格」属常态，
 * 本机恰好无空格故从未爆雷。
 *
 * 修复形态：spawnSync(command, argsArray)，projectDir 是独立 argv token，
 * shell 不参与解析。
 *
 * 本测试为什么用哨兵文件而不是断言「输出变了」：
 * 「没被注入」是无法从输出反推的负向命题。唯一可信的形态是让**注入本身留下
 * 可检的痕迹**（哨兵文件），再断言该痕迹缺席。因此测试含两半：
 *   ① 反向自检（negative control）：用旧模板串真实执行一次，**必须**打出哨兵
 *      ——证明哨兵机制真的能捕获注入（否则守卫会在负载/引号变化后永久假绿）；
 *   ② 被守卫行为：同样的恶意 projectDir / 工具参数走 spawnSync 路径，哨兵必须缺席。
 *
 * 为何自建 stub SDK：本仓（含父工程）未安装 @modelcontextprotocol/sdk，
 * mcp-server.mjs 顶层 import 该包即 ERR_MODULE_NOT_FOUND，无法直接加载。
 * 故测试把 scripts/ 副本与一个最小 stub 包写进临时目录，经子进程驱动真实
 * 模块体（真 spawn、真 argv、真哨兵），而非在进程内 mock 掉被测代码。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS_SRC = join(import.meta.dirname, '..', '..', 'assets', 'skill', 'scripts');
const SDK_PKG = '@modelcontextprotocol/sdk';

const SENTINEL_TEXT = 'pwned-by-injection';

let TMP: string;
let SENTINEL: string;

/**
 * 注入负载：闭合外层双引号 + 命令连接符 + `echo SENT> <哨兵>` + `rem "` 收尾。
 *
 * 四处刻意的工程选择（各由一次实测反推，非风格偏好）：
 *  1. **分隔符用 `&` 而非 `&&`**：`&&` 要求前一条命令**成功**，而被测的
 *     `node "<dummy>"` 必然以 ERR_MODULE_NOT_FOUND 失败 → `&&` 短路，注入不执行，
 *     反向自检会假红。`&` 无条件串联，POSIX sh 与 Windows cmd.exe 都支持。
 *  2. **用 `echo` 重定向写哨兵，不用嵌套 `node -e`**：cmd.exe 的引号剥离规则下，
 *     嵌套引号内的路径会被当成参数拆分（实测 `&` 分支里注入的 node 找不到脚本）。
 *     `echo X> file` 无需嵌套引号，跨平台可靠。
 *  3. **负载本身不含引号**：cmd.exe 合并 `/s /c` 串时先剥一层引号，负载需保留到
 *     拼接后才闭合外层引号。实测无引号负载在两种 shell 下均成功注入。
 *  4. **以 `& rem "` 收尾**：旧模板在 projectDir 之后还拼了固定参数（`status`）。
 *     若负载止于重定向，尾随参数会被 cmd 接到重定向目标上（`echo X> "s.txt" status`
 *     写向名为 `sentinel.txt status` 的文件），哨兵在预期路径下落空。`rem "` 是注释
 *     命令，吞掉尾部残余——真实攻击者同样必须处理尾随参数，此步是负载可信度的一部分，
 *     不是测试脚手架。
 */
function injectionPayload(sep: string): string {
  return `evil" ${sep} echo ${SENTINEL_TEXT}> "${SENTINEL}" ${sep} rem "`;
}

/** 逐字复刻修复前的拼接形态（旧 :33），只把 projectDir 换成注入负载。 */
function buildLegacyCommand(sep: string): string {
  const scriptPath = join(TMP, 'scripts', 'org-status.mjs');
  return `node "${scriptPath}" "${injectionPayload(sep)}" status`;
}

/** 以给定 projectDir 调用一个 MCP 工具，返回其 content[0].text 与进程输出。 */
function callTool(projectDir: string, toolName: string, toolArgs: unknown): { text: string; raw: string } {
  const r = spawnSync(
    'node',
    [join(TMP, 'scripts', '__driver.mjs'), toolName, JSON.stringify(toolArgs), projectDir],
    { encoding: 'utf-8', timeout: 60000 },
  );
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /DRIVER_RESULT:(.*)$/s.exec(r.stdout ?? '');
  const parsed = m ? (JSON.parse(m[1]!) as { content: Array<{ text: string }> }) : { content: [{ text: raw }] };
  return { text: parsed.content?.[0]?.text ?? '', raw };
}

/** 写入最小 stub SDK：Server 只记录 handler，transport 为空转，不碰真实 stdio。 */
function writeStubSdk(): void {
  const sdkDir = join(TMP, 'node_modules', ...SDK_PKG.split('/'));
  mkdirSync(join(sdkDir, 'server'), { recursive: true });
  // 无 exports 字段 → Node 允许任意子路径（server/index.js、types.js）直接解析
  writeFileSync(join(sdkDir, 'package.json'), JSON.stringify({ name: SDK_PKG, type: 'module' }), 'utf-8');
  writeFileSync(join(sdkDir, 'server', 'index.js'), `
export class Server {
  constructor(info) { this.info = info; }
  setRequestHandler(schema, handler) {
    globalThis.__mcpStub = globalThis.__mcpStub || {};
    globalThis.__mcpStub.handlers = globalThis.__mcpStub.handlers || {};
    globalThis.__mcpStub.handlers[String(schema)] = handler;
  }
  async connect() { /* 空转：测试直接调用 handler，不经 stdio */ }
}
`, 'utf-8');
  writeFileSync(join(sdkDir, 'server', 'stdio.js'),
    'export class StdioServerTransport { constructor() {} }\n', 'utf-8');
  // schema 用字符串常量：跨模块实例同一（ESM 单例），driver 与被测模块拿到同一把钥匙
  writeFileSync(join(sdkDir, 'types.js'), `
export const CallToolRequestSchema = 'CallToolRequestSchema';
export const ListToolsRequestSchema = 'ListToolsRequestSchema';
`, 'utf-8');
}

/**
 * 驱动脚本：把子进程 argv 改写成 mcp-server 期望的形状后再 import 被测模块。
 *
 * 必须在 import **之前**改写 process.argv——被测模块在模块体顶层即调用
 * parseCliArgs(process.argv) 解析 --project-dir，晚一步就来不及。
 */
function writeDriver(): void {
  writeFileSync(join(TMP, 'scripts', '__driver.mjs'), `
const [, , toolName, argsJson, projectDir] = process.argv;
// __NOFLAG__：完全省略 --project-dir，验证「未提供旗标 → 回落 cwd」的合法用法
// 不被上面的响亮拒绝误伤（回归保护）。
process.argv = projectDir === '__NOFLAG__'
  ? ['node', 'mcp-server.mjs']
  : ['node', 'mcp-server.mjs', '--project-dir', projectDir];
await import('./mcp-server.mjs');
const handler = globalThis.__mcpStub.handlers['CallToolRequestSchema'];
const result = await handler({ params: { name: toolName, arguments: JSON.parse(argsJson) } });
process.stdout.write('DRIVER_RESULT:' + JSON.stringify(result));
`, 'utf-8');
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'anic-mcp-argv-'));
  SENTINEL = join(TMP, 'sentinel.txt');
  // 真实脚本 + 共享库：被测模块必须仍是出厂实现，故整目录复制而非重写
  cpSync(SCRIPTS_SRC, join(TMP, 'scripts'), { recursive: true });
  writeStubSdk();
  writeDriver();
});

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 并发清理容忍 */ }
});

describe('反向自检：哨兵机制真的能捕获注入（守卫不得永久假绿）', () => {
  it('旧模板串拼接 projectDir → 注入的 echo 真实执行，哨兵出现（证明机制有效）', () => {
    rmSync(SENTINEL, { force: true });
    expect(existsSync(SENTINEL)).toBe(false);

    // `&` 无条件串联：前一条 node 失败（dummy 脚本不存在）也不阻断注入
    try {
      execSync(buildLegacyCommand('&'), { stdio: 'pipe' });
    } catch { /* 被测命令自身失败属预期，哨兵已落盘 */ }

    expect(existsSync(SENTINEL)).toBe(true);
    expect(readFileSync(SENTINEL, 'utf-8').trim()).toBe(SENTINEL_TEXT);
    rmSync(SENTINEL, { force: true });
  });

  it('（平台旁证）POSIX sh 下 `;` 分隔符同样注入 —— 两种 shell 都非空防线', () => {
    // `;` 仅 POSIX sh 是分隔符；Windows cmd 下不成立，故断言按平台收窄。
    // 保留该用例是为了证明「换一个分隔符就能绕过引号」不是单平台孤例。
    if (process.platform === 'win32') return;
    rmSync(SENTINEL, { force: true });
    try { execSync(buildLegacyCommand(';'), { stdio: 'pipe' }); } catch { /* 预期 */ }
    expect(existsSync(SENTINEL)).toBe(true);
    rmSync(SENTINEL, { force: true });
  });
});

describe('被守卫行为：projectDir 含 shell 元字符不产生额外命令', () => {
  it('projectDir 含 `" & echo ... > 哨兵` → 工具调用完成但哨兵缺席（argv 形态）', () => {
    rmSync(SENTINEL, { force: true });
    expect(existsSync(SENTINEL)).toBe(false);

    const r = callTool(injectionPayload('&'), 'org_status', { command: 'status' });

    // 哨兵缺席 = 没有第二条命令被执行（P0 断言）
    expect(existsSync(SENTINEL)).toBe(false);
    // 且恶意值被当作**数据**传递：脚本报错文本里出现该路径片段（而非被 shell 吃掉）
    expect(`${r.text}${r.raw}`).toContain('evil');
  });

  it('`&&` 与 `;` 两种连接符负载同样不产生哨兵', () => {
    for (const sep of ['&&', ';', '|']) {
      rmSync(SENTINEL, { force: true });
      callTool(injectionPayload(sep), 'org_status', { command: 'status' });
      expect(existsSync(SENTINEL)).toBe(false);
    }
  });

  it('工具**参数**位置同样不可注入（role 值含 & 载荷）', () => {
    rmSync(SENTINEL, { force: true });
    expect(existsSync(SENTINEL)).toBe(false);

    // 参数经 toArgvTokens 切分后仍是独立 token，从未进入 shell 语法
    callTool(join(TMP, 'ws'), 'org_status', {
      command: 'agent',
      role: `dev" & echo ${SENTINEL_TEXT}> "${SENTINEL}"`,
    });

    expect(existsSync(SENTINEL)).toBe(false);
  });
});

describe('形状校验：空值与 NUL 响亮拒绝（不静默回落 cwd）', () => {
  it('显式传空 projectDir → exit 1 且报错（旧实现静默回落 cwd）', () => {
    const r = spawnSync(
      'node',
      [join(TMP, 'scripts', '__driver.mjs'), 'org_status', '{}', ''],
      { encoding: 'utf-8', timeout: 60000 },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('--project-dir');
  });

  it('未提供 --project-dir 仍回落 cwd（合法路径不被误伤）', () => {
    // 回归保护：上面的响亮拒绝不能把「未传旗标」的正常 CLI 用法一起打死。
    // 经同一 driver 的 __NOFLAG__ 模式省略旗标，断言模块加载成功且工具正常执行。
    const r = callTool('__NOFLAG__', 'org_status', { command: 'status' });
    expect(r.raw).toContain('DRIVER_RESULT:');
  });
});
