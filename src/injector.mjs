import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { CodexAppServerClient } from "./app-server-client.mjs";
import { connectCodexTarget, listCdpTargets } from "./cdp-client.mjs";
import { logger } from "./logger.mjs";
import { normalizeUsageResponse } from "./usage-model.mjs";
import { buildWidgetSource, usageWidgetBootstrap } from "./widget-runtime.mjs";

/** localStorage 中的有效版本键，必须和 Renderer 脚本保持一致。 */
const ACTIVE_REVISION_KEY = "codex-usage-injector-active-revision";

/** Renderer 全局控制器名称，用于推送数据、读取状态和执行恢复。 */
const WIDGET_STATE_KEY = "__CODEX_USAGE_WIDGET__";

/** 目标发现循环间隔；兼顾窗口重开响应速度和本机 CPU 占用。 */
const DISCOVERY_INTERVAL_MS = 800;

/** 连接错误日志的最小间隔，端口未开启时避免每轮重复输出相同消息。 */
const CONNECTION_LOG_INTERVAL_MS = 5_000;

/** 数据读取失败后的重试间隔；失败时比正常刷新更快，但不高频请求后台。 */
const USAGE_RETRY_INTERVAL_MS = 10_000;

/** 会话 Token 日志轮询间隔；比额度刷新更快，确保回复完成后尽快补到操作栏。 */
const TOKEN_USAGE_POLL_INTERVAL_MS = 1_000;

/** 会话日志单行允许保留的最大长度；超长正文行直接跳过，避免把完整对话内容放进内存。 */
const TOKEN_USAGE_LINE_BUFFER_LIMIT = 16_384;

/**
 * 会话日志增量读取块大小；固定上限避免首次处理大型 JSONL 时按文件大小分配 Buffer。
 * 该值只影响单次磁盘读取，不改变日志偏移量和 Token 统计结果。
 */
const TOKEN_USAGE_READ_CHUNK_BYTES = 64 * 1024;

/** 项目版本参与生成注入 revision，源码变化后旧 early script 会自动失效。 */
const PROJECT_VERSION = "0.1.0";

/**
 * 延迟指定时长，让常驻循环有机会处理窗口和数据刷新。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {number} milliseconds 等待毫秒数。
 * @returns {Promise<void>} 等待结束后完成。
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 生成和当前 Renderer 代码绑定的短 revision。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @returns {string} 可安全写入 localStorage 和日志的版本字符串。
 */
function createWidgetRevision() {
  const digest = createHash("sha256")
    .update(`${PROJECT_VERSION}\n${usageWidgetBootstrap.toString()}`)
    .digest("hex")
    .slice(0, 16);
  return `${PROJECT_VERSION}-${digest}`;
}

/**
 * 管理 app-server 用量采集、CDP 页面发现和 Renderer 数据推送。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 */
export class UsageInjector {
  /**
   * 创建注入器运行时；构造过程不启动子进程，也不修改 Renderer。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {{port: number, intervalMs: number}} options 运行端口和用量刷新周期。
   */
  constructor({ port, intervalMs }) {
    this.port = port;
    this.intervalMs = intervalMs;
    this.revision = createWidgetRevision();
    this.widgetSource = buildWidgetSource(this.revision);
    this.sessions = new Map();
    this.appServer = null;
    this.latestSnapshot = { status: "loading" };
    this.nextUsagePollAt = 0;
    this.nextTokenUsagePollAt = 0;
    this.threadLogPaths = new Map();
    this.tokenLogStates = new Map();
    this.stopping = false;
    this.lastConnectionLogAt = 0;
  }

  /**
   * 请求常驻循环结束；实际清理在 run 的 finally 中集中完成。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  stop() {
    this.stopping = true;
    // 修改人：liujl
    // 修改时间：2026-07-22 17:45:00
    // 修改说明：停止等待中的额度请求，避免 Codex 更新后旧注入器超过启动器等待窗口。
    this.appServer?.close();
    this.appServer = null;
  }

  /**
   * 启动常驻循环，持续发现 Codex Renderer 并刷新用量。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @returns {Promise<void>} 收到停止信号并清理完成后返回。
   */
  async run() {
    logger.info("用量注入器开始运行", {
      port: this.port,
      intervalMs: this.intervalMs,
      revision: this.revision,
    });
    try {
      while (!this.stopping) {
        await this.refreshTargets();
        if (Date.now() >= this.nextUsagePollAt) await this.pollUsage();
        if (Date.now() >= this.nextTokenUsagePollAt)
          await this.pollTokenUsage();
        await sleep(DISCOVERY_INTERVAL_MS);
      }
    } finally {
      await this.cleanup();
      logger.info("用量注入器已停止并完成清理");
    }
  }

