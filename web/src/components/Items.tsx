import { useEffect, useRef, useState, type FormEvent } from "react";
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
  Link2,
  ChevronRight,
} from "lucide-react";
import { api, send, failure } from "../api";
import { useApp } from "../Store";
import {
  type Item,
  type Category,
  categories,
  itemName,
  costPerWear,
  money,
  translateValue,
  occasions as occasionNames,
} from "../types";
import { Button, Field, Sheet, Garment, ErrorText } from "./UI";
import { ImageImportOptions, LinkImport } from "./LinkImport";
import { ImageBeautyDialog } from "./ImageBeautyDialog";
import { AttributeChoice, ItemAttributeFields } from "./ItemAttributes";
import {
  itemAttributeDraft,
  observableAttributes,
  subcategories,
  type ItemAttributeDraft,
} from "../item-attributes";
import { ItemExtraDetails } from "./ItemExtraDetails";
const accessoryCategoryHint =
  "帽子、围巾、腰带、首饰、手表等归入配饰；包袋请单独选择“包袋”。";
function UploadPreview({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!URL.createObjectURL) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return (
    <span className="upload-preview" aria-hidden="true">
      {url ? <img src={url} alt="" /> : <ImagePlus size={20} />}
    </span>
  );
}
export function AddSheet({ onClose }: { onClose: () => void }) {
  const { refresh, notify, openItem } = useApp();
  const photo = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [remove, setRemove] = useState(true);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [manual, setManual] = useState(false);
  const [linkImport, setLinkImport] = useState(false);
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
        notify("衣物已添加。");
      } else {
        if (!files.length) throw new Error("先选择衣物照片。");
        const form = new FormData();
        files.forEach((f) => form.append("files", f));
        form.append("remove_background", String(remove));
        form.append("auto_analyze", String(autoAnalyze));
        const result = await api<{ items: Item[]; warnings: string[] }>(
          "/items/upload",
          { method: "POST", body: form },
        );
        id = result.items[0]?.id;
        notify(
          result.warnings.length
            ? result.warnings.join("；")
            : `已添加 ${result.items.length} 件衣物，请核对信息。`,
          result.warnings.length ? "info" : "success",
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
  if (linkImport)
    return (
      <LinkImport
        onClose={onClose}
        onBack={() => {
          setManual(false);
          setLinkImport(false);
        }}
      />
    );
  return (
    <Sheet title="添加衣物" onClose={onClose} busy={busy}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">让衣柜从你常穿的一件开始。</p>
        <div className="add-options">
          <button
            type="button"
            disabled={busy}
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
            disabled={busy}
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
          disabled={busy}
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
          disabled={busy}
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
          disabled={busy}
          className="list-row"
          onClick={() => setLinkImport(true)}
        >
          <Link2 size={22} />
          <span>从链接导入</span>
          <span className="muted">商品页或图片链接</span>
        </button>
        <button
          type="button"
          disabled={busy}
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
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="例如：米白色针织衫"
                maxLength={120}
              />
            </Field>
            <Field
              label="类别"
              hint={
                category === "accessory" ? accessoryCategoryHint : undefined
              }
            >
              <select
                value={category}
                disabled={busy}
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
            <ImageImportOptions
              removeBackground={remove}
              onBackgroundChange={setRemove}
              autoAnalyze={autoAnalyze}
              onAutoAnalyzeChange={setAutoAnalyze}
              busy={busy}
            />
            {files.length > 0 && (
              <div className="file-list" aria-busy={busy}>
                {files.map((f, index) => (
                  <div key={`${f.name}-${f.lastModified}-${index}`}>
                    <span className={busy ? "image-processing" : undefined}>
                      <UploadPreview file={f} />
                    </span>
                    <span>{f.name}</span>
                  </div>
                ))}
              </div>
            )}
            {busy && (
              <div className="upload-status" role="status">
                <span className="upload-status__track" aria-hidden="true" />
                <p className="small muted">
                  正在上传{remove ? "并处理" : ""} {files.length}{" "}
                  张照片，请稍候。
                </p>
              </div>
            )}
          </>
        )}
        <ErrorText error={error} />
        <Button type="submit" busy={busy} disabled={!manual && !files.length}>
          {busy
            ? manual
              ? "正在保存衣物…"
              : "正在录入与处理图片…"
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
  const [occasions, setOccasions] = useState(
    item.occasions.map(translateValue).join("、"),
  );
  const [tags, setTags] = useState(item.tags.join("、"));
  const [attributes, setAttributes] = useState(() => itemAttributeDraft(item));
  const editedRecognition = useRef(new Set<string>());
  const [busy, setBusy] = useState("");
  const [beautyOpen, setBeautyOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState("");
  const [loadedAI, setLoadedAI] = useState(item.updated_at);
  const [recognitionApplied, setRecognitionApplied] = useState(
    item.ai_status === "review",
  );
  const reference = item.reference_price;
  let referenceSource = "";
  if (reference) {
    try {
      referenceSource = new URL(reference.source_url).hostname;
    } catch {
      referenceSource = "";
    }
  }
  useEffect(() => {
    if (item.ai_status === "review" && item.updated_at !== loadedAI)
      fillRecognition(false);
  }, [item, loadedAI]);
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
  function fillRecognition(replaceManual: boolean) {
    const mayFill = (field: string) =>
      replaceManual || !editedRecognition.current.has(field);
    if (mayFill("name")) setName(item.name);
    if (mayFill("category")) setCategory(item.category);
    if (mayFill("colors"))
      setColors(item.colors.map(translateValue).join("、"));
    if (mayFill("brand")) setBrand(item.brand || "");
    if (mayFill("seasons"))
      setSeasons(item.seasons.map(translateValue).join("、"));
    if (mayFill("occasions"))
      setOccasions(item.occasions.map(translateValue).join("、"));
    if (mayFill("tags")) setTags(item.tags.join("、"));
    const recognized = itemAttributeDraft(item);
    setAttributes((previous) => {
      const next = { ...previous };
      for (const field of observableAttributes) {
        if (mayFill(field)) Object.assign(next, { [field]: recognized[field] });
      }
      return next;
    });
    if (replaceManual) editedRecognition.current.clear();
    setLoadedAI(item.updated_at);
    setRecognitionApplied(true);
  }
  function applyRecognition() {
    fillRecognition(true);
    notify("识别结果已填入，请核对后保存。");
  }
  function changeAttribute<K extends keyof ItemAttributeDraft>(
    field: K,
    value: ItemAttributeDraft[K],
  ) {
    editedRecognition.current.add(field);
    setAttributes((previous) => ({ ...previous, [field]: value }));
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
      let backgroundFailed = false;
      if (kind === "save") {
        if (
          price !== "" &&
          (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) > 99999999.99)
        )
          throw new Error("价格应为不超过两位小数的非负金额。");
        const materials = [
          ...new Set(attributes.materials.map((v) => v.trim()).filter(Boolean)),
        ];
        const styles = [
          ...new Set(attributes.styles.map((v) => v.trim()).filter(Boolean)),
        ];
        if (materials.length > 10 || styles.length > 12)
          throw new Error("材质最多填写 10 项，风格最多填写 12 项。");
        if ([...materials, ...styles].some((v) => v.length > 80))
          throw new Error("每项材质或风格请控制在 80 字以内。");
        await send(
          `/items/${item.id}`,
          {
            name: name.trim(),
            category,
            ...attributes,
            materials,
            styles,
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
            occasions: [
              ...new Set(
                occasions
                  .split(/[、,，]/)
                  .map((value) => value.trim())
                  .filter(Boolean)
                  .map(
                    (value) =>
                      Object.entries(occasionNames).find(
                        ([, label]) => label === value,
                      )?.[0] || value,
                  ),
              ),
            ],
            tags: [
              ...new Set(
                tags
                  .split(/[、,，]/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              ),
            ],
            confirmed: true,
          },
          "PATCH",
        );
      } else if (kind === "delete")
        await api(`/items/${item.id}`, { method: "DELETE" });
      else if (kind === "analyze")
        await api(`/ai/analyze/${item.id}`, { method: "POST" });
      else {
        const changed = await api<Item>(`/items/${item.id}/${kind}`, {
          method: "POST",
        });
        backgroundFailed =
          kind === "background" && changed.background_status === "failed";
      }
      await refresh();
      notify(
        kind === "save"
          ? "衣物已确认，加入你的衣柜。"
          : kind === "delete"
            ? "衣物已删除。"
            : kind === "analyze"
              ? "已开始识别，完成后请核对。"
              : backgroundFailed
                ? "去背景未完成，已保留原图，可以重试。"
                : kind === "restore"
                  ? "已恢复原图。"
                  : "背景已去除。",
        backgroundFailed || kind === "analyze" ? "info" : "success",
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
      onClose={() => {
        if (!busy) onClose();
      }}
      busy={!!busy}
      wide
    >
      <div className="item-editor">
        <div className="item-visual stack">
          <Garment
            item={item}
            processing={
              busy === "background" || item.ai_status === "processing"
            }
          />
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
              <Button
                kind="secondary"
                disabled={!!busy}
                onClick={() => setBeautyOpen(true)}
              >
                <Sparkles size={16} />
                图片美化
              </Button>
              {item.original_url && (
                <Button
                  kind="ghost"
                  busy={busy === "restore"}
                  disabled={!!busy}
                  onClick={() => action("restore")}
                >
                  <RotateCcw size={16} />
                  恢复原图
                </Button>
              )}
            </div>
          )}
          {(busy === "background" || busy === "restore") && (
            <p className="small muted" role="status">
              {busy === "background" ? "正在去除照片背景…" : "正在恢复原图…"}
            </p>
          )}
          {item.background_status === "failed" && (
            <p className="small error">去背景未完成，当前保留原图，可重试。</p>
          )}
          {item.ai_status === "processing" && (
            <p className="small muted" role="status">
              AI 正在识别，完成后会自动填入尚未修改的信息。
            </p>
          )}
          {item.ai_status === "review" && recognitionApplied && (
            <div className="soft-panel stack tight recognition-ready">
              <p className="small" role="status">
                {editedRecognition.current.size
                  ? "识别结果已填入未修改的字段，你手动编辑的信息已保留。"
                  : "识别信息已自动填入，请核对后保存。"}
              </p>
              {editedRecognition.current.size > 0 && (
                <Button kind="secondary" onClick={applyRecognition}>
                  填入最新识别结果
                </Button>
              )}
            </div>
          )}
          {item.ai_status === "error" && (
            <p className="small error" role="alert">
              {item.ai_error || "识别未完成，可以手动填写或重新识别。"}
            </p>
          )}
          {state.ai.capabilities.vision &&
            (item.image_url || item.original_url) && (
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
          <fieldset className="item-editor-fields stack" disabled={!!busy}>
            <Field label="名称">
              <input
                value={name}
                onChange={(e) => {
                  editedRecognition.current.add("name");
                  setName(e.target.value);
                }}
                maxLength={120}
                placeholder="给衣物起个名字"
              />
            </Field>
            <div className="form-grid">
              <Field
                label="类别"
                hint={
                  category === "accessory" ? accessoryCategoryHint : undefined
                }
              >
                <select
                  value={category}
                  onChange={(e) => {
                    editedRecognition.current.add("category");
                    setCategory(e.target.value as Category);
                  }}
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
            <AttributeChoice
              label="子分类"
              value={attributes.subcategory}
              choices={subcategories[category]}
              onChange={(v) => changeAttribute("subcategory", v)}
            />
            <Field label="颜色" hint="多种颜色用顿号分开。">
              <input
                value={colors}
                onChange={(e) => {
                  editedRecognition.current.add("colors");
                  setColors(e.target.value);
                }}
                placeholder="米白、蓝色"
              />
            </Field>
            <div className="form-grid">
              <Field label="品牌">
                <input
                  value={brand}
                  onChange={(e) => {
                    editedRecognition.current.add("brand");
                    setBrand(e.target.value);
                  }}
                />
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
                onChange={(e) => {
                  editedRecognition.current.add("seasons");
                  setSeasons(e.target.value);
                }}
                placeholder="春季、秋季"
              />
            </Field>
            <Field
              label="适合场合"
              hint="日常、工作、运动、正式，多种场合用顿号分开。"
            >
              <input
                value={occasions}
                onChange={(e) => {
                  editedRecognition.current.add("occasions");
                  setOccasions(e.target.value);
                }}
                placeholder="日常、工作"
              />
            </Field>
            <Field
              label="衣物标签"
              hint="可填写袖长、图案、版型等，多标签用顿号分开。"
            >
              <input
                value={tags}
                onChange={(e) => {
                  editedRecognition.current.add("tags");
                  setTags(e.target.value);
                }}
                placeholder="短袖、纯色、宽松"
              />
            </Field>
            <details
              className="details"
              open={item.price != null || !!reference}
            >
              <summary>购买信息</summary>
              <div className="stack tight">
                {reference && (
                  <aside
                    className="soft-panel stack tight"
                    aria-label="参考价格"
                  >
                    <div className="row wrap">
                      <span>参考价 · {reference.label}</span>
                      <strong>
                        {money(reference.amount, reference.currency)}
                      </strong>
                    </div>
                    <p className="small muted">
                      {referenceSource && `来源：${referenceSource} · `}
                      <time dateTime={reference.observed_at}>
                        {new Date(reference.observed_at).toLocaleDateString(
                          "zh-CN",
                        )}
                      </time>
                    </p>
                    <p className="small muted">
                      {reference.label === "发售价格"
                        ? "仅供参考，不代表实际支付金额。"
                        : "价格随款式与活动变化。"}
                    </p>
                    <Button
                      type="button"
                      kind="secondary"
                      disabled={!!busy}
                      onClick={() => {
                        setPrice(reference.amount.toFixed(2));
                        setCurrency(reference.currency);
                      }}
                    >
                      {price === "" ? "用作购入价" : "替换为参考价"}
                    </Button>
                  </aside>
                )}
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
            <ItemAttributeFields
              value={attributes}
              onChange={changeAttribute}
            />
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
            <Button
              type="button"
              kind="secondary"
              className="item-extra-entry"
              disabled={!!busy}
              onClick={() => setDetailsOpen(true)}
            >
              <span>
                详情<small>风格、版型与洗护等补充信息</small>
              </span>
              <ChevronRight size={18} />
            </Button>
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
          </fieldset>
        </form>
      </div>
      {beautyOpen && (
        <ImageBeautyDialog item={item} onClose={() => setBeautyOpen(false)} />
      )}
      {detailsOpen && (
        <ItemExtraDetails
          item={item}
          value={attributes}
          onChange={changeAttribute}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </Sheet>
  );
}
