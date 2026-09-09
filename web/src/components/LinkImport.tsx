import { useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ClipboardPaste, ImagePlus, Link2 } from "lucide-react";
import { failure, send } from "../api";
import { parseCapture, type BrowserCapture } from "../capture";
import { useApp } from "../Store";
import { money, type Item, type ReferencePrice } from "../types";
import { Button, ErrorText, Field, Sheet } from "./UI";
import "../link-import.css";

interface LinkPreview {
  preview_id: string;
  title: string;
  source_url: string;
  images: { id: string; url: string }[];
  reference_price?: ReferencePrice | null;
}

export function ImageImportOptions({
  removeBackground,
  onBackgroundChange,
  autoAnalyze,
  onAutoAnalyzeChange,
  busy,
  action = "上传",
}: {
  removeBackground: boolean;
  onBackgroundChange: (value: boolean) => void;
  autoAnalyze: boolean;
  onAutoAnalyzeChange: (value: boolean) => void;
  busy: boolean;
  action?: "上传" | "导入";
}) {
  const { state } = useApp();
  return (
    <div className="stack tight">
      <label className="check-row">
        <input
          type="checkbox"
          checked={removeBackground}
          disabled={busy}
          onChange={(e) => onBackgroundChange(e.target.checked)}
        />
        <span>
          自动去除照片背景<small>在本机处理；保留去背景前的照片。</small>
        </span>
      </label>
      {removeBackground && !state.features.background_removal_ready && (
        <p className="small muted">
          图片处理模块尚未准备好；{action}会保留原图，之后可重新去背景。
        </p>
      )}
      {state.ai.capabilities.vision && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={autoAnalyze}
            disabled={busy}
            onChange={(e) => onAutoAnalyzeChange(e.target.checked)}
          />
          <span>
            {action}后自动识别衣物信息
            <small>
              {state.ai.provider === "codex"
                ? "使用已连接的 Codex 识别，消耗当前账号额度。"
                : "使用已配置的视觉模型识别照片。"}{" "}
              结果会自动填入，保存前可核对。
            </small>
          </span>
        </label>
      )}
      <p className="small muted">
        {state.ai.capabilities.vision
          ? autoAnalyze
            ? "将自动识别名称、类别、颜色、季节、场合和标签；清晰可辨时填写品牌。"
            : "这次只添加照片，你可以手动填写或稍后重新识别。"
          : state.ai.provider === "codex"
            ? state.ai.automatic_vision?.reason ||
              "请在 AI 连接中完成 Codex 验证并开启上传自动识别；当前可先添加照片。"
            : state.ai.provider === "claude-code"
              ? "Claude Code 模式需要在助手中使用衣间技能识别照片；网页不会自动发起识别。"
              : state.ai.provider === "ollama"
                ? "请在 AI 连接中为 Ollama 配置支持图片的视觉模型；仅有文本模型无法识别照片。当前可先添加照片并手动填写。"
                : "尚未连接可用的视觉模型。可先添加照片，稍后连接 AI 或手动确认衣物信息。"}
      </p>
    </div>
  );
}

