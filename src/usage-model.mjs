/**
 * 将 Codex app-server 的额度响应转换成只包含展示所需字段的稳定模型。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 */

/** 默认额度桶标识；Codex 当前用该键表示通用编码额度。 */
const DEFAULT_LIMIT_ID = "codex";

/**
 * 校验并转换单个滚动额度窗口。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {unknown} value app-server 返回的 primary 或 secondary 字段。
 * @param {string} fieldName 用于错误定位的字段名称。
 * @returns {{usedPercent: number, remainingPercent: number, resetsAt: number | null, windowDurationMins: number | null} | null}
 */
function normalizeWindow(value, fieldName) {
  if (value == null) return null;
  if (typeof value !== "object")
    throw new TypeError(`${fieldName} 必须是对象或 null`);

  const usedPercent = value.usedPercent;
  if (!Number.isInteger(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new RangeError(`${fieldName}.usedPercent 必须是 0 到 100 的整数`);
  }
  const resetsAt = value.resetsAt;
  if (resetsAt != null && (!Number.isInteger(resetsAt) || resetsAt <= 0)) {
    throw new RangeError(`${fieldName}.resetsAt 必须是正整数时间戳或 null`);
  }
  const windowDurationMins = value.windowDurationMins;
  if (
    windowDurationMins != null &&
    (!Number.isInteger(windowDurationMins) || windowDurationMins <= 0)
  ) {
    throw new RangeError(`${fieldName}.windowDurationMins 必须是正整数或 null`);
  }

  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: resetsAt ?? null,
    windowDurationMins: windowDurationMins ?? null,
  };
}

/**
 * 选择默认额度快照。优先使用明确的 codex 桶，其次使用协议提供的兼容视图；
 * 不随意挑选其他模型桶，避免把专项模型额度误报成通用剩余额度。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {Record<string, unknown>} response app-server 的 account/rateLimits/read 响应。
 * @returns {Record<string, unknown>} 默认额度快照。
 */
function selectDefaultSnapshot(response) {
  const buckets = response.rateLimitsByLimitId;
  if (buckets && typeof buckets === "object" && buckets[DEFAULT_LIMIT_ID]) {
    return buckets[DEFAULT_LIMIT_ID];
  }
  if (response.rateLimits && typeof response.rateLimits === "object")
    return response.rateLimits;
  throw new Error("额度响应中缺少 codex 默认额度桶");
}

/**
 * 转换一个额度桶，保留主副窗口及展示名称。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {Record<string, unknown>} snapshot 原始额度快照。
 * @param {string | null} fallbackLimitId 字典键提供的备用额度标识。
 * @returns {Record<string, unknown>} 经过校验的展示额度桶。
 */
function normalizeBucket(snapshot, fallbackLimitId) {
  const primary = normalizeWindow(snapshot.primary, "primary");
  const secondary = normalizeWindow(snapshot.secondary, "secondary");
  const windows = [primary, secondary].filter(Boolean);
  if (windows.length === 0)
    throw new Error("额度快照没有可展示的 primary 或 secondary 窗口");

  // 主标签必须反映最先会耗尽的窗口，不能只展示更宽松的那个窗口误导用户。
  const constrainedWindow = windows.reduce((current, next) =>
    next.remainingPercent < current.remainingPercent ? next : current,
  );

  return {
    limitId:
      typeof snapshot.limitId === "string" ? snapshot.limitId : fallbackLimitId,
    limitName:
      typeof snapshot.limitName === "string" ? snapshot.limitName : null,
    planType: typeof snapshot.planType === "string" ? snapshot.planType : null,
    remainingPercent: constrainedWindow.remainingPercent,
    resetsAt: constrainedWindow.resetsAt,
    primary,
    secondary,
  };
}

/**
 * 将完整额度响应转换为可安全传入 Renderer 的最小模型。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @param {unknown} rawResponse app-server 的 account/rateLimits/read 返回值。
 * @param {number} [updatedAtMs] 数据采集完成的毫秒时间戳，测试可传固定值。
 * @returns {Record<string, unknown>} Renderer 用量组件需要的展示模型。
 */
export function normalizeUsageResponse(rawResponse, updatedAtMs = Date.now()) {
  if (!rawResponse || typeof rawResponse !== "object")
    throw new TypeError("额度响应必须是对象");
  const defaultSnapshot = selectDefaultSnapshot(rawResponse);
  const current = normalizeBucket(defaultSnapshot, DEFAULT_LIMIT_ID);
  const sourceBuckets = rawResponse.rateLimitsByLimitId;
  const buckets = [];
  if (sourceBuckets && typeof sourceBuckets === "object") {
    for (const [limitId, snapshot] of Object.entries(sourceBuckets)) {
      if (!snapshot || typeof snapshot !== "object") continue;
      try {
        buckets.push(normalizeBucket(snapshot, limitId));
      } catch (error) {
        // 专项桶可能暂时没有窗口；跳过它不会改变已严格校验的默认 codex 主额度。
        if (limitId === DEFAULT_LIMIT_ID) throw error;
      }
    }
  }

  const credits = defaultSnapshot.credits;
  const resetCredits = rawResponse.rateLimitResetCredits;
  return {
    status: "ready",
    updatedAtMs,
    remainingPercent: current.remainingPercent,
    resetsAt: current.resetsAt,
    planType: current.planType,
    primary: current.primary,
    secondary: current.secondary,
    credits:
      credits && typeof credits === "object"
        ? {
            hasCredits: credits.hasCredits === true,
            unlimited: credits.unlimited === true,
            balance:
              typeof credits.balance === "string" ? credits.balance : null,
          }
        : null,
    resetCreditsAvailable: Number.isInteger(resetCredits?.availableCount)
      ? resetCredits.availableCount
      : 0,
    buckets,
  };
}
