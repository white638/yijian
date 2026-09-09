# 项目路线

## 第一阶段：个人衣柜

完成可在本机使用的完整流程：选择或跳过 AI 连接、照片与商品链接录入、去背景、自动识别与人工确认、搭配、穿着记录、成本统计和数据备份。支持 Codex 技能、模型 API 与已有本地视觉模型服务。

发布条件是核心流程可实际操作、数据可恢复、图片与模型处理失败可见、支持平台和真实验证范围明确。

## 第二阶段：公网版与穿搭社区

公网版是第二阶段的重点，提供产品介绍、演示、在线使用和用户互动。保留本地版，让用户选择本地保存或使用在线衣柜。

### 部署分工

| 服务 | 职责 |
| --- | --- |
| Vercel | 官网、使用教程、演示和 React 网页界面。 |
| Cloudflare Workers | 公网 API、账号会话、访问授权和社区操作。 |
| Cloudflare D1 | 用户、衣物、搭配、帖子、回复、举报和任务等关系表。 |
| Cloudflare R2 | 私密衣物照片与独立的公开展示图。 |
| Cloudflare Queues | 有限重试的异步任务及可选远端 AI 调用。 |

官网域名指向 Vercel，API 子域交由 Worker；Cloudflare 管理 DNS 时，Vercel 对应记录使用 DNS only。保留现有本机 FastAPI 版本，公网版新增 Worker 后端并复用界面与业务规则。

### 账号与在线衣柜

- 建立账号、登录会话和账号恢复，衣柜默认私密。
- 使用 D1 保存结构化关系表，照片放私有 R2 存储。
- 每条私密记录关联所属用户。Worker 从已验证的会话取得身份，统一校验衣物、图片、关联记录、任务、备份及导出的归属。D1 采用应用层授权，需要用跨账号访问测试防止漏检。
- 私密图片通过鉴权后短时访问；公开展示图与私密原图分开存储。
- 提供个人数据导出、删除和可验证的数据库／图片联合备份。

当前本机服务的 SQLite 工作区属于单个用户，浏览器与助手会话共享这份数据。公网版需要数据模型和权限体系的改造，部署前必须验证不同账号之间不能读取或修改彼此的内容。

D1 使用数据库约束、条件更新及原子批处理维护关系一致性。数据库、照片和队列之间通过明确状态与补偿任务协调；删除数据库行时必须同时处理对应图片。

### 穿搭求助与回应

社区第一版聚焦：发布穿搭求助、图文回复、标记有帮助、举报和管理员处理。发帖不要求调用 AI。

用户选择图片、填写场合与需求，预览后主动发布。公开内容生成独立展示副本，清除照片元数据；帖子只包含用户明确选择公开的内容。购买记录、私密备注及其他衣物仍留在个人衣柜中。

添加请求限流、上传容量限制和基础内容管理。删除帖子时同步处理展示图片和缓存；账号删除与备份保留周期在上线前明确告知用户。

### AI 与本机连接

云端 AI 配置按用户隔离并加密保存。自带密钥与平台提供额度分别展示；提供单用户预算、任务并发限制和平台费用上限。

Queues 可能重复投递。模型任务需有唯一编号和状态校验，避免重复调用收费模型；回写失败不能无条件重新发起推理。

Codex 与本地模型继续在用户电脑上运行。在线版通过可选的本机连接程序配对、提交用户授权的任务并取回结果。网站本身不能直接取得用户电脑的登录状态或模型额度。

现有 Python 去背景管线和 Codex CLI 保留在本机版。社区上线先支持图片上传与用户交流，云端图片处理需要单独的服务或执行环境，不直接把这些进程放入 Workers。

### 上线顺序与验收

1. 公布官网介绍、功能演示、安装与使用说明。
2. 在封闭测试中验证账号隔离、私密图片、上传队列、导出／删除及完整恢复。
3. 开放在线衣柜与基础求助／回复，配套举报、限流和管理员入口。
4. 根据真实使用情况扩展本机连接与跨设备同步体验。

验收需覆盖恶意访问他人记录、图片地址泄漏、异步任务归属、公开内容撤回、资源滥用和备份恢复。上线前按目标用户地区核验实际访问体验、平台容量限制与模型预算。

## 技术依据

- [OWASP 授权建议](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)：默认拒绝并逐请求检查权限。
- [Vercel Vite 部署](https://vercel.com/docs/frameworks/frontend/vite) 与 [Cloudflare DNS 配置](https://vercel.com/kb/guide/cloudflare-with-vercel)。
- [D1 数据库和批处理](https://developers.cloudflare.com/d1/worker-api/d1-database/)。
- [R2 Workers API](https://developers.cloudflare.com/r2/get-started/workers-api/) 与 [签名链接限制](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)。
- [Queues 投递保证](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)。
- [Workers Node.js 兼容性](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) 与 [运行限制](https://developers.cloudflare.com/workers/platform/limits/)。
