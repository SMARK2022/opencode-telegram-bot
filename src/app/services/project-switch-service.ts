import type { Context } from "grammy";
import type {
  ForceReply,
  InlineKeyboardMarkup,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from "grammy/types";
import type { ProjectInfo } from "../types/project.js";
import type { ModelInfo } from "../types/model.js";
import { setCurrentProject } from "../stores/settings-store.js";
import { clearSession } from "./session-service.js";
import { summaryAggregator } from "../managers/summary-aggregation-manager.js";
import { detachAttachedSession } from "./attach-service.js";
import { backgroundSessionTracker } from "../managers/background-session-manager.js";
import { getStoredAgent, resolveProjectAgent } from "./agent-selection-service.js";
import { getStoredModel } from "./model-selection-service.js";
import { formatVariantForButton } from "./variant-selection-service.js";
import { clearAllInteractionState } from "../managers/interaction-manager.js";
import { logger } from "../../utils/logger.js";

interface ProjectSwitchContextInfo {
  tokensUsed: number;
  tokensLimit: number;
}

type ProjectSwitchReplyMarkup =
  | InlineKeyboardMarkup
  | ReplyKeyboardMarkup
  | ReplyKeyboardRemove
  | ForceReply;

export interface ProjectSwitchPresentation {
  clearPinnedMessage(): Promise<void>;
  initializeKeyboard(ctx: Context): void;
  refreshContextLimit(): Promise<number>;
  updateKeyboardContext(contextInfo: ProjectSwitchContextInfo): void;
  updateKeyboardAgent(agent: string): void;
  createMainKeyboard(
    agent: string,
    model: ModelInfo,
    contextInfo: ProjectSwitchContextInfo,
    variantName: string,
  ): ProjectSwitchReplyMarkup;
}

interface SwitchToProjectOptions {
  ensureEventSubscription?: (directory: string) => Promise<void>;
  presentation: ProjectSwitchPresentation;
}

export async function switchToProject(
  ctx: Context,
  project: ProjectInfo,
  reason: string,
  options: SwitchToProjectOptions,
) {
  detachAttachedSession(reason);
  // Project切换只替换business filter；process-level global SSE继续承担daemon liveness。
  // detach与summary clear属于业务状态，不能顺带关闭共享transport。
  // 即使background tracking关闭，也更新directory以免旧Project callback继续接收事件。
  // ensureEventSubscription在daemon mode复用现有stream，不产生第二个SSE client。
  backgroundSessionTracker.clear();
  setCurrentProject(project);
  clearSession();
  summaryAggregator.clear();
  clearAllInteractionState(reason);

  try {
    await options.presentation.clearPinnedMessage();
  } catch (err) {
    logger.error("[Bot] Error clearing pinned message:", err);
  }

  options.presentation.initializeKeyboard(ctx);

  const contextLimit = await options.presentation.refreshContextLimit();
  options.presentation.updateKeyboardContext({ tokensUsed: 0, tokensLimit: contextLimit });

  const currentAgent = await resolveProjectAgent(getStoredAgent());
  const currentModel = getStoredModel();
  const contextInfo = { tokensUsed: 0, tokensLimit: contextLimit };
  const variantName = formatVariantForButton(currentModel.variant || "default");
  options.presentation.updateKeyboardAgent(currentAgent);

  if (options.ensureEventSubscription) {
    await options.ensureEventSubscription(project.worktree);
  }

  return options.presentation.createMainKeyboard(currentAgent, currentModel, contextInfo, variantName);
}
