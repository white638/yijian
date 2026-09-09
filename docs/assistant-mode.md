# 在 Codex 和 Claude Code 中使用衣间

衣间的技能让助手读取衣橱照片，使用当前会话的模型分析，再把标签或搭配保存回衣间。应用需保持运行，默认地址为 `http://127.0.0.1:3110`。

## 从网页连接

1. 在衣间的 AI 设置中选择 Codex 或 Claude Code，点击“安装衣间技能”。网页会保存所选方式，将完整技能安装到当前系统用户的个人技能目录。
2. 复制页面给出的连接请求，发送给对应助手。若助手还没发现技能，重新打开会话后再试。
3. 助手发起配对后，衣间会显示短码。核对与助手给出的短码一致，点击确认。
4. 等待“已连接”：此时助手已经保存并重读凭据，成功访问衣柜。接着可以说“识别待确认的衣物”或“用我的衣服搭配一套通勤穿搭”。

短码用来核对本次请求，无法直接访问衣橱。配对请求五分钟内有效，授权有效期为一小时。到期后重新发起配对即可。“已连接”表示有经过验证、尚未过期的授权，宿主会话需要打开才能执行任务。

Codex 的个人安装位置为 `~/.agents/skills/yijian`，Claude Code 为 `~/.claude/skills/yijian`。安装器检查文件内容，相同版本无需重复复制；更新时将原版本保存在技能搜索目录之外的 `.yijian-skill-backups` 中。目录规则参考 [Codex skills 文档](https://developers.openai.com/codex/skills/)和 [Claude Code skills 文档](https://code.claude.com/docs/en/skills)。

## 终端与项目安装

需要项目专用技能时，在衣间仓库目录运行 Python 3.11 或更高版本：

```powershell
python scripts/install_assistant.py --project "C:/你的工作目录"
```

安装位置是该项目的 `.agents/skills/yijian`。也可以用 `--target "完整目标skill目录"` 指定其他技能目录。若目标已有不同内容，核对后加 `--replace`；原内容会备份，安装器会显示备份位置。

Claude Code 也支持在衣间仓库目录运行 `claude --plugin-dir ./integrations/yijian`，并通过 `/yijian:yijian` 调用这次启动加载的插件。格式见 [Claude Code 插件文档](https://code.claude.com/docs/en/plugins)。

完整 CLI 位于 `integrations/yijian/skills/yijian/scripts/yijian.py`：

```powershell
python integrations/yijian/skills/yijian/scripts/yijian.py connect --client codex
python integrations/yijian/skills/yijian/scripts/yijian.py status
python integrations/yijian/skills/yijian/scripts/yijian.py list --pending
```

Claude Code 配对将参数改为 `--client claude-code`。全局 `--server` 支持指定站点根地址或 `/api`。备用方式是在网页展开连接码，使用 `connect --code-stdin` 经隐藏输入或标准输入传入私密码；不能放入命令参数、日志或文件。

## 凭据与运行环境

Windows 使用当前系统账户的 DPAPI 加密凭据，POSIX 凭据文件权限为 600。连接前会测试写入与解密；保存后重新读取并访问衣柜，验证失败会撤销本次新授权。全局 `--cache-dir` 可选择仅自己可访问的缓存位置，应放在项目之外。

Windows 上连接和之后的读取必须由同一系统用户执行。Codex 的沙箱账户与宿主账户可能不同，因此技能要求所有 CLI 命令经宿主执行权限运行。无法取得该权限时，在当前用户终端执行相同命令。不要将加密凭据复制到另一系统账户。`disconnect` 撤销当前 CLI 的授权；网页断开连接会撤销所有助手授权与待配对请求。

## 能力与数据范围

识别结果默认保持待确认，`tag --confirm` 只用于用户已经认可的结果。`save-outfit` 保存搭配，实际穿着由衣间中的“穿过了”记录。保存时校验衣物编号、确认状态和可用性。

模型、图片工具与额度由当前宿主提供，遵循其套餐和权限。宿主模式的分析在用户打开的会话中执行；网页后台不会直接调用宿主订阅。宿主缺少图片查看工具时，衣物仍可手动整理。

CLI 使用衣间受授权接口，不读取数据库、后端密钥、浏览器 cookie 或宿主登录信息，也不请求模型 API。照片只从用户明确连接的服务下载。默认应用仅服务本机个人衣橱，自建远程服务需要用户明确指定可信 HTTPS 地址。
