import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModelCapabilities,
  supportsInput,
  supportsAttachment,
} from "../../../src/app/services/model-capabilities-service.js";
import type { Model } from "@opencode-ai/sdk/v2";

const mocked = vi.hoisted(() => ({ providers: vi.fn(), getCurrentProject: vi.fn() }));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { config: { providers: mocked.providers } },
}));
vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: mocked.getCurrentProject,
}));

describe("model/capabilities", () => {
  beforeEach(() => {
    mocked.providers.mockReset();
    mocked.getCurrentProject.mockReset();
    mocked.getCurrentProject.mockReturnValue({ worktree: "/project-capability" });
  });

  it("requests capabilities in the selected Project", async () => {
    // capabilities可能由Project配置改变，因此unscoped成功不是可接受结果。
    // literal worktree锁定SDK query contract，不断言private cache对象。
    // attachment值只让真实consumer完成解析，测试重点仍是directory boundary。
    mocked.providers.mockResolvedValue({
      data: {
        providers: [{ id: "provider", models: { model: { capabilities: { attachment: true } } } }],
      },
      error: null,
    });

    await getModelCapabilities("provider", "model");

    expect(mocked.providers).toHaveBeenCalledWith({ directory: "/project-capability" });
  });
  describe("supportsInput", () => {
    it("returns true when model supports image input", () => {
      const capabilities: Model["capabilities"] = {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      };

      expect(supportsInput(capabilities, "image")).toBe(true);
    });

    it("returns false when model does not support image input", () => {
      const capabilities: Model["capabilities"] = {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      };

      expect(supportsInput(capabilities, "image")).toBe(false);
    });

    it("returns true when model supports PDF input", () => {
      const capabilities: Model["capabilities"] = {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      };

      expect(supportsInput(capabilities, "pdf")).toBe(true);
    });

    it("returns false when capabilities is null", () => {
      expect(supportsInput(null, "image")).toBe(false);
      expect(supportsInput(null, "pdf")).toBe(false);
      expect(supportsInput(null, "audio")).toBe(false);
      expect(supportsInput(null, "video")).toBe(false);
    });

    it("checks all input types", () => {
      const capabilities: Model["capabilities"] = {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: true, image: true, video: true, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      };

      expect(supportsInput(capabilities, "image")).toBe(true);
      expect(supportsInput(capabilities, "pdf")).toBe(true);
      expect(supportsInput(capabilities, "audio")).toBe(true);
      expect(supportsInput(capabilities, "video")).toBe(true);
    });
  });

  describe("supportsAttachment", () => {
    it("returns true when model supports attachments", () => {
      const capabilities: Model["capabilities"] = {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      };

      expect(supportsAttachment(capabilities)).toBe(true);
    });

    it("returns false when model does not support attachments", () => {
      const capabilities: Model["capabilities"] = {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      };

      expect(supportsAttachment(capabilities)).toBe(false);
    });

    it("returns false when capabilities is null", () => {
      expect(supportsAttachment(null)).toBe(false);
    });
  });
});
