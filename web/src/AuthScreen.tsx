import { useEffect, useState } from "react";
import { api } from "./api";
import type { PublicUser } from "../../src/types.js";

export function AuthScreen({ onUser }: { onUser: (user: PublicUser) => void }) {
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaSvg, setCaptchaSvg] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function refreshCaptcha() {
    const result = await api.captcha();
    setCaptchaId(result.captchaId);
    setCaptchaSvg(result.svg);
    setCaptcha(result.devAnswer ?? "");
  }

  useEffect(() => {
    api
      .bootstrapStatus()
      .then((status) => setNeedsBootstrap(status.needsBootstrap))
      .catch(() => setNeedsBootstrap(false));
  }, []);

  useEffect(() => {
    if (needsBootstrap === false) {
      refreshCaptcha().catch((err) => setError(err instanceof Error ? err.message : "验证码加载失败"));
    }
  }, [needsBootstrap]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (needsBootstrap) {
        const result = await api.bootstrap({ name, email, password });
        onUser(result.user);
        return;
      }
      const result = await api.login({ email, password, captchaId, captcha });
      onUser(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      if (!needsBootstrap) {
        setCaptcha("");
        refreshCaptcha().catch(() => undefined);
      }
    } finally {
      setPending(false);
    }
  }

  if (needsBootstrap === null) {
    return <div className="boot">正在打开知行人生…</div>;
  }

  return (
    <main className="auth-shell">
      <section className="auth-hero" aria-label="知行人生">
        <div className="auth-sky" aria-hidden="true">
          <span className="auth-orb auth-orb-a" />
          <span className="auth-orb auth-orb-b" />
          <span className="auth-orb auth-orb-c" />
          <span className="auth-grain" />
          <div className="auth-orbit">
            <span className="auth-orbit-ring" />
            <span className="auth-orbit-ring delay" />
            <span className="auth-orbit-dot d1">先做</span>
            <span className="auth-orbit-dot d2">记录</span>
            <span className="auth-orbit-dot d3">复盘</span>
            <span className="auth-orbit-dot d4">再改</span>
          </div>
        </div>
        <div className="auth-hero-copy">
          <div className="brand brand-hero">
            <span className="logo" aria-hidden="true" />
            <span className="brand-word">知行人生</span>
          </div>
          <p className="auth-kicker">人生管理工具</p>
          <h1>不要为完美而等待。</h1>
          <p className="auth-lead">先记下、先推进，在知与行里一点点完善。目标、待办、科研与日常节奏，都放在这里。</p>
          <ul className="auth-beats">
            <li>
              <strong>先做</strong>
              <span>想到就记，未完成也可以开始</span>
            </li>
            <li>
              <strong>知行</strong>
              <span>看板、日历与提醒帮你看见进度</span>
            </li>
            <li>
              <strong>完善</strong>
              <span>复盘与迭代，让计划越用越准</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="brand brand-panel">
            <span className="logo" aria-hidden="true" />
            <span className="brand-word">知行人生</span>
          </div>
          <h2 className="auth-title">{needsBootstrap ? "创建你的管理员" : "欢迎回来"}</h2>
          <p className="fine">
            {needsBootstrap
              ? "第一次使用：先建首位管理员，之后再在「用户管理」里为家人或伙伴开通账号。"
              : "使用账号与密码登录。账号由管理员开通。"}
          </p>
          <form onSubmit={submit}>
            {needsBootstrap && (
              <label>
                姓名
                <input value={name} onChange={(event) => setName(event.target.value)} required placeholder="怎么称呼你" />
              </label>
            )}
            <label>
              账号
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                placeholder="邮箱账号"
                autoComplete="username"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
                placeholder={needsBootstrap ? "至少 8 位" : undefined}
                autoComplete={needsBootstrap ? "new-password" : "current-password"}
              />
            </label>
            {!needsBootstrap && (
              <label>
                图形验证码
                <div className="captcha-row">
                  <input
                    value={captcha}
                    onChange={(event) => setCaptcha(event.target.value.toUpperCase())}
                    required
                    placeholder="不区分大小写"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="captcha-image"
                    title="点击刷新"
                    onClick={() => {
                      setCaptcha("");
                      refreshCaptcha().catch((err) => setError(err instanceof Error ? err.message : "刷新失败"));
                    }}
                    dangerouslySetInnerHTML={{ __html: captchaSvg }}
                  />
                </div>
              </label>
            )}
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="primary wide" disabled={pending}>
              {pending ? "请稍候…" : needsBootstrap ? "开始知行人生" : "进入知行人生"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