  /**
   * 发现新增/关闭的页面目标，并为新增 Codex 页面安装组件。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  async refreshTargets() {
    let targets;
    try {
      targets = await listCdpTargets(this.port);
    } catch (error) {
      if (Date.now() - this.lastConnectionLogAt >= CONNECTION_LOG_INTERVAL_MS) {
        logger.warn("尚未连接到 Codex 调试端口", {
          port: this.port,
          error: error.message,
        });
        this.lastConnectionLogAt = Date.now();
      }
      return;
    }

    const activeIds = new Set(targets.map((target) => target.id));
    for (const [targetId, record] of this.sessions) {
      if (!activeIds.has(targetId) || record.session.closed) {
        record.session.close();
        this.sessions.delete(targetId);
        logger.info("Codex Renderer 已关闭，移除对应会话", { targetId });
      }
    }

    for (const target of targets) {
      if (this.sessions.has(target.id)) continue;
      try {
        const connection = await connectCodexTarget(target, this.port);
        if (!connection) continue;
        await this.installWidget(
          target.id,
          connection.session,
          connection.probe,
        );
      } catch (error) {
        logger.error("连接或注入 Codex Renderer 失败", {
          targetId: target.id,
          error: error.message,
        });
      }
    }
  }

  /**
   * 在当前文档安装组件，并注册页面重载前的 early script。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {string} targetId CDP 目标 id。
   * @param {import("./cdp-client.mjs").CdpSession} session CDP 页面会话。
   * @param {Record<string, unknown>} probe 结构探测结果。
   */
  async installWidget(targetId, session, probe) {
    const revisionJson = JSON.stringify(this.revision);
    const keyJson = JSON.stringify(ACTIVE_REVISION_KEY);
    await session.evaluate(`localStorage.setItem(${keyJson}, ${revisionJson})`);
    const registration = await session.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: this.widgetSource,
      },
    );
    const record = {
      session,
      earlyScriptId: registration.identifier ?? null,
    };
    session.on("Page.loadEventFired", () => {
      // early script 只负责恢复组件代码；最新用量仍由宿主在页面加载后重新推送，避免显示“用量…”直到下一轮轮询。
      setTimeout(() => {
        const reinstall = record.earlyScriptId
          ? Promise.resolve()
          : session.evaluate(this.widgetSource);
        void reinstall
          .then(() => this.pushSnapshotToSession(session))
          .catch((error) => {
            logger.error("页面重载后的组件恢复失败", {
              targetId,
              error: error.message,
            });
          });
      }, 0);
    });
    await session.evaluate(this.widgetSource);
    await this.pushSnapshotToSession(session);
    this.sessions.set(targetId, record);
    logger.info("已向 Codex Renderer 注入用量组件", {
      targetId,
      href: probe.href,
      earlyScript: Boolean(record.earlyScriptId),
    });
  }

  /**
   * 确保 app-server 连接存在，并监听稀疏更新通知以提前触发完整快照刷新。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @returns {Promise<CodexAppServerClient>} 可读取额度的连接。
   */
  async ensureAppServer() {
    if (this.appServer?.child) return this.appServer;
    const client = new CodexAppServerClient();
    try {
      await client.start();
    } catch (error) {
      client.close();
      throw error;
    }
    client.on("account/rateLimits/updated", () => {
      // 稀疏通知不能直接覆盖完整快照，因此只把下一次完整读取提前到当前循环。
      this.nextUsagePollAt = 0;
    });
    this.appServer = client;
    return client;
  }

  /**
   * 获取完整额度快照、标准化并推送到所有已连接页面。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  async pollUsage() {
    try {
      const client = await this.ensureAppServer();
      const response = await client.readRateLimits();
      this.latestSnapshot = normalizeUsageResponse(response);
      this.nextUsagePollAt = Date.now() + this.intervalMs;
      await this.pushSnapshotToAllSessions();
      logger.info("Codex 剩余用量刷新完成", {
        remainingPercent: this.latestSnapshot.remainingPercent,
        rendererCount: this.sessions.size,
      });
    } catch (error) {
      this.latestSnapshot = { status: "error" };
      this.nextUsagePollAt = Date.now() + USAGE_RETRY_INTERVAL_MS;
      await this.pushSnapshotToAllSessions();
      this.appServer?.close();
      this.appServer = null;
      logger.error("Codex 剩余用量刷新失败，将按重试周期重新连接", {
        error: error.message,
      });
    }
  }

  /**
   * 向全部存活 Renderer 推送最新的最小展示模型。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  async pushSnapshotToAllSessions() {
    for (const [targetId, record] of this.sessions) {
      try {
        await this.pushSnapshotToSession(record.session);
      } catch (error) {
        logger.error("向 Renderer 推送用量失败", {
          targetId,
          error: error.message,
        });
      }
    }
  }

  /**
   * 向一个 Renderer 推送最新用量，并返回组件挂载状态。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {import("./cdp-client.mjs").CdpSession} session CDP 页面会话。
   * @returns {Promise<unknown>} Renderer 组件状态。
   */
  async pushSnapshotToSession(session) {
    const stateKey = JSON.stringify(WIDGET_STATE_KEY);
    const snapshot = JSON.stringify(this.latestSnapshot);
    return session.evaluate(
      `window[${stateKey}]?.update?.(${snapshot}) ?? null`,
    );
  }

  /**
   * 读取当前 Renderer 正在展示的会话和最后一条助手回复锚点。
   *
   * Codex 当前页面会在助手消息容器上写入稳定的
   * data-response-annotation-conversation/data-response-annotation-target 属性；
   * 通过这两个属性关联会话日志，不依赖易变的 CSS module 类名。
   * 作者：liujl
   * 创建时间：2026-07-23 13:48:00
   *
   * @param {import("./cdp-client.mjs").CdpSession} session Renderer 会话。
   * @returns {Promise<{conversationId: string, messageTarget: string} | null>} 当前会话上下文。
   */
  async readRendererConversation(session) {
    return session.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll(
        '[data-response-annotation-conversation][data-response-annotation-target]'
      ));
      const visible = nodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      // 只有出现“复制”按钮的助手消息才视为已完成；流式输出阶段不提前把上一条回复误绑定到新 usage。
      const completed = visible.filter((node) =>
        node.querySelector('button[aria-label="复制"]'),
      );
      const current = completed.at(-1);
      if (!current) return null;
      const conversationId = current.getAttribute('data-response-annotation-conversation');
      const messageTarget = current.getAttribute('data-response-annotation-target');
      if (!conversationId || !messageTarget) return null;
      return { conversationId, messageTarget };
    })()`);
  }

  /**
   * 按会话标识定位 Codex 持久化日志路径；路径只缓存，不缓存日志内容，避免更新后读到旧快照。
   * 作者：liujl
   * 创建时间：2026-07-23 13:48:00
   *
   * @param {string} conversationId 会话标识。
   * @returns {Promise<string>} 会话 JSONL 日志绝对路径。
   */
  async resolveThreadLogPath(conversationId) {
    const cached = this.threadLogPaths.get(conversationId);
    if (cached) return cached;
    const client = await this.ensureAppServer();
    const response = await client.readThread(conversationId);
    const thread = response?.thread;
    if (!thread || typeof thread.path !== "string" || !thread.path)
      throw new Error(`会话 ${conversationId} 缺少可读取的日志路径`);
    this.threadLogPaths.set(conversationId, thread.path);
    return thread.path;
  }

  /**
   * 增量读取会话 JSONL 尾部，并提取最近一次 turn 的 Token 统计和模型。
   *
   * session 日志中的 token_count 是 Codex 当前 turn 的 usage 快照；按 task_started 的 turn_id
   * 聚合后，可将历史统计绑定到页面对应助手回复，避免把中间流式快照误当作多个回复。日志只在本机读取，
   * 不把 Cookie、Access Token 或完整对话内容传入 Renderer。
   * 作者：liujl
   * 创建时间：2026-07-23 13:48:00
   *
   * @param {string} logPath 会话 JSONL 日志路径。
   * @returns {Promise<Record<string, unknown> | null>} 按 turnId 聚合的 Token 统计，没有统计时返回 null。
   */
  async readTokenUsageFromLog(logPath) {
    let state = this.tokenLogStates.get(logPath);
    if (!state) {
      state = {
        offset: 0,
        remainder: "",
        latest: null,
        latestTurnId: null,
        currentTurnId: null,
        model: null,
        decoder: new StringDecoder("utf8"),
        skipOversizedLine: false,
        oversizedLineWarned: false,
      };
      this.tokenLogStates.set(logPath, state);
    }

    const fileInfo = await stat(logPath);
    if (fileInfo.size < state.offset) {
      // Codex 更新或会话归档可能替换日志文件；文件缩短时必须从头读取，不能沿用旧偏移量。
      state.offset = 0;
      state.remainder = "";
      state.latest = null;
      state.latestTurnId = null;
      state.currentTurnId = null;
      state.model = null;
      state.decoder = new StringDecoder("utf8");
      state.skipOversizedLine = false;
      state.oversizedLineWarned = false;
    }

    /**
     * 处理已经按换行切出的完整 JSONL 记录；不保存完整对话文本，只保留 Token 汇总状态。
     * 作者：liujl
     * 创建时间：2026-07-23 15:05:00
     *
     * @param {string[]} lines 完整行集合，不包含仍可能跨块的最后一行。
     */
    const consumeLines = (lines) => {
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          // 只跳过当前损坏行；下一轮仍从完整行边界继续，不伪造 Token 结果。
          continue;
        }
        const payload = record?.payload;
        if (record?.type !== "event_msg" || !payload) continue;
        if (payload.type === "task_started") {
          const turnId = payload.turn_id;
          state.currentTurnId =
            typeof turnId === "string" && turnId ? turnId : null;
          continue;
        }
        if (payload.type === "thread_settings_applied") {
          const model = payload.thread_settings?.model;
          if (typeof model === "string" && model) state.model = model;
          continue;
        }
        if (payload.type !== "token_count") continue;
        const usage = payload.info?.last_token_usage;
        if (!usage || typeof usage !== "object") continue;
        const fields = [
          "input_tokens",
          "output_tokens",
          "total_tokens",
          "cached_input_tokens",
          "reasoning_output_tokens",
        ];
        if (
          fields.some(
            (field) =>
              !Number.isInteger(usage[field]) || usage[field] < 0,
          )
        )
          continue;
        if (!state.currentTurnId) continue;
        const usageSnapshot = {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
          cachedInputTokens: usage.cached_input_tokens,
          reasoningOutputTokens: usage.reasoning_output_tokens,
          model: state.model,
          costLabel: "订阅额度",
          updatedAtMs:
            typeof record.timestamp === "string"
              ? Date.parse(record.timestamp)
              : Date.now(),
        };
        state.latestTurnId = state.currentTurnId;
        state.latest = usageSnapshot;
      }
    };

    /**
     * 消费一个 UTF-8 文本块，只把完整且长度可控的 JSONL 行交给解析器。
     * 超长行通常是正文或工具输出，不可能是需要展示的 Token 快照；丢弃到下一个换行符，
     * 可以避免在等待行结束时持续增长字符串，同时保留后续正常记录的读取能力。
     * 作者：liujl
     * 创建时间：2026-07-23 15:08:00
     *
     * @param {string} text 当前读取块解码后的文本。
     */
    const consumeText = (text) => {
      let start = 0;
      while (start < text.length) {
        const newlineIndex = text.indexOf("\n", start);
        if (state.skipOversizedLine) {
          if (newlineIndex < 0) return;
          state.skipOversizedLine = false;
          start = newlineIndex + 1;
          continue;
        }

        const lineEnd = newlineIndex < 0 ? text.length : newlineIndex;
        const line = `${state.remainder}${text.slice(start, lineEnd)}`;
        state.remainder = "";
        if (line.length > TOKEN_USAGE_LINE_BUFFER_LIMIT) {
          state.skipOversizedLine = newlineIndex < 0;
          if (!state.oversizedLineWarned) {
            state.oversizedLineWarned = true;
            logger.warn("会话日志存在超长正文记录，已跳过该行", {
              logPath,
              limitBytes: TOKEN_USAGE_LINE_BUFFER_LIMIT,
            });
          }
        } else if (newlineIndex < 0) {
          state.remainder = line;
        } else {
          consumeLines([line]);
        }
        if (newlineIndex < 0) return;
        start = newlineIndex + 1;
      }
    };

    if (fileInfo.size > state.offset) {
      const handle = await open(logPath, "r");
      const buffer = Buffer.allocUnsafe(TOKEN_USAGE_READ_CHUNK_BYTES);
      try {
        while (state.offset < fileInfo.size) {
          const length = Math.min(
            TOKEN_USAGE_READ_CHUNK_BYTES,
            fileInfo.size - state.offset,
          );
          const result = await handle.read(buffer, 0, length, state.offset);
          if (!result.bytesRead) break;
          state.offset += result.bytesRead;
          consumeText(
            state.decoder.write(buffer.subarray(0, result.bytesRead)),
          );
        }
      } finally {
        await handle.close();
      }
    }

    if (!state.latest) return null;
    return {
      latest: { ...state.latest, model: state.model ?? state.latest.model },
      latestTurnId: state.latestTurnId,
    };
  }

  /**
   * 把当前会话最近一次 Token 统计推送到对应助手回复底部；读取失败只影响 Token 展示，不覆盖额度徽标。
   * 作者：liujl
   * 创建时间：2026-07-23 13:48:00
   */
  async pollTokenUsage() {
    this.nextTokenUsagePollAt = Date.now() + TOKEN_USAGE_POLL_INTERVAL_MS;
    for (const [targetId, record] of this.sessions) {
      try {
        const context = await this.readRendererConversation(record.session);
        if (!context) continue;
        const logPath = await this.resolveThreadLogPath(context.conversationId);
        const usage = await this.readTokenUsageFromLog(logPath);
        if (!usage) continue;
        await record.session.evaluate(
          `window[${JSON.stringify(WIDGET_STATE_KEY)}]?.updateTokenUsage?.(${JSON.stringify({
            conversationId: context.conversationId,
            latest: usage.latest,
            latestTurnId: usage.latestTurnId,
          })}) ?? null`,
        );
      } catch (error) {
        logger.warn("读取当前对话 Token 用量失败", {
          targetId,
          error: error.message,
        });
      }
    }
  }

  /**
   * 注销 early script、移除当前 DOM 组件并关闭外部进程。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  async cleanup() {
    const stateKey = JSON.stringify(WIDGET_STATE_KEY);
    const revisionKey = JSON.stringify(ACTIVE_REVISION_KEY);
    for (const record of this.sessions.values()) {
      if (record.earlyScriptId && !record.session.closed) {
        await record.session
          .send("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: record.earlyScriptId,
          })
          .catch(() => {});
      }
      if (!record.session.closed) {
        await record.session
          .evaluate(
            `(() => {
          window[${stateKey}]?.remove?.();
          localStorage.removeItem(${revisionKey});
        })()`,
          )
          .catch(() => {});
      }
      record.session.close();
    }
    this.sessions.clear();
    this.threadLogPaths.clear();
    this.tokenLogStates.clear();
    this.appServer?.close();
    this.appServer = null;
  }
}

/**
 * 单次读取并标准化 Codex 用量，用于安装前自检。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @returns {Promise<Record<string, unknown>>} 标准化用量模型。
 */
export async function probeUsageOnce() {
  const client = new CodexAppServerClient();
  try {
    await client.start();
    return normalizeUsageResponse(await client.readRateLimits());
  } finally {
    client.close();
  }
}

/**
 * 读取所有当前 Codex 页面的组件状态，不改变 DOM。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {number} port 本机调试端口。
 * @returns {Promise<Array<Record<string, unknown>>>} 每个已验证页面的组件状态。
 */
export async function readWidgetStatuses(port) {
  const targets = await listCdpTargets(port);
  const statuses = [];
  for (const target of targets) {
    const connection = await connectCodexTarget(target, port);
    if (!connection) continue;
    try {
      const state = await connection.session.evaluate(
        `window[${JSON.stringify(WIDGET_STATE_KEY)}]?.status?.() ?? { active: false }`,
      );
      statuses.push({
        targetId: target.id,
        href: connection.probe.href,
        ...state,
      });
    } finally {
      connection.session.close();
    }
  }
  return statuses;
}

/**
 * 从当前 Codex 页面移除组件和有效版本标记；常驻进程必须先停止，否则它会按设计重新挂载。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {number} port 本机调试端口。
 * @returns {Promise<number>} 成功处理的 Codex 页面数量。
 */
export async function removeWidgets(port) {
  const targets = await listCdpTargets(port);
  let removedCount = 0;
  for (const target of targets) {
    const connection = await connectCodexTarget(target, port);
    if (!connection) continue;
    try {
      await connection.session.evaluate(`(() => {
        window[${JSON.stringify(WIDGET_STATE_KEY)}]?.remove?.();
        localStorage.removeItem(${JSON.stringify(ACTIVE_REVISION_KEY)});
        document.getElementById('codex-usage-badge')?.remove();
        document.getElementById('codex-usage-style')?.remove();
      })()`);
      removedCount += 1;
    } finally {
      connection.session.close();
    }
  }
  return removedCount;
}
