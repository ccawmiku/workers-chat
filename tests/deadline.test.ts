import { afterEach, describe, expect, it, vi } from "vitest";
import { generationDeadline } from "../src/server/deadline";

describe("generation deadline lifetime", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["complete", "failure", "stopped"])("releases the DO timer after %s without waiting for its deadline", async status => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const dispose = generationDeadline(controller);
    expect(vi.getTimerCount()).toBe(1);
    try {
      if (status === "stopped") controller.abort();
      if (status === "failure") throw Error("upstream failure");
      await Promise.resolve();
    } catch { /* The caller persists the error; cleanup is unconditional. */ }
    finally { dispose(); }
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.signal.aborted).toBe(true);
    dispose(); // idempotent cleanup
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains the hard timeout while running and releases its abort listener", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const dispose = generationDeadline(controller, 1234);
    vi.advanceTimersByTime(1233);
    expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(controller.signal.reason.name).toBe("TimeoutError");
    dispose();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not allocate a timer when already cancelled, and cancellation clears one immediately", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const dispose = generationDeadline(controller);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    dispose();
    generationDeadline(controller)();
    expect(vi.getTimerCount()).toBe(0);
  });
});
