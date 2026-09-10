import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, send, failure } from "../api";
import type { ImageBeautySettingsValue } from "../beautify";
import { Button, ErrorText, Field } from "./UI";
import "../image-beauty.css";

const MODELS = [
  ["gpt-image-2", "GPT Image 2"],
  ["gpt-image-2.5-flare", "GPT Image 2.5 Flare"],
  ["gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst"],
] as const;
const officialURL = "https://api.openai.com/v1";

export function ImageBeautySettings({
  initial,
  onSaved,
  onOpenAI,
  onBusyChange,
}: {
  initial?: ImageBeautySettingsValue;
  onSaved?: (value: ImageBeautySettingsValue) => void;
  onOpenAI?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [stored, setStored] = useState<ImageBeautySettingsValue | null>(
    initial || null,
  );
  const [enabled, setEnabled] = useState(initial?.enabled || false);
  const [provider, setProvider] = useState<"api" | "codex">(
    initial?.provider || "api",
  );
  const [baseURL, setBaseURL] = useState(initial?.base_url || officialURL);
  const [model, setModel] = useState(initial?.model || "gpt-image-2");
  const [custom, setCustom] = useState(
    !!initial?.model && !MODELS.some(([id]) => id === initial.model),
  );
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState(0);
  const sameEndpoint =
    stored?.provider === provider &&
    stored?.base_url.replace(/\/+$/, "") === baseURL.trim().replace(/\/+$/, "");
  const hasStoredKey = !!stored?.has_key && sameEndpoint && !clearKey;
  function fill(value: ImageBeautySettingsValue) {
    setStored(value);
    setEnabled(value.enabled);
    setProvider(value.provider);
    setBaseURL(value.base_url || officialURL);
    setModel(value.model || "gpt-image-2");
    setCustom(!!value.model && !MODELS.some(([id]) => id === value.model));
  }
  useEffect(() => {
    if (initial && retry === 0) {
      fill(initial);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<ImageBeautySettingsValue>("/beautify/settings", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) fill(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(failure(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [initial, retry]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || loading) return;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    setSaved(false);
    try {
      const value = await send<ImageBeautySettingsValue>(
        "/beautify/settings",
        {
          enabled,
          provider,
          base_url: provider === "api" ? baseURL.trim() : "",
          model: provider === "api" ? model.trim() : "",
          ...(provider === "api" && key.trim() ? { api_key: key.trim() } : {}),
          ...(clearKey ? { clear_key: true } : {}),
        },
        "PUT",
      );
      fill(value);
      setKey("");
      setClearKey(false);
      setSaved(true);
      onSaved?.(value);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="image-beauty-settings stack">
      <div className="row">
        <Sparkles size={20} aria-hidden="true" />
        <h2>图片美化</h2>
      </div>
      <p className="small muted">
        把衣物照片整理成干净的商品展示图。与衣物识别、穿搭模型分开配置，默认关闭。
      </p>
      {loading ? (
        <p className="small muted" role="status">
          正在读取美化设置…
        </p>
      ) : null}
      {!loading && !stored ? (
        <Button kind="secondary" onClick={() => setRetry((value) => value + 1)}>
          重新读取设置
        </Button>
      ) : null}
      {stored && (
        <form className="stack" onSubmit={save}>
          <fieldset className="beauty-fields stack" disabled={busy || loading}>
            <label className="check-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setSaved(false);
                }}
              />
              <span>
                启用图片美化<small>每次都由你主动生成并确认采用。</small>
              </span>
            </label>
            <div
              className="beauty-providers"
              role="group"
              aria-label="图片美化方式"
            >
              {[
                ["api", "图片模型接口"],
                ["codex", "Codex"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={provider === value}
                  onClick={() => {
                    setProvider(value as "api" | "codex");
                    setKey("");
                    setClearKey(false);
                    setSaved(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {provider === "api" ? (
              <>
                <Field label="图片模型接口地址">
                  <input
                    type="url"
                    value={baseURL}
                    required={enabled}
                    onChange={(e) => {
                      setBaseURL(e.target.value);
                      setSaved(false);
                    }}
                    placeholder={officialURL}
                    autoComplete="off"
                  />
                </Field>
                <Field label="图片模型">
                  <select
                    value={custom ? "custom" : model}
                    onChange={(e) => {
                      setCustom(e.target.value === "custom");
                      setModel(
                        e.target.value === "custom" ? "" : e.target.value,
                      );
                      setSaved(false);
                    }}
                  >
                    {MODELS.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                    <option value="custom">自定义模型</option>
                  </select>
                </Field>
                {custom && (
                  <Field label="自定义图片模型名称">
                    <input
                      value={model}
                      required={enabled}
                      autoComplete="off"
                      onChange={(e) => {
                        setModel(e.target.value);
                        setSaved(false);
                      }}
                      placeholder="填写服务商提供的图片编辑模型名称"
                    />
                  </Field>
                )}
                <Field
                  label="图片接口密钥"
                  hint={
                    hasStoredKey
                      ? "已保存密钥。留空可继续使用。"
                      : "使用你自己的密钥，保存后不会回显。"
                  }
                >
                  <input
                    type="password"
                    value={key}
                    autoComplete="off"
                    spellCheck={false}
                    required={enabled && !hasStoredKey}
                    onChange={(e) => {
                      setKey(e.target.value);
                      setSaved(false);
                    }}
                  />
                </Field>
                {stored.has_key && !sameEndpoint && (
                  <p className="small muted">
                    接口地址已变更，需要填写新接口的密钥。
                  </p>
                )}
                {stored.has_key && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(e) => {
                        setClearKey(e.target.checked);
                        setSaved(false);
                      }}
                    />
                    <span>清除已保存的图片接口密钥</span>
                  </label>
                )}
                <p className="small muted">
                  调用图片模型的费用由你的服务商账户承担。
                </p>
              </>
            ) : (
              <>
                <p className="small muted">
                  使用已连接的 Codex 和当前账号额度。创建任务后，在 Codex
                  会话中发送处理请求。
                </p>
                <Button
                  kind="ghost"
                  type="button"
                  onClick={() => {
                    if (onOpenAI) onOpenAI();
                    else
                      document
                        .getElementById("ai")
                        ?.scrollIntoView({ block: "start" });
                  }}
                >
                  查看 Codex 连接设置
                </Button>
              </>
            )}
            {stored.provider === provider && !stored.ready && stored.reason && (
              <p className="small muted">{stored.reason}</p>
            )}
            <Button type="submit" busy={busy}>
              保存美化设置
            </Button>
          </fieldset>
        </form>
      )}
      <ErrorText error={error} />
      {saved && (
        <p className="small status" role="status">
          图片美化设置已保存。
        </p>
      )}
    </div>
  );
}
