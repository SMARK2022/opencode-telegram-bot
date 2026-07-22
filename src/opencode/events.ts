import { opencodeClient } from "./client.js";
import { Event } from "@opencode-ai/sdk/v2";
import { logger } from "../utils/logger.js";
import { isExpectedOpencodeUnavailableError } from "../utils/opencode-error.js";

type EventCallback = (event: Event) => void;
type EventStreamSource = "global" | "legacy";
export type EventTransportMode = "daemon" | "server";
type EventStreamSubscription = {
  source: EventStreamSource;
  stream: AsyncGenerator<unknown, unknown, unknown>;
};
type EventSubscriptionResult = {
  stream?: AsyncGenerator<unknown, unknown, unknown> | null;
};
type OptionalGlobalEventApi = {
  event?: (options?: { signal?: AbortSignal }) => Promise<EventSubscriptionResult>;
};
type OptionalGlobalEventClient = {
  global?: OptionalGlobalEventApi;
};

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
let sseIdleTimeoutMs = 30_000;
const FATAL_NO_STREAM_ERROR = "No stream returned from event subscription";
const SSE_IDLE_TIMEOUT_ERROR = "SSE stream idle timeout";

let eventStream: AsyncGenerator<unknown, unknown, unknown> | null = null;
let eventCallback: EventCallback | null = null;
let isListening = false;
let activeDirectory: string | null = null;
let activeMode: EventTransportMode = "server";
let streamAbortController: AbortController | null = null;
let listenerGeneration = 0;
let consumerGeneration = 0;
let readyCallback: (() => void) | null = null;
let disconnectCallback: (() => Promise<void>) | null = null;
// transport状态属于bot进程，directory只属于当前business consumer过滤器。
// ready与disconnect callback连接lifecycle owner，但不复制其status/ensure策略。
// daemon与Server mode共享读取循环，只在已证明的legacy compatibility处分支。
let consecutiveTimeouts = 0;

type StreamReadResult =
  | { type: "next"; result: IteratorResult<unknown, unknown> }
  | { type: "error"; error: unknown }
  | { type: "aborted" }
  | { type: "timeout" };

function getReconnectDelayMs(attempt: number): number {
  const exponentialDelay = RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exponentialDelay, RECONNECT_MAX_DELAY_MS);
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAttemptAbortController(parentSignal: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();

  if (parentSignal.aborted) {
    controller.abort();
    return { controller, cleanup: () => {} };
  }

  const onAbort = () => controller.abort();
  parentSignal.addEventListener("abort", onAbort, { once: true });

  return {
    controller,
    cleanup: () => parentSignal.removeEventListener("abort", onAbort),
  };
}

function readStreamWithIdleTimeout(
  stream: AsyncGenerator<unknown, unknown, unknown>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: StreamReadResult) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => finish({ type: "aborted" });
    const timeout = setTimeout(() => finish({ type: "timeout" }), sseIdleTimeoutMs);

    if (signal.aborted) {
      finish({ type: "aborted" });
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    stream.next().then(
      (result) => finish({ type: "next", result }),
      (error) => finish({ type: "error", error }),
    );
  });
}

function isEventStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === SSE_IDLE_TIMEOUT_ERROR;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEventLike(value: unknown): value is Event {
  return isRecord(value) && typeof value.type === "string" && isRecord(value.properties);
}

