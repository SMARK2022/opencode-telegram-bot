import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { isExpectedOpencodeUnavailableError } from "../../utils/opencode-error.js";
import { getCurrentProject } from "../stores/settings-store.js";

export const DEFAULT_CONTEXT_LIMIT = 200000;

const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1000;

const contextLimitCache = new Map<string, Map<string, number>>();
const providersCacheExpiresAt = new Map<string, number>();
const providersFetchInFlight = new Map<string, Promise<void>>();
// context limit可能被Project配置覆盖，因此按worktree隔离整个catalog snapshot。
// expiry map与value map使用相同identity，避免新Project命中过期时间却没有自己的值。
// in-flight map阻止同Project重复请求，同时允许不同Project并行解析。

function getModelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

async function refreshContextLimitCache(directory: string): Promise<void> {
  // refresh失败保留该Project既有值，不能清空或读取其他Project的cache。
  // 完成时只删除同directory的Promise，Project A不能结束Project B的in-flight。
  // default context limit仍是显式unavailable结果，不伪造Provider返回值。
  if (Date.now() < (providersCacheExpiresAt.get(directory) ?? 0)) {
    return;
  }

  const currentFetch = providersFetchInFlight.get(directory);
  if (currentFetch) {
    await currentFetch;
    return;
  }

  const fetch = (async () => {
    try {
      const { data, error } = await opencodeClient.config.providers({ directory });

      if (error || !data) {
        if (isExpectedOpencodeUnavailableError(error)) {
          logger.warn("[ModelContextLimit] OpenCode server unavailable; using default context limit");
        } else {
          logger.warn("[ModelContextLimit] Failed to fetch providers:", error);
        }
        return;
      }

      const limits = new Map<string, number>();
      for (const provider of data.providers) {
        for (const [modelID, model] of Object.entries(provider.models)) {
          if (model?.limit?.context) {
            limits.set(getModelKey(provider.id, modelID), model.limit.context);
          }
        }
      }

      contextLimitCache.set(directory, limits);
      providersCacheExpiresAt.set(directory, Date.now() + PROVIDER_CACHE_TTL_MS);
      logger.debug(
        `[ModelContextLimit] Cached limits for ${limits.size} provider/model pairs`,
      );
    } catch (error) {
      if (isExpectedOpencodeUnavailableError(error)) {
        logger.warn("[ModelContextLimit] OpenCode server unavailable; using default context limit");
      } else {
        logger.warn("[ModelContextLimit] Error refreshing providers cache:", error);
      }
    } finally {
      providersFetchInFlight.delete(directory);
    }
  })();

  providersFetchInFlight.set(directory, fetch);
  await fetch;
}

export async function getModelContextLimit(
  providerID?: string | null,
  modelID?: string | null,
): Promise<number> {
  if (!providerID || !modelID) {
    return DEFAULT_CONTEXT_LIMIT;
  }

  const directory = getCurrentProject()?.worktree;
  if (!directory) return DEFAULT_CONTEXT_LIMIT;

  const cacheKey = getModelKey(providerID, modelID);
  const cachedLimit = contextLimitCache.get(directory)?.get(cacheKey);
  if (cachedLimit) {
    return cachedLimit;
  }

  // expiry与in-flight都按worktree隔离，Project切换不能等待或命中另一个catalog。
  await refreshContextLimitCache(directory);
  return contextLimitCache.get(directory)?.get(cacheKey) ?? DEFAULT_CONTEXT_LIMIT;
}
