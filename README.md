# Codex Usage Injector

在 Codex 桌面端侧栏底部的用户名后显示实时剩余用量，例如 `剩余 27%`。

这是独立的本地增强工具，不是官方 `.codex-plugin`。它复用 Codex Dream Skin 的安全注入思路：通过仅绑定 `127.0.0.1` 的 Chrome DevTools Protocol 向 Renderer 添加一个受控 DOM 节点，不修改 `app.asar`，也不改变应用代码签名。

## 工作方式

1. 后台 Node 进程启动 Codex 自带的 `codex app-server --stdio`。
2. 使用 `account/rateLimits/read` 读取主/副窗口、重置时间和模型额度桶。
3. 通过 CDP 向已验证包含 `aside.app-shell-left-panel` 的 Codex 页面注入徽标。
4. `MutationObserver` 在 React 重渲染或路由切换后重新确认挂载点。
5. 默认每 60 秒刷新用量；app-server 发出更新通知时会提前刷新。

注入节点属于 Codex Renderer，因此移动、缩放、最小化或关闭 Codex 窗口时会自然跟随，不需要额外计算屏幕坐标。

## 启动

双击：

- `Start Codex Usage.command`

如果 Codex Dream Skin 已经开放 9341 端口，启动器会直接复用，不重启 Codex。否则启动器会显示系统确认框，经确认后正常退出并重新启动 Codex；不会强制结束进程。

也可以从终端运行：

```bash
./scripts/start-macos.sh
```

启动成功后，后台状态保存在：

```text
~/.codex-usage-injector/
```

该目录只包含 PID 和运行日志，不保存 Cookie、Access Token 或完整账户响应。

## 查看状态与恢复

双击对应文件：

- `Check Codex Usage.command`
- `Restore Codex Usage.command`

恢复操作会先校验 PID 的完整命令行，再停止本项目后台进程，并删除以下自有节点：

- `#codex-usage-badge`
- `#codex-usage-style`
- `window.__CODEX_USAGE_WIDGET__`

它不会删除或暂停 Codex Dream Skin。

## 数据展示规则

- 主标签显示 `primary` 和 `secondary` 中剩余比例更低的窗口。
- 50% 及以上显示绿色，20%～49% 显示黄色，低于 20% 显示红色。
- 鼠标停留时显示重置时间、可用重置券和其他模型额度。
- 每条已完成的助手回复操作栏后直接显示 `输入`、`输出`、`合计`、`模型` 和 `费用`。
- Token 数量按 `tokens`、`K tokens`、`M tokens` 自动压缩；ChatGPT 订阅模式的费用显示为“订阅额度”，不伪造美元金额。
- Token 数据来自对应会话的本地 JSONL 日志，按 `turnId` 绑定到历史助手回复，不读取或注入完整对话内容。
- 找不到合格的侧栏账户按钮时不做错误挂载，状态命令会返回 `mounted: false`。

## 开发验证

```bash
npm test
npm run check
npm run probe
```

`npm run probe` 只验证 app-server 数据链路，不要求重启 Codex，也不会注入页面。

## 已知边界

- `codex app-server` 是开发/调试接口，客户端升级后协议可能变化。
- Codex 更新如果改变侧栏 DOM 结构，结构评分可能找不到锚点；这种情况会停止挂载而不是猜测其他按钮。
- Codex 更新如果改变回复操作栏的 `data-response-annotation-*` 属性或“复制”按钮标识，回复级 Token 统计会暂时停止挂载，但侧栏额度徽标仍可独立工作。
- 完全退出 Codex 后，如果后台注入器也被停止，下次启动需要再次运行启动命令。
- CDP 端口只能绑定 `127.0.0.1`，不要改成局域网地址。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始开发前请阅读 [贡献指南](CONTRIBUTING.md)；发现安全问题时请按照 [安全策略](SECURITY.md) 私密报告，不要在公开 Issue 中发布认证信息或可被直接利用的细节。

## 开源协议

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 liujl。
