# 配置指南

本指南涵盖 Spec Workflow MCP 的所有配置选项。

## 命令行选项

### 基本用法

```bash
npx -y @pimzino/spec-workflow-mcp@latest [project-path] [options]
```

### 可用选项

| 选项 | 描述 | 示例 |
|--------|-------------|---------|
| `--help` | 显示详细使用信息 | `npx -y @pimzino/spec-workflow-mcp@latest --help` |
| `--dashboard` | 运行纯仪表板模式（默认端口：5000） | `npx -y @pimzino/spec-workflow-mcp@latest --dashboard` |
| `--port <number>` | 指定自定义仪表板端口（1024-65535） | `npx -y @pimzino/spec-workflow-mcp@latest --dashboard --port 8080` |

### 重要说明

- **单一仪表板实例**：同时只运行一个仪表板。所有 MCP 服务器连接到同一个仪表板。
- **默认端口**：仪表板默认使用端口 5000。仅在 5000 不可用时使用 `--port`。
- **独立仪表板**：始终将仪表板与 MCP 服务器分开运行。

## 使用示例

### 典型工作流程

1. **启动仪表板**（首先执行此操作，仅一次）：
```bash
# 使用默认端口 5000
npx -y @pimzino/spec-workflow-mcp@latest --dashboard
```

2. **启动 MCP 服务器**（每个项目一个，在单独的终端中）：
```bash
# 项目 1
npx -y @pimzino/spec-workflow-mcp@latest ~/projects/app1

# 项目 2
npx -y @pimzino/spec-workflow-mcp@latest ~/projects/app2

# 项目 3
npx -y @pimzino/spec-workflow-mcp@latest ~/projects/app3
```

所有项目将出现在 http://localhost:5000 的仪表板中

### 使用自定义端口的仪表板

仅在端口 5000 不可用时使用自定义端口：

```bash
# 在端口 8080 上启动仪表板
npx -y @pimzino/spec-workflow-mcp@latest --dashboard --port 8080
```

## 环境变量

### SPEC_WORKFLOW_HOME

覆盖默认的全局状态目录（`~/.spec-workflow-mcp`）。这对于 `$HOME` 为只读的沙盒环境很有用。

| 变量 | 默认值 | 描述 |
|----------|---------|-------------|
| `SPEC_WORKFLOW_HOME` | `~/.spec-workflow-mcp` | 全局状态文件的目录 |

**存储在此目录中的文件：**
- `activeProjects.json` - 项目注册表
- `activeSession.json` - 仪表板会话信息
- `settings.json` - 全局设置
- `job-execution-history.json` - 作业执行历史
- `migration.log` - 实现日志迁移跟踪

**使用示例：**

```bash
# 绝对路径
SPEC_WORKFLOW_HOME=/workspace/.spec-workflow-mcp npx -y @pimzino/spec-workflow-mcp@latest /workspace

# 相对路径（相对于当前工作目录解析）
SPEC_WORKFLOW_HOME=./.spec-workflow-mcp npx -y @pimzino/spec-workflow-mcp@latest .

# 对于仪表板模式
SPEC_WORKFLOW_HOME=/workspace/.spec-workflow-mcp npx -y @pimzino/spec-workflow-mcp@latest --dashboard
```

**沙盒环境（例如，Codex CLI）：**

在使用 `sandbox_mode=workspace-write` 的 Codex CLI 等沙盒环境中运行时，将 `SPEC_WORKFLOW_HOME` 设置为工作区内的可写位置：

```bash
SPEC_WORKFLOW_HOME=/workspace/.spec-workflow-mcp npx -y @pimzino/spec-workflow-mcp@latest /workspace
```

## 仪表板会话管理

仪表板将其会话信息存储在 `~/.spec-workflow-mcp/activeSession.json`（如果设置了 `$SPEC_WORKFLOW_HOME`，则为 `$SPEC_WORKFLOW_HOME/activeSession.json`）中。此文件：
- 强制实施单一仪表板实例
- 允许 MCP 服务器发现正在运行的仪表板
- 在仪表板停止时自动清理

### 单一实例强制

同时只能运行一个仪表板。如果尝试启动第二个仪表板：

```
Dashboard is already running at: http://localhost:5000

You can:
  1. Use the existing dashboard at: http://localhost:5000
  2. Stop it first (Ctrl+C or kill PID), then start a new one

Note: Only one dashboard instance is needed for all your projects.
```

## 端口管理

**默认端口**：5000
**自定义端口**：仅在端口 5000 不可用时使用 `--port <number>`

### 端口冲突

如果端口 5000 已被其他服务使用：

```bash
Failed to start dashboard: Port 5000 is already in use.

This might be another service using port 5000.
To use a different port:
  spec-workflow-mcp --dashboard --port 8080
```

## 引擎配置文件（config.toml）

