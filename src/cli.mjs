#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { logger } from "./logger.mjs";
import {
  probeUsageOnce,
  readWidgetStatuses,
  removeWidgets,
  UsageInjector,
} from "./injector.mjs";

/** 默认使用换肤项目相同的本地调试端口，两个注入器可连接同一个 Renderer。 */
const DEFAULT_CDP_PORT = 9341;

/** 默认每 60 秒读取一次百分比；倒计时在 Renderer 本地计算，无需高频访问后台。 */
const DEFAULT_USAGE_INTERVAL_MS = 60_000;

/** 正常刷新允许的最小周期，防止误配置成毫秒级请求。 */
const MIN_USAGE_INTERVAL_MS = 15_000;

/**
 * 解析并严格校验命令行参数。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {string[]} argv process.argv 中的用户参数。
 * @returns {{command: string, port: number, intervalMs: number, json: boolean}} 运行配置。
 */
export function parseArgs(argv) {
  const options = {
    command: argv[0] ?? "watch",
    port: DEFAULT_CDP_PORT,
    intervalMs: DEFAULT_USAGE_INTERVAL_MS,
    json: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--interval-ms")
      options.intervalMs = Number(argv[++index]);
    else if (argument === "--json") options.json = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (!new Set(["watch", "probe", "status", "remove"]).has(options.command)) {
    throw new Error(`未知命令：${options.command}`);
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1024 ||
    options.port > 65_535
  ) {
    throw new RangeError(
      `CDP 端口必须是 1024 到 65535 的整数：${options.port}`,
    );
  }
  if (
    !Number.isInteger(options.intervalMs) ||
    options.intervalMs < MIN_USAGE_INTERVAL_MS ||
    options.intervalMs > 900_000
  ) {
    throw new RangeError(
      `刷新周期必须是 ${MIN_USAGE_INTERVAL_MS} 到 900000 毫秒的整数`,
    );
  }
  return options;
}

/**
 * 输出命令结果。JSON 模式保持单文档 stdout，普通模式仍用 JSON 便于用户复制诊断。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {unknown} value 要输出的结果。
 */
function printResult(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 执行 CLI 命令并管理常驻进程信号。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {string[]} argv 用户参数。
 */
export async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "probe") {
    printResult(await probeUsageOnce());
    return;
  }
  if (options.command === "status") {
    try {
      const pages = await readWidgetStatuses(options.port);
      printResult({ active: pages.some((page) => page.active), pages });
    } catch (error) {
      printResult({ active: false, pages: [], reason: error.message });
    }
    return;
  }
  if (options.command === "remove") {
    try {
      const removedCount = await removeWidgets(options.port);
      printResult({ removed: true, removedCount });
    } catch (error) {
      // CDP 未开启表示当前进程没有可保留的注入 DOM，恢复命令仍可安全视为完成并报告原因。
      printResult({ removed: true, removedCount: 0, reason: error.message });
    }
    return;
  }

  const injector = new UsageInjector(options);
  const stop = () => injector.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await injector.run();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    logger.error("命令执行失败", { error: error.message });
    process.exitCode = 1;
  });
}
