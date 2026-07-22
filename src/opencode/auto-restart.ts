import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { opencodeClient } from "./client.js";
import { isDaemonMode, recoverOpencodeConnection } from "./daemon-connection.js";
import { opencodeReadyLifecycle } from "./ready-lifecycle.js";
import {
  resolveLocalOpencodeTarget,
  startLocalOpencodeServer,
  type LocalOpencodeTarget,
} from "./process.js";

const SERVER_READY_TIMEOUT_MS = 10000;
const SERVER_READY_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const HEALTH_CHECK_TIMED_OUT = Symbol("health-check-timed-out");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof HEALTH_CHECK_TIMED_OUT> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<typeof HEALTH_CHECK_TIMED_OUT>((resolve) => {
        timeout = setTimeout(() => resolve(HEALTH_CHECK_TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function isOpencodeServerHealthy(): Promise<boolean> {
  try {
    const result = await withTimeout(opencodeClient.global.health(), HEALTH_CHECK_TIMEOUT_MS);
    if (result === HEALTH_CHECK_TIMED_OUT) {
      logger.warn(
        `[OpenCodeAutoRestart] Health-check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`,
      );
      return false;
    }

    const { data, error } = result;
    return !error && data?.healthy === true;
  } catch {
    return false;
  }
}

async function waitForOpencodeServerReady(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isOpencodeServerHealthy()) {
      return true;
    }

    await sleep(SERVER_READY_POLL_INTERVAL_MS);
  }

  return false;
}

export class OpencodeAutoRestartService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private localTarget: LocalOpencodeTarget | null = null;
  private started = false;
  private checkInProgress = false;
  private serverWasHealthy = false;

  async start(): Promise<boolean> {
    if (this.started || !config.opencode.autoRestartEnabled) {
      return false;
    }

    this.started = true;

    if (isDaemonMode()) {
      // 默认daemon的owner由OpenCode维护；bot只在ready后的丢失窗口请求同一ensure路径。
      // monitor调用同一connection owner，不能重新引入standalone serve acquisition。
      // auto-restart flag只控制post-ready owner creation，不改变initial ensure。
      // Event disconnect仍是即时恢复信号，interval只是现有产品monitor的补充观察。
      await this.checkAndRestart("startup");
      this.timer = setInterval(() => {
        void this.checkAndRestart("interval");
      }, config.opencode.monitorIntervalSec * 1000);
      this.timer.unref?.();
      return true;
    }

    const apiUrl = config.opencode.apiUrl;
    const localTarget = apiUrl ? resolveLocalOpencodeTarget(apiUrl) : null;
    if (!localTarget) {
      logger.warn(`[OpenCodeAutoRestart] Disabled because OPENCODE_API_URL is not local: ${apiUrl ?? "unset"}`);
      this.started = false;
      return false;
    }

    this.localTarget = localTarget;

    logger.info(
      `[OpenCodeAutoRestart] Enabled: port=${localTarget.port}, intervalSec=${config.opencode.monitorIntervalSec}`,
    );

    await this.checkAndRestart("startup");

    this.timer = setInterval(() => {
      void this.checkAndRestart("interval");
    }, config.opencode.monitorIntervalSec * 1000);
    this.timer.unref?.();

    return true;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.started = false;
    this.localTarget = null;
    this.serverWasHealthy = false;
  }

  private async checkAndRestart(reason: "startup" | "interval"): Promise<void> {
    if (this.checkInProgress || (!this.localTarget && !isDaemonMode())) {
      return;
    }

    this.checkInProgress = true;

    try {
      if (isDaemonMode()) {
        await recoverOpencodeConnection();
        return;
      }
      const localTarget = this.localTarget;
      if (!localTarget) return;

      if (await isOpencodeServerHealthy()) {
        logger.debug(`[OpenCodeAutoRestart] Health-check succeeded: reason=${reason}`);
        if (!this.serverWasHealthy) {
          this.serverWasHealthy = true;
          await opencodeReadyLifecycle.notifyReady(`auto_restart_${reason}`);
        }
        return;
      }

      this.serverWasHealthy = false;
      opencodeReadyLifecycle.notifyUnavailable(`auto_restart_${reason}`);

      logger.warn(
        `[OpenCodeAutoRestart] OpenCode server is unavailable, starting local server: reason=${reason}, port=${localTarget.port}`,
      );

      const childProcess = startLocalOpencodeServer(localTarget);
      childProcess.once("error", (error) => {
        logger.error("[OpenCodeAutoRestart] OpenCode server process failed to start", error);
      });

      const pid = childProcess.pid;
      childProcess.unref();

      const ready = await waitForOpencodeServerReady(SERVER_READY_TIMEOUT_MS);
      if (!ready) {
        logger.warn(
          `[OpenCodeAutoRestart] OpenCode server was started but did not become ready: pid=${pid ?? "unknown"}, port=${localTarget.port}`,
        );
        return;
      }

      logger.info(
        `[OpenCodeAutoRestart] OpenCode server recovered: pid=${pid ?? "unknown"}, port=${localTarget.port}`,
      );
      this.serverWasHealthy = true;
      await opencodeReadyLifecycle.notifyReady(`auto_restart_${reason}`);
    } catch (error) {
      logger.error("[OpenCodeAutoRestart] Failed to check or restart OpenCode server", error);
    } finally {
      this.checkInProgress = false;
    }
  }
}

export const opencodeAutoRestartService = new OpencodeAutoRestartService();
