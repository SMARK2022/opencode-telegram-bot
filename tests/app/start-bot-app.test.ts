import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createBotMock: vi.fn(),
  cleanupBotRuntimeMock: vi.fn(),
  autoRestartStartMock: vi.fn(),
  autoRestartStopMock: vi.fn(),
  notifyOpencodeReadyIfHealthyMock: vi.fn(),
  registerOpenCodeReadyRefreshHandlerMock: vi.fn(),
  loadSettingsMock: vi.fn(),
  scheduledTaskInitializeMock: vi.fn(),
  scheduledTaskShutdownMock: vi.fn(),
  reconcileStoredModelSelectionMock: vi.fn(),
  clearServiceStateFileMock: vi.fn(),
  isServiceChildProcessMock: vi.fn(),
  getServiceStateFilePathFromEnvMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  initializeLoggerMock: vi.fn(),
  getLogFilePathMock: vi.fn(),
  isDaemonModeMock: vi.fn(),
  startOpencodeConnectionMock: vi.fn(),
  startOpencodeConnectionLifecycleMock: vi.fn(),
  stopOpencodeConnectionLifecycleMock: vi.fn(),
  readyHandlers: [] as Array<(reason: string) => Promise<void> | void>,
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
    },
    telegram: {
      allowedUserId: 123,
    },
  },
}));

vi.mock("../../src/bot/index.js", () => ({
  cleanupBotRuntime: mocked.cleanupBotRuntimeMock,
  createBot: mocked.createBotMock,
}));

vi.mock("../../src/config.js", () => ({
  config: mocked.config,
}));

vi.mock("../../src/opencode/auto-restart.js", () => ({
  opencodeAutoRestartService: {
    start: mocked.autoRestartStartMock,
    stop: mocked.autoRestartStopMock,
  },
}));

vi.mock("../../src/opencode/daemon-connection.js", () => ({
  isDaemonMode: mocked.isDaemonModeMock,
  startOpencodeConnection: mocked.startOpencodeConnectionMock,
  startOpencodeConnectionLifecycle: mocked.startOpencodeConnectionLifecycleMock,
  stopOpencodeConnectionLifecycle: mocked.stopOpencodeConnectionLifecycleMock,
}));

vi.mock("../../src/opencode/ready-lifecycle.js", () => ({
  opencodeReadyLifecycle: {
    onReady: (handler: (reason: string) => Promise<void> | void) => {
      mocked.readyHandlers.push(handler);
      return () => undefined;
    },
  },
}));

vi.mock("../../src/opencode/ready-refresh.js", () => ({
  notifyOpencodeReadyIfHealthy: mocked.notifyOpencodeReadyIfHealthyMock,
  registerOpenCodeReadyRefreshHandler: mocked.registerOpenCodeReadyRefreshHandlerMock,
}));

vi.mock("../../src/app/stores/settings-store.js", () => ({
  loadSettings: mocked.loadSettingsMock,
}));

vi.mock("../../src/app/services/scheduled-task-runtime-service.js", () => ({
  scheduledTaskRuntime: {
    initialize: mocked.scheduledTaskInitializeMock,
    shutdown: mocked.scheduledTaskShutdownMock,
  },
}));

vi.mock("../../src/app/services/model-selection-service.js", () => ({
  reconcileStoredModelSelection: mocked.reconcileStoredModelSelectionMock,
}));

vi.mock("../../src/runtime/mode.js", () => ({
  getRuntimeMode: () => "source",
}));

vi.mock("../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({ envFilePath: ".env" }),
}));

vi.mock("../../src/runtime/service/manager.js", () => ({
  clearServiceStateFile: mocked.clearServiceStateFileMock,
}));

vi.mock("../../src/runtime/service/env.js", () => ({
  getServiceStateFilePathFromEnv: mocked.getServiceStateFilePathFromEnvMock,
  isServiceChildProcess: mocked.isServiceChildProcessMock,
}));

vi.mock("../../src/utils/logger.js", () => ({
  getLogFilePath: mocked.getLogFilePathMock,
  initializeLogger: mocked.initializeLoggerMock,
  logger: {
    debug: mocked.loggerDebugMock,
    info: mocked.loggerInfoMock,
    warn: mocked.loggerWarnMock,
    error: mocked.loggerErrorMock,
  },
}));

import { startBotApp } from "../../src/app/bootstrap/start-bot-app.js";

function createBot() {
  return {
    api: {
      deleteWebhook: vi.fn().mockResolvedValue(undefined),
      getWebhookInfo: vi.fn().mockResolvedValue({ url: "" }),
    },
    start: vi.fn().mockImplementation(async ({ onStart }) => {
      onStart?.({ username: "test_bot" });
    }),
    stop: vi.fn(),
  };
}

