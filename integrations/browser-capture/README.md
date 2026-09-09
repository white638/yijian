# 衣间 · 商品图片采集

适用于桌面 Chrome / Edge。用户在商品页主动采集当前可见的大图，选择一张后复制到衣间。图片来自浏览器当前显示的画面，适合需要登录或动态加载的商品页。

## 安装

1. 下载衣间项目并解压，找到 `integrations/browser-capture` 文件夹。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 打开“开发者模式”，选择“加载已解压的扩展程序”，选择上述文件夹。
4. 在浏览器扩展菜单中固定“衣间 · 商品图片采集”。

## 使用

1. 在浏览器中打开商品页，按网站要求自行登录，选择想要的款式，让商品大图完整显示在当前窗口内。
2. 点击衣间扩展，再点“采集当前可见图片”。先关闭遮挡图片的弹窗或浮层。
3. 核对候选图片，选择一张，点击“复制到衣间”。
4. 回到衣间，打开“添加衣物 → 从链接导入”，点击“粘贴”或在输入框中粘贴，然后点击“解析链接”。
5. 选择预览图片，确认去背景与识别选项，导入并核对衣物信息。

刷新扩展代码后，在扩展管理页点击重新加载即可使用更新。

## 范围与数据

- 只在点击时读取当前标签页中可见的大型图片矩形、页面标题和地址。截图在扩展内存中裁切，复制内容只含所选图片和来源信息；关闭弹窗会释放采集状态。
- 请求权限为 `activeTab`、`scripting`、`clipboardWrite`。不读取 Cookie、账号存储、隐藏表单、其他标签页，也不向电商接口或衣间后台发送请求。
- 复制数据以 `YIJIAN_CAPTURE_V1` 开头，包含 JPEG 图片。图片最长边不超过 1280 像素，文件不超过 2 MiB。
- 来源地址仅保留商品路径及常见商品编号参数。图片质量取决于当前显示大小；只显示了一部分时也只采集可见部分。
- 只处理主页面内的普通图片元素。跨域内嵌页面、画布、背景图、视频及被遮挡图片可能不提供候选；可以保存图片或截图后上传。
- 手机浏览器、网站内置浏览器不在此扩展的支持范围。扩展不能代替登录，也不会处理验证码或保证所有网站的所有商品页面都可采集。

## API 依据

- [Chrome activeTab 临时权限](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome scripting 隔离执行环境](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome captureVisibleTab 可见区域截图](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)
- [Chrome 权限清单](https://developer.chrome.com/docs/extensions/reference/permissions-list)
