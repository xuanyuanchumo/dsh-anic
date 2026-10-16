/**
 * P0-8 回归守卫：CORS 来源策略。
 *
 * 被钉死的缺陷：`snapshotRoute.ts` 曾对**所有**响应无条件写
 * `Access-Control-Allow-Origin: '*'`，任何网页都能跨站读取本插件的响应体
 * （工作区绝对路径、账本、agent 卡提示词、信任分与自主级）。
 *
 * 关键论证（为什么去掉通配符不伤功能）：面板由宿主 Web 服务器**同源**提供，
 * 它 fetch `/anic/api/...` 不带 Origin、也不需要 CORS 头；桌面端走 `file://`+IPC
 * 不经此服务器。所以通配符的唯一受益者是外部页面。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isOriginAllowed,
  corsHeaders,
  originOf,
  originFromRes,
  envAllowedOrigins,
  setConfiguredOrigins,
  getConfiguredOrigins,
} from '../../src/host/cors.ts';

beforeEach(() => {
  setConfiguredOrigins([]);
  delete process.env.ANIC_ALLOWED_ORIGINS;
});

afterEach(() => {
  setConfiguredOrigins([]);
  delete process.env.ANIC_ALLOWED_ORIGINS;
});

describe('corsHeaders — 默认拒绝', () => {
  it('无 Origin（同源 / curl）→ 空对象，不发任何 CORS 头', () => {
    expect(corsHeaders(undefined)).toEqual({});
    expect(corsHeaders('')).toEqual({});
  });

  it('公网来源 → 空对象（跨站读取面关闭）', () => {
    expect(corsHeaders('https://evil.example.com')).toEqual({});
    expect(corsHeaders('http://attacker.test:8080')).toEqual({});
  });

  it('回环来源 → 回显**具体 Origin**，绝不回 `*`', () => {
    const h = corsHeaders('http://localhost:5173');
    expect(h['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(h['Access-Control-Allow-Origin']).not.toBe('*');
    expect(h['Vary']).toBe('Origin');
  });

  it('127.0.0.1 与 [::1] 任意端口都在默认允许集内', () => {
    expect(corsHeaders('http://127.0.0.1:19387')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:19387');
    expect(corsHeaders('http://127.0.0.1')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1');
    expect(corsHeaders('http://[::1]:8080')['Access-Control-Allow-Origin']).toBe('http://[::1]:8080');
    expect(corsHeaders('https://localhost:443')['Access-Control-Allow-Origin']).toBe('https://localhost:443');
  });

  it('伪装成回环的来源被拒（前缀/后缀混淆）', () => {
    // 正则锚定，不接受这些形态
    expect(corsHeaders('http://localhost.evil.com')).toEqual({});
    expect(corsHeaders('http://127.0.0.1.evil.com')).toEqual({});
    expect(corsHeaders('http://notlocalhost')).toEqual({});
    expect(corsHeaders('http://evil.com/?x=http://localhost')).toEqual({});
    expect(corsHeaders('file://')).toEqual({});
  });

  it('尾斜杠归一化后仍能匹配，但回显不带尾斜杠', () => {
    const h = corsHeaders('http://localhost:5173/');
    expect(h['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
  });
});

describe('corsHeaders — 显式放行', () => {
  it('注册期写入的允许集生效', () => {
    setConfiguredOrigins(['https://anic.example.com']);
    expect(getConfiguredOrigins()).toEqual(['https://anic.example.com']);
    expect(corsHeaders('https://anic.example.com')['Access-Control-Allow-Origin']).toBe('https://anic.example.com');
    expect(corsHeaders('https://other.example.com')).toEqual({});
  });

  it('环境变量 ANIC_ALLOWED_ORIGINS（逗号分隔）生效', () => {
    process.env.ANIC_ALLOWED_ORIGINS = 'https://a.example.com, https://b.example.com';
    expect(envAllowedOrigins()).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(corsHeaders('https://b.example.com')['Access-Control-Allow-Origin']).toBe('https://b.example.com');
  });

  it('配置里写 `*` **不**重新打开通配符（配置错误必须是安全的）', () => {
    setConfiguredOrigins(['*']);
    // 公网来源仍被拒
    expect(corsHeaders('https://evil.example.com')).toEqual({});
    // 回环仍按缺省策略放行
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
  });

  it('extra 参数覆盖注册期集合（显式传参优先）', () => {
    setConfiguredOrigins(['https://registered.example.com']);
    expect(corsHeaders('https://registered.example.com', [])['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders('http://localhost:1', ['https://x.example.com'])['Access-Control-Allow-Origin']).toBe('http://localhost:1');
  });
});

describe('isOriginAllowed', () => {
  it('undefined / 非字符串 / 空串 → false', () => {
    expect(isOriginAllowed(undefined)).toBe(false);
    expect(isOriginAllowed('')).toBe(false);
  });

  it('默认集是回环，不是「全部」', () => {
    expect(isOriginAllowed('http://localhost:8080')).toBe(true);
    expect(isOriginAllowed('https://github.com')).toBe(false);
  });
});

describe('originOf / originFromRes — 头提取', () => {
  it('大小写不敏感（Origin / origin / ORIGIN）', () => {
    expect(originOf({ Origin: 'http://a' })).toBe('http://a');
    expect(originOf({ origin: 'http://b' })).toBe('http://b');
    expect(originOf({ ORIGIN: 'http://c' })).toBe('http://c');
  });

  it('数组形态取首个字符串', () => {
    expect(originOf({ origin: ['http://a', 'http://b'] })).toBe('http://a');
  });

  it('缺失 / 空 headers → undefined', () => {
    expect(originOf(undefined)).toBe(undefined);
    expect(originOf({})).toBe(undefined);
    expect(originOf({ 'x-other': 'v' })).toBe(undefined);
  });

  it('originFromRes 经 res.req.headers 取值（sendJson 的实际路径）', () => {
    expect(originFromRes({ req: { headers: { origin: 'http://localhost:9' } } })).toBe('http://localhost:9');
    expect(originFromRes({ req: {} })).toBe(undefined);
    expect(originFromRes({})).toBe(undefined);
    expect(originFromRes(null)).toBe(undefined);
  });
});

describe('端到端：sendJson 的头组合', () => {
  it('同源请求（无 Origin）→ 无 CORS 头；回环 → 回显；公网 → 无 CORS 头', async () => {
    const { sendJson } = await import('../../src/host/snapshotRoute.ts');
    const mk = (origin?: string) => {
      const captured: { headers?: Record<string, string> } = {};
      const res = {
        writeHead: (_c: number, h: Record<string, string>) => { captured.headers = h; },
        end: () => {},
        ...(origin === undefined ? {} : { req: { headers: { origin } } }),
      };
      sendJson(res, 200, { ok: true });
      return captured.headers ?? {};
    };
    expect(mk()['Access-Control-Allow-Origin']).toBeUndefined();
    expect(mk('http://localhost:19387')['Access-Control-Allow-Origin']).toBe('http://localhost:19387');
    expect(mk('https://evil.example.com')['Access-Control-Allow-Origin']).toBeUndefined();
    // 任何情况下都不得出现通配符
    for (const o of [undefined, 'http://localhost:1', 'https://evil.example.com', 'http://localhost.evil.com']) {
      expect(mk(o)['Access-Control-Allow-Origin']).not.toBe('*');
    }
  });
});
