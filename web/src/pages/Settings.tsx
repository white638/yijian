import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArchiveRestore,
  Download,
  Plus,
  Trash2,
  Wallet,
  Shirt,
  Sparkles,
} from "lucide-react";
import { api, send, downloadBackup, failure } from "../api";
import { useApp } from "../Store";
import {
  categories,
  itemName,
  money,
  costPerWear,
  translateValue,
  type Preferences,
} from "../types";
import {
  Button,
  Field,
  IconButton,
  SectionTitle,
  Garment,
  Empty,
  ErrorText,
} from "../components/UI";
import { AIConnect } from "../components/AIConnect";
import { ItemPicker } from "../components/Outfits";
export function Settings() {
  const { state, refresh, notify, navigate } = useApp();
  const [name, setName] = useState(state.settings.name);
  const [prefs, setPrefs] = useState<Preferences>(state.settings.preferences);
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const restoreInput = useRef<HTMLInputElement>(null);
  const closets = [...new Set(state.items.map((i) => i.closet))];
  async function save() {
    setBusy("preferences");
    setError("");
    try {
      await send(
        "/settings",
        { name: name.trim(), preferences: prefs },
        "PATCH",
      );
      await refresh();
      notify("偏好已保存。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function backup() {
    setBusy("backup");
    setError("");
    try {
      await downloadBackup();
      notify("备份已准备下载。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function restore(file: File) {
    if (!confirm("将备份内容导入当前空衣柜？照片和记录会一并恢复。")) return;
    setBusy("restore");
    setError("");
    try {
      const f = new FormData();
      f.append("file", file);
      await api("/restore", { method: "POST", body: f });
      await refresh();
      notify("衣柜已从备份恢复。");
      navigate("home");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  function addPair() {
    if (!pairA || !pairB || pairA === pairB) return;
    const ids = [pairA, pairB];
    if (
      !prefs.blocked_pairs.some((p) => p.includes(pairA) && p.includes(pairB))
    )
      setPrefs({ ...prefs, blocked_pairs: [...prefs.blocked_pairs, ids] });
    setPairA("");
    setPairB("");
  }
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div className="row">
          <IconButton label="返回首页" onClick={() => navigate("home")}>
            <ArrowLeft size={23} />
          </IconButton>
          <h1>个人设置</h1>
        </div>
      </div>
      <div className="settings-columns">
        <section className="settings-card" id="ai">
          <AIConnect />
        </section>
        <div className="stack">
          <section className="settings-card stack">
            <h2>穿搭推荐偏好</h2>
            <p className="muted">把你的习惯告诉衣柜，让建议更贴近生活。</p>
            <Field label="怎么称呼你">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="你的名字"
                maxLength={40}
              />
            </Field>
            <div className="form-grid">
              <Field label="所在城市">
                <input
                  value={prefs.location}
                  onChange={(e) =>
                    setPrefs({ ...prefs, location: e.target.value })
                  }
                  placeholder="例如：北京"
                />
              </Field>
              <Field label="参考气温（°C）" hint="用于推荐，可按当日情况调整。">
                <input
                  type="number"
                  min="-40"
                  max="55"
                  value={prefs.temperature}
                  onChange={(e) =>
                    setPrefs({ ...prefs, temperature: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <Field label="温度敏感度">
              <select
                value={prefs.sensitivity}
                onChange={(e) =>
                  setPrefs({ ...prefs, sensitivity: e.target.value })
                }
              >
                <option value="cold">比较怕冷</option>
                <option value="normal">恰到好处</option>
                <option value="hot">比较怕热</option>
              </select>
            </Field>
            <Field label="给造型师的备注">
              <textarea
                value={prefs.notes}
                onChange={(e) => setPrefs({ ...prefs, notes: e.target.value })}
                rows={3}
                maxLength={2000}
                placeholder="例如：喜欢宽松一点，工作日少穿亮色"
              />
            </Field>
            <Field label="用于建议的衣橱">
              <select
                value={prefs.closet_scope}
                onChange={(e) =>
                  setPrefs({ ...prefs, closet_scope: e.target.value })
                }
              >
                <option value="all">所有衣橱</option>
                {closets.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <details className="details">
              <summary>排除的衣物 · {prefs.excluded_ids.length} 件</summary>
              <p className="small muted">这些衣物仍会保留，推荐时暂时跳过。</p>
              <ItemPicker
                selected={prefs.excluded_ids}
                onChange={(ids) => setPrefs({ ...prefs, excluded_ids: ids })}
              />
            </details>
            <details className="details">
              <summary>不搭的组合 · {prefs.blocked_pairs.length} 组</summary>
              <div className="stack tight">
                <p className="small muted">选两件衣物，推荐时避开同时出现。</p>
                <div className="form-grid">
                  {[
                    [pairA, setPairA, "第一件"],
                    [pairB, setPairB, "第二件"],
                  ].map(([value, setter, label], index) => (
                    <Field label={label as string} key={index}>
                      <select
                        value={value as string}
                        onChange={(e) =>
                          (setter as (v: string) => void)(e.target.value)
                        }
                      >
                        <option value="">选择衣物</option>
                        {state.items.map((i) => (
                          <option value={i.id} key={i.id}>
                            {itemName(i)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
                <Button
                  kind="secondary"
                  disabled={!pairA || !pairB || pairA === pairB}
                  onClick={addPair}
                >
                  <Plus size={16} />
                  加入限制
                </Button>
                {prefs.blocked_pairs.map((pair, index) => (
                  <div className="row between small" key={pair.join("-")}>
                    <span>
                      {pair
                        .map((id) => {
                          const i = state.items.find((x) => x.id === id);
                          return i ? itemName(i) : "已删除衣物";
                        })
                        .join(" ＋ ")}
                    </span>
                    <IconButton
                      label="移除组合限制"
                      onClick={() =>
                        setPrefs({
                          ...prefs,
                          blocked_pairs: prefs.blocked_pairs.filter(
                            (_, n) => n !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </details>
            <Button
              busy={busy === "preferences"}
              disabled={!!busy}
              onClick={save}
            >
              保存我的偏好
            </Button>
          </section>
          <section className="settings-card stack">
            <h2>数据属于你</h2>
            <p className="muted">
              导出衣物、照片、搭配与记录。备份不包含模型密钥或助手授权。
            </p>
            <Button
              kind="secondary"
              busy={busy === "backup"}
              disabled={!!busy}
              onClick={backup}
            >
              <Download size={18} />
              下载衣柜备份
            </Button>
            <Button
              kind="secondary"
              busy={busy === "restore"}
              disabled={!!busy || state.items.length > 0}
              onClick={() => restoreInput.current?.click()}
            >
              <ArchiveRestore size={18} />
              从备份恢复
            </Button>
            <input
              ref={restoreInput}
              hidden
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) restore(f);
                e.target.value = "";
              }}
            />
            <small className="muted">
              恢复需使用空衣柜，支持兼容的衣柜备份。
            </small>
          </section>
          <ErrorText error={error} />
          <p className="small muted center">
            衣间 · 开放源码的个人衣柜
            <br />
            用已有衣物，穿出新的日常。
          </p>
        </div>
      </div>
    </div>
  );
}
export function Stats() {
  const { state, openItem, navigate } = useApp();
  const totals = state.insights;
  return (
    <div className="page stats-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">穿得更多，了解自己更多</p>
          <h1>我的衣柜洞察</h1>
        </div>
        <IconButton label="返回衣柜" onClick={() => navigate("wardrobe")}>
          <ArrowLeft size={22} />
        </IconButton>
      </div>
      <div className="stat-grid">
        {[
          [totals.total, "件衣物"],
          [totals.available, "件可以穿"],
          [state.wear_events.length, "次穿搭记录"],
          [totals.unworn, "件还没穿过"],
        ].map(([n, label]) => (
          <div key={label} className="stat-card">
            <strong>{n}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <section className="insight-note">
        <Sparkles size={22} />
        <div>
          <h3>让衣柜多一点新鲜感</h3>
          <p>
            {totals.unworn
              ? `你有 ${totals.unworn} 件衣物还没有穿着记录，可以试着用它们搭配。`
              : "继续记录穿着，慢慢发现最适合自己的衣物。"}
          </p>
        </div>
      </section>
      <div className="stats-columns">
        <section className="settings-card">
          <SectionTitle title="衣物构成" />
          {totals.categories.map((c) => (
            <div className="distribution-row" key={c.category}>
              <span>{categories[c.category] || c.category}</span>
              <div>
                <i
                  style={{
                    width: `${totals.total ? (c.count / totals.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <strong>{c.count}</strong>
            </div>
          ))}
        </section>
        <section className="settings-card">
          <SectionTitle title="衣柜的颜色" />
          {totals.colors.length ? (
            <div className="color-tags">
              {totals.colors.map((c) => (
                <span key={c.color}>
                  {translateValue(c.color)} <b>{c.count}</b>
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">给衣物标注颜色后，就能看到配色分布。</p>
          )}
        </section>
      </div>
      <section>
        <SectionTitle title="穿着里的价值" />
        <p className="muted small mb">
          不同币种分别统计，单次成本按实际穿着次数计算。
        </p>
        <div className="value-totals">
          {totals.costs.map((c) => (
            <div className="value-card" key={c.currency || "unknown"}>
              <Wallet size={23} />
              <strong>{money(c.total, c.currency)}</strong>
              <span>{c.priced_items} 件已记录价格的衣物</span>
            </div>
          ))}
        </div>
        {state.items.length ? (
          <div className="cost-list">
            {state.items
              .filter((i) => i.status !== "archived")
              .map((i) => (
                <button
                  key={i.id}
                  className="cost-row"
                  onClick={() => openItem(i.id)}
                >
                  <Garment item={i} />
                  <span>
                    <strong>{itemName(i)}</strong>
                    <small>
                      穿着 {i.wear_count} 次 ·{" "}
                      {i.price == null
                        ? "价格未填"
                        : money(i.price, i.currency)}
                    </small>
                  </span>
                  <span className="cost-value">
                    {costPerWear(i)}
                    <small>单次穿着成本</small>
                  </span>
                </button>
              ))}
          </div>
        ) : (
          <Empty
            title="每一次穿着，都值得记下来"
            description="添加衣物和购买信息，就能了解你的衣柜价值。"
          />
        )}
      </section>
      <section>
        <SectionTitle title="最常穿的伙伴" />
        <div className="recent-strip">
          {totals.most_worn.map((i) => (
            <button key={i.id} onClick={() => openItem(i.id)}>
              <Garment item={i} />
              <strong>{itemName(i)}</strong>
              <small>穿过 {i.wear_count} 次</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
