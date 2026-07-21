import test from "node:test";
import assert from "node:assert/strict";
import { validateDebuggerUrl } from "../src/cdp-client.mjs";

test("接受本机指定端口上的页面调试地址", () => {
  const target = {
    id: "ABC_123",
    webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/ABC_123",
  };
  assert.equal(validateDebuggerUrl(target, 9341), target.webSocketDebuggerUrl);
});

test("拒绝外部主机的调试地址", () => {
  const target = {
    id: "ABC_123",
    webSocketDebuggerUrl: "ws://example.com:9341/devtools/page/ABC_123",
  };
  assert.throws(() => validateDebuggerUrl(target, 9341), /拒绝连接/);
});

test("拒绝目标 id 与路径不一致的调试地址", () => {
  const target = {
    id: "ABC_123",
    webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/OTHER",
  };
  assert.throws(() => validateDebuggerUrl(target, 9341), /拒绝连接/);
});
