/**
 * Tauri invoke 的窄接口。生产环境绑定 @tauri-apps/api 的 invoke,
 * 测试环境注入伪后端,从而在同一契约下验证命令名与参数边界。
 */
export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;
