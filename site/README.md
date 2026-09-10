# 衣间静态官网

此目录可以直接作为静态站点发布，无需安装 Node.js、React 或构建依赖。页面用于介绍 Windows 本机应用、链接使用文档与实际安装包，不提供账户或衣柜 API。

所有图标来自仓库 `web/public/icons/` 的原创 SVG。页面使用系统字体，不加载远程字体、分析脚本或第三方媒体，也不包含用户衣柜照片。

## 本地预览

在仓库根目录执行：

```sh
python -m http.server 3120 --bind 127.0.0.1 --directory site
```

打开 `http://127.0.0.1:3120/`。部署时将站点根目录设置为 `site`，不配置构建命令。

## 发布安装包后启用下载

修改 `release.js`：

- `published`：仅在安装文件已上传并核验可下载后改为 `true`。
- `version`：填写实际版本号。
- `windowsUrl`：填写本仓库 GitHub Releases 中完整的 `.exe` 文件地址。
- `sha256`：填写实际文件的 64 位 SHA-256 校验值；留空时不显示校验值。

脚本只接受 `https://github.com/white638/yijian/releases/download/` 下的 `.exe` 地址，不接受凭证、查询或 fragment。配置不完整或不合法时，保留 GitHub Releases 版本入口，不生成安装文件直链。禁用 JavaScript 时同样可以阅读页面和前往发布页。

更新下载信息时同时核对 README、`docs/desktop.md` 与该版本发布说明。Windows 系统兼容范围以实际测试为准。手机录入和跨设备自动同步属于后续方向，未作为已发布功能宣传。
