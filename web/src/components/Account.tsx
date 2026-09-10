import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { LockKeyhole, LogOut, Mail } from "lucide-react";
import { api, failure } from "../api";
import { type AccountConfig, type AccountUser } from "../edition";
import { Button, ErrorText, Field } from "./UI";
import "../online.css";

interface Session {
  user: AccountUser;
}
export function OnlineEntry({
  children,
}: {
  children: (account: AccountUser, signOut: () => Promise<void>) => ReactNode;
}) {
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const cancelLoad = useRef<(() => void) | null>(null);
  async function load() {
    const version = ++generation.current;
    cancelLoad.current?.();
    const controller = new AbortController();
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const cancel = (reason = new Error("连接已取消。")) => {
      window.clearTimeout(deadline);
      controller.abort();
      rejectCancelled(reason);
    };
    const deadline = window.setTimeout(
      () => cancel(new Error("连接超时，请检查网络后重新连接。")),
      15_000,
    );
    cancelLoad.current = cancel;
    setLoading(true);
    setError("");
    async function readAccount() {
      const settings = await api<AccountConfig>("/account/config", {
        signal: controller.signal,
      });
      if (version !== generation.current || controller.signal.aborted)
        return null;
      setConfig(settings);
      return api<Session | null>("/auth/get-session", {
        signal: controller.signal,
      });
    }
    try {
      const session = await Promise.race([readAccount(), cancelled]);
      if (version === generation.current && !controller.signal.aborted)
        setAccount(session?.user || null);
    } catch (e) {
      if (version === generation.current) setError(failure(e));
    } finally {
      window.clearTimeout(deadline);
      if (cancelLoad.current === cancel) cancelLoad.current = null;
      if (version === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const expired = () => {
      generation.current++;
      cancelLoad.current?.();
      setAccount(null);
      setLoading(false);
    };
    window.addEventListener("yijian:unauthorized", expired);
    return () => {
      generation.current++;
      cancelLoad.current?.();
      window.removeEventListener("yijian:unauthorized", expired);
    };
  }, []);
  async function signOut() {
    await api("/auth/sign-out", { method: "POST", body: "{}" });
    generation.current++;
    cancelLoad.current?.();
    setAccount(null);
  }
  if (account) return <>{children(account, signOut)}</>;
  return (
    <main className="account-entry">
      <a className="onboarding-brand" href="#home">
        衣间<span>你的衣物，你的风格</span>
      </a>
      {loading ? (
        <p role="status">正在打开你的衣柜…</p>
      ) : error || !config ? (
        <section className="settings-card stack">
          <ErrorText error={error} />
          <Button onClick={load}>重新连接</Button>
        </section>
      ) : (
        <AccountForm config={config} onSuccess={load} />
      )}
      <p className="small muted center">个人衣柜 · 自由导出 · 开放源码</p>
    </main>
  );
}

export function AccountForm({
  config,
  onSuccess,
}: {
  config: AccountConfig;
  onSuccess: () => Promise<void>;
}) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const invites = config.registrationMode === "invite";
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(register ? "/auth/sign-up/email" : "/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify(
          register
            ? { email: email.trim(), password, name: name.trim() }
            : { email: email.trim(), password },
        ),
        ...(register && invites
          ? { headers: { "x-yijian-invite-code": invite.trim() } }
          : {}),
      });
      setPassword("");
      setInvite("");
      await onSuccess();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="account-card settings-card stack" onSubmit={submit}>
      <div className="account-mark" aria-hidden="true">
        <LockKeyhole size={27} />
      </div>
      <div>
        <h1>{register ? "建立你的衣间" : "欢迎回到衣间"}</h1>
        <p className="muted">登录后，在不同设备整理自己的衣柜。</p>
      </div>
      <fieldset disabled={busy} className="account-fields stack">
        {register && (
          <Field label="怎么称呼你">
            <input
              required
              maxLength={40}
              autoComplete="nickname"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        <Field label="邮箱">
          <input
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="密码" hint={register ? "至少 12 个字符。" : undefined}>
          <input
            type="password"
            required
            minLength={register ? 12 : undefined}
            maxLength={128}
            autoComplete={register ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {register && invites && (
          <Field label="邀请码">
            <input
              required
              maxLength={256}
              autoComplete="off"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
          </Field>
        )}
        <ErrorText error={error} />
        <Button type="submit" busy={busy}>
          {register ? "创建账户" : "登录衣间"}
        </Button>
        {config.registrationMode !== "closed" && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setRegister(!register);
              setError("");
              setPassword("");
            }}
          >
            {register ? "已有账户，去登录" : "第一次使用，创建账户"}
          </button>
        )}
        {config.registrationMode === "closed" && (
          <p className="small muted">
            当前网站暂未开放注册，请使用已有账户登录。
          </p>
        )}
      </fieldset>
    </form>
  );
}

export function AccountCard({
  account,
  signOut,
}: {
  account: AccountUser;
  signOut: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="settings-card stack">
      <h2>我的账户</h2>
      <div className="row">
        <span className="account-mark" aria-hidden="true">
          <Mail size={23} />
        </span>
        <div>
          <strong>{account.name || "衣间用户"}</strong>
          <p className="small muted">{account.email}</p>
        </div>
      </div>
      <p className="small muted">
        当前衣柜保存在 {location.host}。可导出完整备份，带到自己部署的衣间。
      </p>
      <Button
        kind="secondary"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await signOut();
          } catch (e) {
            setError(failure(e));
            setBusy(false);
          }
        }}
      >
        <LogOut size={17} />
        退出登录
      </Button>
      <ErrorText error={error} />
    </section>
  );
}
