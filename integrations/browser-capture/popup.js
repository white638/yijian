import {
  capturePayload,
  collectVisibleImages,
  cropCandidate,
  dataBytes,
} from "./core.js";

export function mountPopup({
  chromeApi = chrome,
  root = document,
  clipboard = navigator.clipboard,
  crop = cropCandidate,
} = {}) {
  const capture = root.getElementById("capture");
  const copy = root.getElementById("copy");
  const choices = root.getElementById("choices");
  const status = root.getElementById("status");
  const error = root.getElementById("error");
  const title = root.getElementById("page-title");
  let busy = false,
    page = null,
    selected = null;
  function lock(value) {
    busy = value;
    capture.disabled = value;
    copy.disabled = value || !selected;
    for (const input of choices.querySelectorAll("input"))
      input.disabled = value;
  }
  capture.addEventListener("click", async () => {
    if (busy) return;
    selected = null;
    page = null;
    choices.replaceChildren();
    title.textContent = "";
    error.textContent = "";
    lock(true);
    status.textContent = "正在采集当前可见商品图…";
    try {
      const [tab] = await chromeApi.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id || !/^https?:\/\//.test(tab.url || ""))
        throw new Error("请打开商品网页后再采集，浏览器设置页无法采集。");
      const [result] = await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        func: collectVisibleImages,
        world: "ISOLATED",
      });
      page = result?.result;
      if (!page?.candidates?.length)
        throw new Error(
          "当前没有可采集的大图。请关闭页面浮层，让商品图完整显示后再试。",
        );
      const [current] = await chromeApi.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (current?.id !== tab.id || current.url !== tab.url)
        throw new Error("当前页面已改变，请重新采集。");
      const screenshot = await chromeApi.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 80,
      });
      if (dataBytes(screenshot) > 4 * 1024 * 1024)
        throw new Error("页面截图过大，请缩小浏览器窗口后重新采集。");
      const images = await Promise.all(
        page.candidates.map(async (candidate) => ({
          ...candidate,
          image: await crop(screenshot, candidate.rect, page.viewport),
        })),
      );
      title.textContent = page.title || "当前商品页";
      for (const candidate of images) {
        const label = root.createElement("label");
        const radio = root.createElement("input");
        const image = root.createElement("img");
        const caption = root.createElement("span");
        label.className = "candidate";
        radio.type = "radio";
        radio.name = "candidate";
        radio.value = candidate.id;
        image.src = candidate.image;
        image.alt = "";
        caption.textContent = `图片 ${candidate.id}`;
        radio.addEventListener("change", () => {
          if (busy) return;
          selected = candidate.image;
          copy.disabled = false;
          for (const row of choices.querySelectorAll("label"))
            row.classList.toggle("selected", row === label);
          status.textContent = "已选择图片，核对后复制到衣间。";
        });
        label.append(radio, image, caption);
        choices.append(label);
      }
      status.textContent = "选择一张图片。请确认画面中没有遮挡或无关内容。";
    } catch (e) {
      error.textContent =
        e instanceof Error && /[\u3400-\u9fff]/.test(e.message)
          ? e.message
          : "采集未完成，请刷新商品页并重新打开扩展。也可以保存截图后上传。";
      status.textContent = "";
    } finally {
      lock(false);
    }
  });
  copy.addEventListener("click", async () => {
    if (busy || !selected || !page) return;
    lock(true);
    error.textContent = "";
    try {
      await clipboard.writeText(capturePayload(page, selected));
      status.textContent = "已复制。回到衣间的“从链接导入”，粘贴后点击解析。";
    } catch {
      error.textContent = "复制失败，请再次点击复制，或保存商品截图后上传。";
    } finally {
      lock(false);
    }
  });
}