本 fork 驱动一个代码生成引擎以及一个可选的自动循环。两者均通过写入
`<project-dir>/.spec-workflow/config.toml` 的 TOML 文件进行配置。

### 默认位置

服务器在以下位置查找配置：`<project-dir>/.spec-workflow/config.toml`

该文件由 `bash init.sh <project-dir>` 为你生成。通常你应就地编辑它，而非从头编写。

### 文件格式

配置使用 TOML 格式。以下是本 fork 使用的完整结构：

```toml
[engine]
default = "codex"        # codex | claude
maxFixAttempts = 5       # red→fix 闭环上限，超过则任务标 blocked

[engine.codex]
sandbox = "workspace-write"   # read-only | workspace-write | danger-full-access
approvalPolicy = "never"      # untrusted | on-failure | on-request | never
# model = "..."              # 可选 — 建议保持注释，让 Codex 用最新默认模型

[loop]
autoLoop = false         # true = Stop hook 驱动 Phase 4 自动跑到完成（opt-in）
maxIterations = 50       # 自动循环硬上限（主安全阀）
noProgressStop = 3       # 连续 N 轮 tasks.md / verify-results 无变化则停
```

### 配置选项

#### `[engine]` — 引擎选择

| 选项 | 类型 | 取值域 | 默认值 | 描述 |
|--------|------|--------|---------|-------------|
| `default` | string | `codex`、`claude` | `codex` | 执行编码任务的引擎。`codex` 将任务派发给 Codex MCP 服务器；`claude` 则在宿主 Claude 会话中执行。 |
| `maxFixAttempts` | number | ≥ 1 | `5` | 单个任务 red→fix 闭环的最大迭代次数。当某任务持续未通过验证并超过此上限时，会被标记为 `blocked`，而非无限循环。 |

#### `[engine.codex]` — Codex 引擎设置

这些字段仅在当前引擎为 `codex` 时生效。在派发任务时，它们会被映射到 Codex MCP 工具调用的参数上。

| 选项 | 类型 | 取值域 | 默认值 | 描述 |
|--------|------|--------|---------|-------------|
| `sandbox` | string | `read-only`、`workspace-write`、`danger-full-access` | `workspace-write` | 授予 Codex 的文件系统访问级别。`read-only` 禁止写入；`workspace-write` 允许在工作区内编辑；`danger-full-access` 完全移除沙箱。 |
| `approvalPolicy` | string | `untrusted`、`on-failure`、`on-request`、`never` | `never` | Codex 何时暂停以请求审批。映射为 Codex MCP 工具入参 `approval-policy`。`never` 表示全程无人值守；其余取值会在对应条件下拦截执行。 |
| `model` | string | 任意 Codex 模型 id | _（省略）_ | 可选。覆盖 Codex 模型。省略时使用 Codex 默认模型。 |

`sandbox`、`approvalPolicy` 和 `model` 的取值会在派发时被翻译为 Codex MCP 工具调用参数
（其中 `approvalPolicy` 对应工具入参 `approval-policy`）。

#### `[loop]` — Phase 4 自动循环

控制可选的自动循环，它会反复运行 Phase 4 直至 spec 完成。

| 选项 | 类型 | 取值域 | 默认值 | 描述 |
|--------|------|--------|---------|-------------|
| `autoLoop` | boolean | `true`、`false` | `false` | 主开关。为 `true` 时，已注册的 Stop hook 会自动重新触发 Phase 4 直至完成。opt-in。 |
| `maxIterations` | number | ≥ 1 | `50` | 自动循环迭代次数的硬上限；保证循环终止的主安全阀。 |
| `noProgressStop` | number | ≥ 1 | `3` | 连续该轮数内 `tasks.md` 或 verify-results 无变化时停止循环，以避免在卡住的任务上空转。 |

#### 如何生成与切换

- **生成**：`bash init.sh <project-dir>` 会将上述 `config.toml` 写入
  `<project-dir>/.spec-workflow/`。
- **启用自动循环**：向 `init.sh` 传入 `--auto-loop` 会把 `[loop].autoLoop` 置为 `true`，
  并在项目的 `.claude/settings.json` 中注册 Phase 4 Stop hook。
- **`autoLoop` 只有在 Stop hook 已注册后才生效** —— 即你至少跑过一次
  `init.sh ... --auto-loop`。在该 hook 存在之前，手动编辑 `[loop].autoLoop` 不会有任何效果。
- **暂停自动循环**：将 `autoLoop = false`。无需移除 hook，仅翻转该标志即可停止自动循环。

#### 语言选项

- `en` - English（英语）
- `ja` - Japanese（日本語）
- `zh` - Chinese（中文）
- `es` - Spanish（Español）
- `pt` - Portuguese（Português）
- `de` - German（Deutsch）
- `fr` - French（Français）
- `ru` - Russian（Русский）
- `it` - Italian（Italiano）
- `ko` - Korean（한국어）
- `ar` - Arabic（العربية）

