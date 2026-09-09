import { useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Luggage,
  Plus,
  Trash2,
  PenLine,
} from "lucide-react";
import { api, send, failure } from "../api";
import { useApp } from "../Store";
import {
  type Trip,
  type Plan,
  mergeTripItems,
  itemName,
  today,
  dateLabel,
  categories,
} from "../types";
import {
  Button,
  Collage,
  Empty,
  Field,
  Garment,
  IconButton,
  Sheet,
  ErrorText,
} from "../components/UI";
import { ItemPicker, PlanEditor } from "../components/Outfits";
export function Looks({ tab = "looks" }: { tab?: string }) {
  const { state, navigate, openOutfit } = useApp();
  return (
    <div className="page looks-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">把喜欢的组合，留下来</p>
          <h1>我的穿搭</h1>
        </div>
        <IconButton label="创建穿搭" onClick={() => openOutfit()}>
          <Plus size={25} />
        </IconButton>
      </div>
      <div className="main-tabs" role="tablist" aria-label="穿搭功能">
        {[
          ["looks", "穿搭"],
          ["packing", "打包"],
          ["calendar", "日历"],
        ].map(([id, name]) => (
          <button
            role="tab"
            key={id}
            aria-selected={tab === id}
            onClick={() => navigate(id)}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === "packing" ? (
        <Packing />
      ) : tab === "calendar" ? (
        <Calendar />
      ) : (
        <div className="looks-grid">
          <button className="create-look-card" onClick={() => openOutfit()}>
            <span>
              <Plus size={32} />
            </span>
            <div className="abstract-clothes">
              <svg viewBox="0 0 160 160" aria-hidden="true">
                <path
                  d="m43 27 22-10h30l22 10 24 36-21 13-15-17v69H55V59L40 76 20 63Z"
                  fill="#dedfeb"
                />
                <path
                  d="M65 17q15 30 30 0"
                  fill="none"
                  stroke="#f7f7fb"
                  strokeWidth="6"
                />
                <path d="M57 87h47" stroke="#f7f7fb" strokeWidth="13" />
              </svg>
            </div>
            <strong>
              把穿搭想法
              <br />
              变成下一次出门
            </strong>
            <small>创建一套自己的搭配</small>
          </button>
          {state.outfits.map((o) => (
            <button
              className="saved-look-card"
              key={o.id}
              onClick={() => openOutfit(o.id)}
            >
              <Collage ids={o.item_ids} items={state.items} />
              <div>
                <h3>{o.name}</h3>
                <p>
                  {o.item_ids.length} 件单品 ·{" "}
                  {o.source === "manual"
                    ? "我的创作"
                    : o.source === "rules"
                      ? "衣柜搭配"
                      : o.source === "assistant"
                        ? "助手搭配"
                        : "AI 搭配"}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function Calendar() {
  const { state, refresh, notify } = useApp();
  const dateParam = new URLSearchParams(location.hash.split("?")[1]).get(
    "date",
  );
  const initialDate =
    dateParam &&
    /^\d{4}-\d{2}-\d{2}$/.test(dateParam) &&
    !Number.isNaN(Date.parse(dateParam))
      ? dateParam
      : today();
  const [month, setMonth] = useState(initialDate.slice(0, 7));
  const [selected, setSelected] = useState(initialDate);
  const wearRequests = useRef(new Map<string, string>());
  const [edit, setEdit] = useState<Plan | true | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [y, m] = month.split("-").map(Number);
  const first = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const days = new Date(y, m, 0).getDate();
  const cells = Array.from({ length: first + days }, (_, i) =>
    i < first ? null : `${month}-${String(i - first + 1).padStart(2, "0")}`,
  );
  const plans = state.plans.filter((p) => p.date === selected);
  const wears = state.wear_events.filter((p) => p.date === selected);
  function step(by: number) {
    const d = new Date(y, m - 1 + by, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  async function record(plan: Plan) {
    if (busy) return;
    setBusy(plan.id);
    setError("");
    try {
      let id = wearRequests.current.get(plan.id);
      if (!id) {
        id = crypto.randomUUID();
        wearRequests.current.set(plan.id, id);
      }
      await send("/wear", {
        item_ids: plan.item_ids,
        date: plan.date,
        notes: plan.notes,
        request_id: id,
      });
      await refresh();
      notify("已记录这天的实际穿着。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function remove(kind: "plans" | "wear", id: string) {
    if (
      !confirm(
        kind === "wear"
          ? "撤销这次穿着记录？衣物次数会相应减少。"
          : "删除这条穿搭计划？",
      )
    )
      return;
    setBusy(id);
    setError("");
    try {
      await api(`/${kind}/${id}`, { method: "DELETE" });
      if (kind === "wear") wearRequests.current.clear();
      await refresh();
      notify("记录已更新。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="calendar-layout">
      <div className="calendar-panel">
        <div className="row between">
          <IconButton label="上个月" onClick={() => step(-1)}>
            <ChevronLeft size={20} />
          </IconButton>
          <h2>
            {y} 年 {m} 月
          </h2>
          <IconButton label="下个月" onClick={() => step(1)}>
            <ChevronRight size={20} />
          </IconButton>
        </div>
        <div className="calendar-week">
          {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {cells.map((d, i) =>
            d ? (
              <button
                key={d}
                onClick={() => setSelected(d)}
                className={`${d === selected ? "selected" : ""} ${d === today() ? "is-today" : ""}`}
                aria-label={`${dateLabel(d)}，${state.plans.filter((p) => p.date === d).length} 条计划，${state.wear_events.filter((p) => p.date === d).length} 次穿着`}
              >
                <span>{Number(d.slice(-2))}</span>
                <div className="calendar-dots">
                  {state.plans.some((p) => p.date === d) && <i />}
                  {state.wear_events.some((w) => w.date === d) && (
                    <i className="worn" />
                  )}
                </div>
              </button>
            ) : (
              <span key={`blank-${i}`} />
            ),
          )}
        </div>
        <div className="calendar-legend">
          <span>
            <i />
            穿搭计划
          </span>
          <span>
            <i className="worn" />
            实际穿着
          </span>
          <button
            className="text-button"
            onClick={() => {
              setMonth(today().slice(0, 7));
              setSelected(today());
            }}
          >
            回到今天
          </button>
        </div>
      </div>
      <section className="day-panel stack">
        <div className="row between">
          <h2>{dateLabel(selected)}</h2>
          <Button kind="secondary" onClick={() => setEdit(true)}>
            <Plus size={16} />
            安排穿搭
          </Button>
        </div>
        {!plans.length && !wears.length && (
          <Empty
            title="这一天，还留着空白"
            description="提前想好穿什么，出门时少一点纠结。"
          />
        )}
        {plans.map((p) => (
          <article key={p.id} className="day-card">
            <Collage ids={p.item_ids} items={state.items} />
            <div>
              <span className="tiny-label">计划</span>
              <h3>{p.name}</h3>
              {p.notes && <p className="small muted">{p.notes}</p>}
              <div className="row wrap">
                <Button
                  kind="secondary"
                  disabled={
                    !!busy ||
                    p.date > today() ||
                    state.wear_events.some(
                      (w) =>
                        w.date === p.date &&
                        w.item_ids.length === p.item_ids.length &&
                        w.item_ids.every((id) => p.item_ids.includes(id)),
                    )
                  }
                  onClick={() => record(p)}
                >
                  <Check size={15} />
                  {state.wear_events.some(
                    (w) =>
                      w.date === p.date &&
                      w.item_ids.length === p.item_ids.length &&
                      w.item_ids.every((id) => p.item_ids.includes(id)),
                  )
                    ? "已记录穿着"
                    : "记录穿着"}
                </Button>
                <Button kind="ghost" onClick={() => setEdit(p)}>
                  <PenLine size={15} />
                  编辑
                </Button>
                <IconButton
                  label={`删除${p.name}`}
                  disabled={!!busy}
                  onClick={() => remove("plans", p.id)}
                >
                  <Trash2 size={17} />
                </IconButton>
              </div>
            </div>
          </article>
        ))}
        {wears.map((w) => (
          <article className="wear-record" key={w.id}>
            <div className="row between">
              <span className="badge success">
                <Check size={13} />
                实际穿着
              </span>
              <IconButton
                label="撤销穿着记录"
                disabled={!!busy}
                onClick={() => remove("wear", w.id)}
              >
                <Trash2 size={16} />
              </IconButton>
            </div>
            <p>{Object.values(w.item_names).join(" · ")}</p>
            {w.notes && <small className="muted">{w.notes}</small>}
          </article>
        ))}
        <ErrorText error={error} />
      </section>
      {edit && (
        <PlanEditor
          itemIds={edit === true ? [] : edit.item_ids}
          plan={edit === true ? undefined : edit}
          date={selected}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}
function Packing() {
  const { state, refresh, notify } = useApp();
  const [activeId, setActiveId] = useState("");
  const [editing, setEditing] = useState<Trip | true | null>(null);
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trip = state.trips.find((t) => t.id === activeId) || state.trips[0];
  const packed = trip?.entries.filter((e) => e.packed).length || 0;
  async function change(entries: Trip["entries"]) {
    if (!trip || busy) return false;
    setBusy(true);
    setError("");
    try {
      await send(`/trips/${trip.id}`, { entries }, "PATCH");
      await refresh();
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function removeTrip() {
    if (!trip || !confirm("删除这个行李箱？衣物仍然保留在衣柜中。")) return;
    setBusy(true);
    try {
      await api(`/trips/${trip.id}`, { method: "DELETE" });
      await refresh();
      setActiveId("");
      notify("行李箱已删除。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  const groups = trip
    ? Object.entries(categories)
        .map(([cat, label]) => ({
          label,
          entries: trip.entries.filter(
            (e) =>
              state.items.find((i) => i.id === e.item_id)?.category === cat,
          ),
        }))
        .filter((g) => g.entries.length)
    : [];
  return (
    <div className="packing-layout">
      <aside className="trip-list">
        <Button onClick={() => setEditing(true)}>
          <Plus size={17} />
          创建旅行行李箱
        </Button>
        {state.trips.map((t) => (
          <button
            key={t.id}
            className={`trip-tab ${trip?.id === t.id ? "active" : ""}`}
            onClick={() => setActiveId(t.id)}
          >
            <Luggage size={23} />
            <span>
              <strong>{t.name}</strong>
              <small>
                {t.destination || "我的旅行"} · {dateLabel(t.start_date)}
              </small>
            </span>
            <span>{t.entries.length}</span>
          </button>
        ))}
      </aside>
      {trip ? (
        <section className="trip-detail stack">
          <div className="trip-heading">
            <div>
              <span className="eyebrow">{trip.destination || "准备出发"}</span>
              <h2>{trip.name}</h2>
              <p>
                {dateLabel(trip.start_date)} — {dateLabel(trip.end_date)}
              </p>
            </div>
            <IconButton label="编辑旅行信息" onClick={() => setEditing(trip)}>
              <PenLine size={19} />
            </IconButton>
          </div>
          <div className="packing-progress">
            <div className="row between">
              <strong>
                已打包 {packed} / {trip.entries.length}
              </strong>
              <span>
                {trip.entries.length
                  ? Math.round((packed / trip.entries.length) * 100)
                  : 0}
                %
              </span>
            </div>
            <progress
              value={packed}
              max={trip.entries.length || 1}
              aria-label="打包进度"
            />
          </div>
          <div className="row wrap">
            <Button
              kind="secondary"
              onClick={() => {
                setSelection([]);
                setAdding(true);
              }}
            >
              <Plus size={16} />
              添加衣物
            </Button>
            <label className="outfit-select">
              <select
                aria-label="从整套搭配加入行李箱"
                value=""
                disabled={busy}
                onChange={(e) => {
                  const o = state.outfits.find((x) => x.id === e.target.value);
                  if (o) change(mergeTripItems(trip.entries, o.item_ids));
                }}
              >
                <option value="">从整套搭配加入</option>
                {state.outfits.map((o) => (
                  <option value={o.id} key={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {groups.map((g) => (
            <div key={g.label} className="packing-group">
              <h3>
                {g.label} <span>{g.entries.length}</span>
              </h3>
              {g.entries.map((entry) => {
                const item = state.items.find((i) => i.id === entry.item_id)!;
                return (
                  <div className="packing-row" key={entry.item_id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={entry.packed}
                        disabled={busy}
                        onChange={(e) =>
                          change(
                            trip.entries.map((v) =>
                              v.item_id === entry.item_id
                                ? { ...v, packed: e.target.checked }
                                : v,
                            ),
                          )
                        }
                      />
                      <Garment item={item} />
                      <span>
                        <strong>{itemName(item)}</strong>
                        {item.status === "laundry" && (
                          <small className="warning">出发前记得清洗</small>
                        )}
                        {item.status === "archived" && (
                          <small className="warning">这件衣物已归档</small>
                        )}
                      </span>
                    </label>
                    <IconButton
                      label={`移除${itemName(item)}`}
                      disabled={busy}
                      onClick={() =>
                        change(
                          trip.entries.filter(
                            (v) => v.item_id !== entry.item_id,
                          ),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                );
              })}
            </div>
          ))}
          {!trip.entries.length && (
            <Empty
              title="行李箱里，先放哪一件？"
              description="加入单品或整套搭配，再逐件勾选。"
            />
          )}
          <ErrorText error={error} />
          <Button kind="ghost" disabled={busy} onClick={removeTrip}>
            <Trash2 size={16} />
            删除行李箱
          </Button>
        </section>
      ) : (
        <Empty
          title="为下一次出发做好准备"
          description="按行程整理衣物，少带一点，却穿得更多。"
        />
      )}
      {editing && (
        <TripForm
          trip={editing === true ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => setActiveId(id)}
        />
      )}{" "}
      {adding && trip && (
        <Sheet title="加入行李箱" onClose={() => setAdding(false)}>
          <div className="stack">
            <ItemPicker selected={selection} onChange={setSelection} />
            <ErrorText error={error} />
            <Button
              busy={busy}
              disabled={!selection.length || busy}
              onClick={async () => {
                if (await change(mergeTripItems(trip.entries, selection)))
                  setAdding(false);
              }}
            >
              加入 {selection.length} 件衣物
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
function TripForm({
  trip,
  onClose,
  onSaved,
}: {
  trip?: Trip;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { refresh, notify } = useApp();
  const [name, setName] = useState(trip?.name || "");
  const [destination, setDestination] = useState(trip?.destination || "");
  const [start, setStart] = useState(trip?.start_date || today());
  const [end, setEnd] = useState(trip?.end_date || today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (end < start) throw new Error("结束日期不能早于开始日期。");
      const t = await send<Trip>(
        trip ? `/trips/${trip.id}` : "/trips",
        { name: name.trim(), destination, start_date: start, end_date: end },
        trip ? "PATCH" : "POST",
      );
      await refresh();
      onSaved(t.id);
      notify("旅行信息已保存。");
      onClose();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={trip ? "旅行信息" : "新建旅行行李箱"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="旅行名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="例如：去海边的周末"
          />
        </Field>
        <Field label="目的地">
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            maxLength={120}
            placeholder="想去哪里？"
          />
        </Field>
        <div className="form-grid">
          <Field label="出发日期">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </Field>
          <Field label="结束日期">
            <input
              type="date"
              min={start}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </Field>
        </div>
        <ErrorText error={error} />
        <Button type="submit" busy={busy}>
          保存行李箱
        </Button>
      </form>
    </Sheet>
  );
}
