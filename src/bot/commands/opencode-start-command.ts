import { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import { resolveLocalOpencodeTarget, startLocalOpencodeServer } from "../../opencode/process.js";
import { opencodeReadyLifecycle } from "../../opencode/ready-lifecycle.js";
import {
  isDaemonMode,
  startOpencodeConnection,
  startOpencodeConnectionLifecycle,
} from "../../opencode/daemon-connection.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { editBotText } from "../messages/telegram-text.js";

const SERVER_READY_TIMEOUT_MS = 10_000;
const SERVER_READY_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_CHECK_TIMED_OUT = Symbol("health-check-timed-out");

type HealthCheckResult = Awaited<ReturnType<typeof opencodeClient.global.health>>;

async function healthWithTimeout(
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthCheckResult | typeof HEALTH_CHECK_TIMED_OUT> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      opencodeClient.global.health({ signal: controller.signal }),
      new Promise<typeof HEALTH_CHECK_TIMED_OUT>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(HEALTH_CHECK_TIMED_OUT);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function getHealthIfAvailable(): Promise<HealthCheckResult | null> {
  try {
    const result = await healthWithTimeout();
    if (result === HEALTH_CHECK_TIMED_OUT) {
      logger.warn(`[Bot] OpenCode health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`);
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Wait for OpenCode server to become ready by polling health endpoint
 * @param maxWaitMs Maximum time to wait in milliseconds
 * @returns true if server became ready, false if timeout
 */
async function waitForServerReady(maxWaitMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const health = await getHealthIfAvailable();
    if (health?.data?.healthy) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, SERVER_READY_POLL_INTERVAL_MS));
  }

  return false;
}

/**
 * Command handler for /opencode-start
 * Starts the OpenCode server process
 */
export async function opencodeStartCommand(ctx: CommandContext<Context>) {
  try {
    if (isDaemonMode()) {
      // 命令先恢复running intent与owner，再等待global connected后向用户报告成功。
      // 十秒上限只控制Telegram诊断等待，不改变后台lifecycle继续重试的事实。
      // fixed-port child在该分支完全不可达，explicit Server逻辑保留在后续分支。
      // already-running文案复用现有i18n，避免为拓扑变化扩大用户消息接口。
      await startOpencodeConnection();
      startOpencodeConnectionLifecycle();
      if (!opencodeReadyLifecycle.isReady()) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            unsubscribe();
            reject(new Error("OpenCode daemon global event stream did not become ready"));
          }, SERVER_READY_TIMEOUT_MS);
          const unsubscribe = opencodeReadyLifecycle.onReady(() => {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          });
        });
      }
      await ctx.reply(t("opencode_start.already_running", { version: t("common.unknown") }));
      return;
    }

    const apiUrl = config.opencode.apiUrl;
    // server mode理论上必有effective URL；缺失表示配置invariant损坏而非daemon fallback信号。
    // loopback target继续使用现有serve PID合同，remote target继续返回unmanaged提示。
    // 此处不按hostname改变mode，只在已选Server域内判断本地进程管理能力。
    // health tuple仍按既有逻辑解析，connection owner不吸收显式Server monitor责任。
    if (!apiUrl) {
      throw new Error("OpenCode Server URL is missing in direct Server mode");
    }
    const localTarget = resolveLocalOpencodeTarget(apiUrl);
    if (!localTarget) {
      await ctx.reply(t("opencode_start.remote_configured"));
      return;
    }

    // Check if server is already accessible.
    try {
      const health = await getHealthIfAvailable();
      const data = health?.data;

      if (data?.healthy) {
        await ctx.reply(
          t("opencode_start.already_running", { version: data.version || t("common.unknown") }),
        );
        await opencodeReadyLifecycle.notifyReady("opencode_start_already_running");
        return;
      }
    } catch {
      // Server not accessible, continue with start.
    }

    const statusMessage = await ctx.reply(t("opencode_start.starting"));

    const childProcess = startLocalOpencodeServer(localTarget);

    childProcess.once("error", (error) => {
      logger.error("[Bot] OpenCode server process failed to start", error);
    });

    const pid = childProcess.pid;
    if (!pid) {
      await editBotText({
        api: ctx.api,
        chatId: ctx.chat.id,
        messageId: statusMessage.message_id,
        text: t("opencode_start.start_error", { error: t("common.unknown_error") }),
      });
      return;
    }

    childProcess.unref();

    logger.info("[Bot] Waiting for OpenCode server to become ready...");
    const ready = await waitForServerReady(SERVER_READY_TIMEOUT_MS);

    if (!ready) {
      await editBotText({
        api: ctx.api,
        chatId: ctx.chat.id,
        messageId: statusMessage.message_id,
        text: t("opencode_start.started_not_ready", {
          pid,
        }),
      });
      return;
    }

    const health = (await getHealthIfAvailable())?.data;
    await editBotText({
      api: ctx.api,
      chatId: ctx.chat.id,
      messageId: statusMessage.message_id,
      text: t("opencode_start.success", {
        pid,
        version: health?.version || t("common.unknown"),
      }),
    });

    logger.info(`[Bot] OpenCode server started successfully, PID=${pid}, port=${localTarget.port}`);
    await opencodeReadyLifecycle.notifyReady("opencode_start_success");
  } catch (err) {
    logger.error("[Bot] Error in /opencode-start command:", err);
    await ctx.reply(t("opencode_start.error"));
  }
}