async function flushBackgroundTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("app/start-bot-app", () => {
  beforeEach(() => {
    mocked.createBotMock.mockReset();
    mocked.cleanupBotRuntimeMock.mockReset();
    mocked.autoRestartStartMock.mockReset();
    mocked.autoRestartStopMock.mockReset();
    mocked.notifyOpencodeReadyIfHealthyMock.mockReset();
    mocked.registerOpenCodeReadyRefreshHandlerMock.mockReset();
    mocked.loadSettingsMock.mockReset();
    mocked.scheduledTaskInitializeMock.mockReset();
    mocked.scheduledTaskShutdownMock.mockReset();
    mocked.reconcileStoredModelSelectionMock.mockReset();
    mocked.clearServiceStateFileMock.mockReset();
    mocked.isServiceChildProcessMock.mockReset();
    mocked.getServiceStateFilePathFromEnvMock.mockReset();
    mocked.loggerInfoMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerErrorMock.mockReset();
    mocked.initializeLoggerMock.mockReset();
    mocked.getLogFilePathMock.mockReset();
    mocked.isDaemonModeMock.mockReset();
    mocked.startOpencodeConnectionMock.mockReset();
    mocked.startOpencodeConnectionLifecycleMock.mockReset();
    mocked.stopOpencodeConnectionLifecycleMock.mockReset();
    mocked.readyHandlers.length = 0;

    mocked.createBotMock.mockReturnValue(createBot());
    mocked.autoRestartStartMock.mockResolvedValue(false);
    mocked.notifyOpencodeReadyIfHealthyMock.mockResolvedValue(false);
    mocked.loadSettingsMock.mockResolvedValue(undefined);
    mocked.scheduledTaskInitializeMock.mockResolvedValue(undefined);
    mocked.reconcileStoredModelSelectionMock.mockResolvedValue(undefined);
    mocked.isServiceChildProcessMock.mockReturnValue(false);
    mocked.initializeLoggerMock.mockResolvedValue(undefined);
    mocked.getLogFilePathMock.mockReturnValue(null);
    mocked.isDaemonModeMock.mockReturnValue(false);
    mocked.startOpencodeConnectionMock.mockResolvedValue("http://127.0.0.1:4096");
  });

  it("registers ready refresh and performs startup health notification", async () => {
    await startBotApp();
    await flushBackgroundTasks();

    expect(mocked.registerOpenCodeReadyRefreshHandlerMock).toHaveBeenCalledTimes(1);
    expect(mocked.notifyOpencodeReadyIfHealthyMock).toHaveBeenCalledWith("startup");
  });

  it("runs startup health notification even when auto-restart handled startup", async () => {
    mocked.autoRestartStartMock.mockResolvedValue(true);

    await startBotApp();
    await flushBackgroundTasks();

    expect(mocked.notifyOpencodeReadyIfHealthyMock).toHaveBeenCalledWith("startup");
  });

  it("starts Telegram polling without waiting for OpenCode startup checks", async () => {
    let resolveAutoRestart: (value: boolean) => void = () => undefined;
    mocked.autoRestartStartMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveAutoRestart = resolve;
      }),
    );
    const bot = createBot();
    mocked.createBotMock.mockReturnValue(bot);

    await startBotApp();

    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(mocked.notifyOpencodeReadyIfHealthyMock).not.toHaveBeenCalled();

    resolveAutoRestart(false);
    await flushBackgroundTasks();
    expect(mocked.notifyOpencodeReadyIfHealthyMock).toHaveBeenCalledWith("startup");
  });

  it("starts Telegram polling while daemon acquisition lifecycle retries", async () => {
    // lifecycle mock代表任意长的acquisition outage，bot.start仍是独立公开控制面。
    // 该断言不等待内部retry次数，因此在慢CI上保持确定性。
    // direct one-shot acquisition必须零调用，避免startup重新引入阻塞await。
    mocked.isDaemonModeMock.mockReturnValue(true);
    mocked.startOpencodeConnectionLifecycleMock.mockImplementation(() => undefined);
    const bot = createBot();
    mocked.createBotMock.mockReturnValue(bot);

    await startBotApp();

    expect(mocked.startOpencodeConnectionLifecycleMock).toHaveBeenCalledTimes(1);
    // monitor只属于post-ready owner-loss recovery，首次acquisition仍只有supervised lifecycle一个producer。
    expect(mocked.autoRestartStartMock).not.toHaveBeenCalled();
    // polling可用性独立于daemon acquisition结果，用户仍能发送start/status命令。
    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(mocked.startOpencodeConnectionMock).not.toHaveBeenCalled();

    const handler = mocked.readyHandlers.at(-1);
    if (!handler) throw new Error("missing daemon ready handler");
    await handler("daemon_global_connected");
    expect(mocked.autoRestartStartMock).toHaveBeenCalledTimes(1);
  });

  it("initializes scheduled tasks once only after authoritative ready", async () => {
    // ready handler是startup owner的公开协作seam，测试不读取scheduled内部timer。
    // 两次ready模拟真实reconnect，expected count来自one-shot产品合同。
    // ready前零调用证明到期任务不会消费fail-closed SDK client。
    mocked.isDaemonModeMock.mockReturnValue(true);

    await startBotApp();
    expect(mocked.scheduledTaskInitializeMock).not.toHaveBeenCalled();

    const handler = mocked.readyHandlers.at(-1);
    if (!handler) throw new Error("missing scheduled ready handler");
    await handler("daemon_global_connected");
    await handler("daemon_reconnected");

    // due task recovery属于首次ready，不属于后续reconnect；因此整个进程只初始化一次。
    expect(mocked.scheduledTaskInitializeMock).toHaveBeenCalledTimes(1);
  });
});
