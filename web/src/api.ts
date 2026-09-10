const errors: Record<string, string> = {
  unauthorized: "连接已失效，请刷新页面重新连接。",
  invalid_item: "衣物信息不完整，请检查后重试。",
  not_found: "这条记录已不存在，请刷新页面。",
  invalid_endpoint: "请检查模型接口地址。",
  missing_api_key: "请填写此服务所需的接口密钥。",
  missing_model: "请至少填写一个模型名称。",
  authentication_failed: "密钥验证失败，请检查密钥和权限。",
  model_unavailable: "该模型不可用，请检查名称和权限。",
  connection_failed: "无法连接服务，请检查地址和网络。",
  timeout: "服务响应超时，请稍后重试。",
  rate_limited: "请求过于频繁或额度不足，请稍后重试。",
  assistant_mode: "请在 Codex 或 Claude Code 中运行衣间技能。",
  assistant_mode_required: "请先保存 Codex 或 Claude Code 模式。",
  restore_requires_empty: "请在空衣柜中恢复备份，避免覆盖现有数据。",
  invalid_backup: "备份文件无法读取，请选择衣间导出的完整备份。",
  invalid_settings: "请检查填写的设置。",
  private_endpoint_disabled: "此接口地址不允许访问，请检查服务地址。",
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确，请检查后重试。",
  USER_ALREADY_EXISTS: "此邮箱已有账户，请直接登录。",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "此邮箱已有账户，请直接登录。",
  PASSWORD_TOO_SHORT: "密码长度不足，请至少填写 12 个字符。",
  registration_closed: "此实例暂未开放注册。",
  invalid_invite: "邀请码无效，请核对后重试。",
  invite_required: "请填写邀请码。",
  preview_expired: "导入预览已过期，请重新选择备份文件。",
  share_expired: "分享链接已失效。",
  share_unavailable: "分享链接已失效。",
  replies_closed: "主人已关闭建议提交。",
};
export class RequestError extends Error {
  constructor(
    public code: string,
    public status: number,
    message?: string,
  ) {
    super(message || errors[code] || "操作未完成，请检查输入并重试。");
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const isForm = options.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(!isForm && options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error("暂时无法连接衣柜，请确认服务正在运行。");
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith("/auth/") &&
      !path.startsWith("/share/")
    )
      window.dispatchEvent(new Event("yijian:unauthorized"));
    const body = await response.json().catch(() => ({}));
    const d = body.detail;
    const code =
      typeof d === "string" ? d : d?.code || body.code || "request_failed";
    const message =
      typeof d === "string" && /[\u3400-\u9fff]/.test(d)
        ? d
        : typeof body.message === "string" &&
            /[\u3400-\u9fff]/.test(body.message)
          ? body.message
          : undefined;
    throw new RequestError(code, response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const send = <T>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, body: JSON.stringify(body) });
export const failure = (e: unknown) =>
  e instanceof Error ? e.message : "操作未完成，请稍后重试。";
export async function downloadBackup() {
  const r = await fetch("/api/backup", { credentials: "same-origin" });
  if (!r.ok) {
    if (r.status === 401)
      window.dispatchEvent(new Event("yijian:unauthorized"));
    throw new Error("备份下载失败，请重试。");
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `衣间备份-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
