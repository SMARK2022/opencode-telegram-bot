import { describe, expect, it } from "vitest";

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  createOpencodeDaemonCommand,
  createOpencodeServeSpawnCommand,
  findUnixListeningPidInSs,
  findWindowsListeningPidInNetstat,
  runOpencodeDaemonCommand,
} from "../../src/opencode/process.js";

describe("opencode/process", () => {
  it("matches the exact local port on Windows netstat output", async () => {
    const stdout = [
      "  TCP    127.0.0.1:40960      0.0.0.0:0      LISTENING       1111",
      "  TCP    127.0.0.1:4096       0.0.0.0:0      LISTENING       2222",
    ].join("\r\n");

    expect(findWindowsListeningPidInNetstat(stdout, 4096)).toBe(2222);
  });

  it("matches the exact local port in ss fallback output", async () => {
    const stdout = [
      'LISTEN 0 128 127.0.0.1:40960 0.0.0.0:* users:(("node",pid=1111,fd=17))',
      'LISTEN 0 128 127.0.0.1:4096 0.0.0.0:* users:(("opencode",pid=2222,fd=18))',
    ].join("\n");

    expect(findUnixListeningPidInSs(stdout, 4096)).toBe(2222);
  });

  it("builds opencode serve command with the configured local port", () => {
    const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });

    if (process.platform === "win32") {
      expect(command.windowsHide).toBe(true);

      // If we claim to spawn opencode.exe directly, it must be a real absolute path.
      // Otherwise, spawn() will likely fail with ENOENT on default npm installs where
      // only opencode.cmd is on PATH.
      if (command.command.toLowerCase() === "cmd.exe") {
        expect(command.args).toEqual(["/c", "opencode", "serve", "--port", "4987"]);
      } else {
        expect(path.isAbsolute(command.command)).toBe(true);
        expect(command.command.toLowerCase().endsWith("\\opencode.exe")).toBe(true);
        expect(command.args).toEqual(["serve", "--port", "4987"]);
      }
      return;
    }

    expect(command).toEqual({
      command: "opencode",
      args: ["serve", "--port", "4987"],
      windowsHide: false,
    });
  });

  it("builds a shell-free daemon command for the current platform", () => {
    // daemon argv必须保持数组边界；status/start参数不能进入cmd.exe或其他shell字符串。
    if (process.platform === "win32") {
      try {
        const command = createOpencodeDaemonCommand(["status", "--json"]);
        expect(path.isAbsolute(command.command)).toBe(true);
        expect(command.command.toLowerCase().endsWith("\\opencode.exe")).toBe(true);
        expect(command.args).toEqual(["daemon", "status", "--json"]);
      } catch (error) {
        expect(error).toEqual(new Error("Unable to resolve opencode.exe for daemon command"));
      }
      return;
    }

    expect(createOpencodeDaemonCommand(["status", "--json"])).toEqual({
      command: "opencode",
      args: ["daemon", "status", "--json"],
      windowsHide: false,
    });
  });

  it("preserves daemon argv and separates output from non-zero diagnostics", async () => {
    if (process.platform === "win32") return;
    // literal分号若被shell解释会提前退出；成功输出证明spawn保持argv并由fixture executable直接接收。
    // 第二次运行保留stderr到拒绝信息，失败不能被部分stdout转换为machine成功。
    const originalPath = process.env.PATH;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-daemon-adapter-"));
    const executable = path.join(tempRoot, "opencode");
    try {
      fs.writeFileSync(executable, '#!/bin/sh\nprintf "stdout:%s\\n" "$*"\nprintf "stderr-only\\n" >&2\n', "utf8");
      fs.chmodSync(executable, 0o755);
      process.env.PATH = tempRoot;

      await expect(runOpencodeDaemonCommand(["status", "literal; exit 99"])).resolves.toEqual({
        stdout: "stdout:daemon status literal; exit 99\n",
        stderr: "stderr-only\n",
      });

      fs.writeFileSync(executable, '#!/bin/sh\nprintf "partial"\nprintf "adapter failed\\n" >&2\nexit 7\n', "utf8");
      await expect(runOpencodeDaemonCommand(["status", "--json"])).rejects.toThrow(
        "opencode daemon status exited with code 7: adapter failed",
      );
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to cmd.exe on Windows when opencode.exe cannot be resolved", () => {
    if (process.platform !== "win32") {
      return;
    }

    const originalPath = process.env.PATH;

    try {
      process.env.PATH = "";

      const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });
      expect(command).toEqual({
        command: "cmd.exe",
        args: ["/c", "opencode", "serve", "--port", "4987"],
        windowsHide: true,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves opencode.exe directly from PATH when no .cmd shim exists", () => {
    if (process.platform !== "win32") {
      return;
    }

    const originalPath = process.env.PATH;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-telegram-bot-"));
    const binDir = path.join(tempRoot, "bin");
    const exePath = path.join(binDir, "opencode.exe");

    try {
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(exePath, "", "utf8");

      // Isolate PATH to only the temp dir — no npm .cmd shim on PATH
      process.env.PATH = binDir;

      const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });
      expect(command).toEqual({
        command: exePath,
        args: ["serve", "--port", "4987"],
        windowsHide: true,
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses resolved opencode.exe on Windows when opencode.cmd is on PATH and exe exists", () => {
    if (process.platform !== "win32") {
      return;
    }

    const originalPath = process.env.PATH;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-telegram-bot-"));
    const binDir = path.join(tempRoot, "bin");
    const exePath = path.join(binDir, "node_modules", "opencode-ai", "bin", "opencode.exe");
    const cmdPath = path.join(binDir, "opencode.cmd");

    try {
      fs.mkdirSync(path.dirname(exePath), { recursive: true });
      fs.writeFileSync(exePath, "", "utf8");
      fs.writeFileSync(cmdPath, "@echo off\r\nexit /b 0\r\n", "utf8");

      process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);

      const command = createOpencodeServeSpawnCommand({ host: "localhost", port: 4987 });
      expect(command).toEqual({
        command: exePath,
        args: ["serve", "--port", "4987"],
        windowsHide: true,
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
