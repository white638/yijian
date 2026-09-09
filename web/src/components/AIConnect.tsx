import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, PlugZap } from "lucide-react";
import { FeatureIcon } from "./FeatureIcon";
import { api, send, failure } from "../api";
import { useApp } from "../Store";
import type { AISettings, Provider } from "../types";
import { Button, Field, ErrorText } from "./UI";
const names: Record<Provider, string> = {
  none: "暂不连接",
  openai: "OpenAI",
  compatible: "兼容接口",
  ollama: "Ollama",
  codex: "Codex",
  "claude-code": "Claude Code",
};
const urls: Record<Provider, string> = {
  none: "",
  openai: "https://api.openai.com/v1",
  compatible: "",
  ollama: "http://localhost:11434/v1",
  codex: "",
  "claude-code": "",
};
export function AIConnect({ onFinish }: { onFinish?: () => void }) {
  const { state, refresh, notify } = useApp();
  const current = state.ai;
  const [provider, setProvider] = useState<Provider>(
    current.provider === "none" ? "codex" : current.provider,
  );
  const [base, setBase] = useState(current.base_url || "");
  const [text, setText] = useState(current.text_model || "");
  const [vision, setVision] = useState(current.vision_model || "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    text: boolean;
    vision: boolean;
    message: string;
  } | null>(null);
  const [code, setCode] = useState<{ code: string; until: number } | null>(
    null,
  );
  const [seconds, setSeconds] = useState(0);
  const host = provider === "codex" || provider === "claude-code";
  const same = current.provider === provider && current.base_url === base;
  useEffect(() => {
    if (!code) return;
    const update = () =>
      setSeconds(Math.max(0, Math.ceil((code.until - Date.now()) / 1000)));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [code]);
  useEffect(() => {
    if (!host || !code) return;
    const t = setInterval(() => refresh().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [host, code]);
  function choose(p: Provider) {
    setProvider(p);
    setBase(urls[p]);
    setKey("");
    setClearKey(false);
    setVision("");
    setText("");
    setError("");
    setResult(null);
    setCode(null);
  }
  async function save() {
    const val = await send<AISettings>(
      "/ai/settings",
      {
        provider,
        base_url: host || provider === "none" ? "" : base.trim(),
        text_model: host ? "" : text.trim(),
        vision_model: host ? "" : vision.trim(),
        ...(key ? { api_key: key } : {}),
        ...(clearKey ? { clear_key: true } : {}),
      },
      "PUT",
    );
    setKey("");
    setClearKey(false);
    await refresh();
    return val;
  }
  async function run(action: "save" | "test" | "code" | "disconnect") {
    if (busy) return;
    setBusy(action);
    setError("");
    setResult(null);
    try {
      if (action === "disconnect") {
        await api("/ai/disconnect", { method: "POST" });
        setCode(null);
        await refresh();
        notify("助手连接已断开。");
      } else {
        await save();
        if (action === "test")
          setResult(await api("/ai/test", { method: "POST" }));
        else if (action === "code") {
          const c = await api<{ code: string; expires_in: number }>(
            "/ai/connection-code",
            { method: "POST" },
          );
          setCode({ code: c.code, until: Date.now() + c.expires_in * 1000 });
        } else {
          notify("AI 偏好已保存。");
          onFinish?.();
        }
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="ai-connect stack">
      <div className="row between">
        <FeatureIcon name="assistant" className="connect-illustration" />
        {onFinish && (
          <Button kind="ghost" disabled={!!busy} onClick={onFinish}>
            暂时跳过
          </Button>
        )}
      </div>
      <div>
        <h2>{onFinish ? "先连接你的 AI 助手" : "AI 连接"}</h2>
        <p className="muted">
          选择模型接口，或在熟悉的助手中使用衣柜。图片去背景已内置，无需单独配置模型。
        </p>
      </div>
      <div className="provider-grid">
        {(
          [
            "codex",
            "claude-code",
            "openai",
            "compatible",
            "ollama",
            "none",
          ] as Provider[]
        ).map((p) => (
          <button
            key={p}
            className={`provider ${provider === p ? "selected" : ""}`}
            aria-pressed={provider === p}
            onClick={() => choose(p)}
            disabled={!!busy}
          >
            {provider === p ? <Check size={17} /> : <PlugZap size={17} />}
            <span>{names[p]}</span>
          </button>
        ))}
      </div>
      {host ? (
        <div className="soft-panel stack">
          <h3>在 {names[provider]} 中使用衣柜</h3>
          {current.provider === provider && current.assistant_connected && (
            <p className="badge success" role="status">
              <Check size={15} />
              助手已连接
            </p>
          )}
          <p>
            衣物识别与搭配使用宿主本身的模型能力和额度，在助手中发起。网页仍可管理衣物、去背景和生成规则搭配。
          </p>
          <a
            className="link"
            href="https://github.com/white638/yijian/blob/main/docs/assistant-mode.md"
            target="_blank"
            rel="noreferrer"
          >
            查看技能安装说明 <ExternalLink size={15} />
          </a>
          <div className="command">
            {provider === "codex" ? "$yijian" : "/yijian:yijian"}
          </div>
          <p className="muted small">
            把本衣柜网址和连接码交给你要授权的助手。连接后，它可在 1
            小时内读取和更新衣柜；点击断开可立即撤销。
          </p>
          <Button
            kind="secondary"
            busy={busy === "code"}
            disabled={!!busy}
            onClick={() => run("code")}
          >
            保存并生成连接码
          </Button>
          {code &&
            (seconds > 0 ? (
              <div className="stack tight">
                <label className="field">
                  <span>一次性连接码</span>
                  <input value={code.code} readOnly />
                </label>
                <div className="row between">
                  <small role="timer">{seconds} 秒后过期</small>
                  <Button
                    kind="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(code.code);
                        notify("连接码已复制。");
                      } catch {
                        notify("请选中连接码手动复制。", "info");
                      }
                    }}
                  >
                    <Copy size={16} />
                    复制
                  </Button>
                </div>
              </div>
            ) : (
              <p className="muted">连接码已过期，可重新生成。</p>
            ))}
          <Button
            kind="ghost"
            disabled={!!busy}
            onClick={() => run("disconnect")}
          >
            断开所有助手连接
          </Button>
        </div>
      ) : provider !== "none" ? (
        <div className="stack">
          <Field
            label="接口地址"
            hint={
              provider === "ollama"
                ? "localhost 指运行衣柜的这台电脑；本地 Ollama 服务需由你自行运行。"
                : "填写服务商提供的 HTTPS 接口地址。"
            }
          >
            <input
              type="url"
              value={base}
              placeholder={urls[provider] || "https://你的服务/v1"}
              onChange={(e) => {
                setBase(e.target.value);
                setKey("");
                setResult(null);
              }}
            />
          </Field>
          <Field
            label="接口密钥"
            hint={
              same && current.has_key
                ? "已有密钥，留空保留。更换服务地址后不会沿用旧密钥。"
                : "密钥只保存在当前服务端。ChatGPT 订阅不包含 API 调用额度。"
            }
          >
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          {same && current.has_key && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={clearKey}
                onChange={(e) => setClearKey(e.target.checked)}
              />
              清除已保存的密钥
            </label>
          )}
          <div className="form-grid">
            <Field label="视觉模型" hint="用于识别衣物，可留空。">
              <input
                value={vision}
                placeholder="模型名称"
                onChange={(e) => setVision(e.target.value)}
              />
            </Field>
            <Field label="文本模型" hint="用于搭配和造型聊天，可留空。">
              <input
                value={text}
                placeholder="模型名称"
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
          </div>
          <p className="small muted">
            测试会发送简短文字和合成图片，服务商可能收取少量费用。
          </p>
          <Button
            kind="secondary"
            busy={busy === "test"}
            disabled={!!busy}
            onClick={() => run("test")}
          >
            保存并测试连接
          </Button>
          {result && (
            <div className="soft-panel" role="status">
              <p>
                文本：{result.text ? "测试通过" : "未通过或未配置"} · 视觉：
                {result.vision ? "测试通过" : "未通过或未配置"}
              </p>
              <p className="small muted">{result.message}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="soft-panel">
          可以先添加衣物、手动搭配、记录穿着，之后随时连接 AI。
        </p>
      )}
      <ErrorText error={error} />
      <Button
        busy={busy === "save"}
        disabled={!!busy}
        onClick={() => run("save")}
      >
        {onFinish ? "保存并开始" : "保存设置"}
      </Button>
      {onFinish && (
        <Button kind="ghost" disabled={!!busy} onClick={onFinish}>
          跳过，先逛逛衣柜
        </Button>
      )}
    </div>
  );
}
