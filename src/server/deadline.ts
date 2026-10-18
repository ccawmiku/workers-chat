/** Explicitly release timers and upstream I/O so a finished DO can hibernate. */
export function generationDeadline(
  controller: AbortController,
  milliseconds = 30 * 60 * 1000,
) {
  const timer = controller.signal.aborted
    ? undefined
    : setTimeout(
        () => controller.abort(new DOMException("生成超时", "TimeoutError")),
        milliseconds,
      );
  const clear = () => clearTimeout(timer);
  controller.signal.addEventListener("abort", clear, { once: true });
  return () => {
    clear();
    controller.signal.removeEventListener("abort", clear);
    controller.abort();
  };
}
