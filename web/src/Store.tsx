import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import type { AppState } from "./types";
interface AppContext {
  state: AppState;
  refresh: () => Promise<void>;
  notify: (text: string) => void;
  openItem: (id: string) => void;
  openAdd: () => void;
  openOutfit: (id?: string) => void;
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
export function useSnapshot() {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = async () => {
    const token = ++sequence.current;
    const next = await api<AppState>("/state");
    if (token === sequence.current) setState(next);
  };
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(location.hash.slice(1));
    const code = params.get("open");
    if (code)
      history.replaceState(null, "", location.pathname + location.search);
    api("/session", {
      method: "POST",
      ...(code ? { body: JSON.stringify({ code }) } : {}),
    })
      .then(() => refresh())
      .catch((e) => {
        if (active)
          setError(code ? e.message : "请从衣间启动窗口打开本机入口。");
      });
    return () => {
      active = false;
    };
  }, []);
  return { state, error, refresh };
}
export function Toast({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!text) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 4500);
    return () => clearTimeout(t);
  }, [text]);
  return show ? (
    <div className="toast" role="status">
      {text.split("\u0000")[0]}
    </div>
  ) : null;
}
