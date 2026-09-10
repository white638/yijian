# 在 Codex 和 Claude Code 中使用衣间

衣间的技能让助手读取衣橱照片，使用当前会话的模型分析，再把标签或搭配保存回衣间。应用需保持运行，默认地址为 `http://127.0.0.1:3110`。

## 从网页连接

1. 在衣间的 AI 设置中选择 Codex 或 Claude Code，点击“安装衣间技能”。网页会保存所选方式，将完整技能安装到当前系统用户的个人技能目录。
2. 复制页面给出的连接请求，发送给对应助手。若助手还没发现技能，重新打开会话后再试。
3. 助手发起配对后，衣间会显示短码。核对与助手给出的短码一致，点击确认。
4. 等待“已连接”：此时助手已经保存并重读凭据，成功访问衣柜。接着可以说“识别待确认的衣物”或“用我的衣服搭配一套通勤穿搭”。

短码用来核对本次请求，无法直接访问衣橱。配对请求五分钟内有效，授权有效期为一小时。到期后重新发起配对即可。“已连接”表示有经过验证、尚未过期的授权。在会话中使用技能时，需要打开对应助手。

Codex 的个人安装位置为 `~/.agents/skills/yijian`，Claude Code 为 `~/.claude/skills/yijian`。安装器检查文件内容，相同版本无需重复复制；更新时将原版本保存在技能搜索目录之外的 `.yijian-skill-backups` 中。目录规则参考 [Codex skills 文档](https://developers.openai.com/codex/skills/)和 [Claude Code skills 文档](https://code.claude.com/docs/en/skills)。

## 上传后自动识别

本机已安装并登录 Codex CLI、衣间显示已连接时，可在 AI 设置中开启“上传后用 Codex 自动识别”。开启后，网页上传照片会调用本机 Codex，将识别结果填入衣物表单；每批上传也可以关闭识别。结果等待核对，用户正在修改的字段会保留。

这条通道通过官方 `codex exec` 调用已登录的 Codex，使用该账号可用的额度，无需另填 API 密钥。衣间与 Codex 必须由同一系统用户运行。每次任务只附带一张衣物图片，在临时目录以只读模式执行，关闭搜索及相关扩展，并要求结构化输出；任务结束清理临时文件。调用方式见 [Codex 非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)。

自动识别任务串行执行，单次调用最长两分钟。关闭自动识别、切换服务或断开连接会取消待处理任务；授权过期后需要重新连接。登录失效、额度不足或识别失败时保留照片，界面提示重试或手动填写。

OpenAI、兼容接口与本地 Ollama 也支持同一套上传、自动填表和核对流程，在设置中填写支持图片输入的视觉模型。Ollama 服务与模型需要用户自行准备。Claude Code 的识别通过打开的助手会话执行。

## 用 Codex 美化商品图

在图片美化设置中选择 Codex，并保持主 AI 方式为 Codex、助手已连接。在衣物页面创建美化任务后，向 Codex 发送“处理待处理的图片美化任务”，也可以指定一条任务。更新功能后，先从 AI 设置重新安装衣间技能，让助手使用包含美化命令的版本。

当前 Codex 会话领取任务，读取任务固定的原图，使用内置生图编辑，再把生成图片回传。内置生图模型与额度由 Codex 提供，无需填写图片 API 密钥；额度说明见 [Codex 图片生成文档](https://developers.openai.com/codex/image-generation.md)。CLI 本身不调用模型。网页排队后显示等待处理，已连接状态不代表 Codex 会在后台自动监听。

美化以保留衣物或配饰的款式、颜色、图案和细节为前提，改善光线与背景。结果先作为预览返回，用户对比后决定是否采用，原图保留。图片生成可能改变细节，采用前应核对。任务处理期限最长十五分钟，并受当前一小时连接有效期限制；用户取消、原图变化或授权失效后，旧结果不能提交。

技能提供以下命令，其中任务编号必须使用 `beautify-list` 返回的 `job_id`：

```powershell
python integrations/yijian/skills/yijian/scripts/yijian.py beautify-list
python integrations/yijian/skills/yijian/scripts/yijian.py beautify-claim <任务编号>
python integrations/yijian/skills/yijian/scripts/yijian.py beautify-download <任务编号> --output <新的原图路径.jpg>
python integrations/yijian/skills/yijian/scripts/yijian.py beautify-submit <任务编号> --file <实际生成图片路径.png>
python integrations/yijian/skills/yijian/scripts/yijian.py beautify-fail <任务编号>
```

领取与下载之后，必须由助手实际查看原图并调用内置图片工具。上传支持 PNG、JPEG、WebP，最大 20 MiB。没有内置生图能力或无法取得生成文件时，助手说明失败；用户仍可选择在衣间配置自己的图片 API 服务。

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

模型、图片工具与额度由所选宿主或模型服务提供，遵循其套餐和权限。会话中的穿搭与整理使用技能；Codex 的上传自动识别由网页中的独立开关控制。宿主缺少图片查看能力时，衣物仍可手动整理。

CLI 使用衣间受授权接口，不读取数据库、后端密钥、浏览器 cookie 或宿主登录信息，也不请求模型 API。照片只从用户明确连接的服务下载。默认应用仅服务本机个人衣橱，自建远程服务需要用户明确指定可信 HTTPS 地址。
