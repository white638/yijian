import { useMemo, useRef, useState } from "react";
import { Bookmark, CalendarDays, Check, Search, Trash2 } from "lucide-react";
import { useApp } from "../Store";
import { api, send, failure } from "../api";
import {
  type Item,
  type Outfit,
  type Plan,
  itemName,
  today,
  categories,
} from "../types";
import { Button, Field, Sheet, Garment, Collage, ErrorText, Empty } from "./UI";
export function ItemPicker({
  selected,
  onChange,
  items,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  items?: Item[];
}) {
  const { state } = useApp();
  const [query, setQuery] = useState("");
  const all = items || state.items.filter((i) => i.status !== "archived");
  const shown = useMemo(
    () =>
      all.filter((i) =>
        `${itemName(i)} ${i.brand} ${categories[i.category]}`.includes(query),
      ),
    [all, query],
  );
  return (
    <div className="stack tight">
      <label className="search-box">
        <Search size={17} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索衣物"
          aria-label="搜索可选衣物"
        />
      </label>
      <div className="picker-grid">
        {shown.map((i) => (
          <button
            type="button"
            key={i.id}
            className={`pick-card ${selected.includes(i.id) ? "selected" : ""}`}
            aria-pressed={selected.includes(i.id)}
            onClick={() =>
              onChange(
                selected.includes(i.id)
                  ? selected.filter((x) => x !== i.id)
                  : [...selected, i.id],
              )
            }
          >
            <Garment item={i} />
            <span>{itemName(i)}</span>
            {selected.includes(i.id) && (
              <Check size={16} className="pick-check" />
            )}
          </button>
        ))}
      </div>
      {!shown.length && <p className="muted small">没有匹配的衣物。</p>}
      <small className="muted">已选 {selected.length} 件</small>
    </div>
  );
}
export function OutfitEditor({
  outfit,
  onClose,
}: {
  outfit?: Outfit;
  onClose: () => void;
}) {
  const { state, refresh, notify, openPlan } = useApp();
  const [ids, setIds] = useState(outfit?.item_ids || []);
  const [name, setName] = useState(outfit?.name || "");
  const [notes, setNotes] = useState(outfit?.notes || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [wearDate, setWearDate] = useState(today());
  const requestId = useRef(crypto.randomUUID());
  async function action(kind: string) {
    if (busy) return;
    if (kind === "delete" && !confirm("删除这套搭配？衣物会保留在衣柜中。"))
      return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "save")
        await send(
          outfit ? `/outfits/${outfit.id}` : "/outfits",
          {
            name: name.trim() || "我的搭配",
            item_ids: ids,
            notes,
            source:
              outfit &&
              ids.length === outfit.item_ids.length &&
              ids.every((id) => outfit.item_ids.includes(id))
                ? outfit.source
                : "manual",
          },
          outfit ? "PATCH" : "POST",
        );
      if (kind === "delete" && outfit)
        await api(`/outfits/${outfit.id}`, { method: "DELETE" });
      if (kind === "wear")
        await send("/wear", {
          item_ids: ids,
          date: wearDate,
          notes,
          request_id: requestId.current,
        });
      await refresh();
      notify(
        kind === "wear"
          ? "已记录实际穿着。"
          : kind === "delete"
            ? "搭配已删除。"
            : "搭配已保存。",
      );
      onClose();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Sheet title={outfit ? "编辑搭配" : "创建一套穿搭"} onClose={onClose} wide>
      <div className="outfit-editor">
        <div className="stack">
          <Collage ids={ids} items={state.items} />
          <Field label="搭配名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：周五的轻松通勤"
              maxLength={120}
            />
          </Field>
          <Field label="搭配笔记">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="记录这套搭配的想法"
            />
          </Field>
          <Button
            disabled={!ids.length || !!busy}
            busy={busy === "save"}
            onClick={() => action("save")}
          >
            <Bookmark size={16} />
            保存穿搭
          </Button>
          <Button
            kind="secondary"
            disabled={!ids.length || !!busy}
            onClick={() => {
              onClose();
              openPlan(ids, name, outfit?.id);
            }}
          >
            <CalendarDays size={16} />
            安排穿搭日期
          </Button>
          <div className="soft-panel stack tight">
            <Field label="实际穿着日期">
              <input
                type="date"
                value={wearDate}
                max={today()}
                onChange={(e) => setWearDate(e.target.value)}
              />
            </Field>
            <Button
              kind="secondary"
              disabled={!ids.length || !!busy || !wearDate}
              busy={busy === "wear"}
              onClick={() => action("wear")}
            >
              <Check size={16} />
              这天穿过了
            </Button>
            <small className="muted">保存或安排搭配不会增加穿着次数。</small>
          </div>
          {outfit && (
            <Button
              kind="danger"
              disabled={!!busy}
              onClick={() => action("delete")}
            >
              <Trash2 size={16} />
              删除搭配
            </Button>
          )}
          <ErrorText error={error} />
        </div>
        <div>
          <h3 className="mb">从你的衣柜里挑选</h3>
          <ItemPicker selected={ids} onChange={setIds} />
        </div>
      </div>
    </Sheet>
  );
}
export function PlanEditor({
  itemIds,
  name: initialName = "",
  outfitId,
  plan,
  onClose,
  date: initialDate,
}: {
  itemIds: string[];
  name?: string;
  outfitId?: string;
  plan?: Plan;
  onClose: () => void;
  date?: string;
}) {
  const { state, refresh, notify } = useApp();
  const [ids, setIds] = useState(plan?.item_ids || itemIds);
  const [name, setName] = useState(plan?.name || initialName);
  const [date, setDate] = useState(plan?.date || initialDate || today());
  const [notes, setNotes] = useState(plan?.notes || "");
  const [choice, setChoice] = useState(plan?.outfit_id || outfitId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (!ids.length) throw new Error("先选择一套搭配或几件衣物。");
      await send(
        plan ? `/plans/${plan.id}` : "/plans",
        {
          name: name || "穿搭计划",
          date,
          item_ids: ids,
          outfit_id: choice || null,
          notes,
        },
        plan ? "PATCH" : "POST",
      );
      await refresh();
      notify("穿搭已加入日历。");
      onClose();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={plan ? "编辑穿搭计划" : "安排穿搭日期"} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="日期">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="选择已保存的穿搭">
          <select
            value={choice}
            onChange={(e) => {
              const o = state.outfits.find((x) => x.id === e.target.value);
              setChoice(e.target.value);
              if (o) {
                setIds(o.item_ids);
                setName(o.name);
              }
            }}
          >
            <option value="">自己选择衣物</option>
            {state.outfits.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
        {choice ? (
          <Collage ids={ids} items={state.items} />
        ) : (
          <ItemPicker selected={ids} onChange={setIds} />
        )}
        <Field label="计划名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：周六去看展"
          />
        </Field>
        <Field label="备注">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </Field>
        <p className="small muted">这是计划。实际穿过后，再记录穿着。</p>
        <ErrorText error={error} />
        <Button type="submit" busy={busy} disabled={!ids.length || !date}>
          保存到日历
        </Button>
      </form>
    </Sheet>
  );
}
