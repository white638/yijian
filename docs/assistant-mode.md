# 在 Codex 和 Claude Code 中使用衣间

衣间提供自包含的 skill 和 Claude Code 插件。助手读取衣橱内已有的照片，用当前会话的模型分析，再把标签或搭配保存回衣间。应用需保持运行，默认地址为 `http://127.0.0.1:3110`。

## 安装到 Codex 项目

在衣间仓库目录运行 Python 3.11 或更高版本：

```powershell
python scripts/install_assistant.py --project "C:/你的工作目录"
```

安装器将 skill 与完整 CLI 放到该项目的 `.agents/skills/yijian`。在 Codex 中打开这个项目，开始新会话，用 `$yijian` 调用。若目标已有不同内容，安装器会停止；核对后添加 `--replace`，原目录会保留为相邻备份。重复安装相同版本不会改写文件。

也可以通过 `--target "完整目标skill目录"` 选择用户级 skill 位置。以当前 [Codex skills 文档](https://developers.openai.com/codex/skills/)列出的搜索位置为准。无需把整个衣间仓库放进项目。

## 在 Claude Code 中加载插件

在衣间仓库目录启动：

```powershell
claude --plugin-dir ./integrations/yijian
```

在会话中调用 `/yijian:yijian`。插件根目录含 `.claude-plugin/plugin.json`，技能位于 `skills/yijian`。该命令仅为这次启动加载本地插件，格式参考 [Claude Code 插件文档](https://code.claude.com/docs/en/plugins)。

## 配对和使用

1. 在衣间的 AI 设置选择 Codex 或 Claude Code，保存设置并生成一次性连接码。
2. 对助手说“连接衣间，帮我识别待确认的衣物”，按隐藏提示输入连接码。自动化环境通过标准输入传入；不要把连接码写入命令参数或提交文件。
3. 助手读取衣物与照片，提交待确认的标签。在衣间中检查并确认后，即可让助手搭配并保存穿搭。

CLI 可以独立运行，路径是 `integrations/yijian/skills/yijian/scripts/yijian.py`：

```powershell
python integrations/yijian/skills/yijian/scripts/yijian.py connect
python integrations/yijian/skills/yijian/scripts/yijian.py status
python integrations/yijian/skills/yijian/scripts/yijian.py list --pending
```

识别结果默认保持待确认。`tag --confirm` 只用于用户已经明确认可的结果。`save-outfit` 保存搭配，不记录实际穿着；穿着次数由衣间中的“穿过了”记录增加。

连接码 5 分钟内有效且只能使用一次；CLI 授权有效期为 1 小时。过期后在衣间重新生成连接码。Windows 凭据由当前账户的 DPAPI 加密，POSIX 文件权限为 600。全局 `--cache-dir` 可选择缓存位置；缓存目录应放在项目之外。`disconnect` 或网页的断开连接会撤销所有宿主授权。

## 能力与数据范围

skill 使用当前宿主的模型与工具，遵循该宿主实际的额度和权限。衣间网页不会把 ChatGPT 或 Claude 的订阅变成可供后台调用的 API；宿主模式下，识别与建议在用户打开的宿主会话里执行。若宿主不支持查看本地图片，助手会说明限制，衣物仍可手动整理。

CLI 使用衣间的受授权接口，不读取数据库、后端密钥、浏览器 cookie 或宿主登录信息。它不会请求模型 API。照片只从用户明确连接的服务下载，保存建议时检查真实衣物编号、确认与可用状态。默认应用仅服务本机个人衣橱；自建远程服务需要用户明确指定可信 HTTPS 地址。
