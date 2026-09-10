(() => {
  const release = window.YIJIAN_RELEASE;
  if (!release?.published || !release.version || !release.windowsUrl) return;

  let url;
  try {
    url = new URL(release.windowsUrl);
  } catch {
    return;
  }
  if (
    url.origin !== "https://github.com" ||
    !url.pathname.startsWith("/white638/yijian/releases/download/") ||
    !url.pathname.toLowerCase().endsWith(".exe") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return;

  const link = document.getElementById("download-link");
  link.href = url.href;
  link.textContent = "下载 Windows x64 安装包 ↓";
  document.getElementById("release-status").textContent =
    `Windows x64 · ${release.version}`;
  document.getElementById("release-faq").textContent =
    `可以。Windows x64 ${release.version} 已发布，本站下载入口指向 GitHub Releases 的安装文件。系统要求和具体兼容范围请阅读该版本的发布说明。`;
  const detail = document.getElementById("release-detail");
  detail.textContent =
    "Windows 10 22H2 / Windows 11 x64。安装包未签名；缺少 WebView2 时首次安装需要联网。";
  if (/^[a-fA-F0-9]{64}$/.test(release.sha256 || "")) {
    const hash = document.createElement("code");
    hash.className = "release-hash";
    hash.textContent = `SHA-256: ${release.sha256.toLowerCase()}`;
    detail.append(document.createElement("br"), hash);
  }
})();
