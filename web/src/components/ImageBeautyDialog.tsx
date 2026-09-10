import { useEffect, useRef, useState } from "react";
import { Copy, RotateCcw, Settings2, Sparkles } from "lucide-react";
import { api, failure } from "../api";
import { useApp } from "../Store";
import type { Item } from "../types";
import {
  beautyPending,
  type ImageBeautyJob,
  type ImageBeautySettingsValue,
} from "../beautify";
import { Button, ErrorText, Sheet } from "./UI";
import { ImageBeautySettings } from "./ImageBeautySettings";
import { AIConnect } from "./AIConnect";
import "../image-beauty.css";

const codexRequest = "使用衣间技能处理待处理的图片美化任务。";
export function ImageBeautyDialog({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { refresh, notify } = useApp();
  const [settings, setSettings] = useState<ImageBeautySettingsValue | null>(
    null,
  );
  const [job, setJob] = useState<ImageBeautyJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollFailed, setPollFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [panel, setPanel] = useState<"preview" | "settings" | "connection">(
    "preview",
  );
  const [before, setBefore] = useState("source");
  const [copied, setCopied] = useState(false);
  const readVersion = useRef(0);
  const path = `/beautify/items/${encodeURIComponent(item.id)}`;
  const pending = beautyPending(job);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++readVersion.current;
    setLoading(true);
    setError("");
    setPollFailed(false);
    Promise.all([
      api<ImageBeautySettingsValue>("/beautify/settings", {
        signal: controller.signal,
      }),
      api<ImageBeautyJob>(path, { signal: controller.signal }),
    ])
      .then(([config, view]) => {
        if (controller.signal.aborted || readVersion.current !== version)
          return;
        setSettings(config);
        setJob(view);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(failure(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, reload]);
  useEffect(() => {
    if (!pending || busy || loading || pollFailed) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const version = readVersion.current;
    async function poll() {
      try {
        const next = await api<ImageBeautyJob>(path, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || readVersion.current !== version)
          return;
        setJob(next);
        if (beautyPending(next)) timer = setTimeout(poll, 2000);
        else await refresh();
      } catch (e) {
        if (!controller.signal.aborted && readVersion.current === version) {
          setError(failure(e));
          setPollFailed(true);
        }
      }
    }
    timer = setTimeout(poll, 2000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, job?.status, job?.job_id, busy, loading, pollFailed]);
  async function action(kind: "start" | "cancel" | "apply" | "restore") {
    if (busy) return;
    if (kind === "start" && (!settings?.enabled || !settings.ready || pending))
      return;
    if (kind === "apply" && (pending || !job?.preview_url || job.applied))
      return;
    ++readVersion.current;
    setBusy(kind);
    setError("");
    setCopied(false);
    setPollFailed(false);
    try {
      let next: ImageBeautyJob;
      if (kind === "restore") {
        await api(`/items/${encodeURIComponent(item.id)}/restore`, {
          method: "POST",
        });
        next = await api<ImageBeautyJob>(path);
      } else
        next = await api<ImageBeautyJob>(
          `${path}${kind === "start" ? "" : `/${kind}`}`,
          { method: "POST" },
        );
      setJob(next);
      if (kind === "apply" || kind === "restore" || !beautyPending(next))
        await refresh();
      if (kind === "apply") notify("已采用美化图，衣物信息保持不变。");
      if (kind === "restore") notify("已恢复原图。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function copyRequest() {
    setError("");
    try {
      await navigator.clipboard.writeText(codexRequest);
      setCopied(true);
    } catch {
      setError("无法复制，请手动复制下方请求并发送到 Codex。");
    }
  }
  const beforeOptions = [
    {
      value: "source",
      label: "处理前照片",
      url: job?.source_url || item.image_url || item.original_url,
    },
    ...(item.original_url && item.original_url !== job?.source_url
      ? [{ value: "original", label: "原始照片", url: item.original_url }]
      : []),
    ...(item.image_url && item.image_url !== job?.source_url
      ? [{ value: "current", label: "当前照片", url: item.image_url }]
      : []),
  ];
  const beforeImage =
    beforeOptions.find((option) => option.value === before) || beforeOptions[0];
  const provider = pending ? job?.provider : settings?.provider;
  return (
    <Sheet
      title="图片美化"
      onClose={() => {
        if (!busy && !settingsBusy) onClose();
      }}
      busy={!!busy || settingsBusy}
      wide
    >
      <div className="beauty-dialog stack">
        {panel === "settings" ? (
          <>
            <Button
              kind="ghost"
              disabled={settingsBusy}
              onClick={() => setPanel("preview")}
            >
              返回图片预览
            </Button>
            <ImageBeautySettings
              initial={settings || undefined}
              onSaved={(value) => setSettings(value)}
              onBusyChange={setSettingsBusy}
              onOpenAI={() => setPanel("connection")}
            />
          </>
        ) : panel === "connection" ? (
          <>
            <Button
              kind="ghost"
              onClick={() => {
                setPanel("settings");
                setReload((value) => value + 1);
              }}
            >
              返回美化设置
            </Button>
            <AIConnect />
          </>
        ) : (
          <>
            <p className="small muted">
              生成干净的衣物展示图。请核对颜色、图案和版型等细节，再决定采用。
            </p>
            {loading && (
              <p role="status" className="small muted">
                正在读取图片与设置…
              </p>
            )}
            {!loading && job && (
              <>
                <div className="beauty-comparison">
                  <figure>
                    <figcaption>
                      {beforeOptions.length > 1 ? (
                        <select
                          aria-label="对比照片"
                          value={beforeImage.value}
                          onChange={(e) => setBefore(e.target.value)}
                        >
                          {beforeOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        beforeImage.label
                      )}
                    </figcaption>
                    {beforeImage.url && (
                      <img src={beforeImage.url} alt={beforeImage.label} />
                    )}
                  </figure>
                  <figure>
                    <figcaption>美化预览</figcaption>
                    {job.preview_url ? (
                      <img src={job.preview_url} alt="美化预览" />
                    ) : (
                      <div className="beauty-empty">
                        <Sparkles size={30} />
                        <span>生成后在这里查看</span>
                      </div>
                    )}
                  </figure>
                </div>
                {(pending || busy === "start") && (
                  <p className="beauty-progress" role="status">
                    {busy === "start"
                      ? "正在创建美化任务…"
                      : job.status === "queued" && job.provider === "codex"
                        ? "待 Codex 处理"
                        : job.status === "queued"
                          ? "美化任务已排队…"
                          : "正在处理美化图片…"}
                  </p>
                )}
                {pending && job.provider === "api" && (
                  <p className="small muted">
                    已开始的图片接口请求可能仍会计费。
                  </p>
                )}
                {job.status === "queued" && job.provider === "codex" && (
                  <div className="soft-panel stack tight">
                    <p className="small">
                      复制下面的请求，发送到已连接的 Codex
                      会话。处理完成后回到这里查看预览。
                    </p>
                    <p className="beauty-copy-text">{codexRequest}</p>
                    <Button kind="secondary" onClick={copyRequest}>
                      <Copy size={16} />
                      {copied ? "已复制处理请求" : "复制给 Codex 的处理请求"}
                    </Button>
                  </div>
                )}
                {job.status === "failed" && (
                  <ErrorText
                    error={job.error || "图片美化未完成，可以重试。"}
                  />
                )}
                {job.status === "cancelled" && (
                  <p className="small muted" role="status">
                    美化任务已取消，照片保持不变。
                  </p>
                )}
                {job.applied && (
                  <p className="small status" role="status">
                    已采用这张美化图。
                  </p>
                )}
                {!settings?.enabled || !settings.ready ? (
                  <div className="soft-panel stack tight">
                    <p className="small">
                      {!settings?.enabled
                        ? "图片美化尚未启用。"
                        : settings.reason || "请先完成美化设置。"}
                    </p>
                    <Button
                      kind="secondary"
                      onClick={() => setPanel("settings")}
                    >
                      配置图片美化
                    </Button>
                  </div>
                ) : null}
                <div className="row wrap">
                  {!pending && (
                    <Button
                      disabled={!!busy || !settings?.enabled || !settings.ready}
                      busy={busy === "start"}
                      onClick={() => action("start")}
                    >
                      <Sparkles size={16} />
                      {provider === "codex"
                        ? "创建美化任务"
                        : job.preview_url
                          ? "重新生成预览"
                          : "生成美化预览"}
                    </Button>
                  )}
                  {pending && (
                    <Button
                      kind="secondary"
                      disabled={!!busy}
                      busy={busy === "cancel"}
                      onClick={() => action("cancel")}
                    >
                      取消任务
                    </Button>
                  )}
                  {!pending && job.preview_url && !job.applied && (
                    <Button
                      disabled={!!busy}
                      busy={busy === "apply"}
                      onClick={() => action("apply")}
                    >
                      采用美化图
                    </Button>
                  )}
                  {(job.applied || item.beautified_url) &&
                    item.original_url &&
                    !pending && (
                      <Button
                        kind="ghost"
                        disabled={!!busy}
                        busy={busy === "restore"}
                        onClick={() => action("restore")}
                      >
                        <RotateCcw size={16} />
                        恢复原图
                      </Button>
                    )}
                  <Button
                    kind="ghost"
                    disabled={!!busy}
                    onClick={() => setPanel("settings")}
                  >
                    <Settings2 size={16} />
                    美化设置
                  </Button>
                </div>
                <p className="small muted">
                  {settings?.provider === "codex"
                    ? "使用 Codex 当前账号额度，需在会话中主动发起处理。"
                    : "使用你配置的图片接口，费用由你的账户承担。"}{" "}
                  原图会保留，采用预览后可恢复。
                </p>
              </>
            )}
            {!loading && (!job || !settings || pollFailed) && (
              <Button
                kind="secondary"
                onClick={() => setReload((value) => value + 1)}
              >
                重新读取图片状态
              </Button>
            )}
          </>
        )}
        <ErrorText error={error} />
      </div>
    </Sheet>
  );
}
