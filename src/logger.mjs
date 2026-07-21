/**
 * 为注入器提供统一中文日志，避免后台运行时混入难以检索的零散输出。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 */

/** 日志前缀用于从 Codex、自身和 app-server 的混合日志中快速筛选本项目输出。 */
const LOG_PREFIX = "codex-usage";

/**
 * 序列化非敏感诊断字段；调用方不得传入令牌、Cookie 或完整账户响应。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {Record<string, unknown> | undefined} fields 允许记录的结构化诊断字段。
 * @returns {string} 可直接追加到日志行的 JSON 文本。
 */
function serializeFields(fields) {
  return fields && Object.keys(fields).length > 0
    ? ` ${JSON.stringify(fields)}`
    : "";
}

/**
 * 输出统一格式的中文日志。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {"INFO" | "WARN" | "ERROR"} level 日志等级。
 * @param {string} message 中文日志正文。
 * @param {Record<string, unknown>} [fields] 不包含敏感信息的诊断字段。
 */
function write(level, message, fields) {
  const line = `[${new Date().toISOString()}][${LOG_PREFIX}][${level}] ======>>>>>>【${message}】<<<<<<======${serializeFields(fields)}`;
  // 诊断日志统一写入 stderr，确保 --json 等命令的 stdout 始终是可直接解析的单个 JSON 文档。
  console.error(line);
}

export const logger = {
  /**
   * 记录正常状态流转。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  info(message, fields) {
    write("INFO", message, fields);
  },
  /**
   * 记录可自动恢复但需要关注的异常状态。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  warn(message, fields) {
    write("WARN", message, fields);
  },
  /**
   * 记录当前操作失败或连接中断。
   * 作者：liujl
   * 创建时间：2026-07-21 13:47:34
   */
  error(message, fields) {
    write("ERROR", message, fields);
  },
};
