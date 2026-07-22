import { createHash } from "node:crypto";
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