function normalizeDirectoryForComparison(directory: string): string {
  const normalized = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isSameDirectory(left: string, right: string): boolean {
  return normalizeDirectoryForComparison(left) === normalizeDirectoryForComparison(right);
}

function normalizeGlobalEvent(rawEvent: unknown, directory: string): Event | null {
  // 空directory表示尚未选择Project，connected/heartbeat仍必须被消费以维持liveness。
  // 有directory时才过滤envelope，避免Project A事件进入Project B业务状态。
  // payload形状未知时fail closed，不能合成Session或Project mutation。
  if (isEventLike(rawEvent)) {
    return rawEvent;
  }

  if (!isRecord(rawEvent) || !("payload" in rawEvent)) {
    logger.debug("[Events] Ignoring global event with unknown shape");
    return null;
  }

  const eventDirectory = typeof rawEvent.directory === "string" ? rawEvent.directory : null;
  if (directory && eventDirectory && !isSameDirectory(eventDirectory, directory)) {
    return null;
  }

  if (!isEventLike(rawEvent.payload)) {
    logger.debug("[Events] Ignoring global event with unknown payload shape");
    return null;
  }

  return rawEvent.payload;
}

function normalizeEvent(rawEvent: unknown, source: EventStreamSource, directory: string): Event | null {
  if (source === "global") {
    return normalizeGlobalEvent(rawEvent, directory);
  }

  if (!isEventLike(rawEvent)) {
    logger.debug("[Events] Ignoring legacy event with unknown shape");
    return null;
  }

  return rawEvent;
}

async function subscribeToGlobalEventStream(signal: AbortSignal): Promise<EventStreamSubscription> {
  const globalEvents = (opencodeClient as OptionalGlobalEventClient).global;
  if (!globalEvents?.event) {
    throw new Error("Global event subscription is not available");
  }

  const result = await globalEvents.event({ signal });
  if (!result.stream) {
    throw new Error(FATAL_NO_STREAM_ERROR);
  }

  return { source: "global", stream: result.stream };
}

async function subscribeToLegacyEventStream(
  directory: string,
  signal: AbortSignal,
): Promise<EventStreamSubscription> {
  const result = await opencodeClient.event.subscribe({ directory }, { signal });

  if (!result.stream) {
    throw new Error(FATAL_NO_STREAM_ERROR);
  }

  return { source: "legacy", stream: result.stream };
}

export async function subscribeToEvents(
  directory: string,
  callback: EventCallback,
  mode: EventTransportMode = "server",
): Promise<void> {
  // daemon mode更新callback/directory时复用同一stream，Project切换不得制造零client窗口。
  // explicit Server切换directory保留既有重订阅语义，因为它不承担daemon idle计数。
  // listener generation保护延迟callback，旧consumer不能在切换后写入新Project状态。
  if (isListening && activeMode === mode && (mode === "daemon" || activeDirectory === directory)) {
    // transport保持不变时仍需换代business consumer，丢弃切换前已排队的旧Project callback。
    consumerGeneration++;
    eventCallback = callback;
    activeDirectory = directory;
    logger.debug(`Event listener already running for ${directory}`);
    return;
  }

  if (isListening && activeDirectory !== directory) {
    logger.info(`Stopping event listener for ${activeDirectory}, starting for ${directory}`);
    streamAbortController?.abort();
    streamAbortController = null;
    isListening = false;
    activeDirectory = null;
  }

  const controller = new AbortController();
  const generation = ++listenerGeneration;

  activeDirectory = directory;
  activeMode = mode;
  consumerGeneration++;
  eventCallback = callback;
  isListening = true;
  streamAbortController = controller;

  try {
    let reconnectAttempt = 0;
    let useLegacyEventsOnce = false;

    while (isListening && isCurrentListener(directory, mode) && !controller.signal.aborted) {
      let attemptAbort: ReturnType<typeof createAttemptAbortController> | null = null;
      try {
        let subscription: EventStreamSubscription;
        attemptAbort = createAttemptAbortController(controller.signal);
        if (useLegacyEventsOnce) {
          useLegacyEventsOnce = false;
          subscription = await subscribeToLegacyEventStream(directory, attemptAbort.controller.signal);
        } else {
          try {
            subscription = await subscribeToGlobalEventStream(attemptAbort.controller.signal);
            logger.debug(`Using global OpenCode event stream for ${directory}`);
          } catch (error) {
            if (controller.signal.aborted || !isListening || !isCurrentListener(directory, mode)) {
              throw error;
            }

            if (mode === "daemon" || isExpectedOpencodeUnavailableError(error)) {
              throw error;
            }

            logger.warn(
              `Global event stream unavailable for ${directory}, falling back to project event stream`,
              error,
            );
            subscription = await subscribeToLegacyEventStream(directory, attemptAbort.controller.signal);
          }
        }

        reconnectAttempt = 0;
        consecutiveTimeouts = 0;
        eventStream = subscription.stream;
        let usefulEventCount = 0;

        try {
          while (isListening && isCurrentListener(directory, mode) && !controller.signal.aborted) {
            const readResult = await readStreamWithIdleTimeout(
              eventStream,
              attemptAbort.controller.signal,
            );

            if (readResult.type === "aborted") {
              logger.debug(`Event listener stopped or changed directory, breaking loop`);
              break;
            }

            if (readResult.type === "timeout") {
              attemptAbort.controller.abort();
              const closeStream = eventStream.return?.(undefined);
              void closeStream?.catch(() => undefined);
              throw new Error(SSE_IDLE_TIMEOUT_ERROR);
            }

            if (readResult.type === "error") {
              throw readResult.error;
            }

            if (readResult.result.done) {
              break;
            }

            const event = readResult.result.value;

            // CRITICAL: Explicitly yield to the event loop BEFORE processing the event
            // This allows grammY to handle getUpdates between SSE events
            await new Promise<void>((resolve) => setImmediate(resolve));

            const normalizedEvent = normalizeEvent(event, subscription.source, activeDirectory ?? directory);
            if (!normalizedEvent) {
              continue;
            }

            if (normalizedEvent.type !== "server.connected") {
              usefulEventCount++;
            } else {
              readyCallback?.();
            }

            if (eventCallback) {
              // Use setImmediate to avoid blocking the event loop
              // and let grammY process incoming Telegram updates
              const callbackSnapshot = eventCallback;
              const callbackGeneration = consumerGeneration;
              setImmediate(() => {
                if (
                  streamAbortController !== controller ||
                  controller.signal.aborted ||
                  !isListening ||
                  !isCurrentListener(directory, mode) ||
                  listenerGeneration !== generation ||
                  consumerGeneration !== callbackGeneration
                ) {
                  return;
                }

                try {
                  callbackSnapshot(normalizedEvent);
                } catch (error) {
                  logger.error("[Events] Callback failed:", error);
                }
              });
            }
          }
        } finally {
          attemptAbort.cleanup();
        }

        eventStream = null;

        if (!isListening || !isCurrentListener(directory, mode) || controller.signal.aborted) {
          break;
        }

        if (mode === "server" && subscription.source === "global" && usefulEventCount === 0) {
          useLegacyEventsOnce = true;
          logger.warn(
            `Global event stream ended without project events for ${directory}, falling back to project event stream`,
          );
          continue;
        }

        reconnectAttempt++;
        consecutiveTimeouts = 0;
        // 下一次global subscribe必须读取recovery后live binding，不能继续请求失效URL。
        if (mode === "daemon") await disconnectCallback?.();
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        logger.warn(
          `Event stream ended for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
        );

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      } catch (error) {
        attemptAbort?.cleanup();
        eventStream = null;

        if (controller.signal.aborted || !isListening || !isCurrentListener(directory, mode)) {
          logger.info("Event listener aborted");
          return;
        }

        if (error instanceof Error && error.message === FATAL_NO_STREAM_ERROR) {
          logger.error("Event stream fatal error:", error);
          throw error;
        }

        reconnectAttempt++;
        consecutiveTimeouts++;
        if (mode === "daemon") await disconnectCallback?.();
        const reconnectDelay = getReconnectDelayMs(reconnectAttempt);
        if (isEventStreamIdleTimeoutError(error)) {
          const timeoutWarning =
            consecutiveTimeouts >= 5
              ? ` (${consecutiveTimeouts} consecutive timeouts — OpenCode server may be unreachable)`
              : "";
          logger.warn(
            `Event stream idle timeout for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})${timeoutWarning}`,
          );
        } else if (isExpectedOpencodeUnavailableError(error)) {
          logger.warn(
            `Event stream unavailable for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
          );
        } else {
          logger.error(
            `Event stream error for ${directory}, reconnecting in ${reconnectDelay}ms (attempt=${reconnectAttempt})`,
            error,
          );
        }

        const shouldContinue = await waitWithAbort(reconnectDelay, controller.signal);
        if (!shouldContinue) {
          break;
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      logger.info("Event listener aborted");
      return;
    }

    if (isExpectedOpencodeUnavailableError(error)) {
      logger.warn("Event stream unavailable; listener stopped");
    } else {
      logger.error("Event stream error:", error);
    }
    isListening = false;
    activeDirectory = null;
    streamAbortController = null;
    throw error;
  } finally {
    if (streamAbortController === controller) {
      if (isListening && isCurrentListener(directory, mode) && !controller.signal.aborted) {
        logger.warn(`Event stream ended for ${directory}, listener marked as disconnected`);
      }

      streamAbortController = null;
      eventStream = null;
      eventCallback = null;
      readyCallback = null;
      disconnectCallback = null;
      isListening = false;
      activeDirectory = null;
    }
  }
}

export async function startGlobalEventTransport(
  onReady: () => void,
  onDisconnect: () => Promise<void>,
): Promise<void> {
  // startup promise只等待首个server.connected，长期读取循环继续在后台拥有stream。
  // connected是SDK rebind后的authoritative ready证据，health成功不能替代它。
  // reject仅表示首连失败，外层supervisor负责同一模式重试而非fallback。
  await new Promise<void>((resolve, reject) => {
    readyCallback = () => {
      onReady();
      resolve();
    };
    disconnectCallback = onDisconnect;
    void subscribeToEvents("", () => undefined, "daemon").catch(reject);
  });
}

function isCurrentListener(directory: string, mode: EventTransportMode): boolean {
  return activeMode === mode && (mode === "daemon" || activeDirectory === directory);
}

export function stopEventListening(): void {
  listenerGeneration++;
  consumerGeneration++;
  streamAbortController?.abort();
  streamAbortController = null;
  isListening = false;
  eventCallback = null;
  readyCallback = null;
  disconnectCallback = null;
  eventStream = null;
  activeDirectory = null;
  logger.info("Event listener stopped");
}

export function __setSseIdleTimeoutForTests(timeoutMs: number): void {
  sseIdleTimeoutMs = timeoutMs;
}
