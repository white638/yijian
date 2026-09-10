import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Copy, Plus, Share2, Shirt, Trash2 } from "lucide-react";
import { api, send, failure } from "../api";
import { useApp } from "../Store";
import { categories, itemName, type Category } from "../types";
import {
  Button,
  ErrorText,
  Field,
  Garment,
  IconButton,
  Sheet,
  Empty,
} from "./UI";
import { ItemPicker } from "./Outfits";
import "../online.css";

interface SharedItem {
  id: string;
  item_id?: string;
  name: string;
  category: Category;
  brand: string;
  image_id: string | null;
}
interface Share {
  id: string;
  question: string;
  status: "active" | "closed" | "revoked" | "expired" | "imported";
  expires_at: string;
  created_at: string;
  items: SharedItem[];
  suggestion_count?: number;
}
interface Reply {
  id: string;
  nickname: string;
  text: string;
  item_ids: string[];
  snapshot_item_ids: string[];
  created_at: string;
}
interface SharedView {
  question: string;
  items: SharedItem[];
  expires_at: string;
  accepting: boolean;
}
const statusNames = {
  active: "接受建议",
  closed: "已关闭回复",
  revoked: "已撤销",
  expired: "已到期",
  imported: "导入的分享历史",
};
const dateText = (date: string | number) =>
  new Date(
    typeof date === "number" && date < 1e12 ? date * 1000 : date,
  ).toLocaleDateString("zh-CN");

function GuestPhoto({
  item,
  token,
  onInvalid,
}: {
  item: SharedItem;
  token: string;
  onInvalid: () => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!item.image_id) return;
    const controller = new AbortController();
    let objectUrl = "";
    fetch(`/api/share/images/${encodeURIComponent(item.image_id)}`, {
      credentials: "omit",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) {
          if ([401, 403, 404, 410].includes(r.status)) onInvalid();
          return;
        }
        const blob = await r.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.image_id, token]);
  return (
    <div className="shared-photo">
      {url ? (
        <img src={url} alt={item.name} />
      ) : (
        <Shirt size={35} aria-label="衣物照片" />
      )}
    </div>
  );
}

