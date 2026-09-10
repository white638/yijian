import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Gem,
  LoaderCircle,
  Shirt,
  ShoppingBag,
  X,
} from "lucide-react";
import type { Item, OutfitLayout } from "../types";
import { itemName } from "../types";
import { placementStyle, syncLayout } from "../outfit-layout";
import "../outfit-studio.css";
export function Button({
  children,
  busy = false,
  kind = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  kind?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || props["aria-busy"]}
      className={`button ${kind} ${props.className || ""}`}
    >
      {busy && <LoaderCircle size={17} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      type="button"
      className={`icon-button ${props.className || ""}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(
            children as React.ReactElement<{
              id: string;
              "aria-describedby"?: string;
            }>,
            { id, "aria-describedby": hint ? `${id}-hint` : undefined },
          )
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Sheet({
  title,
  onClose,
  children,
  wide = false,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    before.current = document.activeElement as HTMLElement;
    const d = ref.current;
    d?.showModal();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      d?.close();
      document.body.style.overflow = prev;
      before.current?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`sheet ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
      aria-label={title}
      aria-busy={busy}
    >
      <div className="sheet-handle" />
      <header className="sheet-header">
        <h2>{title}</h2>
        <IconButton label="关闭" onClick={onClose} disabled={busy}>
          <X size={22} />
        </IconButton>
      </header>
      <div className="sheet-body">{children}</div>
    </dialog>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Shirt size={32} strokeWidth={1.3} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function SectionTitle({
  title,
  action,
  onClick,
}: {
  title: string;
  action?: string;
  onClick?: () => void;
}) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {action && (
        <button onClick={onClick} className="text-button">
          {action}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}
export function Garment({
  item,
  className = "",
  processing = false,
}: {
  item: Item;
  className?: string;
  processing?: boolean;
}) {
  const Placeholder =
    item.category === "bag"
      ? ShoppingBag
      : item.category === "accessory"
        ? Gem
        : Shirt;
  return (
    <div
      className={`garment-image ${className} ${processing ? "image-processing" : ""}`}
      aria-busy={processing || undefined}
    >
      {item.image_url ? (
        <img src={item.image_url} alt={itemName(item)} loading="lazy" />
      ) : (
        <Placeholder size={40} strokeWidth={1.1} aria-hidden="true" />
      )}
    </div>
  );
}
export function Collage({
  ids,
  items,
  expanded = false,
  layout,
}: {
  ids: string[];
  items: Item[];
  expanded?: boolean;
  layout?: OutfitLayout | null;
}) {
  const chosen = ids
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  const shown = expanded ? chosen : chosen.slice(0, 6);
  const remaining = chosen.length - shown.length;
  if (layout && !expanded) {
    const placements = syncLayout(layout, ids, items).placements;
    return (
      <div
        className="collage saved-layout"
        role="group"
        aria-label={`搭配预览（${chosen.length} 件）`}
        style={{ background: layout.background }}
      >
        {placements.map((placement) => {
          const item = chosen.find((i) => i.id === placement.item_id);
          return item ? (
            <div
              key={item.id}
              className="layout-garment"
              style={placementStyle(placement)}
            >
              <Garment item={item} />
            </div>
          ) : null;
        })}
      </div>
    );
  }
  return (
    <div
      className={`collage count-${Math.min(chosen.length, 4)} ${expanded ? "expanded" : ""}`}
      role="group"
      aria-label={`${expanded ? "搭配全部单品" : "搭配预览"}（${chosen.length} 件）`}
    >
      {shown.map((i) =>
        expanded ? (
          <figure className="collage-item" key={i.id}>
            <Garment item={i} />
            <figcaption>{itemName(i)}</figcaption>
          </figure>
        ) : (
          <Garment key={i.id} item={i} />
        ),
      )}
      {remaining > 0 && (
        <span
          className="collage-overflow"
          aria-label={`另有 ${remaining} 件单品`}
        >
          +{remaining}
        </span>
      )}
      {chosen.length === 0 && <Shirt size={42} strokeWidth={1} />}
    </div>
  );
}
export function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Status({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="status">
      {children}
    </p>
  );
}
