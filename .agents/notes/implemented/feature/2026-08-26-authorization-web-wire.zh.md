# Agent Note：授权上 Web 线路

Status: implemented

English | [中文](2026-08-26-authorization-web-wire.md)

## 问题

授权接缝（[dsh-authorization](../../../../packages/credentials/authorization/README.zh.md)）让每个插件都能获取只有人类本人才能提供的凭证——OAuth 授权、设备码、交互式密钥录入——多提供方适配器也为每个内置提供方注册了对应的流。但能驱动这些流的界面此前只有与宿主进程同侧的 CLI 提示或编辑器桥。浏览器会话作为产品的主界面，能列出提供方、能输入 API 密钥，却无法对任何需要"对话式"授权的提供方完成登录。接缝早已存在，只是它最大的消费方对 Web 不可达。

打通二者有一个结构性问题：`AuthorizationSession` 天生是对话式的——通知向外流出、问题等回答——而 Web 的 apiproxy 契约是 HTTP 上的 unary 请求/响应，流式通道保留给会话自有的帧。

## 决策

授权域以五个 unary 方法（`authorization.list/begin/cancel/status/answer`）加入 apiproxy：不新增 mux 帧，也不改动 `respond()` 的路由：

- `begin` 直到结算才返回，并采用"调用者节奏"的超时策略（同 `host.pickDirectory`）：没有 unary 截止时间，只受调用者/连接中止约束——OAuth 尝试在人于另一个标签页完成操作的几分钟里保持打开是正常的。
- 进度走轮询侧信道而非 mux 流：`status({key})` 返回该尝试已缓存的通知和至多一个待答问题，`answer({key, promptRpcId, value})` 以该 id 关联回答。模型页在登录对话框打开期间按有界节奏轮询。
- 撤销只有一个漏斗：settled 事件监听器会用 `AuthorizationDeclinedError` 拒绝该 key 下仍开放的问题，因此端点取消、调用者中止、服务销毁、流程自身失败都经同一路径收卷问题，接缝再把"拒绝"折算成 `cancelled` 结算而非失败。

客户端侧，模型页把每个提供方行与认领其记录地址（`<settingsNs>/<route>`，即 `recordKeyFor` 推导的同一个 key）的流做连接，只要连接到的流声明了交互式方法，就在 API 密钥字段旁渲染登录控件。凭证本身在两个方向都不经过这条线路：流程在宿主侧经 `ctx.credentials` 落盘，结算只触发页面重新拉取连接视图。

### 为什么轮询而非 mux 流

mux 是会话的流：客户端对象层只有唯一消费者。若把授权帧穿过那一层，等于让一个设置域控件耦合进会话传输机制，而这个对话框只在用户注视时存在。轮询使授权域保持纯 unary，除新域外不需要改 fixture 与运行时；轮询失败只会退化为"看不到进度"，绝不会变成一次损坏的尝试。代价是打开的对话框每个节奏至多一次往返，而模型页一次至多一个对话框，代价有界。

## 已考虑的替代

**经 `respond()` 的全双工**——待答问题注册表并入 approvals/questions 通道，问题作为可应答 mux 帧推送。v1 否决：它给 `respond()` 的 id 空间加第三个注册表、给 mux 重放基线加内容、还要动运行时对象层的帧分发，换来的即时性对一个轮询对话框并不必要。unary 形状不妨碍日后迁移；线类型刻意选成 `status` 里的问题投影可以原样变成帧载荷。

**在 harness 内逐家实现 OAuth**——绕开 pi-ai 为每家公司重写令牌交换。否决：这会复制提供方库已经持有的刷新、作用域与安全责任，违背凭证族文档确立的"存储而不拥有"立场。

## 后果

- 所有内置支持 OAuth 的提供方（`anthropic`、`github-copilot`、`kimi-coding`、`openai-codex`、`openrouter`、`radius`、`xai`）即刻可在网页端登录，零按提供方的代码；上游新增提供方自动出现。
- 尝试状态天然进程内：登录中途刷新页面会放弃浏览器侧（宿主尝试随载体信号断开而结算为 cancelled），这与接缝既有的非持久性一致，没有引入尚无人需要的持久尝试记录。
- 轮询侧信道是有意划下的范围边界。未来某个界面若确需推送（例如后台重授权），把 `authorization/*` 帧转发进 mux 即是记录在案的重新引入路径。

## 验证

- 宿主：`packages/host/apiproxy/tests/api-proxy-authorization.spec.ts` 用真实 `AuthorizationService` 驱动代理——列举、拒绝映射、通知/问题侧信道、回答关联、端点取消、调用者中止、迟到结算守卫，以及两条提交契约拒绝。
- 客户端：`packages/client/ui-settings-models/tests/signin.client.spec.tsx` 以脚本化 face 覆盖控件（文件 100% 覆盖）；`components.client.spec.tsx` 覆盖页级连接与完整的卡片 → begin → 结算 → describe 刷新回路；connection fixture 与 runtime fake 均补齐该域。
- 全部为无密钥通道：`pnpm run test --run packages/host/apiproxy/tests packages/client/connection/tests packages/credentials packages/client/ui-settings-models/tests`，以及 `pnpm run typecheck`。
