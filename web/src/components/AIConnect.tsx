import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, PlugZap } from "lucide-react";
import { FeatureIcon } from "./FeatureIcon";
import { api, send, failure } from "../api";
import { useApp } from "../Store";
import type { AISettings, AssistantDeviceRequest, Provider } from "../types";
import { Button, Field, ErrorText } from "./UI";
import "../assistant-connect.css";
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
type AssistantProvider = "codex" | "claude-code";
function connectionTime(value?: number) {
  if (!value || !Number.isFinite(value)) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}
function verifiedConnection(settings: AISettings) {
  const connection = settings.assistant_connection;
  return Boolean(
    settings.assistant_connected &&
      connection?.status === "connected" &&
      connection.verified_at &&
      connection.expires_at &&
      connection.expires_at * 1000 > Date.now(),
  );
}
function AssistantConnection({
  provider,
  settings,
  save,
  busy,
  setBusy,
}: {
  provider: AssistantProvider;
  settings: AISettings;
  save: () => Promise<AISettings>;
  busy: string;
  setBusy: (value: string) => void;
}) {
  const { refresh, notify } = useApp();
  const [snapshot, setSnapshot] = useState(settings);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [requests, setRequests] = useState<AssistantDeviceRequest[]>([]);
  const [watching, setWatching] = useState(
    settings.provider !== provider || !verifiedConnection(settings),
  );
  const [pollVersion, setPollVersion] = useState(0);
  const [verificationBaseline, setVerificationBaseline] = useState<
    number | null
  >(null);
  const [targetRequest, setTargetRequest] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [copyFallback, setCopyFallback] = useState(false);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState<{ code: string; until: number } | null>(
    null,
  );
  const [seconds, setSeconds] = useState(0);
  const [, setClock] = useState(0);
  const refreshRef = useRef(refresh);
  const busyRef = useRef(busy);
  const snapshotRef = useRef(snapshot);
  const installVersion = useRef(0);
  refreshRef.current = refresh;
  busyRef.current = busy;
  snapshotRef.current = snapshot;
  const saved = settings.provider === provider;
  const verified =
    snapshot.provider === provider &&
    verifiedConnection(snapshot) &&
    (targetRequest
      ? snapshot.assistant_connection?.request_id === targetRequest
      : verificationBaseline === null ||
        snapshot.assistant_connection?.verified_at !== verificationBaseline);
  const connection = snapshot.assistant_connection;
  const automatic = snapshot.automatic_vision;
  const expired =
    connection?.expires_at && connection.expires_at * 1000 <= Date.now();
  const requestText = `使用衣间技能连接 ${location.origin}，发起配对，验证连接后读取衣物数量。`;

  useEffect(() => setSnapshot(settings), [settings]);
  useEffect(() => {
    if (!saved) return;
    const controller = new AbortController();
    const version = ++installVersion.current;
    api<{ installed: boolean }>(
      `/ai/assistant/installation?provider=${provider}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted && version === installVersion.current)
          setInstalled(result.installed);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [saved, provider]);
  useEffect(() => {
    if (!code) return;
    const update = () =>
      setSeconds(Math.max(0, Math.ceil((code.until - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [code]);
  useEffect(() => {
    if (!connection?.expires_at) return;
    const remaining = connection.expires_at * 1000 - Date.now();
    if (remaining <= 0 || !Number.isFinite(remaining)) return;
    const timer = setTimeout(() => {
      setClock((value) => value + 1);
      void refreshRef.current().catch(() => {});
    }, remaining + 50);
    return () => clearTimeout(timer);
  }, [connection?.expires_at]);
  useEffect(() => {
    if (!saved || !watching) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cycles = 0;
    let awaitingVerification =
      snapshotRef.current.assistant_connection?.status === "pending";
    async function poll() {
      let complete = false;
      try {
        if (document.hidden || busyRef.current) return;
        const result = await api<{ requests: AssistantDeviceRequest[] }>(
          "/ai/device/requests",
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!Array.isArray(result.requests))
          throw new Error("暂时无法读取连接请求，请稍后重试。");
        const active = result.requests.filter(
          (request) => request.expires_at * 1000 > Date.now(),
        );
        setRequests(active);
        const approved = active.find(
          (request) => request.status === "approved",
        );
        const requestedId = targetRequest || approved?.id;
        if (approved && !targetRequest) setTargetRequest(approved.id);
        awaitingVerification ||= Boolean(approved);
        if (awaitingVerification || cycles++ % 5 === 0) {
          const next = await api<AISettings>("/ai/settings", {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setSnapshot(next);
          awaitingVerification ||=
            next.assistant_connection?.status === "pending";
          const freshVerification = requestedId
            ? next.assistant_connection?.request_id === requestedId
            : verificationBaseline === null ||
              next.assistant_connection?.verified_at !== verificationBaseline;
          if (
            next.provider === provider &&
            verifiedConnection(next) &&
            freshVerification &&
            !active.some((request) => request.status === "pending")
          ) {
            complete = true;
            setWatching(false);
            setRequests([]);
            await refreshRef.current();
          }
        }
        setPollError("");
      } catch (e) {
        if (!controller.signal.aborted) setPollError(failure(e));
      } finally {
        if (!controller.signal.aborted && !complete)
          timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    saved,
    provider,
    watching,
    pollVersion,
    targetRequest,
    verificationBaseline,
  ]);

  async function ensureSaved() {
    if (saved) return settings;
    const next = await save();
    setSnapshot(next);
    return next;
  }
  function watch() {
    setWatching(true);
    setPollVersion((value) => value + 1);
  }
  async function run(
    action: "install" | "copy" | "code" | "disconnect" | "check",
  ) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      if (action === "disconnect") {
        await api("/ai/disconnect", { method: "POST" });
        setWatching(false);
        setRequests([]);
        setCode(null);
        setTargetRequest(null);
        setVerificationBaseline(null);
        setSnapshot({
          ...settings,
          assistant_connected: false,
          assistant_connection: { status: "disconnected" },
        });
        await refresh();
        notify("助手连接已断开。");
        return;
      }
      await ensureSaved();
      if (action === "install") {
        ++installVersion.current;
        const result = await send<{ installed: boolean }>(
          "/ai/assistant/install",
          { provider },
        );
        if (!result.installed) throw new Error("技能尚未安装完成，请重试。");
        setInstalled(true);
        notify(`衣间技能已安装到 ${names[provider]}。`);
      } else if (action === "copy") {
        setTargetRequest(null);
        setVerificationBaseline(
          snapshot.assistant_connection?.verified_at || 0,
        );
        try {
          await navigator.clipboard.writeText(requestText);
          setCopied(true);
          setCopyFallback(false);
          notify("连接请求已复制，请发送给助手。", "info");
        } catch {
          setCopyFallback(true);
          setCopied(false);
        }
        watch();
      } else if (action === "code") {
        const result = await api<{ code: string; expires_in: number }>(
          "/ai/connection-code",
          { method: "POST" },
        );
        setCode({
          code: result.code,
          until: Date.now() + result.expires_in * 1000,
        });
        setTargetRequest(null);
        setVerificationBaseline(
          snapshot.assistant_connection?.verified_at || 0,
        );
        watch();
      } else watch();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function decide(request: AssistantDeviceRequest, approve: boolean) {
    if (busy) return;
    setBusy(request.id);
    setError("");
    try {
      await api(
        `/ai/device/${encodeURIComponent(request.id)}${approve ? "/approve" : ""}`,
        { method: approve ? "POST" : "DELETE" },
      );
      setRequests((current) =>
        approve
          ? current.map((item) =>
              item.id === request.id ? { ...item, status: "approved" } : item,
            )
          : current.filter((item) => item.id !== request.id),
      );
      if (approve) {
        setTargetRequest(request.id);
        setVerificationBaseline(
          snapshot.assistant_connection?.verified_at || 0,
        );
        setSnapshot((current) => ({
          ...current,
          assistant_connected: false,
          assistant_connection: { status: "pending" },
        }));
      }
      watch();
    } catch (e) {
      setError(failure(e));
      watch();
    } finally {
      setBusy("");
    }
  }
  async function toggleAutomatic(enabled: boolean) {
    if (busy || !automatic?.supported || !verified) return;
    setBusy("automatic");
    setError("");
    try {
      const next = await send<AISettings>(
        "/ai/automatic-vision",
        { enabled },
        "PUT",
      );
      setSnapshot(next);
      await refresh();
      notify(
        next.automatic_vision?.enabled
          ? "上传后自动识别已开启。"
          : "上传后自动识别已关闭。",
      );
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="soft-panel assistant-connection">
      <div>
        <h3>在 {names[provider]} 中使用衣柜</h3>
        <p className="muted small">
          {provider === "codex" && automatic?.ready
            ? "上传后会自动用 Codex 识别衣物信息。需要搭配帮助时，可在 Codex 中使用衣间技能。"
            : provider === "codex"
              ? "完成连接后，可开启上传自动识别。也可以在 Codex 中使用衣间技能识别和搭配。"
              : "请在 Claude Code 中使用衣间技能识别和搭配。网页可以管理衣物、去背景和生成规则搭配。"}
        </p>
      </div>
      {verified && (
        <div className="assistant-verified" role="status">
          <div className="assistant-verified-title">
            <Check size={17} />
            已验证连接
          </div>
          <dl>
            <div>
              <dt>连接助手</dt>
              <dd>{connection?.client_name || names[provider]}</dd>
            </div>
            <div>
              <dt>授权到期</dt>
              <dd>{connectionTime(connection?.expires_at)}</dd>
            </div>
            <div>
              <dt>最近验证</dt>
              <dd>{connectionTime(connection?.verified_at)}</dd>
            </div>
          </dl>
          <small className="muted">此处显示最近一次验证结果。</small>
        </div>
      )}
      {provider === "codex" && (
        <div className="assistant-request">
          <label className="check-row">
            <input
              type="checkbox"
              role="switch"
              checked={Boolean(automatic?.enabled)}
              disabled={!!busy || !automatic?.supported || !verified}
              onChange={(e) => toggleAutomatic(e.target.checked)}
            />
            <span>上传后用 Codex 自动识别</span>
          </label>
          <p className="small muted">
            开启后，会将上传的衣物照片发送给
            Codex，并使用当前账号的模型额度。每次上传时仍可取消自动识别。
          </p>
          <p className="small muted" role="status">
            {busy === "automatic"
              ? "正在保存自动识别设置…"
              : automatic?.reason ||
                (!verified
                  ? "请先完成 Codex 连接并验证。"
                  : automatic?.ready
                    ? "已准备好，上传照片后会自动填写衣物信息。"
                    : "开启后可自动识别上传的衣物照片。")}
          </p>
        </div>
      )}
      <ol className="assistant-steps">
        <li className="assistant-step">
          <div className="assistant-step-content">
            <h4>安装衣间技能</h4>
            <Button
              kind="secondary"
              busy={busy === "install"}
              disabled={!!busy}
              onClick={() => run("install")}
            >
              {installed
                ? `重新安装到 ${names[provider]}`
                : `安装到 ${names[provider]}`}
            </Button>
            {installed && (
              <p className="small muted" role="status">
                衣间技能已安装。
              </p>
            )}
            <p className="small muted">
              若助手还没发现技能，重新打开会话后再试。
            </p>
          </div>
        </li>
        <li className="assistant-step">
          <div className="assistant-step-content">
            <h4>让助手发起连接</h4>
            <Button
              kind="secondary"
              busy={busy === "copy"}
              disabled={!!busy}
              onClick={() => run("copy")}
            >
              <Copy size={16} />
              复制给 {names[provider]} 的连接请求
            </Button>
            {copied && (
              <p className="small muted" role="status">
                已复制，请粘贴到 {names[provider]} 并发送。
              </p>
            )}
            {copyFallback && (
              <Field
                label="请手动复制连接请求"
                hint="复制未完成，请选中下面的文字复制。"
              >
                <textarea
                  className="assistant-copy-text"
                  readOnly
                  value={requestText}
                />
              </Field>
            )}
            <p className="small muted">
              助手发起配对后，回到这里核对短码并确认。
            </p>
          </div>
        </li>
        <li className="assistant-step">
          <div className="assistant-step-content">
            <h4>确认并验证连接</h4>
            {!verified && requests.length === 0 && (
              <p className="small muted" role="status">
                {targetRequest || connection?.status === "pending"
                  ? "助手尚未完成验证，请让助手继续连接。"
                  : expired
                    ? "授权已到期，请复制新的连接请求。"
                    : watching && saved
                      ? "等待助手发起连接…"
                      : "发送连接请求后，这里会显示待确认的助手。"}
              </p>
            )}
            {requests.map((request) => (
              <div className="assistant-request" key={request.id}>
                <p className="small">{request.client_name} 请求连接</p>
                <strong className="assistant-user-code">
                  {request.user_code}
                </strong>
                <small className="muted">
                  请核对助手显示的短码。到期时间：
                  {connectionTime(request.expires_at)}
                </small>
                {request.status === "approved" ? (
                  <p role="status">等待助手保存凭据并验证…</p>
                ) : (
                  <Button
                    disabled={!!busy}
                    busy={busy === request.id}
                    onClick={() => decide(request, true)}
                    aria-label={`确认连接 ${names[provider]}，短码 ${request.user_code}`}
                  >
                    确认连接 {names[provider]}
                  </Button>
                )}
                <Button
                  kind="ghost"
                  disabled={!!busy}
                  onClick={() => decide(request, false)}
                >
                  {request.status === "approved"
                    ? "撤销此次确认"
                    : "拒绝此次连接"}
                </Button>
              </div>
            ))}
            <p className="small muted">
              确认后，助手可在 1 小时内读取和更新当前衣柜；点击断开可立即撤销。
            </p>
            <ErrorText error={pollError} />
            {(!watching || pollError) && (
              <Button
                kind="ghost"
                disabled={!!busy}
                onClick={() => run("check")}
              >
                检查连接请求
              </Button>
            )}
          </div>
        </li>
      </ol>
      {(snapshot.assistant_connected ||
        targetRequest ||
        connection?.status === "pending" ||
        requests.length > 0) && (
        <Button
          kind="ghost"
          disabled={!!busy}
          onClick={() => run("disconnect")}
        >
          断开所有助手连接
        </Button>
      )}
      <details className="assistant-backup">
        <summary>备用安装与连接方式</summary>
        <div className="stack tight">
          <a
            className="link"
            href="https://github.com/white638/yijian/blob/main/docs/assistant-mode.md"
            target="_blank"
            rel="noreferrer"
          >
            查看技能安装说明 <ExternalLink size={15} />
          </a>
          <div className="command">
            {provider === "codex" ? "$yijian" : "/yijian"}
          </div>
          <Button
            kind="secondary"
            busy={busy === "code"}
            disabled={!!busy}
            onClick={() => run("code")}
          >
            生成备用连接码
          </Button>
          {code &&
            (seconds > 0 ? (
              <Field
                label="一次性连接码"
                hint={`${seconds} 秒后过期；仅交给你要授权的助手。`}
              >
                <input readOnly value={code.code} />
              </Field>
            ) : (
              <p className="small muted">连接码已过期，可重新生成。</p>
            ))}
        </div>
      </details>
      <ErrorText error={error} />
    </div>
  );
}
export function AIConnect({ onFinish }: { onFinish?: () => void }) {
  const { state, refresh, notify } = useApp();
  const [current, setCurrent] = useState(state.ai);
  useEffect(() => setCurrent(state.ai), [state.ai]);
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
  const host = provider === "codex" || provider === "claude-code";
  const same = current.provider === provider && current.base_url === base;
  function choose(p: Provider) {
    setProvider(p);
    setBase(urls[p]);
    setKey("");
    setClearKey(false);
    setVision("");
    setText("");
    setError("");
    setResult(null);
  }
  async function save() {
    if (host && current.provider === provider) return current;
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
    setCurrent(val);
    await refresh();
    return val;
  }
  async function run(action: "save" | "test") {
    if (busy) return;
    setBusy(action);
    setError("");
    setResult(null);
    try {
      await save();
      if (action === "test")
        setResult(await api("/ai/test", { method: "POST" }));
      else {
        notify("AI 偏好已保存。");
        onFinish?.();
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
        <AssistantConnection
          key={provider}
          provider={provider as AssistantProvider}
          settings={current}
          save={save}
          busy={busy}
          setBusy={setBusy}
        />
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
