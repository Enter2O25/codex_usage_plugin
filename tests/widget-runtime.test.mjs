import test from "node:test";
import assert from "node:assert/strict";
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
