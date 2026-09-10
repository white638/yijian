import { useRef, useState } from "react";
import { ArchiveRestore, Download } from "lucide-react";
import { api, send, downloadBackup, failure } from "../api";
import { useApp } from "../Store";
import { Button, ErrorText, Sheet } from "./UI";

interface Preview {
  preview_id: string;
  counts: Record<string, number>;
  duplicates: number;
  conflicts: { collection: string; id: string; name: string }[];
  requires_empty: false;
  expires_at: string | number;
}
const names: Record<string, string> = {
  items: "衣物",
  outfits: "穿搭",
  plans: "计划",
  wear_events: "穿着记录",
  care_events: "洗护记录",
  trips: "旅行清单",
};
export function Migration() {
  const { refresh, notify } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function inspect(file: File) {
    setBusy("preview");
    setError("");
    setPreview(null);
    try {
      const form = new FormData();
      form.append("file", file);
      setPreview(
        await api<Preview>("/migration/preview", {
          method: "POST",
          body: form,
        }),
      );
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function importBackup() {
    if (!preview || busy) return;
    setBusy("import");
    setError("");
    try {
      await send("/migration/import", { preview_id: preview.preview_id });
      await refresh();
      setPreview(null);
      notify("衣柜已导入，现有冲突记录已保留。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="settings-card stack">
      <h2>数据属于你</h2>
      <p className="muted">
        用完整备份在在线版与本机版之间转移衣物、照片和记录。账户密码和模型密钥需在目标网站重新配置。
      </p>
      <Button
        kind="secondary"
        busy={busy === "export"}
        disabled={!!busy}
        onClick={async () => {
          setBusy("export");
          setError("");
          try {
            await downloadBackup();
            notify("备份已准备下载。");
          } catch (e) {
            setError(failure(e));
          } finally {
            setBusy("");
          }
        }}
      >
        <Download size={18} />
        下载衣柜备份
      </Button>
      <Button
        kind="secondary"
        busy={busy === "preview"}
        disabled={!!busy}
        onClick={() => input.current?.click()}
      >
        <ArchiveRestore size={18} />
        导入已有衣柜
      </Button>
      <input
        ref={input}
        hidden
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void inspect(file);
          e.target.value = "";
        }}
      />
      <p className="small muted">
        先预览导入内容，再确认写入。重复记录会跳过，冲突项保留当前衣柜的版本。
      </p>
      {!preview && <ErrorText error={error} />}
      {preview && (
        <Sheet
          title="确认导入衣柜"
          onClose={() => {
            if (!busy) {
              setPreview(null);
              setError("");
            }
          }}
          busy={!!busy}
        >
          <div className="stack">
            <p>以下内容将导入你在 {location.host} 的当前账户。</p>
            <div className="migration-counts">
              {Object.entries(names).map(([key, label]) => (
                <div key={key}>
                  <strong>{preview.counts[key] || 0}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            {!!preview.duplicates && (
              <p className="small muted">
                {preview.duplicates} 条重复记录会跳过。
              </p>
            )}
            {!!preview.conflicts.length && (
              <div className="soft-panel">
                <strong>{preview.conflicts.length} 条记录存在差异</strong>
                <p className="small muted">保留当前衣柜的内容，不覆盖。</p>
                <ul className="migration-conflicts">
                  {preview.conflicts.map((c) => (
                    <li key={`${c.collection}-${c.id}`}>
                      {names[c.collection] || "记录"} · {c.name || "未命名"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="small muted">
              历史分享与建议作为记录保留。原网站的有效分享链接仍需在原网站管理。
            </p>
            <ErrorText error={error} />
            <Button
              busy={busy === "import"}
              disabled={!!busy}
              onClick={importBackup}
            >
              确认导入
            </Button>
            <Button
              kind="ghost"
              disabled={!!busy}
              onClick={() => {
                setPreview(null);
                setError("");
              }}
            >
              取消
            </Button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
