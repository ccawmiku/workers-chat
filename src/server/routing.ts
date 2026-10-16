import { HttpError } from "./store";

const routes: [RegExp, string[]][] = [
  [
    /^\/api\/auth\/(login|recover|logout|password|revoke|recovery-code)$/,
    ["POST"],
  ],
  [/^\/api\/auth\/(status|sessions)$/, ["GET"]],
  [/^\/api\/settings$/, ["GET", "PUT"]],
  [/^\/api\/settings\/(export|import)$/, ["POST"]],
  [/^\/api\/providers$/, ["GET", "POST"]],
  [/^\/api\/providers\/[^/]+$/, ["DELETE"]],
  [/^\/api\/providers\/[^/]+\/(key|test)$/, ["POST"]],
  [/^\/api\/providers\/[^/]+\/models$/, ["PUT"]],
  [/^\/api\/groups$/, ["GET", "POST"]],
  [/^\/api\/groups\/[^/]+$/, ["PATCH", "DELETE"]],
  [/^\/api\/chats$/, ["GET", "POST"]],
  [/^\/api\/chats\/[^/]+$/, ["GET", "PATCH"]],
  [/^\/api\/chats\/[^/]+\/(export|title-status)$/, ["GET"]],
  [/^\/api\/chats\/[^/]+\/preview$/, ["POST"]],
  [/^\/api\/chats\/[^/]+\/draft$/, ["PUT"]],
  [/^\/api\/chats\/[^/]+\/permanent$/, ["DELETE"]],
  [
    /^\/api\/chats\/[^/]+\/(send|seen|stop|title|regenerate|retry|continue|edit|select|exclude|fork)$/,
    ["POST"],
  ],
  [/^\/api\/import(?:\/preview)?$/, ["POST"]],
];

export function requireMethod(path: string, method: string) {
  const route = routes.find(([pattern]) => pattern.test(path));
  if (!route) throw new HttpError(404, "接口不存在");
  if (!route[1].includes(method))
    throw new HttpError(405, "此接口不支持该请求方法");
}