### 创建自定义配置

1. 复制示例配置：
```bash
cp .spec-workflow/config.example.toml .spec-workflow/config.toml
```

2. 编辑配置：
```toml
# 我的项目配置
projectDir = "/Users/myname/projects/myapp"
port = 3000
lang = "en"
```

3. 使用配置：
```bash
# 自动使用 .spec-workflow/config.toml
npx -y @pimzino/spec-workflow-mcp@latest

# 或明确指定
npx -y @pimzino/spec-workflow-mcp@latest --config .spec-workflow/config.toml
```

## 配置优先级

配置值按以下顺序应用（从高到低优先级）：

1. **命令行参数** - 始终优先
2. **自定义配置文件** - 使用 `--config` 指定
3. **默认配置文件** - `.spec-workflow/config.toml`
4. **内置默认值** - 后备值

### 优先级示例

```toml
# config.toml
port = 3000
```

```bash
# 命令行参数覆盖配置文件
npx -y @pimzino/spec-workflow-mcp@latest --config config.toml --port 4000
# 结果：port = 4000（CLI 优先）
```

## 特定环境配置

### 开发配置

```toml
# dev-config.toml
projectDir = "./src"
port = 3000
lang = "en"

[advanced]
debugMode = true
verboseLogging = true
```

用法：
```bash
npx -y @pimzino/spec-workflow-mcp@latest --config dev-config.toml
```

### 生产配置

```toml
# prod-config.toml
projectDir = "/var/app"
port = 8080
lang = "en"

[advanced]
debugMode = false
verboseLogging = false
```

用法：
```bash
npx -y @pimzino/spec-workflow-mcp@latest --config prod-config.toml
```

## 端口配置

### 有效端口范围

端口必须在 1024 到 65535 之间。

### 临时端口

当未指定端口时，系统会自动选择可用的临时端口。建议用于：
- 开发环境
- 多个同时项目
- 避免端口冲突

### 固定端口

在以下情况下使用固定端口：
- 需要一致的 URL 以便书签
- 与其他工具集成
- 使用共享配置的团队协作

### 端口冲突解决

如果端口已被使用：

1. **检查正在使用端口的进程：**
   - Windows：`netstat -an | findstr :3000`
   - macOS/Linux：`lsof -i :3000`

2. **解决方案：**
   - 使用不同端口：`--port 3001`
   - 终止使用该端口的进程
   - 省略 `--port` 以使用临时端口

## 多项目设置

### 独立配置

创建项目特定的配置：

```bash
# 项目 A
project-a/
  .spec-workflow/
    config.toml  # port = 3000

# 项目 B
project-b/
  .spec-workflow/
    config.toml  # port = 3001
```

### 共享配置

使用带覆盖的共享配置：

```bash
# 共享基础配置
~/configs/spec-workflow-base.toml

# 项目特定的覆盖
npx -y @pimzino/spec-workflow-mcp@latest \
  --config ~/configs/spec-workflow-base.toml \
  --port 3000 \
  /path/to/project-a
```

## VSCode 扩展配置

VSCode 扩展有自己的设置：

1. 打开 VSCode 设置（Cmd/Ctrl + ,）
2. 搜索 "Spec Workflow"
3. 配置：
   - 语言偏好
   - 声音通知
   - 归档可见性
   - 自动刷新间隔

## 配置故障排除

### 配置未加载

1. **检查文件位置：**
   ```bash
   ls -la .spec-workflow/config.toml
   ```

2. **验证 TOML 语法：**
   ```bash
   # 安装 toml CLI 工具
   npm install -g @iarna/toml

   # 验证
   toml .spec-workflow/config.toml
   ```

3. **检查权限：**
   ```bash
   # 确保文件可读
   chmod 644 .spec-workflow/config.toml
   ```

### 常见问题

| 问题 | 解决方案 |
|-------|----------|
| 端口已被使用 | 使用不同端口或省略以使用临时端口 |
| 找不到配置文件 | 检查路径，必要时使用绝对路径 |
| 无效的 TOML 语法 | 使用 TOML 检查器验证 |
| 设置未应用 | 检查配置优先级 |

## 最佳实践

1. **使用版本控制**管理配置文件
2. **在项目 README 中记录**自定义设置
3. **在开发中使用临时端口**
4. **将敏感数据排除在**配置文件之外
5. **创建特定环境的**配置
6. **在部署前测试**配置更改

## 相关文档

- [用户指南](USER-GUIDE.zh.md) - 使用已配置的服务器
- [界面指南](INTERFACES.zh.md) - 仪表板和扩展设置
- [故障排除](TROUBLESHOOTING.zh.md) - 常见配置问题
