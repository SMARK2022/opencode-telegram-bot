import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ providers: vi.fn(), getCurrentProject: vi.fn() }));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { config: { providers: mocked.providers } },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProject,
}));
vi.mock("../../../src/utils/logger.js", () => ({
  // 全局afterEach会经Event cleanup调用info；局部mock必须保留这个真实reset边界。
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe("model/context-limit Project scope", () => {
  beforeEach(() => {
    vi.resetModules();
    mocked.providers.mockReset();
    mocked.getCurrentProject.mockReset();
  });

  it("does not reuse context limits across Project worktrees", async () => {
    // 相同Provider/model故意返回两个limit，跨Project命中会产生明确错误值。
    // 连续调用覆盖cache identity，避免只证明请求参数却遗漏缓存隔离。
    // expected limits是独立fixtures，不重算production catalog algorithm。
    mocked.getCurrentProject.mockReturnValueOnce({ worktree: "/project-a" }).mockReturnValueOnce({ worktree: "/project-b" });
    mocked.providers
      .mockResolvedValueOnce({
        data: { providers: [{ id: "provider", models: { model: { limit: { context: 1000 } } } }] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { providers: [{ id: "provider", models: { model: { limit: { context: 2000 } } } }] },
        error: null,
      });
    const { getModelContextLimit } = await import("../../../src/app/services/model-context-limit-service.js");

    expect(await getModelContextLimit("provider", "model")).toBe(1000);
    expect(await getModelContextLimit("provider", "model")).toBe(2000);
    // 相同Provider/model在不同worktree仍需两次目录化catalog请求。
    expect(mocked.providers.mock.calls).toEqual([
      [{ directory: "/project-a" }],
      [{ directory: "/project-b" }],
    ]);
  });
});
