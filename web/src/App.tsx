import { useEffect, useRef, useState } from "react";
import {
  Home as HomeIcon,
  PanelsTopLeft,
  Plus,
  Shirt,
  Compass,
  Settings as SettingsIcon,
  CalendarDays,
  ChartNoAxesCombined,
  ArrowRight,
} from "lucide-react";
import { useSnapshot, AppProvider, Toast, type NoticeTone } from "./Store";
import { send, failure } from "./api";
import { AIConnect } from "./components/AIConnect";
import { AddSheet, ItemEditor } from "./components/Items";
import { OutfitEditor, PlanEditor } from "./components/Outfits";
import { Button, IconButton, ErrorText } from "./components/UI";
import { Home, Explore } from "./pages/Home";
import { Wardrobe } from "./pages/Wardrobe";
import { Looks } from "./pages/Looks";
import { Settings, Stats } from "./pages/Settings";
const routes = new Set([
  "home",
  "wardrobe",
  "looks",
  "packing",
  "calendar",
  "explore",
  "settings",
  "stats",
]);
const readRoute = () => {
  const s = location.hash.replace("#", "").split("?")[0];
  return routes.has(s) ? s : "home";
};
export default function App() {
  const { state, error: loadError, refresh } = useSnapshot();
  const [route, setRoute] = useState(readRoute);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("success");
  const [add, setAdd] = useState(false);
  const [itemId, setItemId] = useState("");
  const [outfitId, setOutfitId] = useState<string | null>(null);
  const [plan, setPlan] = useState<{
    ids: string[];
    name?: string;
    outfitId?: string;
  } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");
  const routeContent = useRef<HTMLDivElement>(null);
  const navigate = (page: string) => {
    const base = page.split("?")[0];
    location.hash = routes.has(base) ? page : "home";
    setRoute(routes.has(base) ? base : "home");
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const notify = (text: string, tone: NoticeTone = "success") => {
    setNoticeTone(tone);
    setNotice(`${text}\u0000${Date.now()}`);
  };
  useEffect(() => {
    const update = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    const content = routeContent.current;
    if (!content?.animate || !window.matchMedia) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) return;
    const animation = content.animate(
      [
        { opacity: 0.35, translate: "0 7px" },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    );
    const stop = () => animation.cancel();
    reducedMotion.addEventListener("change", stop);
    return () => {
      animation.cancel();
      reducedMotion.removeEventListener("change", stop);
    };
  }, [route, state?.settings.onboarded]);
  const analyzing = state?.items.some((i) => i.ai_status === "processing");
  useEffect(() => {
    if (!analyzing) return;
    const timer = setInterval(() => refresh().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [analyzing]);
  async function finish() {
    if (finishing) return;
    setFinishing(true);
    setError("");
    try {
      await send("/settings", { onboarded: true }, "PATCH");
      await refresh();
      navigate("home");
    } catch (e) {
      setError(failure(e));
    } finally {
      setFinishing(false);
    }
  }
  if (!state)
    return (
      <main className="boot" aria-busy={!loadError}>
        <span className="brand-word">衣间</span>
        {loadError ? (
          <>
            <p role="alert">{loadError}</p>
            <Button onClick={() => location.reload()}>重新连接</Button>
          </>
        ) : (
          <p role="status">正在打开你的衣柜…</p>
        )}
      </main>
    );
  const context = {
    state,
    refresh,
    notify,
    openItem: (id: string) => setItemId(id),
    openAdd: () => setAdd(true),
    openOutfit: (id?: string) => setOutfitId(id || ""),
    openPlan: (ids: string[], name?: string, outfitId?: string) =>
      setPlan({ ids, name, outfitId }),
    navigate,
  };
  const primary = [
    { id: "home", label: "首页", icon: HomeIcon },
    { id: "wardrobe", label: "衣柜", icon: PanelsTopLeft },
    { id: "looks", label: "穿搭", icon: Shirt },
    { id: "explore", label: "探索", icon: Compass },
  ];
  const active = ["packing", "calendar"].includes(route) ? "looks" : route;
  return (
    <AppProvider value={context}>
      {!state.settings.onboarded ? (
        <main className="onboarding">
          <a className="onboarding-brand" href="#home">
            衣间<span>你的衣物，你的风格</span>
          </a>
          <section className="onboarding-card" aria-busy={finishing}>
            <AIConnect onFinish={finish} />
            {finishing && (
              <p className="muted" role="status">
                正在打开衣柜…
              </p>
            )}
            <ErrorText error={error} />
          </section>
          <p className="small muted center">免费开源 · 本地保存 · 随时导出</p>
        </main>
      ) : (
        <div className="app-shell">
          <aside className="desktop-sidebar">
            <button className="brand" onClick={() => navigate("home")}>
              <span className="brand-word">衣间</span>
              <small>让每件衣物，有更多可能</small>
            </button>
            <nav aria-label="主导航">
              {primary.map((n) => (
                <button
                  key={n.id}
                  className={active === n.id ? "active" : ""}
                  onClick={() => navigate(n.id)}
                >
                  <n.icon size={23} />
                  {n.label}
                </button>
              ))}
              <button className="desktop-add" onClick={() => setAdd(true)}>
                <Plus size={22} />
                添加衣物
              </button>
            </nav>
            <div className="sidebar-bottom">
              <button onClick={() => navigate("stats")}>
                <ChartNoAxesCombined size={20} />
                风格统计
              </button>
              <button onClick={() => navigate("calendar")}>
                <CalendarDays size={20} />
                穿搭日历
              </button>
              <button
                className={route === "settings" ? "active" : ""}
                onClick={() => navigate("settings")}
              >
                <SettingsIcon size={20} />
                个人设置
              </button>
              <small>属于自己的日常衣柜</small>
            </div>
          </aside>
          <div className="app-content">
            <div className="desktop-topbar">
              <span>我的衣柜日常</span>
              <button onClick={() => navigate("settings")}>
                {state.settings.name || "衣间用户"}
                <SettingsIcon size={17} />
              </button>
            </div>
            <div className="mobile-top-actions">
              <IconButton
                label="打开穿搭日历"
                onClick={() => navigate("calendar")}
              >
                <CalendarDays size={21} />
              </IconButton>
              <IconButton label="打开设置" onClick={() => navigate("settings")}>
                <SettingsIcon size={21} />
              </IconButton>
            </div>
            <div ref={routeContent} className="route-content">
              {route === "home" ? (
                <Home />
              ) : route === "wardrobe" ? (
                <Wardrobe />
              ) : ["looks", "packing", "calendar"].includes(route) ? (
                <Looks tab={route} />
              ) : route === "explore" ? (
                <Explore />
              ) : route === "stats" ? (
                <Stats />
              ) : (
                <Settings />
              )}
            </div>
          </div>
          <nav className="bottom-nav" aria-label="底部导航">
            {primary.slice(0, 2).map((n) => (
              <button
                key={n.id}
                aria-current={active === n.id ? "page" : undefined}
                className={active === n.id ? "active" : ""}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={25} strokeWidth={active === n.id ? 2.3 : 1.6} />
                <span>{n.label}</span>
              </button>
            ))}
            <button
              className="central-add"
              aria-label="添加衣物"
              onClick={() => setAdd(true)}
            >
              <Plus size={35} strokeWidth={1.6} />
            </button>
            {primary.slice(2).map((n) => (
              <button
                key={n.id}
                aria-current={active === n.id ? "page" : undefined}
                className={active === n.id ? "active" : ""}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={25} strokeWidth={active === n.id ? 2.3 : 1.6} />
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
        </div>
      )}
      {add && <AddSheet onClose={() => setAdd(false)} />}{" "}
      {itemId && state.items.find((i) => i.id === itemId) && (
        <ItemEditor
          key={itemId}
          item={state.items.find((i) => i.id === itemId)!}
          onClose={() => setItemId("")}
        />
      )}{" "}
      {outfitId !== null && (
        <OutfitEditor
          key={outfitId || "new"}
          outfit={state.outfits.find((o) => o.id === outfitId)}
          onClose={() => setOutfitId(null)}
        />
      )}{" "}
      {plan && (
        <PlanEditor
          itemIds={plan.ids}
          name={plan.name}
          outfitId={plan.outfitId}
          onClose={() => setPlan(null)}
        />
      )}
      <Toast text={notice} tone={noticeTone} />
    </AppProvider>
  );
}
