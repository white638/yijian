# 高级自托管实验：账号与迁移

本页面向具备服务器运维能力的开发者。衣间的主要交付形态是 [Windows 本机应用](desktop.md)；`online/` 保留账号隔离、私密分享、Node / Workers 部署及数据迁移的实验实现，均以 MIT 开源。部署者自行承担认证配置、存储、备份、资源费用和维护工作。

实验实现包含邀请注册、私密衣柜、手动穿搭与规则推荐、日历、穿着与洗护记录、旅行清单、备份及朋友分享。Node 与 Cloudflare Workers 共用业务代码和迁移格式，自托管注册默认关闭。普通用户请从桌面版开始，本页不提供官方账户服务入口。

邮箱验证、密码找回、账号自助删除、在线 AI 和本机助手连接尚未形成已验收的自托管发布能力。应以目标提交的实际配置、接口与测试为准；完整 AI 识别、去背景和 Codex 使用流程由 Python 本机版提供。

## 数据与权限

| 部署 | 账号与衣柜记录 | 私有照片 |
| --- | --- | --- |
| Node 自托管 | 数据目录内的 SQLite | 数据目录的 `objects/` |
| Cloudflare | D1 | 私有 R2 桶，经鉴权接口访问 |
| Python 本机版 | 原有 `.local/data` 或指定目录 | 原数据目录内的照片 |

衣柜、照片、备份预览和分享均关联所属账号。密码保存为密码哈希，会话通过 HttpOnly Cookie 传递。浏览器不把衣柜或会话凭证保存到 localStorage。退出后关闭私有界面，另一个账号登录时重新读取自己的数据。

分享仅包含问题、所选衣物名称、类别、品牌和独立图片快照。朋友持链接即可查看和回复；购买信息、私人备注和其他衣物保持私密。主人可以关闭回复、撤销链接、删除建议和整份分享。照片清除元数据；撤销阻止后续读取，已经由朋友保存的内容无法收回。

## Node 自托管

需要 Node.js 24.15+。从仓库根目录执行：

```sh
cd web
npm ci
npm run build:online
cd ../online
npm ci
```

设置以下运行环境变量，再执行 `npm start`：

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_ORIGIN` | 实际网站地址，例如 `https://closet.example.com`；本机可用 `http://127.0.0.1:3117` |
| `BETTER_AUTH_SECRET` | 独立随机认证密钥，至少 32 字符；重启时保持一致 |
| `REGISTRATION_MODE` | `closed`、`invite` 或 `open`；默认 `closed` |
| `INVITE_CODE` | 邀请注册必填，16 至 256 字符 |
| `YIJIAN_DATA_DIR` | 持久目录，默认相对于启动目录的 `.local/data` |
| `HOST` / `PORT` | 默认 `127.0.0.1` / `3117` |

配置示例见 [`online/.env.example`](../online/.env.example)。启动不自动读取该文件，可以由部署平台注入环境变量，或复制为 `.env` 后使用 `node --env-file=.env --import tsx src/node.ts`。密钥用密码管理器生成，不应写入 Git。

Node 启动时自动应用数据库迁移，并校验已应用迁移的内容摘要。后续结构变化使用新迁移文件。常驻服务由进程管理器或容器负责重启。

### Docker

将 `online/.env.example` 复制为 `online/.env`，填写独立随机值。在仓库根目录执行：

```sh
docker compose --env-file online/.env -f online/compose.yaml up --build -d
```

Compose 默认仅开放本机 `127.0.0.1:3117`，账号与照片保存在持久卷 `wardrobe`。服务器部署时配置 HTTPS 反向代理，将 `PUBLIC_ORIGIN` 改为实际网址。不要把数据卷当作构建缓存清理。

## Vercel 与 Cloudflare

需要自己的平台账号。当前认证和迁移实现按 **Workers 付费计划**的 CPU 与 D1 请求额度设计。代码免费开源，平台托管费用由部署者承担；没有使用 Workers 免费计划完成上线验收。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。

