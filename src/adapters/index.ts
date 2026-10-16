/**
 * Adapter 层 — 外部服务隔离（Q5 架构约束）。
 *
 * 所有外部依赖（文件系统、子进程、网络 fetch）经此层抽象，
 * 便于测试注入 mock，且防止业务逻辑直接耦合宿主 API。
 *
 * INV-25：配置单入口；INV-26：诊断域隔离。
 */

// ── 文件系统适配 ──────────────────────────────────────────────

export interface FsAdapter {
  readText(path: string): string | null;
  readDir(path: string): string[];
  exists(path: string): boolean;
  writeText(path: string, content: string): void;
}

// ── 子进程适配 ──────────────────────────────────────────────

export interface ExecAdapter {
  run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
}

// ── 网络/HTTP 适配 ──────────────────────────────────────────

export interface HttpAdapter {
  fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: <T>() => Promise<T>;
    text: () => Promise<string>;
  }>;
}

// ── 适配器集合 ──────────────────────────────────────────────

export interface Adapters {
  fs: FsAdapter;
  exec: ExecAdapter;
  http: HttpAdapter;
}

/**
 * 创建 Node.js 原生适配器（生产用）。
 * 测试时可注入 mock 实现。
 */
export function createNodeAdapters(): Adapters {
  return {
    fs: {
      readText: (p) => {
        try {
          return nodeFs.readFileSync(p, 'utf-8');
        } catch {
          return null;
        }
      },
      readDir: (p) => {
        try {
          return nodeFs.readdirSync(p);
        } catch {
          return [];
        }
      },
      exists: (p) => {
        try {
          nodeFs.accessSync(p);
          return true;
        } catch {
          return false;
        }
      },
      writeText: (p, c) => {
        nodeFs.writeFileSync(p, c, 'utf-8');
      },
    },
    // 方法语法（非箭头简写）：接口 ExecAdapter/HttpAdapter 声明的是**方法签名**，
    // 只有对象方法语法才触发上下文参数推断；箭头函数简写会让 cmd/args/opts 隐式 any
    // 且返回类型不参与检查（TS2322 + TS7006 ×6）。
    exec: {
      run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) {
        const result = nodeChild.spawnSync(cmd, args, {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          encoding: 'utf-8',
        });
        return {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          exitCode: result.status ?? -1,
        };
      },
    },
    http: {
      async fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) {
        const res = await nodeFetch(url, {
          method: opts?.method ?? 'GET',
          headers: opts?.headers,
          body: opts?.body,
        });
        return {
          ok: res.ok,
          status: res.status,
          // 接口声明 json 是泛型方法 <T>() => Promise<T>；非泛型实现返回 Promise<unknown>
          // 不满足（TS2322）。断言保留声明 API 的诚实性（调用方显式承担反序列化形状）。
          json: <T>() => res.json() as Promise<T>,
          text: () => res.text(),
        };
      },
    },
  };
}

// ── Node 内部导入（延迟绑定，便于测试 mock） ────────────────

import * as nodeFs from 'node:fs';
import * as nodeChild from 'node:child_process';
// fetch is global in Node 22+
const nodeFetch = globalThis.fetch;
