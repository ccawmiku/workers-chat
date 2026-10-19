import { WorkersChatServer } from "./dsh-adapter";

export { WorkersChatServer };
export const name = "dsh-plugin-workers-chat";
export const inject = ["webServer"];

export function apply(ctx: any) {
  const server = new WorkersChatServer();

  // Register static assets: /workers-chat and /workers-chat/*
  const disposeStatic = ctx.webServer.register({
    kind: "prefix",
    path: "/workers-chat",
    handler: (req: any, res: any) => server.handleStatic(req, res),
  });

  // Register API: /api/workers-chat and /api/workers-chat/*
  const disposeApi = ctx.webServer.register({
    kind: "prefix",
    path: "/api/workers-chat",
    handler: (req: any, res: any) => server.handleApi(req, res),
  });

  // Register WebSocket upgrade: /api/workers-chat/jobs/events
  const disposeWs = ctx.webServer.registerUpgrade({
    path: "/api/workers-chat/jobs/events",
    handler: (req: any, socket: any, head: any) =>
      server.handleUpgrade(req, socket, head),
  });

  ctx.on("dispose", () => {
    disposeStatic?.();
    disposeApi?.();
    disposeWs?.();
  });
}
