/**
 * 运行时配置读取(单用户自部署版,薄 env reader)。
 *
 * Reason: 抽离后不再读 admin app_settings / crypto / settings 注册表,配置全部来自 process.env。
 * 保持 getRuntimeSettings/getRuntimeSetting 签名不变,搬迁来的 pr 代码(model keys / PR_EMBEDDING_* 等)零改动。
 */
export async function getRuntimeSettings(
  _opts: { force?: boolean } = {},
): Promise<Record<string, string>> {
  const settings: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') settings[k] = v
  }
  return settings
}

export async function getRuntimeSetting(key: string): Promise<string> {
  const settings = await getRuntimeSettings()
  return settings[key] ?? ''
}
