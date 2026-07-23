import test from "node:test";
import assert from "node:assert/strict";
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
  // 修改说明：锁定回复级别的静态展示字段和 K/M 数量格式，避免后续改版退回悬停或隐藏单位。
  assert.match(source, /MESSAGE_USAGE_CLASS/);
  assert.match(source, /输入 \$\{formatTokenCount\(usage\.inputTokens\)\} tokens/);
  assert.match(source, /输出 \$\{formatTokenCount\(usage\.outputTokens\)\} tokens/);
  assert.match(source, /合计 \$\{formatTokenCount\(usage\.totalTokens\)\} tokens/);
  assert.match(source, /模型 \$\{model\}/);
  assert.match(source, /费用 \$\{cost\}/);
  assert.match(source, /updateTokenUsage\(snapshot\)/);
  assert.match(source, /getMessageTurnId/);
  assert.match(source, /byTurnId/);
  assert.match(source, /value >= 1_000_000/);
  // 修改人：liujl
  // 修改时间：2026-07-23 14:12:00
  // 修改说明：确认 Token 注入不会接管 Codex 原生消息时间样式，时间显示仍由客户端自身 hover 规则决定。
  assert.doesNotMatch(source, /text-token-text-tertiary/);
  assert.doesNotMatch(source, /opacity: 1 !important/);
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
