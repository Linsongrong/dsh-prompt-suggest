# dsh-prompt-suggest

在 DSH 输入框内提供 Claude Code 风格的内联预测 + 历史召回：

- 一轮对话结束、输入框为空且空闲时，框内第一行以灰字预测你的下一句（不会自动发送）。
- Tab 接受成真实草稿；↑/↓ 召回本会话发过的 prompt，行为接近 shell history。
- 开始打字即消失；Esc 本轮隐藏。

## 交互

| 场景 | 行为 |
| --- | --- |
| 一轮完成、输入框空且空闲 | 输入框第一行出现一条灰色预测，右侧一个很淡的 Tab 键帽 |
| 按 Tab | 预测变成真实草稿，光标移到末尾，不自动发送 |
| 按 ↑（草稿为空） | 填入本会话上一条真实发送的 prompt；连按继续往前翻 |
| 按 ↓ | 往回走到更新的 prompt；翻到最新一条再 ↓ 清空草稿 |
| 开始打字 / 输入法组合中 | 预测立即消失，按键完全不拦截 |
| 按 Esc | 本轮不再显示，直到下一轮结束 |
| 发送消息后 6 秒 | 冷却期，避免宿主会话快照写入延迟导致旧预测闪回 |
| 设置 → 输入框内联预测 | 总开关。关闭后客户端完全不请求，模型零调用 |

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.mjs` | 宿主侧：读会话历史 → 调当前会话模型 → 生成单条预测 → 同源 JSON 接口（get / refresh / history / diag / probe） |
| `lib/client.cjs` | 客户端：`conversation.input.overlay` 插槽 + body 级 fixed ghost 浮层 + 键盘层 + 设置开关 |
| `cordis.patch.yml` | 挂进 profile 插件树的补丁 |
| `package.json` | 包清单，声明 bundle 补丁与客户端注入 |

宿主只用 `node:crypto`，客户端手写 CJS —— 没有构建步骤。改客户端需要页面重新加载（桌面端 Ctrl+R 未绑定，需彻底退出应用重开）；改宿主需要重启应用。

## 实现要点

- **拉取式生成**：客户端在「空闲 + 草稿为空 + 不在冷却期」时才请求；拿到结果后停止轮询；轮次进行中按 `TURN_IN_FLIGHT` 每 3 秒探一次，轮次一结束立刻补预测。
- **空闲门控**：宿主只认「最后一个事件是 `turn/end` 且其后没有新的 `user/message`」为真空闲。否则返回 `TURN_IN_FLIGHT`，避免把上一轮的预测在新轮次里返回。
- **按轮缓存**：缓存键是「会话 + 最后 turn/end 的 seq」，同一轮内重复请求不重复生成；失败结果缓存 45 秒避免空转。
- **历史过滤**：只保留 `source.kind === 'user'` 的真实输入；框架注入（runtime-context / time-context / skill-catalog / mnemon 快照 / agent-instructions）和插件委托（`[dsh-*:delegated]`）全部剔除，所以 ↑ 不会召回系统提示词。
- **ghost 渲染**：挂到 `document.body` 的 fixed 浮层（z-index 最高），覆盖编辑器第一行；字体/行高/padding 从编辑器 `computedStyle` 取样对齐，背景取 composer 卡片底色以遮住原生 placeholder。位置在挂载、resize、滚动时重测。
- **键盘层**：document capture 阶段监听 Tab / ↑ / ↓ / Esc，仅当「草稿为空且 ghost 可见」时 `preventDefault` + 接受；`isComposing` 期间不介入。
- **推理档位**：不同 provider 支持的取值不同（opencode-go 不接受 `off`），按 `none` → `minimal` → `low` → 默认 依次尝试，取第一个被接受的。

## 安装

### 从 GitHub 安装（源码）

```bash
git clone https://github.com/Linsongrong/dsh-prompt-suggest.git
```

桌面端 profile 由应用独占管理，命令行改不了，只能改清单后用 pnpm 装：

1. `~/.dsh/profiles/desktop/package.json`
   - `dependencies` 加 `"dsh-prompt-suggest": "link:<克隆目录的绝对路径>"`
   - `dsh.profile.bundles` 加 `"dsh-prompt-suggest"`
2. 在 profile 目录用应用自带的 pnpm 安装：

   ```
   cd ~/.dsh/profiles/desktop
   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness 安装目录>/DeepSeek Harness.exe" \
     "<安装目录>/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
   ```

3. 完全退出桌面端再打开。

发布到 npm 后可直接 `dsh plugin --profile desktop add -w dsh-prompt-suggest`。

### 本机开发

本仓库当前以 link 方式挂在桌面端 profile 上（见上方流程）。改客户端需完全退出应用重开——桌面端 Ctrl+R 未绑定，浏览器刷新快捷键无效；改宿主必须重启应用，因为宿主插件只在进程启动时装配。

## 卸载 / 回滚

从 `dependencies` 和 `dsh.profile.bundles` 删掉 `dsh-prompt-suggest`，再跑一次 pnpm install，重启应用。源码目录留着不影响运行。

本次重写前的原实现备份在 `lib/client.cjs.bak-20261112` 与 `lib/index.mjs.bak-20261112`，覆盖回去即可回滚。

## 诊断接口

```
POST http://127.0.0.1:<端口>/api/prompt-suggest
  {"method":"diag-get"}                                    # 客户端上报（ghost 位置/遮挡/文字）、错误、生成次数、idle 状态
  {"method":"get","sessionId":"<id>"}                      # 取当前预测
  {"method":"refresh","sessionId":"<id>","skip":[...]}     # 换一条
  {"method":"history","sessionId":"<id>"}                  # ↑ 召回用的真实 prompt 列表（新到旧）
  {"method":"probe","sessionId":"<id>"}                    # 会话结构、事件统计、模型路由
  {"method":"probe","sessionId":"<id>","run":true}         # 立刻跑一次生成并返回原始输出
```

端口在应用重启后会变，从进程参数或 `~/.dsh/web.log` 取当前值。

## 成本

每轮对话结束后一次辅助模型调用，输出一条短消息（约 30 到 60 token），按当前会话模型计费。「换一批」额外一次。关闭开关后为零。
