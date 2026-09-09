import { useMemo, useState } from "react";
import {
  ArrowDownWideNarrow,
  Heart,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useApp } from "../Store";
import { categories, type Category, itemName, dateLabel } from "../types";
import { Button, Garment, Empty, Field, Sheet } from "../components/UI";
import { FeatureIcon } from "../components/FeatureIcon";
export function Wardrobe() {
  const { state, openItem, openAdd, navigate } = useApp();
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("new");
  const [status, setStatus] = useState("all");
  const [favorite, setFavorite] = useState(false);
  const [closet, setCloset] = useState("all");
  const [filter, setFilter] = useState(false);
  const [review, setReview] = useState(false);
  const wardrobes = [...new Set(state.items.map((i) => i.closet))];
  const shown = useMemo(
    () =>
      state.items
        .filter(
          (i) =>
            (status === "archived"
              ? i.status === "archived"
              : i.status !== "archived") &&
            (status === "all" || i.status === status) &&
            (category === "all" || i.category === category) &&
            (!favorite || i.favorite) &&
            (!review || !i.confirmed) &&
            (closet === "all" || i.closet === closet) &&
            `${itemName(i)} ${i.brand} ${i.colors.join(" ")} ${i.tags.join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "name"
            ? itemName(a).localeCompare(itemName(b), "zh-CN")
            : sort === "wear"
              ? b.wear_count - a.wear_count
              : sort === "unused"
                ? a.wear_count - b.wear_count
                : b.created_at.localeCompare(a.created_at),
        ),
    [state.items, status, category, favorite, review, closet, query, sort],
  );
  const pending = state.items.filter((i) => !i.confirmed).length;
  return (
    <div className="page wardrobe-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">每件衣物，都有自己的位置</p>
          <h1>我的衣柜</h1>
        </div>
        <span className="count-label">
          {state.items.filter((i) => i.status !== "archived").length} 件衣物
        </span>
      </div>
      <div className="closet-summary">
        <div>
          <strong>
            {pending ? `${pending} 件衣物等待确认` : "把喜欢的衣物，再穿一次"}
          </strong>
          <p>
            {pending
              ? "核对类别和颜色，让下一套搭配更准确。"
              : "整理、发现，让你的衣柜用起来。"}
          </p>
        </div>
        {pending > 0 && (
          <Button kind="secondary" onClick={() => setReview(!review)}>
            {review ? "查看全部" : "去确认"}
          </Button>
        )}
      </div>
      <div className="wardrobe-shortcuts">
        <button onClick={openAdd}>
          <span className="illustrated-shortcut">
            <FeatureIcon name="add" />
          </span>
          添加衣物
        </button>
        <button onClick={() => navigate("stats")}>
          <span className="illustrated-shortcut">
            <FeatureIcon name="stats" />
          </span>
          风格统计
        </button>
        <button
          onClick={() => setFavorite(!favorite)}
          className={favorite ? "active" : ""}
        >
          <span>
            <Heart size={23} fill={favorite ? "currentColor" : "none"} />
          </span>
          我的收藏
        </button>
        <button
          onClick={() => setStatus(status === "laundry" ? "all" : "laundry")}
        >
          <span>
            <ShirtIcon />
          </span>
          待洗衣物
        </button>
      </div>
      <div className="closet-toolbar">
        <label className="plain-select">
          <select
            aria-label="选择衣橱"
            value={closet}
            onChange={(e) => setCloset(e.target.value)}
          >
            <option value="all">所有衣橱</option>
            {wardrobes.map((w) => (
              <option key={w}>{w}</option>
            ))}
          </select>
        </label>
        <span className="muted small">{shown.length} 件</span>
      </div>
      <div className="row filters-line">
        <button
          className={`icon-button bordered ${filter ? "active" : ""}`}
          aria-label="筛选衣物"
          onClick={() => setFilter(true)}
        >
          <SlidersHorizontal size={20} />
        </button>
        <label className="sort-select">
          <ArrowDownWideNarrow size={17} />
          <select
            aria-label="衣物排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="new">按添加日期</option>
            <option value="wear">最常穿</option>
            <option value="unused">最少穿</option>
            <option value="name">按名称</option>
          </select>
        </label>
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索衣柜"
            placeholder="搜索衣物"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="category-tabs" role="tablist" aria-label="衣物类别">
        {[["all", "全部"], ...Object.entries(categories)].map(([v, l]) => (
          <button
            key={v}
            role="tab"
            aria-selected={category === v}
            onClick={() => setCategory(v)}
          >
            {l}
          </button>
        ))}
      </div>
      {!state.items.length ? (
        <Empty
          title="衣柜的第一件，由你决定"
          description="上传照片或手动添加，开始记录你真正拥有的衣物。"
          action={
            <Button onClick={openAdd}>
              <Plus size={18} />
              添加第一件衣物
            </Button>
          }
        />
      ) : (
        <>
          <div className="wardrobe-grid">
            {shown.map((i) => (
              <button
                className="garment-card"
                key={i.id}
                onClick={() => openItem(i.id)}
              >
                <Garment item={i} />
                {i.favorite && (
                  <Heart
                    className="favorite-mark"
                    size={15}
                    fill="currentColor"
                  />
                )}
                {!i.confirmed && <span className="item-badge">待确认</span>}
                <div className="garment-caption">
                  <strong>{itemName(i)}</strong>
                  <span>{i.brand || categories[i.category]}</span>
                  <small>
                    {i.status === "laundry"
                      ? "待洗"
                      : i.status === "archived"
                        ? "已归档"
                        : dateLabel(i.created_at)}
                  </small>
                </div>
              </button>
            ))}
            <button className="add-grid-card" onClick={openAdd}>
              <span>
                <Plus size={30} />
              </span>
              添加衣物
            </button>
          </div>
          {!shown.length && (
            <p className="empty-small">没有符合这些筛选条件的衣物。</p>
          )}
        </>
      )}
      {filter && (
        <Sheet title="筛选衣物" onClose={() => setFilter(false)}>
          <div className="stack">
            <Field label="可用状态">
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">全部日常衣物</option>
                <option value="available">可以穿</option>
                <option value="laundry">待洗</option>
                <option value="archived">已归档</option>
              </select>
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                checked={favorite}
                onChange={(e) => setFavorite(e.target.checked)}
              />
              只看收藏
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
              />
              只看待确认
            </label>
            <Button onClick={() => setFilter(false)}>
              查看 {shown.length} 件衣物
            </Button>
            <Button
              kind="ghost"
              onClick={() => {
                setStatus("all");
                setFavorite(false);
                setReview(false);
                setCategory("all");
                setQuery("");
                setCloset("all");
              }}
            >
              重置筛选
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
function ShirtIcon() {
  return (
    <svg
      width="25"
      height="25"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M6 4 2 8l3 3 2-2v11h10V9l2 2 3-3-4-4-3-1a3 3 0 0 1-6 0Z" />
      <path d="M9 13h6m-6 3h4" />
    </svg>
  );
}
