import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ providers: vi.fn(), getCurrentProject: vi.fn() }));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { config: { providers: mocked.providers } },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProject,
  getCurrentModel: vi.fn(),
  setCurrentModel: vi.fn(),
}));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAvailableVariants } from "../../../src/app/services/variant-selection-service.js";

describe("model/variant Project scope", () => {
  beforeEach(() => {
    mocked.providers.mockReset();
    mocked.getCurrentProject.mockReset();
  });

  it("requests variants with the selected Project directory", async () => {
    // custom variant只存在于该Project fixture，证明请求落到正确InstanceContext。
    // default与high的expected array来自产品合同，不检查内部map/filter调用次数。
    // directory断言防止SDK无参调用静默使用错误Project。
    mocked.getCurrentProject.mockReturnValue({ worktree: "/project-variant" });
    mocked.providers.mockResolvedValue({
      data: { providers: [{ id: "provider", models: { model: { variants: { high: {} } } } }] },
      error: null,
    });

    expect(await getAvailableVariants("provider", "model")).toEqual([{ id: "default" }, { id: "high" }]);
    expect(mocked.providers).toHaveBeenCalledWith({ directory: "/project-variant" });
  });

  it("keeps the existing explicit default when no Project is selected", async () => {
    // no-Project是合法startup窗口，default是显式结果而非catch生成的成功。
    // 零Provider调用避免unscoped请求污染未来Project cache。
    // 该分支保留既有UI可用性，不引入Workspace推断。
    mocked.getCurrentProject.mockReturnValue(null);

    expect(await getAvailableVariants("provider", "model")).toEqual([{ id: "default" }]);
    expect(mocked.providers).not.toHaveBeenCalled();
  });
});
