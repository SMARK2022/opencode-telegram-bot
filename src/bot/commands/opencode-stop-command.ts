import { CommandContext, Context } from "grammy";
import { config } from "../../config.js";
import { opencodeClient } from "../../opencode/client.js";
import {
  findServerPid,
  killServerProcess,
  resolveLocalOpencodeTarget,
} from "../../opencode/process.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { editBotText } from "../messages/telegram-text.js";
import { isDaemonMode, stopOpencodeConnection } from "../../opencode/daemon-connection.js";

/**
 * Command handler for /opencode-stop
 * Stops the OpenCode server process
 */
export async function opencodeStopCommand(ctx: CommandContext<Context>) {
  try {
    if (isDaemonMode()) {
      // desired stopped在Event abort前提交，断线观察者不能把用户停止误判成故障。
      // safe daemon stop属于OpenCode authenticated control path，bot不处理owner token。
      // success只在CLI完成后发送，不能把“已请求停止”当作“已停止”。
      // process-level stream关闭后由daemon idle/stop语义决定owner，不保留第二liveness连接。
      await stopOpencodeConnection();
      await ctx.reply(t("opencode_stop.success"));
      return;
    }

    const apiUrl = config.opencode.apiUrl;
    // explicit Server支持域继续按配置端口查找PID，这是已发布兼容而非daemon备用路径。
    // remote URL保持unmanaged，bot不会跨主机猜测或终止Server进程。
    // mode invariant损坏直接进入error UI，不尝试shared daemon取得成功。
    // 后续health复核只验证同一configured Server，没有跨URL恢复分支。
    if (!apiUrl) {
      throw new Error("OpenCode Server URL is missing in direct Server mode");
    }
    const localTarget = resolveLocalOpencodeTarget(apiUrl);
    if (!localTarget) {
      await ctx.reply(t("opencode_stop.remote_configured"));
      return;
    }

    try {
      const { data, error } = await opencodeClient.global.health();
      if (error || !data?.healthy) {
        await ctx.reply(t("opencode_stop.not_running"));
        return;
      }
    } catch {
      await ctx.reply(t("opencode_stop.not_running"));
      return;
    }

    const pid = await findServerPid(localTarget.port);
    if (!pid) {
      await ctx.reply(t("opencode_stop.pid_not_found", { port: localTarget.port }));
      return;
    }

    const statusMessage = await ctx.reply(t("opencode_stop.stopping", { pid }));

    const stopped = await killServerProcess(pid, 5000);
    if (!stopped) {
      await editBotText({
        api: ctx.api,
        chatId: ctx.chat.id,
        messageId: statusMessage.message_id,
        text: t("opencode_stop.stop_error", { error: t("common.unknown_error") }),
      });
      return;
    }

    try {
      const { data, error } = await opencodeClient.global.health();
      if (!error && data?.healthy) {
        await editBotText({
          api: ctx.api,
          chatId: ctx.chat.id,
          messageId: statusMessage.message_id,
          text: t("opencode_stop.stop_error", { error: t("opencode_stop.still_running") }),
        });
        return;
      }
    } catch {
      // Health check failure after stop is expected.
    }

    await editBotText({
      api: ctx.api,
      chatId: ctx.chat.id,
      messageId: statusMessage.message_id,
      text: t("opencode_stop.success"),
    });

    logger.info(`[Bot] OpenCode server stopped successfully, PID=${pid}, port=${localTarget.port}`);
  } catch (err) {
    logger.error("[Bot] Error in /opencode-stop command:", err);
    await ctx.reply(t("opencode_stop.error"));
  }
}
