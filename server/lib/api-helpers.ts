/**
 * 路由层小工具(去 Next 版)。认证已改为 Hono 中间件(见 middleware/auth.ts);
 * 这里只留与框架无关的请求体校验,供各路由复用。
 */

/**
 * 返回第一个缺失(null/undefined/空串)的必填字段名;全部就位返回 null。
 * 语义与原仓 validateBody 一致(仅把响应构造交回路由,避免耦合 NextResponse)。
 */
export function missingField(body: Record<string, unknown>, required: string[]): string | null {
  for (const field of required) {
    if (body[field] == null || body[field] === '') return field
  }
  return null
}
