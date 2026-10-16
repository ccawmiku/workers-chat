import { ShieldAlert, X } from "lucide-react";
import type { LoginNotice } from "../shared/auth";
import { IconButton } from "./controls";
const storageKey = "login-security-notice";
export function readLoginNotice(): LoginNotice | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    return value &&
      value.count > 0 &&
      Number.isFinite(value.firstAt) &&
      Number.isFinite(value.lastAt)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function saveLoginNotice(value: LoginNotice | null) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* A disabled browser store must not prevent login. */
  }
}
export function LoginNoticeBanner({
  notice,
  close,
}: {
  notice: LoginNotice;
  close: () => void;
}) {
  const date = (at: number) =>
    new Date(at).toLocaleString("zh-CN", { hour12: false });
  return (
    <div className="login-security-notice du-alert" role="alert">
      <ShieldAlert size={20} aria-hidden="true" />
      <div>
        <strong>登录安全提醒</strong>
        <p>有人在 {date(notice.lastAt)} 尝试登录，但未成功。</p>
        {notice.count > 1 && (
          <small>
            共 {notice.count} 次失败尝试；首次发生于 {date(notice.firstAt)}。
          </small>
        )}
      </div>
      <IconButton label="关闭登录安全提醒" onClick={close}>
        <X size={16} />
      </IconButton>
    </div>
  );
}
