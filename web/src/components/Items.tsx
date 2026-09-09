import { useRef, useState, type FormEvent } from "react";
import {
  Camera,
  ImagePlus,
  PenLine,
  Heart,
  RotateCcw,
  Sparkles,
  Trash2,
  WandSparkles,
  Check,
} from "lucide-react";
import { api, send, failure } from "../api";
import { useApp } from "../Store";
import {
  type Item,
  type Category,
  categories,
  itemName,
  costPerWear,
  translateValue,
} from "../types";
import { Button, Field, Sheet, Garment, ErrorText } from "./UI";
export function AddSheet({ onClose }: { onClose: () => void }) {
  const { state, refresh, notify, openItem } = useApp();
  const photo = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [remove, setRemove] = useState(true);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("top");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let id: string;
      if (manual) {
        const item = await send<Item>("/items", {
          name: name.trim(),
          category,
          confirmed: true,
        });
        id = item.id;
      } else {
        if (!files.length) throw new Error("先选择衣物照片。");
        const form = new FormData();
        files.forEach((f) => form.append("files", f));
        form.append("remove_background", String(remove));
        const result = await api<{ items: Item[]; warnings: string[] }>(
          "/items/upload",
          { method: "POST", body: form },
        );
        id = result.items[0]?.id;
        notify(
          result.warnings.length
            ? result.warnings.join("；")
            : `已添加 ${result.items.length} 件衣物，请核对信息。`,
        );
      }
      await refresh();
      onClose();
      if (id) openItem(id);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="添加衣物" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">让衣柜从你常穿的一件开始。</p>
        <div className="add-options">
          <button
            type="button"
            className={`option-tile ${!manual ? "dark" : ""}`}
            onClick={() => {
              setManual(false);
              photo.current?.click();
            }}
          >
            <ImagePlus size={30} />
            <span>从相册选择</span>
            <small>支持多张照片</small>
          </button>
          <button
            type="button"
            className="option-tile"
            onClick={() => {
              setManual(false);
              camera.current?.click();
            }}
          >
            <Camera size={30} />
            <span>拍一张照片</span>
            <small>自然光下平铺更清晰</small>
          </button>
        </div>
        <input
          ref={photo}
          type="file"
          multiple
          accept="image/*"
          hidden
          onChange={(e) => {
            setFiles([...(e.target.files || [])]);
            setManual(false);
          }}
        />
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            setFiles([...(e.target.files || [])]);
            setManual(false);
          }}
        />
        <button
          type="button"
          className="list-row"
          onClick={() => setManual(!manual)}
        >
          <PenLine size={22} />
          <span>手动记录衣物</span>
          <span className="muted">{manual ? "收起" : "无需照片"}</span>
        </button>
        {manual ? (
          <>
            <Field label="衣物名称">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="例如：米白色针织衫"
                maxLength={120}
              />
            </Field>
            <Field label="类别">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                {Object.entries(categories).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={remove}
                onChange={(e) => setRemove(e.target.checked)}
              />
              <span>
                自动去除照片背景<small>在本机处理；保留去背景前的照片。</small>
              </span>
            </label>
            {remove && !state.features.background_removal_ready && (
              <p className="small muted">
                图片处理模块尚未准备好；上传会保留原图，之后可重新去背景。
              </p>
            )}
            {files.length > 0 && (
              <div className="file-list">
                {files.map((f, index) => (
                  <div key={`${f.name}-${index}`}>
                    <ImagePlus size={17} />
                    <span>{f.name}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="small muted">
              {state.ai.capabilities.vision
                ? "已连接视觉模型，上传后自动识别；识别结果仍由你核对。"
                : "上传后手动确认类别、颜色等信息，即可开始搭配。"}
            </p>
          </>
        )}
        <ErrorText error={error} />
        <Button type="submit" busy={busy} disabled={!manual && !files.length}>
          {busy
            ? "正在录入与处理图片…"
            : manual
              ? "添加这件衣物"
              : `添加${files.length ? ` ${files.length} 件` : ""}衣物`}
        </Button>
      </form>
    </Sheet>
  );
}
export function ItemEditor({
  item,
  onClose,
}: {
  item: Item;
  onClose: () => void;
}) {
  const { state, refresh, notify } = useApp();
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category);
  const [colors, setColors] = useState(
    item.colors.map(translateValue).join("、"),
  );
  const [brand, setBrand] = useState(item.brand || "");
  const [closet, setCloset] = useState(item.closet || "日常衣橱");
  const [notes, setNotes] = useState(item.notes || "");
  const [price, setPrice] = useState(item.price ?? "");
  const [currency, setCurrency] = useState(item.currency || "");
  const [date, setDate] = useState(item.purchased_at || "");
  const [status, setStatus] = useState(item.status);
  const [favorite, setFavorite] = useState(item.favorite);
  const [seasons, setSeasons] = useState(
    item.seasons.map(translateValue).join("、"),
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadedAI, setLoadedAI] = useState(item.updated_at);
  const seasonValues: Record<string, string[]> = {
    春: ["spring"],
    春季: ["spring"],
    夏: ["summer"],
    夏季: ["summer"],
    秋: ["autumn"],
    秋季: ["autumn"],
    冬: ["winter"],
    冬季: ["winter"],
    四季: ["spring", "summer", "autumn", "winter"],
    all: ["spring", "summer", "autumn", "winter"],
  };
  function applyRecognition() {
    setName(item.name);
    setCategory(item.category);
    setColors(item.colors.map(translateValue).join("、"));
    setBrand(item.brand || "");
    setSeasons(item.seasons.map(translateValue).join("、"));
    setLoadedAI(item.updated_at);
    notify("识别结果已填入，请核对后保存。");
  }
  async function action(kind: string) {
    if (busy) return;
    if (
      kind === "delete" &&
      !confirm(`删除“${itemName(item)}”？关联搭配和计划会同步更新。`)
    )
      return;
    setBusy(kind);
    setError("");
    try {
      if (kind === "save") {
        if (
          price !== "" &&
          (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) > 99999999.99)
        )
          throw new Error("价格应为不超过两位小数的非负金额。");
        await send(
          `/items/${item.id}`,
          {
            name: name.trim(),
            category,
            colors: colors
              .split(/[、,，]/)
              .map((x) => x.trim())
              .filter(Boolean),
            brand,
            closet: closet.trim() || "日常衣橱",
            notes,
            price: price === "" ? null : price,
            currency: currency || null,
            purchased_at: date || null,
            status,
            favorite,
            seasons: [
              ...new Set(
                seasons
                  .split(/[、,，]/)
                  .map((x) => x.trim())
                  .filter(Boolean)
                  .flatMap((s) => seasonValues[s] || [s]),
              ),
            ],
            confirmed: true,
          },
          "PATCH",
        );
      } else if (kind === "delete")
        await api(`/items/${item.id}`, { method: "DELETE" });
      else
        await api(
          kind === "analyze"
            ? `/ai/analyze/${item.id}`
            : `/items/${item.id}/${kind}`,
          { method: "POST" },
        );
      await refresh();
      notify(
        kind === "save"
          ? "衣物已确认，加入你的衣柜。"
          : kind === "delete"
            ? "衣物已删除。"
            : kind === "analyze"
              ? "已开始识别，完成后请核对。"
              : "处理完成。",
      );
      if (kind === "save" || kind === "delete") onClose();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Sheet
      title={item.confirmed ? "衣物详情" : "核对新衣物"}
      onClose={onClose}
      wide
    >
      <div className="item-editor">
        <div className="item-visual stack">
          <Garment item={item} />
          {(item.image_url || item.original_url) && (
            <div className="row wrap">
              <Button
                kind="secondary"
                busy={busy === "background"}
                disabled={!!busy}
                onClick={() => action("background")}
              >
                <WandSparkles size={16} />
                去背景
              </Button>
              {item.original_url && (
                <Button
                  kind="ghost"
                  disabled={!!busy}
                  onClick={() => action("restore")}
                >
                  <RotateCcw size={16} />
                  恢复原图
                </Button>
              )}
            </div>
          )}
          {item.background_status === "failed" && (
            <p className="small error">去背景未完成，当前保留原图，可重试。</p>
          )}
          {item.ai_status === "processing" && (
            <p className="small muted" role="status">
              AI 正在识别，完成后可填入建议。
            </p>
          )}
          {item.ai_status === "review" && item.updated_at !== loadedAI && (
            <div className="soft-panel stack tight">
              <p className="small">
                识别已完成，可将建议填入名称、类别、颜色、品牌和季节。
              </p>
              <Button kind="secondary" onClick={applyRecognition}>
                填入最新识别结果
              </Button>
            </div>
          )}
          {item.ai_status === "error" && (
            <p className="small error">识别未完成，可以手动填写或重新识别。</p>
          )}
          {state.ai.capabilities.vision && (
            <Button
              kind="secondary"
              disabled={!!busy || item.ai_status === "processing"}
              busy={busy === "analyze"}
              onClick={() => action("analyze")}
            >
              <Sparkles size={16} />
              重新识别
            </Button>
          )}
          <div className="mini-stats">
            <div>
              <strong>{item.wear_count}</strong>
              <span>穿着次数</span>
            </div>
            <div>
              <strong>{costPerWear(item)}</strong>
              <span>单次穿着成本</span>
            </div>
          </div>
        </div>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            action("save");
          }}
        >
          <Field label="名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="给衣物起个名字"
            />
          </Field>
          <div className="form-grid">
            <Field label="类别">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                {Object.entries(categories).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="状态">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Item["status"])}
              >
                <option value="available">可穿</option>
                <option value="laundry">待洗</option>
                <option value="archived">已归档</option>
              </select>
            </Field>
          </div>
          <Field label="颜色" hint="多种颜色用顿号分开。">
            <input
              value={colors}
              onChange={(e) => setColors(e.target.value)}
              placeholder="米白、蓝色"
            />
          </Field>
          <div className="form-grid">
            <Field label="品牌">
              <input value={brand} onChange={(e) => setBrand(e.target.value)} />
            </Field>
            <Field label="所属衣橱">
              <input
                value={closet}
                onChange={(e) => setCloset(e.target.value)}
              />
            </Field>
          </div>
          <Field label="适合季节">
            <input
              value={seasons}
              onChange={(e) => setSeasons(e.target.value)}
              placeholder="春季、秋季"
            />
          </Field>
          <details className="details" open={item.price != null}>
            <summary>购买信息</summary>
            <div className="stack tight">
              <div className="form-grid">
                <Field label="购买价格">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </Field>
                <Field label="币种">
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    {[
                      ["", "币种未填"],
                      ["CNY", "人民币"],
                      ["USD", "美元"],
                      ["EUR", "欧元"],
                      ["GBP", "英镑"],
                      ["JPY", "日元"],
                      ["KRW", "韩元"],
                      ["HKD", "港币"],
                      ["TWD", "新台币"],
                      ["CAD", "加元"],
                      ["AUD", "澳元"],
                      ["CHF", "瑞士法郎"],
                    ].map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="购买日期">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
            </div>
          </details>
          <Field label="备注">
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="材质、穿着感受或搭配想法"
            />
          </Field>
          <label className="check-row">
            <input
              type="checkbox"
              checked={favorite}
              onChange={(e) => setFavorite(e.target.checked)}
            />
            <Heart size={17} />
            加入收藏
          </label>
          <ErrorText error={error} />
          <Button type="submit" busy={busy === "save"} disabled={!!busy}>
            <Check size={17} />
            确认并保存
          </Button>
          <Button
            type="button"
            kind="danger"
            disabled={!!busy}
            onClick={() => action("delete")}
          >
            <Trash2 size={16} />
            删除衣物
          </Button>
        </form>
      </div>
    </Sheet>
  );
}
