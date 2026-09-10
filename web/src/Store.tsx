import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import { Check, Info } from "lucide-react";
import type { AppState, Outfit } from "./types";
import type { AccountUser } from "./edition";
export type NoticeTone = "success" | "info";
interface AppContext {
  account?: AccountUser;
  signOut?: () => Promise<void>;
  state: AppState;
  refresh: () => Promise<void>;
  notify: (text: string, tone?: NoticeTone) => void;
  openItem: (id: string) => void;
  openAdd: () => void;
  openOutfit: (id?: string, draft?: Partial<Outfit>) => void;
  openPlan: (ids: string[], name?: string, outfitId?: string) => void;
  navigate: (page: string) => void;
}
const Context = createContext<AppContext | null>(null);
export const useApp = () => {
  const c = useContext(Context);
  if (!c) throw new Error("App context missing");
  return c;
};
export const AppProvider = Context.Provider;
export function useSnapshot(options?: { online?: boolean }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const mounted = useRef(true);
  const refresh = async () => {
    if (!mounted.current) return;
    const token = ++sequence.current;
    const next = await api<AppState>("/state");
    if (mounted.current && token === sequence.current) setState(next);
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const params = new URLSearchParams(location.hash.slice(1));
    const code = params.get("open");
    if (code)
      history.replaceState(null, "", location.pathname + location.search);
    (options?.online
      ? Promise.resolve()
      : api("/session", {
          method: "POST",
          ...(code ? { body: JSON.stringify({ code }) } : {}),
        })
    )
      .then(() => {
        if (active) return refresh();
      })
      .catch((e) => {
        if (active)
          setError(
            options?.online || code
              ? e.message
              : "请从衣间启动窗口打开本机入口。",
          );
      });
    return () => {
      active = false;
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  return { state, error, refresh };
}
export function Toast({
  text,
  tone = "success",
}: {
  text: string;
  tone?: NoticeTone;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!text) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 4500);
    return () => clearTimeout(t);
  }, [text]);
  return show ? (
    <div key={text} className="toast" role="status" aria-atomic="true">
      <span className={`toast-mark ${tone}`} aria-hidden="true">
        {tone === "success" ? (
          <Check size={15} strokeWidth={2.4} />
        ) : (
          <Info size={17} />
        )}
      </span>
      <span>{text.split("\u0000")[0]}</span>
    </div>
  ) : null;
}
