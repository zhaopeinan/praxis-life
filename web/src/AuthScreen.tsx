import { useEffect, useState } from "react";
import { api } from "./api";
import type { PublicUser } from "../../src/types.js";

export function AuthScreen({ onUser }: { onUser: (user: PublicUser) => void }) {
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [useCode, setUseCode] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
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

  async function sendCode() {
    setError(null);
    setPending(true);
    try {
      const result = await api.sendCode(email);
      setDevCode(result.devCode ?? null);
      if (result.devCode) setCode(result.devCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败");
    } finally {
      setPending(false);
    }
  }

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
      const result = await api.login(
        useCode
          ? { email, code, captchaId, captcha }
          : { email, password, captchaId, captcha },
      );
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
    return <div className="boot">正在打开多维…</div>;
  }

  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          多维
        </div>
        <h1>表格、看板、日历，同一份数据。</h1>
        <p>工作、生活、科研都能管；团队协作，Agent 通过接口或 MCP 直接读写。</p>
        <div className="hero-board" aria-hidden="true">
          <div>
            <b>待办</b>
            <span>导出 CSV</span>
            <span>关联项目</span>
          </div>
          <div>
            <b>进行中</b>
            <span>看板拖拽</span>
            <span>权限分享</span>
          </div>
          <div>
            <b>已完成</b>
            <span>表格编辑</span>
          </div>
        </div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <h2 className="auth-title">{needsBootstrap ? "初始化管理员" : "登录"}</h2>
          <p className="fine">
            {needsBootstrap
              ? "系统尚无账号。创建首位管理员后，由管理员在「用户管理」中开通其他人。"
              : "账号由管理员开通，不支持自助注册。"}
          </p>
          <form onSubmit={submit}>
            {needsBootstrap && (
              <label>
                姓名
                <input value={name} onChange={(event) => setName(event.target.value)} required placeholder="管理员姓名" />
              </label>
            )}
            <label>
              邮箱
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                placeholder="you@team.com"
                autoComplete="email"
              />
            </label>
            {(needsBootstrap || !useCode) && (
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
            )}
            {!needsBootstrap && useCode && (
              <label>
                邮箱验证码
                <div className="code-row">
                  <input
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    required
                    inputMode="numeric"
                    placeholder="6 位验证码"
                    autoComplete="one-time-code"
                  />
                  <button type="button" className="secondary" onClick={sendCode} disabled={pending || !email}>
                    获取验证码
                  </button>
                </div>
              </label>
            )}
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
            {devCode && <p className="dev-code">当前未配置邮箱服务，邮箱验证码是 {devCode}</p>}
            {error && <p className="form-error">{error}</p>}
            <button type="submit" className="primary wide" disabled={pending}>
              {pending ? "请稍候…" : needsBootstrap ? "创建管理员并进入" : "进入多维"}
            </button>
          </form>
          {!needsBootstrap && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setUseCode((value) => !value);
                setDevCode(null);
                setError(null);
              }}
            >
              {useCode ? "改用密码登录" : "改用邮箱验证码登录"}
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
