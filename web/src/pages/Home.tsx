import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bookmark,
  CalendarDays,
  Check,
  MapPin,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Sun,
} from "lucide-react";
import { useApp } from "../Store";
import { api, send, failure } from "../api";
import { FeatureIcon } from "../components/FeatureIcon";
import {
  type Outfit,
  type Suggestions,
  itemName,
  today,
  dateLabel,
  occasions,
  categories,
  type Category,
} from "../types";
import {
  Button,
  Collage,
  Garment,
  Empty,
  ErrorText,
  SectionTitle,
  IconButton,
} from "../components/UI";
export function Recommendations({
  lockedIds = [],
  compact = false,
}: {
  lockedIds?: string[];
  compact?: boolean;
}) {
  const { state, refresh, notify, openPlan, navigate } = useApp();
  const [temp, setTemp] = useState(state.settings.preferences.temperature);
  const [occasion, setOccasion] = useState("casual");
  const [seed, setSeed] = useState(0);
  const [result, setResult] = useState<Suggestions | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const eligible = state.items.filter(
    (i) => i.confirmed && i.status === "available",
  ).length;
  const host = ["codex", "claude-code"].includes(state.ai.provider);
  async function generate(ai = false) {
    if (busy) return;
    setBusy(ai ? "ai" : "rules");
    setError("");
    try {
      const next = await send<Suggestions>(
        ai ? "/ai/recommend" : "/recommendations",
        {
          temperature: temp,
          occasion,
          locked_ids: lockedIds,
          excluded_ids: state.settings.preferences.excluded_ids,
          seed,
        },
      );
      setResult(next);
      setSeed(seed + 1);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    if (eligible > 0 && !compact) void generate();
  }, [eligible]);
  async function useOutfit(index: number, action: "save" | "wear") {
    const o = result?.outfits[index];
    if (!o || busy) return;
    setBusy(`${action}-${index}`);
    setError("");
    try {
      if (action === "save") {
        const saved = state.outfits.find(
          (s) =>
            s.item_ids.length === o.item_ids.length &&
            s.item_ids.every((id) => o.item_ids.includes(id)),
        );
        if (!saved) {
          await send<Outfit>("/outfits", {
            name: o.name,
            item_ids: o.item_ids,
            notes: o.reason,
            source: o.source,
          });
          await refresh();
        }
        notify("已收进我的穿搭。");
      } else {
        const key = `${o.item_ids.slice().sort().join(",")}-${today()}`;
        let id = requestIds.current.get(key);
        if (!id) {
          id = crypto.randomUUID();
          requestIds.current.set(key, id);
        }
        await send("/wear", {
          item_ids: o.item_ids,
          date: today(),
          request_id: id,
        });
        await refresh();
        notify("今天的穿着已记录。");
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="recommend-section">
      <div className="section-title">
        <h2>{compact ? "围绕这件，试试新组合" : "今天穿什么"}</h2>
        <IconButton label="穿搭推荐设置" onClick={() => navigate("settings")}>
          <Settings2 size={20} />
        </IconButton>
      </div>
      <div className="recommend-controls">
        <label className="weather-chip">
          <Sun size={15} />
          <input
            aria-label="搭配参考气温"
            type="number"
            min="-40"
            max="55"
            value={temp}
            onChange={(e) => setTemp(Number(e.target.value))}
          />
          °C<span>参考气温</span>
        </label>
        <label className="chip">
          <select
            aria-label="搭配场合"
            value={occasion}
            onChange={(e) => setOccasion(e.target.value)}
          >
            {Object.entries(occasions).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {state.settings.preferences.location && (
          <span className="chip">
            <MapPin size={14} />
            {state.settings.preferences.location}
          </span>
        )}
      </div>
      {result?.outfits.length ? (
        <div className="recommend-carousel">
          {result.outfits.map((o, index) => (
            <article
              className="recommend-card"
              key={`${o.item_ids.join("-")}-${index}`}
            >
              <Collage ids={o.item_ids} items={state.items} />
              <div className="recommend-caption">
                <span className="tiny-label">
                  {o.source === "ai" ? "AI 搭配" : "衣柜里的新组合"}
                </span>
                <h3>{o.name}</h3>
                <p>{o.reason}</p>
                <div className="row outfit-actions">
                  <IconButton
                    label={`保存${o.name}`}
                    onClick={() => useOutfit(index, "save")}
                    disabled={!!busy}
                  >
                    <Bookmark size={20} />
                  </IconButton>
                  <IconButton
                    label={`安排${o.name}`}
                    onClick={() => openPlan(o.item_ids, o.name)}
                    disabled={!!busy}
                  >
                    <CalendarDays size={20} />
                  </IconButton>
                  <Button
                    kind="ghost"
                    disabled={!!busy}
                    onClick={() => useOutfit(index, "wear")}
                  >
                    <Check size={16} />
                    今天穿
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="recommend-empty">
          <FeatureIcon name="outfit" className="recommend-illustration" />
          <h3>
            {eligible ? "准备好，发现新组合" : "好穿的搭配，从自己的衣柜开始"}
          </h3>
          <p>
            {result?.message ||
              (eligible
                ? "选择气温与场合，搭配你已经拥有的衣物。"
                : "添加并确认几件上装、下装和鞋履，就能开始。")}
          </p>
          {!!result?.missing.length && (
            <small>
              {result.missing
                .map((c) => categories[c as Category] || c)
                .join("、")}
            </small>
          )}
        </div>
      )}
      <ErrorText error={error} />
      <div className="row wrap recommendation-buttons">
        <Button
          kind="secondary"
          disabled={!!busy || !eligible}
          busy={busy === "rules"}
          onClick={() => generate()}
        >
          <RefreshCw size={16} />
          {result?.outfits.length ? "换一组搭配" : "获取穿搭建议"}
        </Button>
        {state.ai.capabilities.text ? (
          <Button
            disabled={!!busy || !eligible}
            busy={busy === "ai"}
            onClick={() => generate(true)}
          >
            <Sparkles size={16} />让 AI 来搭配
          </Button>
        ) : (
          <button className="text-button" onClick={() => navigate("settings")}>
            {host
              ? `在 ${state.ai.provider === "codex" ? "Codex" : "Claude Code"} 中搭配`
              : "连接 AI 助手"}
            <ArrowRight size={14} />
          </button>
        )}
      </div>
    </section>
  );
}
export function Home() {
  const { state, openAdd, openItem, openOutfit, openPlan, navigate } = useApp();
  const todayPlans = state.plans.filter((p) => p.date === today());
  const recent = [...state.items]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
  const days = Array.from({ length: 5 }, (_, n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  return (
    <div className="page home-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">把日常，穿成自己的样子</p>
          <h1>你好{state.settings.name ? `，${state.settings.name}` : ""}</h1>
        </div>
        <button
          className="avatar-button"
          aria-label="个人设置"
          onClick={() => navigate("settings")}
        >
          {state.settings.name?.slice(0, 1) || "我"}
        </button>
      </div>
      <Recommendations />
      <section className="home-shortcuts">
        <SectionTitle title="随手用起来" />
        <div className="shortcut-grid">
          <button className="shortcut featured shortcut--add" onClick={openAdd}>
            <FeatureIcon name="add" />
            <strong>添加衣物</strong>
            <small>让衣柜更完整</small>
          </button>
          <button
            className="shortcut featured shortcut--outfit"
            onClick={() => openOutfit()}
          >
            <FeatureIcon name="outfit" />
            <strong>创建穿搭</strong>
            <small>组合自己的风格</small>
          </button>
          <button
            className="shortcut shortcut--calendar"
            onClick={() => navigate("calendar")}
          >
            <FeatureIcon name="calendar" />
            <strong>穿搭日历</strong>
          </button>
          <button
            className="shortcut shortcut--packing"
            onClick={() => navigate("packing")}
          >
            <FeatureIcon name="packing" />
            <strong>旅行打包</strong>
          </button>
          <button
            className="shortcut shortcut--stats"
            onClick={() => navigate("stats")}
          >
            <FeatureIcon name="stats" />
            <strong>风格统计</strong>
          </button>
        </div>
      </section>
      <section className="home-recent">
        <SectionTitle
          title="最近加入衣柜"
          action="查看衣柜"
          onClick={() => navigate("wardrobe")}
        />
        {recent.length ? (
          <div className="recent-strip">
            <button
              className="recent-add"
              aria-label="添加衣物"
              onClick={openAdd}
            >
              <Plus size={30} />
            </button>
            {recent.map((i) => (
              <button key={i.id} onClick={() => openItem(i.id)}>
                <Garment item={i} />
                <small>{itemName(i)}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="soft-panel row between">
            <p className="muted">从一件常穿的衣服开始。</p>
            <Button kind="ghost" onClick={openAdd}>
              添加
              <Plus size={16} />
            </Button>
          </div>
        )}
      </section>
      <section className="home-calendar">
        <SectionTitle
          title="接下来的穿搭"
          action="查看日历"
          onClick={() => navigate("calendar")}
        />
        <div className="week-strip">
          {days.map((d, index) => {
            const plans = state.plans.filter((p) => p.date === d);
            return (
              <button
                key={d}
                className={index === 0 ? "today" : ""}
                onClick={() => navigate(`calendar?date=${d}`)}
              >
                <span>
                  {index === 0
                    ? "今天"
                    : new Intl.DateTimeFormat("zh-CN", {
                        weekday: "short",
                      }).format(new Date(`${d}T12:00:00`))}
                </span>
                <strong>{dateLabel(d)}</strong>
                <div>
                  {plans.length ? (
                    <Collage ids={plans[0].item_ids} items={state.items} />
                  ) : (
                    <CalendarDays size={23} strokeWidth={1.2} />
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {todayPlans.length > 0 && (
          <p className="muted small">
            今天已有 {todayPlans.length} 套穿搭计划，穿过后记得记录。
          </p>
        )}
      </section>
      <section className="insight-note">
        <Sparkles size={22} />
        <div>
          <h3>衣柜的小发现</h3>
          <p>
            {state.insights.unworn
              ? `还有 ${state.insights.unworn} 件衣物没有穿着记录，下一套可以试试它们。`
              : "记录每次穿着，慢慢发现你的偏好。"}
          </p>
        </div>
        <IconButton label="查看风格统计" onClick={() => navigate("stats")}>
          <ArrowRight size={20} />
        </IconButton>
      </section>
    </div>
  );
}
export function Explore() {
  const { state, openItem, navigate } = useApp();
  const [anchor, setAnchor] = useState("");
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState<
    { role: "user" | "assistant"; text: string; ids?: string[] }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const usable = state.items.filter(
    (i) => i.confirmed && i.status === "available",
  );
  async function ask() {
    if (!message.trim() || busy) return;
    const m = message.trim();
    setMessage("");
    setChat((v) => [...v, { role: "user", text: m }]);
    setBusy(true);
    setError("");
    try {
      const r = await send<{ message: string; item_ids: string[] }>(
        "/ai/chat",
        { message: m },
      );
      setChat((v) => [
        ...v,
        { role: "assistant", text: r.message, ids: r.item_ids },
      ]);
    } catch (e) {
      setError(failure(e));
      setMessage(m);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page explore-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">从已有衣物里，发现新意</p>
          <h1>探索我的风格</h1>
        </div>
        <Sparkles size={28} strokeWidth={1.3} />
      </div>
      <div className="tip-banner">
        <Sparkles size={22} />
        <p>挑一件衣物，看看它还能怎样搭。每套组合都来自你的衣柜。</p>
      </div>
      {usable.length ? (
        <>
          <div className="anchor-strip">
            {usable.map((i) => (
              <button
                key={i.id}
                className={anchor === i.id ? "selected" : ""}
                onClick={() => setAnchor(anchor === i.id ? "" : i.id)}
                aria-pressed={anchor === i.id}
              >
                <Garment item={i} />
                <small>{itemName(i)}</small>
              </button>
            ))}
          </div>
          <Recommendations
            key={anchor}
            lockedIds={anchor ? [anchor] : []}
            compact
          />
        </>
      ) : (
        <Empty
          title="先认识你的衣柜"
          description="添加并确认衣物，就能围绕单品探索更多搭配。"
          action={
            <Button onClick={() => navigate("wardrobe")}>去衣柜看看</Button>
          }
        />
      )}
      <section className="chat-panel">
        <div className="assistant-heading">
          <FeatureIcon name="assistant" />
          <div>
            <h2>聊聊你的穿搭</h2>
            <p>把想法交给造型助手</p>
          </div>
        </div>
        {state.ai.capabilities.text ? (
          <>
            <p className="muted small">问问场合、配色或一件衣物的新穿法。</p>
            <div className="chat-messages">
              {chat.map((m, i) => (
                <div className={`chat-message ${m.role}`} key={i}>
                  <p>{m.text}</p>
                  {m.ids && m.ids.length > 0 && (
                    <div className="chat-items">
                      {m.ids.map((id) => {
                        const item = state.items.find((x) => x.id === id);
                        return item ? (
                          <button key={id} onClick={() => openItem(id)}>
                            <Garment item={item} />
                            <small>{itemName(item)}</small>
                          </button>
                        ) : null;
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <form
              className="chat-input"
              onSubmit={(e) => {
                e.preventDefault();
                ask();
              }}
            >
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="明天见客户，怎样穿得自然又得体？"
                aria-label="给造型助手的问题"
                maxLength={2000}
              />
              <Button
                type="submit"
                busy={busy}
                disabled={!message.trim() || busy}
              >
                <ArrowRight size={18} />
                <span className="sr-only">发送问题</span>
              </Button>
            </form>
            <ErrorText error={error} />
          </>
        ) : (
          <div className="soft-panel stack">
            <p>
              {["codex", "claude-code"].includes(state.ai.provider)
                ? "在已经连接的助手中打开衣间技能，直接聊聊想穿什么。"
                : "连接文本模型后，可以根据自己的衣柜讨论搭配。"}
            </p>
            <Button kind="secondary" onClick={() => navigate("settings")}>
              查看 AI 连接
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
