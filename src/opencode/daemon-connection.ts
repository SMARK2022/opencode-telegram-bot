import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { rebindOpencodeClient, resetOpencodeClient } from "./client.js";
import { startGlobalEventTransport, stopEventListening } from "./events.js";
import { runOpencodeDaemonCommand } from "./process.js";
import { opencodeReadyLifecycle } from "./ready-lifecycle.js";

export type DaemonConnectionState = "running" | "stopped";
export type DaemonConnectionInfo = {
  running: boolean;
  pid?: number;
  url?: string;
  responsive?: boolean;
};

let desiredState: DaemonConnectionState = "running";
let generation = 0;
let inFlight: { generation: number; promise: Promise<string> } | null = null;
let authorityLaneGeneration = generation;
let authorityLaneTail = Promise.resolve();
let lifecycleAbortController: AbortController | null = null;
// desired state表达用户意图，generation表达异步结果的新旧，两者职责不同。
// single-flight只合并bot侧重复命令，最终single-owner仍由OpenCode election决定。
// lifecycle controller只终止bot重试，不直接终止共享daemon进程。

export function isDaemonMode(): boolean {
  return config.opencode.mode === "daemon";
}

export async function startOpencodeConnection(): Promise<string> {
  // initial acquisition总是ensure，因为bot需要一个backend才能建立authoritative stream。
  // direct Server是配置支持域分支，不会由daemon运行失败触发。
  // rebind完成仍不代表ready，只有后续global SSE connected可以发布ready。
  const wasStopped = desiredState === "stopped";
  desiredState = "running";
  if (wasStopped) generation += 1;
  if (!isDaemonMode()) {
    const url = requireConfiguredServerUrl();
    rebindOpencodeClient(url);
    return url;
  }

  if (inFlight?.generation === generation) return inFlight.promise;
  const currentGeneration = generation;
  const promise = runAuthorityOperation(currentGeneration, () => {
    // 排队期间发生stop时，旧work必须在首次CLI side effect前退出，不能短暂重建owner。
    if (currentGeneration !== generation || connectionIsStopped()) {
      throw new Error("OpenCode daemon acquisition became obsolete");
    }
    return acquireDaemon(currentGeneration);
  }).finally(() => {
    if (inFlight?.generation === currentGeneration) inFlight = null;
  });
  inFlight = { generation: currentGeneration, promise };
  return promise;
}

export async function stopOpencodeConnection(): Promise<void> {
  // 先提交stopped意图再停止owner，断线回调看到的永远是最新用户决定。
  // generation递增使并发start结果失效，避免旧URL在stop后复活业务client。
  // safe stop委托OpenCode control owner，bot不扫描端口或直接kill PID。
  desiredState = "stopped";
  generation += 1;
  // stop前的command不可再满足后续start；其stale检查继续负责迟到owner，但single-flight槽位立即解绑。
  inFlight = null;
  lifecycleAbortController?.abort();
  lifecycleAbortController = null;
  opencodeReadyLifecycle.notifyUnavailable("daemon_explicit_stop");
  if (!isDaemonMode()) return;
  // stopped authority必须先对业务consumer生效，即使safe stop随后失败也不能继续使用旧owner。
  stopEventListening();
  resetOpencodeClient();
  await runOpencodeDaemonCommand(["stop"]);
}

export async function getOpencodeConnectionInfo(): Promise<DaemonConnectionInfo> {
  if (!isDaemonMode()) {
    const url = requireConfiguredServerUrl();
    return { running: true, url, responsive: true };
  }

  const result = await runOpencodeDaemonCommand(["status", "--json"]);
  return parseConnectionInfo(result.stdout);
}

export async function recoverOpencodeConnection(): Promise<string | undefined> {
  // status-first让disabled模式仍能发现由TUI创建的新owner，而不自行创建owner。
  // enabled模式只在确认absent后ensure，不能因暂时unresponsive产生第二owner。
  // 返回undefined表示仍不可用，不转换成固定端口或成功形状。
  if (desiredState === "stopped") return;
  const currentGeneration = generation;
  return runAuthorityOperation(currentGeneration, async () => {
    // status同样可能在lane中等待；过期recovery不能在stop后启动新的CLI child。
    if (currentGeneration !== generation || connectionIsStopped()) return;
    // status failure保持unavailable并交给supervisor重试；它不能被解释为owner absent后ensure成功。
    const existing = await getOpencodeConnectionInfo();
    // status与optional ensure属于同一authority operation，避免两者之间重新开放并发提交窗口。
    if (currentGeneration !== generation || connectionIsStopped()) return;
    if (existing?.running && existing.url) {
      rebindOpencodeClient(existing.url);
      return existing.url;
    }
    if (!config.opencode.autoRestartEnabled) return;
    return acquireDaemon(currentGeneration);
  });
}

