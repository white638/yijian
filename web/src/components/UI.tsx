import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { ArrowRight, LoaderCircle, Shirt, X } from "lucide-react";
import type { Item } from "../types";
import { itemName } from "../types";
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
      className={`button ${kind} ${props.className || ""}`}
    >
      {busy && <LoaderCircle size={17} className="spin" />}
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
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
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
    >
      <div className="sheet-handle" />
      <header className="sheet-header">
        <h2>{title}</h2>
        <IconButton label="关闭" onClick={onClose}>
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
}: {
  item: Item;
  className?: string;
}) {
  return (
    <div className={`garment-image ${className}`}>
      {item.image_url ? (
        <img src={item.image_url} alt={itemName(item)} loading="lazy" />
      ) : (
        <Shirt size={40} strokeWidth={1.1} />
      )}
    </div>
  );
}
export function Collage({ ids, items }: { ids: string[]; items: Item[] }) {
  const chosen = ids
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  return (
    <div className={`collage count-${Math.min(chosen.length, 4)}`}>
      {chosen.slice(0, 6).map((i) => (
        <Garment key={i.id} item={i} />
      ))}
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
