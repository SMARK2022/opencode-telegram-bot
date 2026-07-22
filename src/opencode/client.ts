import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.js";

const FAIL_CLOSED_LOCAL_URL = "http://127.0.0.1:1";
// 该不可达端口只保护daemon discovery前窗口，不能成为可观察成功路径。
// 不保留4096可避免acquisition失败时误连旧standalone Server。
// 所有业务模块读取同一ESM live binding，URL切换无需复制SDK facade。

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

export let opencodeClient = createOpencodeClient({
  baseUrl: config.opencode.apiUrl ?? FAIL_CLOSED_LOCAL_URL,
  headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
});

export function rebindOpencodeClient(baseUrl: string): void {
  // daemon URL是运行时owner事实；单一可变binding让所有现有service在重选主后读取同一连接。
  opencodeClient = createOpencodeClient({
    baseUrl,
    headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
  });
}

export function resetOpencodeClient(): void {
  // stopped窗口撤销旧URL authority，后续consumer只能得到明确连接失败而不能访问正在停止的owner。
  rebindOpencodeClient(FAIL_CLOSED_LOCAL_URL);
}
