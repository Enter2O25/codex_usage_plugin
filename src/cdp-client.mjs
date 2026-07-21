import { logger } from "./logger.mjs";

/** 只允许连接本机回环地址，防止调试协议被重定向到外部主机。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** CDP 页面 id 的允许字符和长度边界，用于阻断伪造的调试目标路径。 */
const CDP_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** 拉取调试目标列表的超时时间；端口未开启时应快速返回给重试循环。 */
const TARGET_LIST_TIMEOUT_MS = 2_000;

/** 单条 CDP 命令的最大等待时间，避免断开的 Renderer 让后台循环永久挂起。 */
const CDP_COMMAND_TIMEOUT_MS = 10_000;

/**
 * 校验调试目标提供的 WebSocket 地址，只接受指定端口上的本机 page endpoint。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {Record<string, unknown>} target /json/list 返回的目标对象。
 * @param {number} port 当前注入器使用的本地调试端口。
 * @returns {string} 校验通过的 WebSocket 地址。
 */
export function validateDebuggerUrl(target, port) {
  const url = new URL(String(target.webSocketDebuggerUrl ?? ""));
  const expectedPath =
    typeof target.id === "string" ? `/devtools/page/${target.id}` : "";
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    Number(url.port) !== port ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("拒绝连接非本机或路径不匹配的 CDP WebSocket 地址");
  }
  return url.href;
}

/**
 * 判断 /json/list 条目是否是可进一步探测的 Codex 页面候选。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {unknown} target 未校验的调试目标。
 * @param {number} port 当前调试端口。
 * @returns {boolean} 目标结构和地址均符合要求时返回 true。
 */
function isCandidateTarget(target, port) {
  if (
    !target ||
    typeof target !== "object" ||
    target.type !== "page" ||
    typeof target.url !== "string" ||
    !target.url.startsWith("app://") ||
    typeof target.id !== "string" ||
    !CDP_ID_PATTERN.test(target.id)
  )
    return false;
  try {
    validateDebuggerUrl(target, port);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从本机 CDP HTTP 端点读取页面目标列表。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {number} port 本机调试端口。
 * @returns {Promise<Array<Record<string, unknown>>>} 经过地址和类型预校验的页面目标。
 */
export async function listCdpTargets(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TARGET_LIST_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`无法访问本机 CDP 端口 ${port}：${error.message}`);
    }
    if (!response.ok)
      throw new Error(`CDP 目标列表返回 HTTP ${response.status}`);
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error("CDP 目标列表不是数组");
    return targets.filter((target) => isCandidateTarget(target, port));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 管理单个 Renderer 的 CDP WebSocket 会话。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 */
export class CdpSession {
  /**
   * 创建指向单个已校验页面目标的会话。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {Record<string, unknown>} target 已预校验的 CDP 页面目标。
   * @param {number} port 本机调试端口。
   */
  constructor(target, port) {
    if (typeof WebSocket !== "function")
      throw new Error(
        "当前 Node.js 不支持 WebSocket，请使用 Node.js 22 或更高版本",
      );
    this.target = target;
    this.socket = new WebSocket(validateDebuggerUrl(target, port));
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  /**
   * 等待连接成功并启用 Runtime、Page 域。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @returns {Promise<CdpSession>} 已准备好发送命令的当前会话。
   */
  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.close();
        reject(new Error("CDP WebSocket 连接超时"));
      }, 5_000);
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("CDP WebSocket 连接失败"));
        },
        { once: true },
      );
    });
    this.socket.addEventListener("message", (event) =>
      this.handleMessage(event),
    );
    this.socket.addEventListener("error", () => this.close());
    this.socket.addEventListener("close", () => this.close());
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  /**
   * 解析 CDP 消息并按请求 id 或事件方法名分发。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {MessageEvent} event WebSocket 消息事件。
   */
  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      logger.warn("收到无法解析的 CDP 消息，关闭当前会话", {
        targetId: this.target.id,
      });
      this.close();
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(`${message.error.message} (${message.error.code})`),
        );
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try {
        listener(message.params ?? {});
      } catch (error) {
        logger.error("CDP 事件监听器执行失败", {
          method: message.method,
          error: error.message,
        });
      }
    }
  }

  /**
   * 注册 CDP 事件监听器。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {string} method CDP 事件方法名。
   * @param {(params: unknown) => void} listener 事件回调。
   */
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  /**
   * 发送 CDP 命令并等待响应。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {string} method CDP 命令名。
   * @param {Record<string, unknown>} [params] 命令参数。
   * @returns {Promise<Record<string, unknown>>} CDP 命令结果。
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP 会话已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * 在 Renderer 主世界执行表达式并取回可序列化结果。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {string} expression JavaScript 表达式。
   * @returns {Promise<unknown>} Renderer 返回的值。
   */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(`Renderer 注入执行失败：${detail}`);
    }
    return result.result?.value;
  }

  /**
   * 关闭会话并拒绝全部未完成命令。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("CDP 会话已关闭"));
    }
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      // close 本身是幂等清理，底层已关闭时无需用另一个异常掩盖原始连接状态。
    }
  }
}

/**
 * 验证目标是否包含 Codex 主侧栏，避免向其他 app:// 页面注入组件。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {CdpSession} session 已连接的页面会话。
 * @returns {Promise<Record<string, unknown>>} 页面地址和结构探测结果。
 */
export async function probeCodexPage(session) {
  return session.evaluate(`(() => {
    const sidebar = document.querySelector('aside.app-shell-left-panel');
    return {
      href: location.href,
      title: document.title,
      isCodex: Boolean(sidebar),
      hasMain: Boolean(document.querySelector('[role="main"], main.main-surface')),
    };
  })()`);
}

/**
 * 连接并验证一个 CDP 页面目标。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {Record<string, unknown>} target CDP 页面目标。
 * @param {number} port 本机调试端口。
 * @returns {Promise<{session: CdpSession, probe: Record<string, unknown>} | null>} Codex 页面连接；非 Codex 页面返回 null。
 */
export async function connectCodexTarget(target, port) {
  const session = await new CdpSession(target, port).open();
  try {
    const probe = await probeCodexPage(session);
    if (!probe?.isCodex) {
      session.close();
      return null;
    }
    return { session, probe };
  } catch (error) {
    session.close();
    throw error;
  }
}
