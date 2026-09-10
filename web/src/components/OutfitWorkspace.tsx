import { useState, type ReactNode } from "react";
import { LayoutGrid, Move, Shapes, Sparkles, X } from "lucide-react";
import { useApp } from "../Store";
import { send, failure } from "../api";
import {
  categories,
  occasions,
  itemName,
  type OutfitLayout,
  type Suggestion,
  type Suggestions,
} from "../types";
import { templatePlacements } from "../outfit-layout";
import { Button, Collage, ErrorText, Field, Garment } from "./UI";
import { OutfitCanvas } from "./OutfitCanvas";

const modes = [
  { value: "free", title: "自由拖动", help: "自己摆放每件单品", Icon: Move },
  {
    value: "categories",
    title: "按类别",
    help: "分门别类挑选衣物",
    Icon: Shapes,
  },
  {
    value: "collage",
    title: "拼图",
    help: "选一个喜欢的版式",
    Icon: LayoutGrid,
  },
  { value: "ai", title: "AI 推荐", help: "让搭配有个起点", Icon: Sparkles },
] as const;
const templates = {
  balanced: "均衡",
  grid: "网格",
  editorial: "杂志",
} as const;
const MAX_LOCKED_ITEMS = 12;

export function OutfitWorkspace({
  ids,
  layout,
  onLayout,
  onRemove,
  onSuggestion,
  picker,
}: {
  ids: string[];
  layout: OutfitLayout;
  onLayout: (value: OutfitLayout) => void;
  onRemove: (id: string) => void;
  onSuggestion: (suggestion: Suggestion) => void;
  picker: ReactNode;
}) {
  const { state } = useApp();
  const [temperature, setTemperature] = useState(
    state.settings.preferences.temperature,
  );
  const [occasion, setOccasion] = useState("casual");
  const [result, setResult] = useState<Suggestions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seed, setSeed] = useState(0);
  const [keepSelected, setKeepSelected] = useState(false);
  const lockedLimitExceeded = keepSelected && ids.length > MAX_LOCKED_ITEMS;
  const host = ["codex", "claude-code"].includes(state.ai.provider);
  const ai = state.ai.capabilities.text && !host;
  const chosen = ids
    .map((id) => state.items.find((i) => i.id === id))
    .filter((i) => !!i);
  async function recommend() {
    if (busy || lockedLimitExceeded) return;
    setBusy(true);
    setError("");
    try {
      const next = await send<Suggestions>(
        ai ? "/ai/recommend" : "/recommendations",
        {
          temperature,
          occasion,
          locked_ids: keepSelected ? ids : [],
          excluded_ids: state.settings.preferences.excluded_ids,
          seed,
        },
      );
      setResult(next);
      setSeed((value) => value + 1);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="studio-workspace">
      <div className="studio-modes" role="group" aria-label="创建穿搭方式">
        {modes.map(({ value, title, help, Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={layout.mode === value}
            className={layout.mode === value ? "active" : ""}
            onClick={() => onLayout({ ...layout, mode: value })}
          >
            <Icon size={21} aria-hidden="true" />
            <span>
              <strong>{title}</strong>
              <small>{help}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="studio-panes">
        <div className="studio-composition stack">
          {layout.mode === "ai" && (
            <section
              className="studio-recommend stack tight"
              aria-label="获取搭配推荐"
            >
              <strong>{ai ? "AI 搭配推荐" : "规则搭配推荐"}</strong>
              <p className="small muted">
                {ai
                  ? "根据衣柜、气温和场合生成搭配，使用已配置的模型服务。"
                  : host
                    ? `可在 ${state.ai.provider === "codex" ? "Codex 中运行 $yijian" : "Claude Code 中运行 /yijian"} 请求 AI 搭配；网页中先提供规则推荐。`
                    : "当前未连接可直接调用的 AI 文本模型，先按衣柜、气温和场合提供规则推荐。"}
              </p>
              <div className="form-grid">
                <Field label="参考气温（°C）">
                  <input
                    type="number"
                    min="-40"
                    max="55"
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                  />
                </Field>
                <Field label="搭配场合">
                  <select
                    value={occasion}
                    onChange={(e) => setOccasion(e.target.value)}
                  >
                    {Object.entries(occasions).map(([value, name]) => (
                      <option key={value} value={value}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {!!ids.length && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={keepSelected}
                    onChange={(e) => setKeepSelected(e.target.checked)}
                  />
                  <span>
                    保留已选单品再推荐
                    <small>最多保留 {MAX_LOCKED_ITEMS} 件</small>
                  </span>
                </label>
              )}
              {lockedLimitExceeded && (
                <p className="small error" role="status">
                  已选 {ids.length} 件，推荐最多保留 {MAX_LOCKED_ITEMS}{" "}
                  件。请减少已选单品，或取消保留后重新推荐。
                </p>
              )}
              <Button
                busy={busy}
                disabled={lockedLimitExceeded}
                onClick={recommend}
              >
                {ai ? "生成 AI 推荐" : "生成规则推荐"}
              </Button>
              <ErrorText error={error} />
              {result && !result.outfits.length && (
                <p className="status" role="status">
                  {result.message || "还没有合适的组合。"}
                  {result.missing.length
                    ? ` 可以补充：${result.missing.map((c) => categories[c as keyof typeof categories] || c).join("、")}。`
                    : ""}
                </p>
              )}
              {!!result?.outfits.length && (
                <div className="studio-suggestions">
                  {result.outfits.map((suggestion, index) => (
                    <article key={`${index}-${suggestion.item_ids.join("-")}`}>
                      <Collage ids={suggestion.item_ids} items={state.items} />
                      <div className="stack tight">
                        <small className="muted">
                          {suggestion.source === "ai" ? "AI 推荐" : "规则推荐"}
                        </small>
                        <strong>{suggestion.name}</strong>
                        <p className="small muted">{suggestion.reason}</p>
                        <Button
                          kind="secondary"
                          onClick={() => onSuggestion(suggestion)}
                        >
                          选用并编辑
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {layout.mode === "categories" ? (
            <section
              className="studio-category-summary"
              aria-label="按类别查看已选单品"
            >
              {Object.entries(categories).map(([category, label]) => {
                const group = chosen.filter(
                  (item) => item.category === category,
                );
                return (
                  <div key={category}>
                    <h3>
                      {label}
                      <small>{group.length} 件</small>
                    </h3>
                    {group.length ? (
                      <div className="category-chosen">
                        {group.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            onClick={() => onRemove(item.id)}
                            aria-label={`移出${itemName(item)}`}
                          >
                            <Garment item={item} />
                            <span>{itemName(item)}</span>
                            <X size={13} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="small muted">还未选择，可从衣柜中添加。</p>
                    )}
                  </div>
                );
              })}
            </section>
          ) : (
            <>
              {layout.mode === "collage" && (
                <>
                  <div
                    className="studio-templates"
                    role="group"
                    aria-label="拼图模板"
                  >
                    {Object.entries(templates).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={layout.template === value}
                        onClick={() =>
                          onLayout({
                            ...layout,
                            template: value as OutfitLayout["template"],
                            placements: templatePlacements(
                              ids,
                              state.items,
                              value as OutfitLayout["template"],
                            ),
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="small muted">
                    增减单品会按模板重排，切换“自由拖动”可保留手动位置。
                  </p>
                </>
              )}
              <OutfitCanvas
                layout={layout}
                items={state.items}
                onChange={onLayout}
                onRemove={onRemove}
              />
              <div
                className="studio-background"
                role="group"
                aria-label="画布背景"
              >
                <span className="small muted">背景</span>
                {[
                  ["#ffffff", "白色"],
                  ["#f5f2ec", "米色"],
                  ["#eceef5", "浅灰蓝"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={label}
                    aria-pressed={layout.background === value}
                    style={{ background: value }}
                    onClick={() => onLayout({ ...layout, background: value })}
                  />
                ))}
              </div>
            </>
          )}
          <div
            className="studio-selected"
            role="group"
            aria-label={`搭配全部单品（${chosen.length} 件）`}
          >
            <strong>已选 {chosen.length} 件</strong>
            <div className="row wrap">
              {chosen.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => onRemove(item.id)}
                  aria-label={`从搭配移除${itemName(item)}`}
                >
                  {itemName(item)}
                  <X size={13} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </div>
        <section className="studio-wardrobe" aria-label="搭配衣柜">
          <h3>从你的衣柜里挑选</h3>
          <p className="small muted">包袋与配饰也可以加入，每套最多 24 件。</p>
          {picker}
        </section>
      </div>
    </div>
  );
}
