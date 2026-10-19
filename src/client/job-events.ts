// One authenticated connection observes an existing job; reconnect never starts a model.
export function observeJob(
  id: string,
  title: boolean,
  onDelta: (content: string, reasoning: string) => void,
  onDone: () => void,
  onUnavailable: () => void,
) {
  const url = new URL(
    `/api/workers-chat/jobs/events`,
    location.href,
  );
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("id", id);
  if (title) url.searchParams.set("kind", "title");
  let socket: WebSocket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false,
    completed = false,
    attempts = 0,
    content = "",
    reasoning = "";
  const connect = () => {
    if (stopped || document.visibilityState !== "visible") return;
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "reset") {
        content = "";
        reasoning = "";
      }
      if (data.type === "delta") {
        content += data.content ?? "";
        reasoning += data.reasoning ?? "";
        onDelta(content, reasoning);
      }
      if (data.type === "done" && !completed) {
        completed = true;
        onDone();
      }
    };
    socket.onclose = () => {
      if (stopped || completed) return;
      if (++attempts <= 3)
        retry = setTimeout(connect, Math.min(30000, 2000 * 2 ** attempts));
      else onUnavailable();
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}
