import fs from "node:fs/promises";
import { readFile } from "node:fs/promises";

import { cleanupBotRuntime, createBot } from "../../bot/index.js";
import { createScheduledTaskDeliverySender } from "../../bot/messages/scheduled-task-delivery.js";
import { config } from "../../config.js";
import { opencodeAutoRestartService } from "../../opencode/auto-restart.js";
import {
  isDaemonMode,
  startOpencodeConnection,
  startOpencodeConnectionLifecycle,
  stopOpencodeConnectionLifecycle,
} from "../../opencode/daemon-connection.js";
import { opencodeReadyLifecycle } from "../../opencode/ready-lifecycle.js";
import {
  notifyOpencodeReadyIfHealthy,
  registerOpenCodeReadyRefreshHandler,
} from "../../opencode/ready-refresh.js";
import { loadSettings } from "../stores/settings-store.js";
import { scheduledTaskRuntime } from "../services/scheduled-task-runtime-service.js";
import { getRuntimeMode } from "../../runtime/mode.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { clearServiceStateFile } from "../../runtime/service/manager.js";
import { getServiceStateFilePathFromEnv, isServiceChildProcess } from "../../runtime/service/env.js";
import { getLogFilePath, initializeLogger, logger } from "../../utils/logger.js";

const SHUTDOWN_TIMEOUT_MS = 5000;

async function getBotVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../../../package.json", import.meta.url);
    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };

    return packageJson.version ?? "unknown";
  } catch (error) {
    logger.warn("[App] Failed to read bot version", error);
    return "unknown";
  }
}

export async function startBotApp(): Promise<void> {
  await initializeLogger();

  const mode = getRuntimeMode();
  const runtimePaths = getRuntimePaths();
  const version = await getBotVersion();
  const logFilePath = getLogFilePath();

  logger.info(`Starting OpenCode Telegram Bot v${version}...`);
  logger.info(`Node.js ${process.version} on ${process.platform} ${process.arch}`);
  logger.info(`Config loaded from ${runtimePaths.envFilePath}`);
  if (logFilePath) {
    logger.info(`Logs are written to ${logFilePath}`);
  }
  logger.info(`Allowed User ID: ${config.telegram.allowedUserId}`);
  logger.debug(`[Runtime] Application start mode: ${mode}`);

  const unhandledRejectionHandler = (reason: unknown): void => {
    logger.error("[App] Unhandled promise rejection", reason);
    void clearManagedServiceState()
      .catch(() => {})
      .finally(() => process.exit(1));
  };

  const uncaughtExceptionHandler = (error: Error): void => {
    logger.error("[App] Uncaught exception", error);
    void clearManagedServiceState()
      .catch(() => {})
      .finally(() => process.exit(1));
  };

  process.on("unhandledRejection", unhandledRejectionHandler);
  process.on("uncaughtException", uncaughtExceptionHandler);

  await loadSettings();
  registerOpenCodeReadyRefreshHandler();
  const bot = createBot();
  let scheduledInitialization: Promise<void> | null = null;
  let daemonMonitorStarted = false;
  const unsubscribeScheduledReady = opencodeReadyLifecycle.onReady(async () => {
    if (isDaemonMode() && !daemonMonitorStarted) {
      // 首个authoritative ready后才激活monitor，initial acquisition始终只有supervised lifecycle一个producer。
      daemonMonitorStarted = true;
      void opencodeAutoRestartService.start().catch((error) => logger.warn("[App] OpenCode daemon monitor failed", error));
    }
    // persisted due task只在首个authoritative ready后恢复；reconnect不能重复执行startup recovery。
    // Promise本身充当one-shot guard，并发ready handler也只能共享一次initialize。
    // 初始化失败保持可见reject，不通过第二次恢复隐式重复执行到期任务。
    // shutdown允许runtime尚未初始化，Telegram polling生命周期不依赖该consumer。
    scheduledInitialization ??= scheduledTaskRuntime.initialize(
      bot,
      createScheduledTaskDeliverySender(bot.api, config.telegram.allowedUserId),
    );
    await scheduledInitialization;
  });

  if (isDaemonMode()) {
    // lifecycle在后台重试，Telegram polling不会因CLI acquisition失败而失去控制面。
    // 用户可在OpenCode outage期间继续使用/start/status类Telegram命令。
    // 后台错误由connection owner记录，不能向bot.start promise传播并终止polling。
    // direct Server保留独立健康路径，运行失败不会切换到daemon mode。
    startOpencodeConnectionLifecycle();
  } else {
    void startOpencodeConnection()
      .then(() => opencodeAutoRestartService.start())
      .then(() => notifyOpencodeReadyIfHealthy("startup"))
      .catch((error) => logger.warn("[App] Explicit OpenCode Server is unavailable", error));
  }
  let shutdownStarted = false;
  let serviceStateCleared = false;
  let shutdownTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearManagedServiceState = async (): Promise<void> => {
    if (!isServiceChildProcess() || serviceStateCleared) {
      return;
    }

    const stateFilePath = getServiceStateFilePathFromEnv();
    if (!stateFilePath) {
      return;
    }

    try {
      await fs.access(stateFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        serviceStateCleared = true;
        return;
      }

      throw error;
    }

    await clearServiceStateFile(stateFilePath);
    serviceStateCleared = true;
  };

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logger.info(`[App] Received ${signal}, shutting down...`);
    cleanupBotRuntime(`app_shutdown_${signal.toLowerCase()}`);
    stopOpencodeConnectionLifecycle();
    opencodeAutoRestartService.stop();
    scheduledTaskRuntime.shutdown();

    shutdownTimeout = setTimeout(() => {
      logger.warn(`[App] Shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit.`);
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    shutdownTimeout.unref?.();

    try {
      bot.stop();
    } catch (error) {
      logger.warn("[App] Failed to stop Telegram bot cleanly", error);
    }

    void clearManagedServiceState().catch((error) => {
      logger.warn("[App] Failed to clear managed service state", error);
    });
  };

  const handleSigint = (): void => shutdown("SIGINT");
  const handleSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  const webhookInfo = await bot.api.getWebhookInfo();
  if (webhookInfo.url) {
    logger.info(`[Bot] Webhook detected: ${webhookInfo.url}, removing...`);
    await bot.api.deleteWebhook();
    logger.info("[Bot] Webhook removed, switching to long polling");
  }

  try {
    await bot.start({
      onStart: (botInfo) => {
        logger.info(`Bot @${botInfo.username} started!`);
      },
    });
  } finally {
    process.off("unhandledRejection", unhandledRejectionHandler);
    process.off("uncaughtException", uncaughtExceptionHandler);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }
    cleanupBotRuntime("app_shutdown_complete");
    unsubscribeScheduledReady();
    stopOpencodeConnectionLifecycle();
    opencodeAutoRestartService.stop();
    scheduledTaskRuntime.shutdown();
    await clearManagedServiceState().catch((error) => {
      logger.warn("[App] Failed to clear managed service state", error);
    });
  }
}
