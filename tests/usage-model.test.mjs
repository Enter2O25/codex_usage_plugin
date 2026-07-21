import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsageResponse } from "../src/usage-model.mjs";

/**
 * 构造包含默认桶和专项模型桶的额度响应，覆盖真实协议的核心字段。
 * 作者：liujl
 * 创建时间：2026-07-21 13:47:34
 *
 * @returns {Record<string, unknown>} 测试额度响应。
 */
function createResponse() {
  const codex = {
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 73,
      resetsAt: 1_800_000_000,
      windowDurationMins: 10_080,
    },
    secondary: {
      usedPercent: 40,
      resetsAt: 1_799_000_000,
      windowDurationMins: 300,
    },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    planType: "pro",
  };
  return {
    rateLimits: codex,
    rateLimitsByLimitId: {
      codex,
      codex_fast: {
        limitId: "codex_fast",
        limitName: "Fast model",
        primary: {
          usedPercent: 10,
          resetsAt: 1_801_000_000,
          windowDurationMins: 10_080,
        },
        secondary: null,
        credits: null,
        planType: "pro",
      },
    },
    rateLimitResetCredits: { availableCount: 2, credits: [] },
  };
}

test("主标签使用主副窗口中更紧张的剩余比例", () => {
  const result = normalizeUsageResponse(createResponse(), 1234);
  assert.equal(result.remainingPercent, 27);
  assert.equal(result.resetsAt, 1_800_000_000);
  assert.equal(result.updatedAtMs, 1234);
  assert.equal(result.resetCreditsAvailable, 2);
});

test("保留专项模型桶供悬停提示展示", () => {
  const result = normalizeUsageResponse(createResponse(), 1234);
  assert.equal(result.buckets.length, 2);
  assert.equal(result.buckets[1].limitName, "Fast model");
  assert.equal(result.buckets[1].remainingPercent, 90);
});

test("拒绝越界的 usedPercent，避免展示虚假剩余量", () => {
  const response = createResponse();
  response.rateLimitsByLimitId.codex.primary.usedPercent = 101;
  assert.throws(() => normalizeUsageResponse(response), /usedPercent/);
});

test("缺少默认额度桶时显式失败", () => {
  assert.throws(
    () => normalizeUsageResponse({ rateLimits: null, rateLimitsByLimitId: {} }),
    /默认额度桶/,
  );
});
