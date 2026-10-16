import { deviceMode } from "./device-mode";
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    ...options,
    headers: {
      ...(deviceMode() ? { "X-Chat-Transport": "device" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "请求失败");
  return result as T;
}
export function download(
  name: string,
  value: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([value], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