export function startOpencodeConnectionLifecycle(): void {
  if (!isDaemonMode() || lifecycleAbortController) return;
  const controller = new AbortController();
  lifecycleAbortController = controller;
  void runLifecycle(controller.signal).catch((error) => {
    if (!controller.signal.aborted) logger.error("[Daemon] Connection lifecycle stopped", error);
  });
}

export function stopOpencodeConnectionLifecycle(): void {
  lifecycleAbortController?.abort();
  lifecycleAbortController = null;
}

async function runLifecycle(signal: AbortSignal): Promise<void> {
  // supervised loop与Telegram polling解耦，连接失败不会关闭用户控制面。
  // 首次connected结束startup等待，但Event内部继续持有唯一长期stream。
  // 每次disconnect都先完成owner rediscovery/rebind，再允许下一次subscribe。
  while (!signal.aborted && desiredState === "running") {
    try {
      await startOpencodeConnection();
      await startGlobalEventTransport(
        () => {
          void opencodeReadyLifecycle.notifyReady("daemon_global_connected");
        },
        async () => {
          if (signal.aborted || connectionIsStopped()) return;
          opencodeReadyLifecycle.notifyUnavailable("daemon_event_disconnected");
          // Event在下一次subscribe前等待该owner恢复，保证读取的是重绑定后的live client。
          await recoverOpencodeConnection();
        },
      );
      return;
    } catch (error) {
      if (signal.aborted || connectionIsStopped()) return;
      opencodeReadyLifecycle.notifyUnavailable("daemon_acquisition_failed");
      logger.warn("[Daemon] Connection unavailable, retrying", error);
      if (!(await waitWithAbort(1_000, signal))) return;
    }
  }
}

function connectionIsStopped(): boolean {
  return desiredState === "stopped";
}

function runAuthorityOperation<T>(currentGeneration: number, operation: () => Promise<T>): Promise<T> {
  // 同一running generation只有一条URL authority lane，status与ensure按进入顺序提交rebind。
  if (authorityLaneGeneration !== currentGeneration) {
    authorityLaneGeneration = currentGeneration;
    authorityLaneTail = Promise.resolve();
  }
  const result = authorityLaneTail.then(operation);
  // caller保留自己的fulfilled/rejected结果；neutral tail只允许下一项继续，不把失败转换为caller成功。
  authorityLaneTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requireConfiguredServerUrl(): string {
  if (config.opencode.apiUrl) return config.opencode.apiUrl;
  throw new Error("OpenCode Server URL is not configured");
}

async function acquireDaemon(currentGeneration: number): Promise<string> {
  const result = await runOpencodeDaemonCommand([
    "start",
    "--json",
    "--launcher-pid",
    String(process.pid),
  ]);
  const info = parseConnectionInfo(result.stdout);
  if (!info.running || !info.url) throw new Error("OpenCode daemon did not return a usable connection");
  if (currentGeneration !== generation || desiredState === "stopped") {
    // 新running intent可合法复用同一OpenCode owner；只有最新意图仍是stopped时才清理迟到owner。
    if (desiredState === "stopped") {
      await runOpencodeDaemonCommand(["stop"]).catch((error) => logger.warn("[Daemon] Failed to stop stale acquisition", error));
    }
    throw new Error("OpenCode daemon acquisition became obsolete");
  }
  rebindOpencodeClient(info.url);
  return info.url;
}

function parseConnectionInfo(stdout: string): DaemonConnectionInfo {
  const value: unknown = JSON.parse(stdout.trim());
  if (!value || typeof value !== "object" || !("running" in value) || typeof value.running !== "boolean") {
    throw new Error("Invalid opencode daemon JSON response");
  }
  if (!value.running) return { running: false };
  if (!("pid" in value) || typeof value.pid !== "number" || !("url" in value) || typeof value.url !== "string") {
    throw new Error("Invalid running opencode daemon JSON response");
  }
  return {
    running: true,
    pid: value.pid,
    url: value.url,
    responsive: "responsive" in value && typeof value.responsive === "boolean" ? value.responsive : undefined,
  };
}