export function ShareGuest({ token }: { token: string }) {
  const [view, setView] = useState<SharedView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("all");
  const [ids, setIds] = useState<string[]>([]);
  const [nickname, setNickname] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const generation = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const headers = { Authorization: `Bearer ${token}` };
  function invalid() {
    generation.current++;
    setView(null);
    setLoading(false);
    setError("分享链接已失效，请向主人获取新链接。");
  }
  async function load() {
    const version = ++generation.current;
    try {
      const next = await api<SharedView>("/share/view", {
        method: "POST",
        body: "{}",
        headers,
        credentials: "omit",
        cache: "no-store",
      });
      if (version === generation.current) {
        setView(next);
        setError("");
      }
    } catch (e) {
      if (version === generation.current) {
        setView(null);
        setError(failure(e));
      }
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    document.title = "朋友的衣柜 · 衣间";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow, noarchive";
    document.head.append(robots);
    const referrer = document.createElement("meta");
    referrer.name = "referrer";
    referrer.content = "no-referrer";
    document.head.append(referrer);
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      generation.current++;
      clearInterval(timer);
      robots.remove();
      referrer.remove();
      document.title = "衣间";
    };
  }, [token]);
  async function reply(e: FormEvent) {
    e.preventDefault();
    if (busy || !view?.accepting || submitted) return;
    setBusy(true);
    setError("");
    try {
      await api("/share/reply", {
        method: "POST",
        credentials: "omit",
        headers,
        body: JSON.stringify({
          request_id: requestId.current,
          nickname: nickname.trim(),
          text: text.trim(),
          item_ids: ids,
        }),
      });
      setSubmitted(true);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  if (!view)
    return (
      <main className="account-entry">
        <span className="brand-word">衣间</span>
        {loading ? (
          <p role="status">正在打开朋友的衣柜…</p>
        ) : (
          <section className="settings-card stack">
            <ErrorText error={error} />
            <Button onClick={load}>重新查看</Button>
          </section>
        )}
      </main>
    );
  const shown = view.items.filter(
    (i) => category === "all" || i.category === category,
  );
  return (
    <main className="share-guest">
      <header className="share-brand">
        <span className="brand-word">衣间</span>
        <span className="small muted">朋友的衣柜</span>
      </header>
      <div className="share-guest-layout">
        <aside className="share-question">
          <span className="account-mark">
            <Share2 size={23} />
          </span>
          <h1>{view.question}</h1>
          <p className="small muted">
            {view.items.length} 件衣物 · 有效至 {dateText(view.expires_at)}
          </p>
          {submitted ? (
            <section className="soft-panel stack" role="status">
              <h2>建议已送达</h2>
              <p>谢谢你的搭配想法。主人可以查看并保存你的建议。</p>
              {text && <p>{text}</p>}
            </section>
          ) : (
            <form ref={form} className="stack share-reply" onSubmit={reply}>
              <h2>给出建议</h2>
              <p className="small muted">
                可以写几句话，也可以选几件衣物组成搭配。
              </p>
              <fieldset
                disabled={busy || !view.accepting}
                className="account-fields stack"
              >
                <Field label="怎么称呼你（选填）">
                  <input
                    value={nickname}
                    onChange={(e) => {
                      requestId.current = crypto.randomUUID();
                      setNickname(e.target.value);
                    }}
                    maxLength={40}
                    autoComplete="nickname"
                  />
                </Field>
                <Field label="你的建议">
                  <textarea
                    rows={4}
                    value={text}
                    onChange={(e) => {
                      requestId.current = crypto.randomUUID();
                      setText(e.target.value);
                    }}
                    maxLength={2000}
                    placeholder="例如：这件衬衫配浅色长裤，会更轻松。"
                  />
                </Field>
                <p className="small muted">
                  已选 {ids.length} 件。建议交给主人保存。
                </p>
                <Button
                  type="submit"
                  busy={busy}
                  disabled={
                    busy || !view.accepting || (!text.trim() && !ids.length)
                  }
                >
                  送出建议
                </Button>
              </fieldset>
              {!view.accepting && (
                <p className="small muted" role="status">
                  主人已关闭回复，仍可查看这次分享。
                </p>
              )}
              <ErrorText error={error} />
            </form>
          )}
        </aside>
        <section className="share-garments">
          <div
            className="studio-picker-categories"
            role="group"
            aria-label="筛选分享衣物"
          >
            {[
              ["all", "全部"],
              ...Object.entries(categories).filter(([key]) =>
                view.items.some((i) => i.category === key),
              ),
            ].map(([key, label]) => (
              <button
                type="button"
                key={key}
                aria-pressed={category === key}
                onClick={() => setCategory(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="share-item-grid">
            {shown.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`shared-item ${ids.includes(item.id) ? "selected" : ""}`}
                aria-pressed={ids.includes(item.id)}
                disabled={busy || submitted || !view.accepting}
                onClick={() => {
                  requestId.current = crypto.randomUUID();
                  setIds((prev) =>
                    prev.includes(item.id)
                      ? prev.filter((id) => id !== item.id)
                      : [...prev, item.id],
                  );
                }}
              >
                <GuestPhoto item={item} token={token} onInvalid={invalid} />
                <strong>{item.name}</strong>
                <small>{item.brand || "未填写品牌"}</small>
                {ids.includes(item.id) && (
                  <span className="share-selected">已选择</span>
                )}
              </button>
            ))}
          </div>
        </section>
      </div>
      {!submitted && view.accepting && (
        <div className="share-mobile-action">
          <Button
            onClick={() => {
              form.current?.scrollIntoView({
                behavior: window.matchMedia?.(
                  "(prefers-reduced-motion: reduce)",
                ).matches
                  ? "auto"
                  : "smooth",
                block: "start",
              });
              form.current?.querySelector("textarea")?.focus();
            }}
          >
            给出建议{ids.length ? ` · 已选 ${ids.length} 件` : ""}
          </Button>
        </div>
      )}
    </main>
  );
}

export function ShareManager() {
  const { state, navigate, openOutfit, notify } = useApp();
  const [shares, setShares] = useState<Share[]>([]);
  const [selected, setSelected] = useState<Share | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [create, setCreate] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [days, setDays] = useState(7);
  const [preview, setPreview] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function load() {
    const data = await api<{ shares: Share[] }>("/shares");
    setShares(data.shares);
  }
  useEffect(() => {
    let active = true;
    api<{ shares: Share[] }>("/shares")
      .then((data) => {
        if (active) setShares(data.shares);
      })
      .catch((e) => {
        if (active) setError(failure(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function open(share: Share) {
    setBusy("open");
    setError("");
    setLink("");
    try {
      const detail = await api<{ share: Share; suggestions: Reply[] }>(
        `/shares/${encodeURIComponent(share.id)}`,
      );
      setSelected(detail.share);
      setReplies(detail.suggestions);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function createShare() {
    if (busy) return;
    setBusy("create");
    setError("");
    try {
      const result = await send<{ share: Share; token: string }>("/shares", {
        question: question.trim(),
        item_ids: ids,
        expires_days: days,
      });
      setSelected(result.share);
      setReplies([]);
      setLink(
        `${location.origin}${location.pathname}#share=${encodeURIComponent(result.token)}`,
      );
      setCreate(false);
      setPreview(false);
      setIds([]);
      setQuestion("");
      await load();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function manage(action: string) {
    if (!selected || busy) return;
    if (
      action === "revoke" &&
      !confirm("撤销后，这个链接将无法继续查看衣物或提交建议。确认撤销？")
    )
      return;
    setBusy(action);
    setError("");
    try {
      const result = await send<{ share: Share; token?: string }>(
        `/shares/${encodeURIComponent(selected.id)}`,
        { action },
        "PATCH",
      );
      setSelected(result.share);
      setLink(
        result.token
          ? `${location.origin}${location.pathname}#share=${encodeURIComponent(result.token)}`
          : "",
      );
      await load();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      notify("分享链接已复制。");
    } catch {
      setError("无法访问剪贴板，请手动复制下方链接。");
    }
  }
  async function deleteShare() {
    if (
      !selected ||
      busy ||
      !confirm(
        "永久删除这份分享及收到的所有建议？旧链接会立即失效，此操作无法撤销。",
      )
    )
      return;
    setBusy("delete-share");
    setError("");
    try {
      await api(`/shares/${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
      });
      setSelected(null);
      setReplies([]);
      setLink("");
      await load();
      notify("分享及收到的建议已删除。");
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="page sharing-page">
      <div className="page-heading">
        <div className="row">
          <IconButton label="返回衣柜" onClick={() => navigate("wardrobe")}>
            <ArrowLeft size={23} />
          </IconButton>
          <h1>我的分享</h1>
        </div>
        <Button
          onClick={() => {
            setCreate(true);
            setPreview(false);
            setError("");
          }}
        >
          <Plus size={18} />
          分享衣柜
        </Button>
      </div>
      <p className="muted">
        选几件衣物，把问题发给家人或朋友。他们直接打开链接就能给建议。
      </p>
      <ErrorText error={!selected && !create ? error : ""} />
      {shares.length ? (
        <div className="share-list">
          {shares.map((share) => (
            <button
              key={share.id}
              className="settings-card share-list-card"
              disabled={!!busy}
              onClick={() => void open(share)}
            >
              <strong>{share.question}</strong>
              <span>
                {share.items.length} 件衣物 · {share.suggestion_count || 0}{" "}
                条建议 · {statusNames[share.status]}
              </span>
              <small>{dateText(share.created_at)}</small>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="让朋友帮你看看怎么穿"
          description="创建一次分享，只展示你选中的衣物。"
          action={
            <Button kind="secondary" onClick={() => setCreate(true)}>
              创建分享
            </Button>
          }
        />
      )}
      {create && (
        <Sheet
          title={preview ? "朋友将看到的内容" : "分享衣柜"}
          onClose={() => {
            if (!busy) {
              setCreate(false);
              setPreview(false);
              setError("");
            }
          }}
          busy={!!busy}
          wide
        >
          <div className="stack">
            {preview ? (
              <>
                <h3>{question}</h3>
                <div className="share-preview-grid">
                  {ids
                    .map((id) => state.items.find((i) => i.id === id))
                    .filter((i) => !!i)
                    .map((item) => (
                      <figure key={item.id}>
                        <Garment item={item} />
                        <figcaption>
                          {itemName(item)}
                          <small>
                            {categories[item.category]} ·{" "}
                            {item.brand || "未填写品牌"}
                          </small>
                        </figcaption>
                      </figure>
                    ))}
                </div>
                <p className="small muted">
                  只分享以上图片、名称、类别和品牌。链接在 {days}{" "}
                  天后失效；收到链接的人也可以转发。
                </p>
                <ErrorText error={error} />
                <Button
                  busy={busy === "create"}
                  disabled={!!busy}
                  onClick={createShare}
                >
                  生成分享链接
                </Button>
                <Button
                  kind="ghost"
                  disabled={!!busy}
                  onClick={() => setPreview(false)}
                >
                  返回修改
                </Button>
              </>
            ) : (
              <>
                <Field label="想问朋友什么">
                  <textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder="这两件周末一起穿合适吗？"
                  />
                </Field>
                <Field label="链接有效期">
                  <select
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    <option value={1}>1 天</option>
                    <option value={7}>7 天</option>
                    <option value={30}>30 天</option>
                  </select>
                </Field>
                <ItemPicker
                  selected={ids}
                  onChange={setIds}
                  items={state.items.filter(
                    (item) =>
                      item.status !== "archived" &&
                      !!(item.image_url || item.original_url),
                  )}
                  grouped
                  limit={24}
                />
                <p className="small muted">
                  可选择已保存照片的衣物。没有照片的单品，请先添加照片后再分享。
                </p>
                <Button
                  disabled={!question.trim() || !ids.length}
                  onClick={() => setPreview(true)}
                >
                  预览分享内容
                </Button>
              </>
            )}
          </div>
        </Sheet>
      )}
      {selected && (
        <Sheet
          title="我的分享"
          onClose={() => {
            if (!busy) {
              setSelected(null);
              setLink("");
              setError("");
            }
          }}
          busy={!!busy}
          wide
        >
          <div className="stack">
            <h3>{selected.question}</h3>
            <p className="small muted">
              {statusNames[selected.status]} · {selected.items.length} 件衣物 ·{" "}
              {dateText(selected.expires_at)}
            </p>
            <div className="share-preview-grid">
              {selected.items.map((item) => (
                <figure key={item.id}>
                  <div className="shared-photo">
                    {item.image_id ? (
                      <img
                        src={`/api/shares/${encodeURIComponent(selected.id)}/images/${encodeURIComponent(item.image_id)}`}
                        alt={item.name}
                      />
                    ) : (
                      <Shirt size={32} />
                    )}
                  </div>
                  <figcaption>
                    {item.name}
                    <small>{item.brand || "未填写品牌"}</small>
                  </figcaption>
                </figure>
              ))}
            </div>
            {link && (
              <section className="soft-panel stack">
                <Field label="分享链接">
                  <input
                    readOnly
                    value={link}
                    onFocus={(e) => e.target.select()}
                  />
                </Field>
                <div className="row wrap">
                  <Button onClick={copyLink}>
                    <Copy size={17} />
                    复制链接
                  </Button>
                  {!!navigator.share && (
                    <Button
                      kind="secondary"
                      onClick={async () => {
                        try {
                          await navigator.share({
                            title: "衣间 · 帮我看看怎么穿",
                            url: link,
                          });
                        } catch (e) {
                          if (
                            !(
                              e instanceof DOMException &&
                              e.name === "AbortError"
                            )
                          )
                            setError("分享菜单未打开，可以复制链接发送。");
                        }
                      }}
                    >
                      <Share2 size={17} />
                      分享
                    </Button>
                  )}
                </div>
                <p className="small muted">
                  关闭此页面前请复制链接。重新生成链接后，旧链接会失效。
                </p>
              </section>
            )}
            {selected.status !== "imported" && (
              <div className="row wrap">
                {selected.status === "active" && (
                  <Button
                    kind="secondary"
                    disabled={!!busy}
                    onClick={() => void manage("close")}
                  >
                    关闭回复
                  </Button>
                )}
                {!["revoked", "expired"].includes(selected.status) && (
                  <Button
                    kind="secondary"
                    disabled={!!busy}
                    onClick={() => void manage("revoke")}
                  >
                    撤销链接
                  </Button>
                )}
                <Button
                  kind="secondary"
                  disabled={!!busy}
                  onClick={() => void manage("regenerate")}
                >
                  重新生成链接
                </Button>
              </div>
            )}
            <ErrorText error={error} />
            <h3>朋友的建议</h3>
            {replies.length ? (
              replies.map((reply) => {
                const valid = reply.item_ids.filter((id) =>
                  state.items.some(
                    (i) =>
                      i.id === id && i.confirmed && i.status === "available",
                  ),
                );
                return (
                  <article className="soft-panel stack" key={reply.id}>
                    <div className="row between">
                      <strong>{reply.nickname || "朋友"}</strong>
                      <small className="muted">
                        {dateText(reply.created_at)}
                      </small>
                    </div>
                    <p>{reply.text}</p>
                    {reply.item_ids.length > 0 && (
                      <>
                        <div className="row wrap">
                          {reply.item_ids.map((id) => (
                            <span className="small" key={id}>
                              {state.items.find((i) => i.id === id)?.name ||
                                "衣物已不存在"}
                            </span>
                          ))}
                        </div>
                        {valid.length !== reply.item_ids.length && (
                          <p className="small muted">
                            部分衣物已不可用。将保留可用单品，进入编辑器后可补充调整。
                          </p>
                        )}
                        <Button
                          kind="secondary"
                          disabled={!valid.length || !!busy}
                          onClick={() => {
                            setSelected(null);
                            setLink("");
                            openOutfit(undefined, {
                              name: "朋友的搭配建议",
                              item_ids: valid,
                              notes: reply.text,
                              source: "manual",
                            });
                          }}
                        >
                          保存为搭配
                        </Button>
                      </>
                    )}
                    {selected.status !== "imported" && (
                      <Button
                        kind="ghost"
                        disabled={!!busy}
                        onClick={async () => {
                          if (!confirm("删除这条建议？")) return;
                          setBusy("delete");
                          try {
                            await api(
                              `/shares/${encodeURIComponent(selected.id)}/suggestions/${encodeURIComponent(reply.id)}`,
                              { method: "DELETE" },
                            );
                            setReplies((prev) =>
                              prev.filter((r) => r.id !== reply.id),
                            );
                          } catch (e) {
                            setError(failure(e));
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        <Trash2 size={15} />
                        删除建议
                      </Button>
                    )}
                  </article>
                );
              })
            ) : (
              <Empty
                title="等待朋友的建议"
                description="把链接发送给朋友，他们无需安装衣间或注册账户。"
              />
            )}
            <Button
              kind="danger"
              disabled={!!busy}
              busy={busy === "delete-share"}
              onClick={deleteShare}
            >
              <Trash2 size={16} />
              删除这份分享
            </Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
