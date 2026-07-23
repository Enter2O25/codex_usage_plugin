import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageInjector } from "../src/injector.mjs";
import { buildWidgetSource } from "../src/widget-runtime.mjs";
import { parseArgs } from "../src/cli.mjs";

test("Renderer 注入脚本可以独立编译并包含当前 revision", () => {
  const source = buildWidgetSource("test-revision");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /test-revision/);
});

test("Renderer 注入脚本接受新版 Codex 的 29px 账户行", () => {
  const source = buildWidgetSource("test-revision");

  // 修改人：liujl
  // 修改时间：2026-07-21 14:32:40
  // 修改说明：锁定已从真实 Renderer 读取到的 29px 行高边界，防止再次被旧的 32px 条件排除。
  assert.match(source, /MIN_ACCOUNT_ROW_HEIGHT_PX = 28/);
  assert.match(source, /rect\.height < MIN_ACCOUNT_ROW_HEIGHT_PX/);
});

test("Renderer 使用零延迟自绘 Tooltip 展示额度详情", () => {
  const source = buildWidgetSource("test-revision");

  // 修改人：liujl
  // 修改时间：2026-07-21 15:10:12
  // 修改说明：禁止回退到延迟不可控的原生 title，并锁定即时显示和减少动态效果规则。
  assert.match(source, /badge\.dataset\.tooltip/);
  assert.match(source, /transition-delay: 0s/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(source, /badge\.title\s*=/);
});

test("Renderer 在对应助手回复操作栏直接展示完整 Token 字段", () => {
  const source = buildWidgetSource("test-revision");

  // 修改人：liujl
  // 修改时间：2026-07-23 13:48:00
  // 修改说明：锁定最新回复的静态展示字段和 K/M 数量格式，避免后续改版退回历史批量挂载、悬停或隐藏单位。
  assert.match(source, /MESSAGE_USAGE_CLASS/);
  assert.match(source, /输入 \$\{formatTokenCount\(usage\.inputTokens\)\} tokens/);
  assert.match(source, /输出 \$\{formatTokenCount\(usage\.outputTokens\)\} tokens/);
  assert.match(source, /合计 \$\{formatTokenCount\(usage\.totalTokens\)\} tokens/);
  assert.match(source, /模型 \$\{model\}/);
  assert.match(source, /费用 \$\{cost\}/);
  assert.match(source, /updateTokenUsage\(snapshot\)/);
  assert.match(source, /getMessageTurnId/);
  assert.match(source, /latestTurnId/);
  assert.doesNotMatch(source, /byTurnId/);
  assert.match(source, /value >= 1_000_000/);
  assert.match(source, /const findMessageToolbar/);
  assert.match(source, /timeNode/);
  // 修改人：liujl
  // 修改时间：2026-07-23 14:12:00
  // 修改说明：确认 Token 注入不会接管 Codex 原生消息时间样式，时间显示仍由客户端自身 hover 规则决定。
  assert.doesNotMatch(source, /opacity: 1 !important/);
});

test("Token 日志按固定块读取且保留跨块统计结果", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-log-"));
  const logPath = join(directory, "session.jsonl");
  const filler = Array.from(
    { length: 2_000 },
    (_, index) =>
      JSON.stringify({
        type: "response_item",
        payload: { index, text: "填充日志".repeat(24) },
      }),
  );
  const records = [
    JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-large-log" },
    }),
    ...filler,
    JSON.stringify({
      type: "response_item",
      payload: { text: "超长正文".repeat(5_000) },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-luna" },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-23T07:05:00.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1234,
            output_tokens: 56,
            total_tokens: 1290,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      },
    }),
  ];
  await writeFile(logPath, `${records.join("\n")}\n`, "utf8");

  const injector = new UsageInjector({ port: 9341, intervalMs: 60_000 });
  try {
    const result = await injector.readTokenUsageFromLog(logPath);
    assert.equal(result?.latestTurnId, "turn-large-log");
    assert.equal(result?.latest?.totalTokens, 1290);
    assert.equal(injector.tokenLogStates.get(logPath)?.remainder, "");
  } finally {
    injector.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("停止注入器时立即关闭等待中的 app-server", () => {
  const injector = new UsageInjector({ port: 9341, intervalMs: 60_000 });
  let closed = false;
  injector.appServer = {
    close() {
      closed = true;
    },
  };

  // 修改人：liujl
  // 修改时间：2026-07-22 17:45:00
  // 修改说明：锁定更新恢复场景的快速停止行为，防止额度请求超时阻塞第二次启动。
  injector.stop();
  assert.equal(injector.stopping, true);
  assert.equal(closed, true);
  assert.equal(injector.appServer, null);
});

test("命令行默认使用 9341 和 60 秒刷新周期", () => {
  assert.deepEqual(parseArgs(["watch"]), {
    command: "watch",
    port: 9341,
    intervalMs: 60_000,
    json: false,
  });
});

test("拒绝过于频繁的用量刷新配置", () => {
  assert.throws(
    () => parseArgs(["watch", "--interval-ms", "1000"]),
    /刷新周期/,
  );
});
