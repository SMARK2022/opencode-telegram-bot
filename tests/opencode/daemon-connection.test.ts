import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  config: {
    opencode: {
      mode: "daemon" as "daemon" | "server",
      apiUrl: undefined as string | undefined,
      autoRestartEnabled: false,
    },
  },
  runCommand: vi.fn(),
  rebind: vi.fn(),
  resetClient: vi.fn(),
  startGlobal: vi.fn(),
  stopEvent: vi.fn(),
  notifyReady: vi.fn(),
  notifyUnavailable: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({ config: mocked.config }));
vi.mock("../../src/opencode/process.js", () => ({ runOpencodeDaemonCommand: mocked.runCommand }));
vi.mock("../../src/opencode/client.js", () => ({
  rebindOpencodeClient: mocked.rebind,
  resetOpencodeClient: mocked.resetClient,
}));
vi.mock("../../src/opencode/events.js", () => ({
  startGlobalEventTransport: mocked.startGlobal,
  stopEventListening: mocked.stopEvent,
}));
vi.mock("../../src/opencode/ready-lifecycle.js", () => ({
  opencodeReadyLifecycle: {
    notifyReady: mocked.notifyReady,
    notifyUnavailable: mocked.notifyUnavailable,
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

async function loadConnection() {
  vi.resetModules();
  return import("../../src/opencode/daemon-connection.js");
}

describe("opencode/daemon-connection", () => {
  beforeEach(() => {
    mocked.config.opencode.mode = "daemon";
    mocked.config.opencode.apiUrl = undefined;
    mocked.config.opencode.autoRestartEnabled = false;
    mocked.runCommand.mockReset();
    mocked.rebind.mockReset();
    mocked.resetClient.mockReset();
    mocked.startGlobal.mockReset();
    mocked.stopEvent.mockReset();
    mocked.notifyReady.mockReset();
    mocked.notifyUnavailable.mockReset();
  });

  it("shares one daemon acquisition and binds the returned owner URL", async () => {
    // deferred CLI结果稳定制造并发窗口，避免依赖wall-clock timing。
    // expected PID/URL是独立fixture literal，不读取production parser常量。
    // 测试只观察public connection API和rebind边界，不断言私有generation值。
    let resolveCommand: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand.mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    const connection = await loadConnection();

    const first = connection.startOpencodeConnection();
    const second = connection.startOpencodeConnection();
    await vi.waitFor(() => expect(mocked.runCommand).toHaveBeenCalledTimes(1));
    expect(mocked.runCommand).toHaveBeenCalledTimes(1);
    resolveCommand({
      stdout: '{"running":true,"pid":42,"url":"http://127.0.0.1:32100","responsive":true}\n',
      stderr: "",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      "http://127.0.0.1:32100",
      "http://127.0.0.1:32100",
    ]);
    // single-flight断言用户可见的owner identity，不依赖OpenCode内部lock或election实现。
    expect(mocked.rebind).toHaveBeenCalledOnce();
    expect(mocked.rebind).toHaveBeenCalledWith("http://127.0.0.1:32100");
  });

  it("lets a new start intent supersede an acquisition from before stop", async () => {
    // deferred旧结果精确覆盖stop/start窗口；新的running intent必须得到独立acquisition，而不是继承旧Promise。
    // 两个不同URL使测试能观察最终authority，且只允许显式stop产生一次safe-stop调用。
    let resolveOldStart: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldStart = resolve;
        }),
      )
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":52,"url":"http://127.0.0.1:32200","responsive":true}\n',
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":52,"url":"http://127.0.0.1:32200","responsive":true}\n',
        stderr: "",
      });
    mocked.startGlobal.mockImplementation(async (onReady: () => void) => onReady());
    const connection = await loadConnection();

    const obsoleteStart = connection.startOpencodeConnection();
    await vi.waitFor(() => expect(mocked.runCommand).toHaveBeenCalledWith(expect.arrayContaining(["start"])));
    await connection.stopOpencodeConnection();
    const restarted = connection.startOpencodeConnection();
    resolveOldStart({
      stdout: '{"running":true,"pid":51,"url":"http://127.0.0.1:32199","responsive":true}\n',
      stderr: "",
    });

    await expect(obsoleteStart).rejects.toThrow("became obsolete");
    await expect(restarted).resolves.toBe("http://127.0.0.1:32200");
    connection.startOpencodeConnectionLifecycle();
    await vi.waitFor(() => expect(mocked.notifyReady).toHaveBeenCalledWith("daemon_global_connected"));
    expect(mocked.runCommand.mock.calls.filter(([args]) => args[0] === "stop")).toHaveLength(1);
    expect(mocked.rebind).toHaveBeenCalledTimes(2);
    expect(mocked.rebind).toHaveBeenCalledWith("http://127.0.0.1:32200");
  });

  it("revokes Event and client authority before a safe-stop failure", async () => {
    // safe stop失败代表真实graceful/force窗口；业务authority必须已fail-closed，不能取决于CLI成功。
    mocked.runCommand.mockRejectedValue(new Error("safe stop failed"));
    const connection = await loadConnection();

    await expect(connection.stopOpencodeConnection()).rejects.toThrow("safe stop failed");

    expect(mocked.stopEvent).toHaveBeenCalledOnce();
    expect(mocked.resetClient).toHaveBeenCalledOnce();
    expect(mocked.stopEvent.mock.invocationCallOrder[0]).toBeLessThan(mocked.runCommand.mock.invocationCallOrder[0]);
    expect(mocked.resetClient.mock.invocationCallOrder[0]).toBeLessThan(mocked.runCommand.mock.invocationCallOrder[0]);
  });

  it("uses status-only rediscovery when auto-restart is disabled", async () => {
    // disabled只禁止创建owner，仍必须发现由TUI发布的新随机URL。
    // 调用序列断言没有start argv，从行为上防止隐式owner creation。
    // rebind断言锁定HTTP与下一次SSE共同使用的新地址。
    mocked.runCommand.mockResolvedValue({
      stdout: '{"running":true,"pid":43,"url":"http://127.0.0.1:32101","responsive":true}\n',
      stderr: "",
    });
    const connection = await loadConnection();

    await expect(connection.recoverOpencodeConnection()).resolves.toBe("http://127.0.0.1:32101");

    expect(mocked.runCommand).toHaveBeenCalledWith(["status", "--json"]);
    expect(mocked.runCommand).not.toHaveBeenCalledWith(expect.arrayContaining(["start"]));
    expect(mocked.rebind).toHaveBeenCalledWith("http://127.0.0.1:32101");
  });

  it("keeps a newer acquisition authoritative when an older status finishes last", async () => {
    // deferred status A与literal acquisition B重放真实producer乱序，不依赖私有lane或generation实现。
    // 最后可观察rebind必须是B；A-after-B会直接把HTTP与后续SSE拉回失效owner。
    let resolveOldStatus: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOldStatus = resolve;
        }),
      )
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":62,"url":"http://127.0.0.1:32302","responsive":true}\n',
        stderr: "",
      });
    const connection = await loadConnection();

    const oldRecovery = connection.recoverOpencodeConnection();
    const newerStart = connection.startOpencodeConnection();
    resolveOldStatus({
      stdout: '{"running":true,"pid":61,"url":"http://127.0.0.1:32301","responsive":true}\n',
      stderr: "",
    });
    await Promise.all([oldRecovery, newerStart]);

    expect(mocked.rebind).toHaveBeenLastCalledWith("http://127.0.0.1:32302");
  });

  it("waits for acquisition authority before starting a later status recovery", async () => {
    // acquisition占用lane时，monitor/Event status不能并发观察并提交另一个URL authority。
    // B完成后的status fixture仍返回B，证明HTTP rebind与后续SSE不会被反向覆盖。
    let resolveAcquisition: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveAcquisition = resolve;
        }),
      )
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":63,"url":"http://127.0.0.1:32303","responsive":true}\n',
        stderr: "",
      });
    const connection = await loadConnection();

    const acquisition = connection.startOpencodeConnection();
    await vi.waitFor(() => expect(mocked.runCommand).toHaveBeenCalledWith(expect.arrayContaining(["start"])));
    const recovery = connection.recoverOpencodeConnection();
    expect(mocked.runCommand.mock.calls.some(([args]) => args[0] === "status")).toBe(false);
    resolveAcquisition({
      stdout: '{"running":true,"pid":63,"url":"http://127.0.0.1:32303","responsive":true}\n',
      stderr: "",
    });
    await Promise.all([acquisition, recovery]);

    expect(mocked.rebind).toHaveBeenLastCalledWith("http://127.0.0.1:32303");
  });

  it("drops a queued acquisition before CLI when stop invalidates its generation", async () => {
    // B在旧lane中尚未产生side effect；stop后即使A结束，B也不得重新创建daemon owner。
    // adapter argv是公开进程边界，断言没有start比观察短暂rebind更早捕获真实副作用。
    let resolveStatus: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      )
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":64,"url":"http://127.0.0.1:32304","responsive":true}\n',
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const connection = await loadConnection();

    const oldRecovery = connection.recoverOpencodeConnection();
    await vi.waitFor(() => expect(mocked.runCommand).toHaveBeenCalledWith(["status", "--json"]));
    const queuedStart = connection.startOpencodeConnection();
    const queuedResult = expect(queuedStart).rejects.toThrow("became obsolete");
    await connection.stopOpencodeConnection();
    resolveStatus({ stdout: '{"running":false}\n', stderr: "" });
    await oldRecovery;
    await queuedResult;

    expect(mocked.runCommand.mock.calls.some(([args]) => args[0] === "start")).toBe(false);
  });

  it("continues the authority lane after returning an acquisition failure", async () => {
    // 第一个caller必须观察原始CLI失败；lane settlement不能把它伪装成成功或unavailable default。
    // 第二个start使用同一primary path并绑定独立literal URL，证明失败只释放队列而不毒化后续retry。
    mocked.runCommand
      .mockRejectedValueOnce(new Error("daemon start failed"))
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":65,"url":"http://127.0.0.1:32305","responsive":true}\n',
        stderr: "",
      });
    const connection = await loadConnection();

    await expect(connection.startOpencodeConnection()).rejects.toThrow("daemon start failed");
    await expect(connection.startOpencodeConnection()).resolves.toBe("http://127.0.0.1:32305");

    expect(mocked.rebind).toHaveBeenLastCalledWith("http://127.0.0.1:32305");
  });

  it("ignores a live status result that arrives after explicit stop", async () => {
    // deferred status制造stop已撤销authority后的迟到live owner；该URL不得越过generation边界重新rebind。
    let resolveStatus: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      )
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const connection = await loadConnection();

    const recovery = connection.recoverOpencodeConnection();
    await vi.waitFor(() => expect(mocked.runCommand).toHaveBeenCalledWith(["status", "--json"]));
    await connection.stopOpencodeConnection();
    resolveStatus({
      stdout: '{"running":true,"pid":53,"url":"http://127.0.0.1:32201","responsive":true}\n',
      stderr: "",
    });

    await expect(recovery).resolves.toBeUndefined();
    expect(mocked.rebind).not.toHaveBeenCalled();
    expect(mocked.runCommand.mock.calls.filter(([args]) => args[0] === "stop")).toHaveLength(1);
  });

  it("does not ensure after an absent status result that arrives after stop", async () => {
    // enabled policy只能处理当前running generation；旧status不能把显式stopped意图改回running。
    mocked.config.opencode.autoRestartEnabled = true;
    let resolveStatus: (value: { stdout: string; stderr: string }) => void = () => undefined;
    mocked.runCommand
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
      )
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const connection = await loadConnection();

    const recovery = connection.recoverOpencodeConnection();
    await vi.waitFor(() => expect(mocked.runCommand).toHaveBeenCalledWith(["status", "--json"]));
    await connection.stopOpencodeConnection();
    resolveStatus({ stdout: '{"running":false}\n', stderr: "" });

    await expect(recovery).resolves.toBeUndefined();
    expect(mocked.runCommand.mock.calls.some(([args]) => args[0] === "start")).toBe(false);
    expect(mocked.rebind).not.toHaveBeenCalled();
  });

  it("ensures an absent owner during enabled post-ready recovery", async () => {
    // 首个missing status是ensure的必要前提，测试不允许无条件start。
    // launcher PID使用真实bot-like进程PID，短命CLI不能承担startup liveness。
    // 两个独立JSON fixture证明status与start属于同一恢复链而非fallback。
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.runCommand
      .mockResolvedValueOnce({ stdout: '{"running":false}\n', stderr: "" })
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":44,"url":"http://127.0.0.1:32102","responsive":true}\n',
        stderr: "",
      });
    const connection = await loadConnection();

    await expect(connection.recoverOpencodeConnection()).resolves.toBe("http://127.0.0.1:32102");
    expect(mocked.runCommand.mock.calls[0][0]).toEqual(["status", "--json"]);
    expect(mocked.runCommand.mock.calls[1][0]).toEqual([
      "start",
      "--json",
      "--launcher-pid",
      String(process.pid),
    ]);
  });

  it("keeps a failed status unavailable instead of ensuring another success path", async () => {
    // status transport/protocol失败不等于权威absent；只有合法running:false才授权enabled ensure。
    // 原始失败返回supervisor继续同一retry，不能被后续start URL掩盖成成功。
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.runCommand
      .mockRejectedValueOnce(new Error("daemon status failed"))
      .mockResolvedValueOnce({
        stdout: '{"running":true,"pid":66,"url":"http://127.0.0.1:32306","responsive":true}\n',
        stderr: "",
      });
    const connection = await loadConnection();

    await expect(connection.recoverOpencodeConnection()).rejects.toThrow("daemon status failed");

    expect(mocked.runCommand.mock.calls.some(([args]) => args[0] === "start")).toBe(false);
    expect(mocked.rebind).not.toHaveBeenCalled();
  });

  it("preserves an explicit Server URL without invoking daemon CLI", async () => {
    // 显式loopback是既有支持域，不能因本机hostname被重定向到shared daemon。
    // no-command断言保护配置意图，也防止direct Server失败后副作用启动daemon。
    // URL原样rebind证明custom path/port不会被规范化丢失。
    mocked.config.opencode.mode = "server";
    mocked.config.opencode.apiUrl = "http://127.0.0.1:4987";
    const connection = await loadConnection();

    await expect(connection.startOpencodeConnection()).resolves.toBe("http://127.0.0.1:4987");
    expect(mocked.runCommand).not.toHaveBeenCalled();
    expect(mocked.rebind).toHaveBeenCalledWith("http://127.0.0.1:4987");
  });
});
