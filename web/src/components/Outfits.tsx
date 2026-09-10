import { useMemo, useRef, useState } from "react";
import { Bookmark, CalendarDays, Check, Search, Trash2 } from "lucide-react";
import { useApp } from "../Store";
import { api, send, failure } from "../api";
import {
  type Item,
  type Outfit,
  type Plan,
  type OutfitLayout,
  type Suggestion,
  itemName,
  today,
  categories,
} from "../types";
import { Button, Field, Sheet, Garment, Collage, ErrorText, Empty } from "./UI";
import { OutfitWorkspace } from "./OutfitWorkspace";
import {
  MAX_OUTFIT_ITEMS,
  syncLayout,
  templatePlacements,
} from "../outfit-layout";
export function ItemPicker({
  selected,
  onChange,
  items,
  grouped = false,
  limit,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  items?: Item[];
  grouped?: boolean;
  limit?: number;
}) {
  const { state } = useApp();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const all = items || state.items.filter((i) => i.status !== "archived");
  const shown = useMemo(
    () =>
      all.filter(
        (i) =>
          (!grouped || category === "all" || i.category === category) &&
          `${itemName(i)} ${i.brand} ${categories[i.category]} ${i.tags.join(" ")}`.includes(
            query,
          ),
      ),
    [all, query, grouped, category],
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
      {grouped && (
        <div
          className="studio-picker-categories"
          role="group"
          aria-label="筛选衣物类别"
        >
          {[["all", "全部"], ...Object.entries(categories)].map(
            ([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
              >
                {label}
                <small>
                  {
                    all.filter((i) => value === "all" || i.category === value)
                      .length
                  }
                </small>
              </button>
            ),
          )}
        </div>
      )}
      <div className="picker-grid">
        {shown.map((i) => (
          <button
            type="button"
            key={i.id}
            className={`pick-card ${selected.includes(i.id) ? "selected" : ""}`}
            aria-pressed={selected.includes(i.id)}
            disabled={
              !!limit && selected.length >= limit && !selected.includes(i.id)
            }
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
      {!!limit && selected.length >= limit && (
        <p className="small muted">
          每套最多选择 {limit} 件，移出一件后可继续添加。
        </p>
      )}
    </div>
  );
}
export function OutfitEditor({
  outfit,
  initialDraft,
  onClose,
}: {
  outfit?: Outfit;
  initialDraft?: Partial<Outfit>;
  onClose: () => void;
}) {
  const { state, refresh, notify, openPlan } = useApp();
  const initial = outfit || initialDraft;
  const [ids, setIds] = useState(initial?.item_ids || []);
  const [layout, setLayout] = useState<OutfitLayout>(() =>
    syncLayout(initial?.layout, initial?.item_ids || [], state.items),
  );
  const [source, setSource] = useState<Outfit["source"]>(
    initial?.source || "manual",
  );
  const [name, setName] = useState(initial?.name || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [wearDate, setWearDate] = useState(today());
  const requestId = useRef(crypto.randomUUID());
  function selectItems(next: string[]) {
    if (busy || next.length > MAX_OUTFIT_ITEMS) return;
    setIds(next);
    setLayout((previous) =>
      previous.mode === "collage"
        ? {
            ...previous,
            placements: templatePlacements(
              next,
              state.items,
              previous.template,
            ),
          }
        : syncLayout(previous, next, state.items),
    );
    setSource("manual");
  }
  function useSuggestion(suggestion: Suggestion) {
    if (busy) return;
    if (suggestion.item_ids.length > MAX_OUTFIT_ITEMS) {
      setError("这套推荐超过 24 件，请选择其他组合。");
      return;
    }
    setIds(suggestion.item_ids);
    setName(suggestion.name);
    setNotes(suggestion.reason);
    setSource(suggestion.source);
    setLayout({
      ...layout,
      mode: "free",
      placements: templatePlacements(
        suggestion.item_ids,
        state.items,
        layout.template,
      ),
    });
    setError("");
  }
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
            source,
            layout,
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
    <Sheet
      title={outfit ? "编辑搭配" : "创建一套穿搭"}
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={!!busy}
      wide
    >
      <div className="outfit-studio">
        <fieldset
          className="studio-fields"
          disabled={!!busy}
          aria-label="穿搭编辑区"
        >
          <OutfitWorkspace
            ids={ids}
            layout={layout}
            onLayout={(next) => {
              if (!busy) setLayout(next);
            }}
            onRemove={(id) =>
              selectItems(ids.filter((chosen) => chosen !== id))
            }
            onSuggestion={useSuggestion}
            picker={
              <ItemPicker
                selected={ids}
                onChange={selectItems}
                grouped
                limit={MAX_OUTFIT_ITEMS}
              />
            }
          />
          <div className="studio-save stack">
            <Field label="搭配名称">
              <input
                value={name}
                onChange={(e) => {
                  if (!busy) setName(e.target.value);
                }}
                placeholder="例如：周五的轻松通勤"
                maxLength={120}
              />
            </Field>
            <Field label="搭配笔记">
              <textarea
                value={notes}
                onChange={(e) => {
                  if (!busy) setNotes(e.target.value);
                }}
                rows={2}
                placeholder="记录这套搭配的想法"
              />
            </Field>
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
                  onChange={(e) => {
                    if (!busy) setWearDate(e.target.value);
                  }}
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
          </div>
        </fieldset>
        <div className="studio-savebar">
          <div>
            <span className="small muted">已选 {ids.length} 件单品</span>
            <ErrorText error={error} />
          </div>
          <Button
            disabled={!ids.length || !!busy}
            busy={busy === "save"}
            onClick={() => action("save")}
          >
            <Bookmark size={16} />
            保存穿搭
          </Button>
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
          <Collage ids={ids} items={state.items} expanded />
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
