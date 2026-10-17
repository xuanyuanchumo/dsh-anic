/**
 * JSON 候选提取（cycle-9 从 reviewEngine.ts 拆出，T3 模块纪律）。
 *
 * 为什么需要：宿主 LLM 不保证结构化输出（docs/anic spike host-llm-service.md
 * 三形态约束第一条）。真实模型经常在 JSON 外面包一层 ```json 围栏或前后缀散文；
 * 「整串必须是 JSON」的严格形态在真机上几乎不可用。闭合协议的实质是
 * **校验闭合**（extracted 对象必须过 validateReviewJson 的闭合 schema），
 * 而不是苛责传输包裹。提取顺序：
 *   1. 整串严格 JSON.parse（最理想形态，零容忍成本）
 *   2. ```json ... ``` / ``` ... ``` 围栏块
 *   3. 首个花括号平衡子串（跳过字符串字面量里的括号）
 * 全部失败 → null（调用方 fail-closed doubt，行为不变）。
 */

/** 从模型原始输出提取首个合法 JSON 对象文本；提不出 → null。 */
export function extractJsonCandidate(raw: string): string | null {
  // 1. 整串即合法 JSON —— 最理想形态
  try {
    JSON.parse(raw);
    return raw;
  } catch { /* 继续提取 */ }

  // 2. Markdown 围栏块（```json 或裸 ```）
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(raw);
  if (fenced !== null && fenced[1] !== undefined) {
    const body = fenced[1].trim();
    try {
      JSON.parse(body);
      return body;
    } catch { /* 围栏内容也不是 JSON → 继续平衡扫描 */ }
  }

  // 3. 首个花括号平衡子串（字符串字面量内的括号不算）
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch { return null; }
      }
    }
  }
  return null;
}