1. 在 Cloudflare 创建 D1 数据库和私有 R2 桶，将 `online/wrangler.jsonc` 的数据库编号和桶名改为自己的资源，保留 `DB` 与 `ASSETS` 绑定名。R2 不开启公开访问。
2. 设置最终前端网址为 `PUBLIC_ORIGIN`，初始注册模式用 `closed`。通过 Cloudflare Secret 配置 `BETTER_AUTH_SECRET`，邀请测试时再配置 `INVITE_CODE`。
3. 在 `online/` 执行 `npx wrangler d1 migrations apply DB --remote`，然后 `npx wrangler deploy`。给 Worker 配置 API 自定义域，例如 `api.closet.example.com`。示例默认关闭 `workers.dev`；如使用平台子域，需显式启用 `workers_dev`。
4. 将 [`deploy/vercel.json.example`](../deploy/vercel.json.example) 复制到仓库根目录的 `vercel.json`，将 API 转发地址改为实际 Worker 地址。Vercel 从仓库根目录构建，输出 `web/dist-online`。
5. 浏览器通过前端域名的 `/api/` 访问，Vercel 转发到 Worker，Cookie 保持同源。`PUBLIC_ORIGIN` 必须与浏览器网址完全一致，包括协议。不要把前端改为跨域请求 Worker。
6. 完成 HTTPS 后启用邀请注册，验证账号隔离、上传、完整备份、跨实例迁移、朋友回复及撤销。邮件验证与账号恢复接入后，再评估公开注册。

预览部署使用独立数据库、桶和认证密钥。生产数据库不绑定不受信任的 PR 预览。密钥通过平台 Secret 保存。示例中的占位地址与数据库编号不能直接部署。自托管用户不需要这些平台账号。

同源部署测试覆盖邀请账号、同源 Cookie、私有照片、账号隔离、朋友分享与撤销，以及包含照片的 ZIP 导出和导入。经 Vercel 转发的请求可能共用代理来源 IP，登录限流粒度与接近容量上限的云端并发负载仍需专项验证。

## 迁移与互通

在来源实例设置中导出 ZIP，在目标账号设置中选择“导入衣柜备份”。先查看新增、重复和冲突数量，再确认写入。衣物、照片、购买与参考价格、属性、穿搭画布、收藏、计划、穿着与洗护记录、旅行清单及普通偏好一并迁移。

- 相同编号和内容按重复处理；相同编号但内容不同，保留目标账号已有内容。同名照片内容不同会停止导入。
- 预览绑定当前账号，15 分钟有效。期间衣柜发生变化，需要重新预览。
- 重复提交同一导入请求不会重复创建记录。密码、会话、分享凭证和 AI 密钥不进入备份。
- 账号版之间保留分享问题、单品关系和建议，迁入后作为只读历史。新链接需重新创建，原站链接仍在原站管理。
- Python 本机版与账号版共用 `yijian-workspace` v1 核心格式。Python 恢复要求空衣柜，且不保存分享历史扩展；需要保留该历史时，迁至 Node 或 Workers 账号版。

当前通过主动导出、导入完成迁移，尚未提供后台增量同步。实例级灾难恢复还应在停写期间同时备份数据库和对象存储，并在隔离环境中验证恢复。

## 测试版容量

两种账号版使用共同容量规则，让接收的数据可以完整导出。超限时明确拒绝操作，不截断记录。

| 内容 | 上限 |
| --- | --- |
| 单品 / 衣柜总记录 | 200 件 / 1,000 条 |
| 衣柜文字信息 | 1 MiB |
| 单品照片 | 150 张、合计 16 MiB；单张 5 MiB |
| 分享 | 50 份；快照单品与建议合计 300 条 |
| 分享文字 / 快照图片 | 768 KiB / 16 MiB |
| 迁移 ZIP / 展开容量 / 清单 | 24 MiB / 24 MiB / 2 MiB |
| 待确认预览 | 每账号 3 份，15 分钟有效 |

上传时浏览器将照片转换为 JPEG，最长边 1600 像素。Worker 对文件处理与密码计算限制并发，繁忙时返回可重试提示。平台总资源额度由实例运营者监控；大容量和多人并发仍需真实云端压力测试。
