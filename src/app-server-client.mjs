import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { logger } from "./logger.mjs";

/** app-server 单次 JSON-RPC 请求的最大等待时间，防止后台进程无响应后永久挂起。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 初始化客户端名称，只用于 app-server 的 user-agent 和诊断信息。 */
const CLIENT_NAME = "codex-usage-injector";

/** 当前客户端协议版本，和项目版本保持一致便于排查兼容问题。 */
const CLIENT_VERSION = "0.1.0";

/**
 * 判断文件是否可执行。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {string} candidate 候选可执行文件绝对路径。
 * @returns {Promise<boolean>} 文件存在并可执行时返回 true。
 */
async function isExecutable(candidate) {
  try {
    await access(candidate, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * 定位与当前桌面客户端配套的 codex 可执行文件。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @returns {Promise<string>} 可用于启动 app-server 的绝对路径。
 */
export async function resolveCodexBinary() {
  const explicit = process.env.CODEX_USAGE_CODEX_BIN;
  if (explicit) {
    if (await isExecutable(explicit)) return explicit;
    throw new Error(`CODEX_USAGE_CODEX_BIN 指向的文件不可执行：${explicit}`);
  }

  const home = process.env.HOME;
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    home
      ? path.join(home, "Applications/ChatGPT.app/Contents/Resources/codex")
      : null,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "codex")),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error("未找到可执行的 codex，无法启动 app-server");
}

/**
 * 管理一条 JSONL-over-stdio app-server 连接，并将请求响应和通知分流。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 */
export class CodexAppServerClient extends EventEmitter {
  /**
   * 创建尚未启动的客户端；start 成功前不会访问账户或网络。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  constructor() {
    super();
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = "";
  }

  /**
   * 启动 app-server 并完成 initialize/initialized 握手。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @returns {Promise<void>} 握手成功后完成。
   */
  async start() {
    if (this.child) throw new Error("app-server 已启动，禁止重复创建连接");
    const codexBinary = await resolveCodexBinary();
    this.child = spawn(codexBinary, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      // app-server 会在 stderr 输出自身告警；只保留尾部，在连接失败时再记录，避免常驻日志刷屏。
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8_000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.child)
        this.failAll(
          new Error(`app-server 已退出，code=${code}, signal=${signal}`),
        );
    });

    await this.request("initialize", {
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", null);
    logger.info("app-server 初始化完成", { codexBinary });
  }

  /**
   * 请求当前账户额度快照。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @returns {Promise<Record<string, unknown>>} account/rateLimits/read 的原始结果。
   */
  async readRateLimits() {
    return this.request("account/rateLimits/read", null);
  }

  /**
   * 读取指定会话的持久化信息，用于定位 Codex 会话日志并关联 Renderer 中的当前回复。
   *
   * 作者：liujl
   * 创建时间：2026-07-23 13:48:00
   *
   * @param {string} threadId Codex 会话标识。
   * @returns {Promise<Record<string, unknown>>} thread/read 返回的会话信息。
   * @throws {Error} 会话不存在或 app-server 返回协议错误时抛出异常。
   */
  async readThread(threadId) {
    if (typeof threadId !== "string" || !threadId.trim())
      throw new TypeError("threadId 必须是非空字符串");
    return this.request("thread/read", { threadId, includeTurns: false });
  }

  /**
   * 发送 JSON-RPC 请求并等待相同 id 的响应。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {string} method app-server 方法名。
   * @param {unknown} params 请求参数。
   * @returns {Promise<unknown>} 协议响应结果。
   */
  request(method, params) {
    if (!this.child?.stdin.writable)
      return Promise.reject(new Error("app-server stdin 不可写"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server 请求超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /**
   * 发送无需响应的 JSON-RPC 通知。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {string} method 通知方法名。
   * @param {unknown} params 通知参数。
   */
  notify(method, params) {
    if (!this.child?.stdin.writable) throw new Error("app-server stdin 不可写");
    const payload = params == null ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * 按行解析 app-server 标准输出，处理半包和多包情况。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {Buffer | string} chunk 子进程输出片段。
   */
  handleStdout(chunk) {
    this.buffer += String(chunk);
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        logger.warn("忽略无法解析的 app-server 输出", {
          preview: line.slice(0, 160),
        });
        continue;
      }
      this.handleMessage(message);
    }
  }

  /**
   * 将协议消息分发给等待中的请求或通知监听器。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {Record<string, unknown>} message 已解析的 JSON-RPC 消息。
   */
  handleMessage(message) {
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(
            `app-server ${pending.method} 返回错误：${JSON.stringify(message.error)}`,
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string")
      this.emit(message.method, message.params);
  }

  /**
   * 连接异常时拒绝全部未完成请求，并保留真实错误供上层决定是否重连。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   *
   * @param {Error} error 导致连接失效的错误。
   */
  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    logger.error("app-server 连接已失效", {
      error: error.message,
      stderrTail: this.stderrTail.slice(-500),
    });
  }

  /**
   * 关闭 app-server 子进程并清理等待请求。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  close() {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("app-server 客户端已关闭"));
    }
    this.pending.clear();
  }
}
