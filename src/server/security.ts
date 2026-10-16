import { HttpError } from "./store";
import type { LoginNotice } from "../shared/auth";
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
export const digest = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const unhex = (value: string) =>
  Uint8Array.from(value.match(/.{2}/g) ?? [], (v) => parseInt(v, 16));
export async function passwordHash(
  password: string,
  salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(salt), iterations: 100000, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${hex(bits)}`;
}
export async function verifyPassword(password: string, stored: string) {
  const fields = stored.split(":");
  if (fields.length !== 4 || fields[0] !== "pbkdf2" || fields[1] !== "100000")
    return false;
  const calculated = (await passwordHash(password, fields[2])).split(":")[3]!;
  // HMAC verification gives a constant-time comparison in both Node and workerd.
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("workers-chat-password-verification"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(fields[3]),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(calculated),
  );
}
export async function encrypt(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    unhex(secret),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value),
  );
  return hex(iv.buffer) + ":" + hex(encrypted);
}
export async function decrypt(value: string, secret: string) {
  const [iv, data] = value.split(":");
  const key = await crypto.subtle.importKey(
    "raw",
    unhex(secret),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(iv!) },
      key,
      unhex(data!),
    ),
  );
}
export function secureOrigin(request: Request) {
  const u = new URL(request.url),
    local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !local)
    throw new HttpError(400, "此应用需要 HTTPS");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (request.headers.get("Origin") !== u.origin)
      throw new HttpError(403, "请求来源无效");
    if (!request.headers.get("Content-Type")?.startsWith("application/json"))
      throw new HttpError(415, "请求必须使用 JSON");
  }
}
export function upstreamUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HttpError(
      400,
      "服务商地址必须使用 HTTPS，且不能包含凭证、查询或片段",
    );
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  )
    throw new HttpError(400, "不能使用本地或私网服务商地址");
  return url.href.replace(/\/$/, "");
}
export async function authenticate(request: Request, env: Env) {
  const token = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  if (!token) throw new HttpError(401, "请先登录");
  const tokenHash = await digest(token);
  const session = await env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash=?",
  )
    .bind(tokenHash)
    .first();
  if (!session) throw new HttpError(401, "登录已失效");
  return tokenHash;
}
export async function authRow(env: Env) {
  if (!env.PASSWORD_HASH || !env.RECOVERY_HASH || !env.ENCRYPTION_KEY)
    throw new HttpError(503, "请先按部署说明配置登录和加密凭证");
  await env.DB.prepare("INSERT OR IGNORE INTO auth VALUES(1,?,?)")
    .bind(env.PASSWORD_HASH, env.RECOVERY_HASH)
    .run();
  return (await env.DB.prepare(
    "SELECT password_hash,recovery_hash FROM auth WHERE id=1",
  ).first<{ password_hash: string; recovery_hash: string }>())!;
}
export async function rateLimit(request: Request, env: Env) {
  const key = await digest(request.headers.get("CF-Connecting-IP") ?? "local");
  await env.DB.prepare(
    "INSERT INTO attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END",
  )
    .bind(key, Date.now() + 900000, Date.now(), Date.now())
    .run();
  const row = await env.DB.prepare("SELECT count FROM attempts WHERE key=?")
    .bind(key)
    .first<{ count: number }>();
  if (row!.count > 12)
    throw new HttpError(429, "登录尝试过多，请 15 分钟后重试");
}
export function sessionCookie(request: Request, token: string) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function redactError(message: string, key?: string) {
  return (key ? message.replaceAll(key, "[已隐藏密钥]") : message)
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .slice(0, 2000);
}

export async function resetRateLimit(request: Request, env: Env) {
  const key = await digest(request.headers.get("CF-Connecting-IP") ?? "local");
  await env.DB.prepare("DELETE FROM attempts WHERE key=?").bind(key).run();
}

const LOGIN_WINDOW = 15 * 60 * 1000;
export class LoginBlocked extends HttpError {
  constructor(public retryAt: number) {
    super(429, "连续输错次数过多，此 IP 已临时封禁，请稍后重试");
  }
}
// Use only Cloudflare's client address, never a caller-controlled forwarded header.
export async function checkLoginGuard(request: Request, env: Env) {
  const key = await digest(
    "login:" + (request.headers.get("CF-Connecting-IP") ?? "local"),
  );
  const row = await env.DB.prepare(
    "SELECT blocked_until FROM login_guards WHERE key=?",
  )
    .bind(key)
    .first<{ blocked_until: number }>();
  if (row && row.blocked_until > Date.now())
    throw new LoginBlocked(row.blocked_until);
  return key;
}
export async function failedLogin(env: Env, key: string): Promise<never> {
  const now = Date.now();
  // The upsert counts concurrent failures atomically. Requests already blocked do
  // not extend the ban or grow the notice; no password or raw IP is stored.
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO login_guards VALUES(?,1,0,?) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN updated_at<=? OR blocked_until>0 THEN 1 ELSE failures+1 END, blocked_until=CASE WHEN updated_at>? AND blocked_until=0 AND failures>=4 THEN ? ELSE 0 END, updated_at=excluded.updated_at WHERE blocked_until<=? RETURNING blocked_until",
    ).bind(
      key,
      now,
      now - LOGIN_WINDOW,
      now - LOGIN_WINDOW,
      now + LOGIN_WINDOW,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO login_notice SELECT 1,1,?,? WHERE changes()>0 ON CONFLICT(id) DO UPDATE SET count=count+1,last_at=excluded.last_at",
    ).bind(now, now),
    env.DB.prepare(
      "DELETE FROM login_guards WHERE updated_at<? AND blocked_until<=?",
    ).bind(now - 86400000, now),
  ]);
  const blockedUntil = (
    results[0]!.results[0] as { blocked_until: number } | undefined
  )?.blocked_until;
  if (blockedUntil && blockedUntil > now) throw new LoginBlocked(blockedUntil);
  if (blockedUntil === undefined) {
    const row = await env.DB.prepare(
      "SELECT blocked_until FROM login_guards WHERE key=?",
    )
      .bind(key)
      .first<{ blocked_until: number }>();
    if (row && row.blocked_until > now)
      throw new LoginBlocked(row.blocked_until);
  }
  throw new HttpError(401, "密码或恢复码错误");
}
export async function resetLoginGuard(env: Env, key: string) {
  await env.DB.prepare("DELETE FROM login_guards WHERE key=?").bind(key).run();
}
export async function createLoginSession(
  request: Request,
  env: Env,
  key: string,
  tokenHash: string,
  expectedHash: string,
): Promise<LoginNotice | undefined> {
  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO sessions SELECT ?,?,? WHERE (SELECT password_hash FROM auth WHERE id=1)=? AND NOT EXISTS(SELECT 1 FROM login_guards WHERE key=? AND blocked_until>?)",
    ).bind(
      tokenHash,
      (request.headers.get("User-Agent") ?? "未知设备").slice(0, 250),
      Date.now(),
      expectedHash,
      key,
      Date.now(),
    ),
    env.DB.prepare(
      "DELETE FROM login_guards WHERE key=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)",
    ).bind(key, tokenHash),
    env.DB.prepare(
      "DELETE FROM login_notice WHERE EXISTS(SELECT 1 FROM sessions WHERE token_hash=?) RETURNING count,first_at,last_at",
    ).bind(tokenHash),
  ]);
  if (!results[0]!.meta.changes) {
    await checkLoginGuard(request, env);
    throw new HttpError(401, "密码已修改，请重新登录");
  }
  const row = results[2]!.results[0] as
    | { count: number; first_at: number; last_at: number }
    | undefined;
  return row
    ? { count: row.count, firstAt: row.first_at, lastAt: row.last_at }
    : undefined;
}
export async function confirmPassword(
  request: Request,
  env: Env,
  value: unknown,
) {
  await rateLimit(request, env);
  const row = await authRow(env);
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    !(await verifyPassword(value, row.password_hash))
  )
    throw new HttpError(401, "密码错误");
  await resetRateLimit(request, env);
  return row;
}