export function LinkImport({
  onClose,
  onBack,
}: {
  onClose: () => void;
  onBack: () => void;
}) {
  const { refresh, notify, openItem } = useApp();
  const [text, setText] = useState("");
  const [capture, setCapture] = useState<BrowserCapture | null>(null);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [busy, setBusy] = useState<"" | "paste" | "preview" | "import">("");
  const [error, setError] = useState("");
  const operation = useRef(false);
  function changeText(value: string) {
    setText("");
    setCapture(null);
    setPreview(null);
    setSelected("");
    setUnavailable([]);
    setError("");
    try {
      const captured = parseCapture(value);
      if (captured) setCapture(captured);
      else if (value.length > 8000)
        setError("分享文字过长，请只粘贴商品链接。");
      else setText(value);
    } catch (e) {
      setError(failure(e));
    }
  }
  async function paste() {
    if (operation.current) return;
    operation.current = true;
    setBusy("paste");
    setError("");
    try {
      if (!navigator.clipboard?.readText) throw new Error();
      const value = await navigator.clipboard.readText();
      if (!value.trim()) {
        setError("剪贴板中没有文字，请复制商品链接后再试。");
      } else {
        changeText(value);
      }
    } catch {
      setError("无法读取剪贴板，请在输入框中手动粘贴链接。");
    } finally {
      operation.current = false;
      setBusy("");
    }
  }
  async function parse(e: FormEvent) {
    e.preventDefault();
    if (operation.current || (!text.trim() && !capture)) return;
    operation.current = true;
    setBusy("preview");
    setError("");
    setPreview(null);
    setSelected("");
    setUnavailable([]);
    try {
      const result = capture
        ? await send<LinkPreview>("/import/capture", capture)
        : await send<LinkPreview>("/import/preview", { text: text.trim() });
      if (!result.images.length)
        throw new Error("这个页面没有找到可用图片，请改用相册上传商品截图。");
      setPreview(result);
    } catch (e) {
      setError(failure(e));
    } finally {
      operation.current = false;
      setBusy("");
    }
  }
  async function importItem() {
    if (
      operation.current ||
      !preview ||
      !selected ||
      unavailable.includes(selected)
    )
      return;
    operation.current = true;
    setBusy("import");
    setError("");
    try {
      const result = await send<{ items: Item[]; warnings: string[] }>(
        "/import/items",
        {
          preview_id: preview.preview_id,
          image_id: selected,
          remove_background: removeBackground,
          auto_analyze: autoAnalyze,
        },
      );
      await refresh();
      notify(
        result.warnings.length
          ? result.warnings.join("；")
          : "衣物已导入，请核对信息。",
        result.warnings.length ? "info" : "success",
      );
      onClose();
      if (result.items[0]) openItem(result.items[0].id);
    } catch (e) {
      setError(failure(e));
    } finally {
      operation.current = false;
      setBusy("");
    }
  }
  let source = "";
  try {
    source = preview ? new URL(preview.source_url).hostname : "";
  } catch {
    source = "";
  }
  return (
    <Sheet title="从链接导入" onClose={onClose} busy={!!busy}>
      <div className="stack link-import">
        <form className="stack" onSubmit={parse}>
          <Field
            label="商品页或图片链接"
            hint="可以粘贴商品链接、分享文字，或衣间浏览器扩展采集的图片。"
          >
            <textarea
              value={text}
              onChange={(e) => changeText(e.target.value)}
              onPaste={(e) => {
                const value = e.clipboardData.getData("text/plain");
                if (
                  value.startsWith("YIJIAN_CAPTURE_") ||
                  value.length > 8000
                ) {
                  e.preventDefault();
                  changeText(value);
                }
              }}
              placeholder="粘贴商品链接或分享文字"
              rows={3}
              maxLength={8000}
              disabled={!!busy}
              required={!capture}
            />
          </Field>
          <div className="row wrap">
            <Button
              type="button"
              kind="secondary"
              onClick={paste}
              disabled={!!busy}
              busy={busy === "paste"}
            >
              <ClipboardPaste size={16} />
              粘贴
            </Button>
            <Button
              type="submit"
              disabled={!!busy || (!text.trim() && !capture)}
              busy={busy === "preview"}
            >
              <Link2 size={16} />
              {busy === "preview" ? "正在解析…" : "解析链接"}
            </Button>
          </div>
          {capture && (
            <div className="soft-panel stack tight" role="status">
              <strong>{capture.title || "浏览器采集的衣物图片"}</strong>
              <p className="small muted">
                来源：{new URL(capture.source_url).hostname}
              </p>
              <p className="small muted">
                已接收 1 张采集图片，点击“解析链接”查看预览。
              </p>
              <Button
                type="button"
                kind="ghost"
                disabled={!!busy}
                onClick={() => changeText("")}
              >
                清除采集图片
              </Button>
            </div>
          )}
        </form>
        <p className="small muted">
          需要登录或动态加载的商品页，可使用衣间浏览器扩展采集当前可见图片，也可以保存图片或截图后从相册上传。
        </p>
        <details className="details">
          <summary>使用网页采集工具（Chrome / Edge）</summary>
          <div className="stack tight">
            <a
              className="button secondary"
              href="/api/import/capture-extension"
              download
            >
              下载网页采集工具
            </a>
            <p className="small muted">
              解压后，打开 Chrome / Edge
              的扩展管理页，启用开发者模式，加载解压文件夹。在商品页点击衣间扩展，采集并复制图片，再回来粘贴、解析。
            </p>
            <a
              className="text-button"
              href="https://github.com/white638/yijian/tree/main/integrations/browser-capture"
              target="_blank"
              rel="noreferrer"
            >
              查看详细安装说明
            </a>
          </div>
        </details>
        {preview && (
          <section className="stack" aria-label="解析结果">
            <div className="link-import__source">
              <h3>{preview.title || "链接中的图片"}</h3>
              {source && <p className="small muted">来源：{source}</p>}
            </div>
            {preview.reference_price && (
              <aside className="soft-panel stack tight" aria-label="参考价格">
                <div className="row wrap">
                  <span>参考价 · {preview.reference_price.label}</span>
                  <strong>
                    {money(
                      preview.reference_price.amount,
                      preview.reference_price.currency,
                    )}
                  </strong>
                </div>
                <p className="small muted">
                  {preview.reference_price.label === "发售价格"
                    ? "仅供参考，不代表实际支付金额。"
                    : "价格随款式与活动变化。"}
                </p>
              </aside>
            )}
            <fieldset className="link-import__images" disabled={!!busy}>
              <legend>选择一张衣物照片</legend>
              <div className="link-import__grid">
                {preview.images.map((image, index) => {
                  const failed = unavailable.includes(image.id);
                  return (
                    <label
                      className={`link-import__image ${selected === image.id ? "selected" : ""} ${failed ? "unavailable" : ""}`}
                      key={image.id}
                    >
                      <input
                        type="radio"
                        name="import-image"
                        checked={selected === image.id}
                        disabled={failed}
                        onChange={() => setSelected(image.id)}
                        value={image.id}
                      />
                      {failed ? (
                        <span className="link-import__placeholder">
                          <ImagePlus size={28} />
                          图片无法加载
                        </span>
                      ) : (
                        <img
                          src={`/api/import/preview/${encodeURIComponent(preview.preview_id)}/images/${encodeURIComponent(image.id)}`}
                          alt=""
                          onError={() => {
                            setUnavailable((ids) => [
                              ...new Set([...ids, image.id]),
                            ]);
                            setSelected((id) => (id === image.id ? "" : id));
                          }}
                        />
                      )}
                      <span>图片 {index + 1}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <ImageImportOptions
              removeBackground={removeBackground}
              onBackgroundChange={setRemoveBackground}
              autoAnalyze={autoAnalyze}
              onAutoAnalyzeChange={setAutoAnalyze}
              busy={!!busy}
              action="导入"
            />
            <p className="small muted">
              导入后核对名称、品牌和其他信息。预览有效期为 10 分钟。
            </p>
            <Button
              type="button"
              onClick={importItem}
              disabled={!!busy || !selected || unavailable.includes(selected)}
              busy={busy === "import"}
            >
              {busy === "import" ? "正在导入并处理…" : "导入这张照片"}
            </Button>
          </section>
        )}
        <ErrorText error={error} />
        <Button type="button" kind="ghost" disabled={!!busy} onClick={onBack}>
          <ArrowLeft size={16} />
          返回相册上传
        </Button>
      </div>
    </Sheet>
  );
}
