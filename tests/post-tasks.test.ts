import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../src/server/plugins", () => ({
  pluginState: vi.fn(),
  pluginView: vi.fn(),
  finishPlugin: vi.fn(),
}));
vi.mock("../src/server/summaries", () => ({
  summaryState: vi.fn(),
  finishSummary: vi.fn(),
}));
import { postView } from "../src/server/post-tasks";
import { pluginState } from "../src/server/plugins";
import { summaryState } from "../src/server/summaries";
import { newChat } from "../src/shared/chat";
import {
  emptyPluginState,
  pluginDefaults,
  type PluginRun,
} from "../src/shared/plugins";
describe("post-task snapshot ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(summaryState).mockResolvedValue({
      value: { runs: [] },
      revision: 0,
    });
  });
  const env = {
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
    },
  } as unknown as Parameters<typeof postView>[0];
  it("reloads a suggestion that completed between foreground and job reads", async () => {
    const foreground = emptyPluginState(),
      run = {
        id: "r",
        status: "running",
        plugin: pluginDefaults("suggest"),
      } as PluginRun;
    foreground.runs.push(run);
    const complete = {
      ...foreground,
      runs: [{ ...run, status: "complete" as const }],
    };
    vi.mocked(pluginState).mockResolvedValue({ value: complete, revision: 2 });
    const result = await postView(env, newChat(), foreground);
    expect(result.postJobs).toEqual([]);
    expect(result.postPluginState.runs[0]?.status).toBe("complete");
    expect(pluginState).toHaveBeenCalledTimes(1);
  });
  it("reuses a settled foreground snapshot without an extra state read", async () => {
    const foreground = emptyPluginState();
    const result = await postView(env, newChat(), foreground);
    expect(result.postPluginState).toBe(foreground);
    expect(pluginState).not.toHaveBeenCalled();
  });
});
