# LeanBridge AI

LeanBridge AI 是一个本地优先的数学证明形式化工作台：输入手写证明图片或 LaTeX/自然语言证明，应用调用 OpenAI 把它转成 Lean 4，在真实 Lean/mathlib 工程中编译，并把编译错误反馈给模型进行有限次自动修复。

> 模型负责提出形式化证明，Lean 内核负责决定证明是否成立。

## 已实现的能力

- PNG、JPEG、WebP 手写证明图片输入（最大 10 MiB）
- LaTeX、中文或英文自然语言输入
- OpenAI Responses API 多模态输入与结构化输出
- 默认使用 `gpt-5.6`，推理强度默认为 `high`
- 自动选择 `lake env lean` 或独立 `lean` 命令
- 编译错误定位、超时与缺少 Lean 的明确诊断
- 最多三轮自动修复（可配置为 0–5）
- 手工编辑、重新验证、复制与下载 `.lean`
- 不需要 API Key 或 Lean 的完整演示模式
- API Key 只存在服务端，不进入浏览器构建产物

## 快速体验

要求 Node.js 20.12 或更高版本。

```bash
npm install
cp .env.example .env
npm run dev
```

`.env.example` 默认启用 `DEMO_MODE=true`。打开终端显示的前端地址即可完整体验输入、生成、验证和编辑流程；演示模式使用确定性输出，不会调用外部 API，也不会启动 Lean。

生产构建：

```bash
npm run build
DEMO_MODE=true npm start
```

应用默认监听 `http://localhost:4310`。

## 云端生产后端

仓库根目录的 `Dockerfile` 会构建固定的 Lean 4 `v4.24.0` 与 mathlib `v4.24.0` 环境；`lake-manifest.json` 进一步固定了 mathlib 与全部传递依赖的提交。容器以非 root 用户运行 LeanBridge。容器默认强制启用 `CLOUD_MODE=true` 和 `DEMO_MODE=false`；缺少 OpenAI Key、后端令牌或固定 Lean 工程时，服务会直接拒绝启动，不会退回演示模型。

本机有 Docker 时，可以这样验证镜像：

```bash
cp .env.docker.example .env.docker
# 在 .env.docker 中填写 OPENAI_API_KEY 和一个足够长的随机 LEANBRIDGE_BACKEND_TOKEN
npm run docker:build
npm run docker:smoke
```

另一个终端中检查公开存活状态与受保护的真实 Lean 就绪状态：

```bash
curl -fsS http://127.0.0.1:4310/api/health
curl -fsS -H "Authorization: Bearer 你的后端令牌" http://127.0.0.1:4310/api/ready
```

`.env.docker` 已被 Git 忽略，绝不能把真实 Key 或后端令牌提交到仓库。

### 部署到 Railway

`railway.json` 已指定 Dockerfile 构建器和 `/api/health` 健康检查。将仓库连接到 Railway 后，只需在 Railway 服务变量中配置：

```dotenv
OPENAI_API_KEY=你的服务端_API_Key
OPENAI_MODEL=gpt-5.6
OPENAI_REASONING_EFFORT=high
LEANBRIDGE_BACKEND_TOKEN=独立生成的高强度随机令牌
```

`CLOUD_MODE`、`DEMO_MODE` 与 `LEAN_PROJECT_PATH` 已由镜像设置，通常无需覆盖。Railway 分配的 `PORT` 会被服务自动读取。部署完成后先访问 `/api/health`，再携带 Bearer 令牌访问 `/api/ready`；后者会通过容器内的真实 Lean 内核编译一个探针定理。

## 连接 OpenAI 与真实 Lean

### 1. 准备 Lean/mathlib 工程

Lean 官方推荐使用 VS Code 与 Lean 4 扩展完成安装，也可以通过 Elan 管理工具链：[Lean 安装指南](https://lean-lang.org/install/)、[Elan 工具链说明](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Managing-Toolchains-with-Elan/)。Lake 是 Lean 的标准构建工具，负责依赖与构建：[Lake 手册](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/)。

创建一个依赖 mathlib 的新工程时，可按 mathlib 社区当前指南执行：

```bash
lake +v4.24.0 new my_project math
cd my_project
lake update
```

指南中的版本用于保证 `lake` 足够新，项目最终采用的 Lean 版本由生成的 `lean-toolchain` 决定。完整说明见 [Creating a Lean project](https://leanprover-community.github.io/install/project.html)。已有工程可以直接使用。

### 2. 配置应用

复制 `.env.example` 为 `.env` 并修改：

```dotenv
DEMO_MODE=false
OPENAI_API_KEY=你的服务端_API_Key
OPENAI_MODEL=gpt-5.6
OPENAI_REASONING_EFFORT=high
LEAN_PROJECT_PATH=/绝对路径/my_project
LEAN_COMMAND=lean
LAKE_COMMAND=lake
LEAN_TIMEOUT_MS=30000
MAX_REPAIR_ATTEMPTS=3
PORT=4310
```

启动：

```bash
npm run dev
```

也可以不设置 `LEAN_PROJECT_PATH`，在界面的“Lean / mathlib 工程路径”中为单次任务指定工程。

## 工作流程

1. 浏览器仅提交证明文本或图片，不接触 API Key。
2. 服务端使用 Responses API：图片作为 `input_image`，文字作为 `input_text`。
3. 模型按结构化 schema 返回转录、定理摘要、假设、imports、Lean 源码与说明。
4. 本地守卫拒绝包含 `sorry` 或 `admit` 的结果。
5. 服务端把源码写入独立临时目录，以参数数组启动 `lake env lean Main.lean`；没有 Lake 工程标记时改用 `lean Main.lean`。
6. 验证失败时，完整但有长度上限的 Lean 诊断会返回给模型修复。
7. 验证成功、禁用自动修复或达到修复上限后停止；最后一次源码与所有尝试记录都会保留。

OpenAI 的实现依据当前官方文档：Responses API 适合推理及多轮工作流，[GPT-5.6 模型指南](https://developers.openai.com/api/docs/guides/latest-model)；图片可以通过 Responses API 作为 Base64 data URL 输入，[Images and vision](https://developers.openai.com/api/docs/guides/images-vision)；输出通过 SDK 的结构化输出解析，[Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 常用命令

```bash
npm run dev        # 同时启动前端与服务端
npm test           # 运行全部自动化测试
npm run typecheck  # 严格 TypeScript 检查
npm run build      # 生成 dist/client 与 dist/server
npm start          # 运行生产构建
npm run docker:build # 构建包含 Lean/mathlib 的生产镜像
npm run docker:smoke # 使用 .env.docker 启动生产镜像
```

## 故障排查

### `Lean executable not found`

先在同一个终端运行 `lean --version` 和 `lake --version`。如果命令只在特定路径可用，可设置 `LEAN_COMMAND`、`LAKE_COMMAND` 为绝对路径；使用 Elan 后可能需要重新打开终端。

### `unknown package 'Mathlib'`

`LEAN_PROJECT_PATH` 必须指向含 `lakefile.lean`、`lakefile.toml` 或 `lakefile` 的 mathlib 工程根目录，并先在该目录运行 `lake update`。

### 验证超时

提高 `LEAN_TIMEOUT_MS`。默认 30 秒，上限 300 秒。首次下载或构建 mathlib 不应由本应用触发，应先在工程中完成依赖安装。

### AI 返回的定理与原证明不完全一致

在输入中明确写出变量类型、量词、定义域、隐含前提和目标定理。手写图可在“补充背景”中说明符号含义。即使 Lean 验证通过，也只说明生成的 Lean 定理被证明；语义是否忠实仍需要人审查。

## 安全边界

- 服务端调用子进程时固定 `shell: false`，用户路径不会拼接成 shell 命令。
- Docker 入口把 OpenAI Key 与后端令牌转移到启动期一次性文件，Node 读取后立即删除；Lean 子进程只接收 PATH、HOME、Elan 等白名单环境变量。
- 生产镜像中的应用、Lean 工具链与 mathlib 工程归 root 所有且只读，Lean 只能写入独立临时目录。
- 源码守卫除 `sorry` / `admit` 外，也拒绝 `#eval`、`run_cmd`、`run_tac`、`initialize`、自定义宏/语法/elaborator、外部函数与新公理等编译期执行入口。
- 编译在应用拥有的临时文件中进行，不覆盖工程文件。
- 请求体、图片、编译输出、超时和修复次数都有上限。
- 云端后端需要独立 Bearer 令牌，除 `/api/health` 外的 API 均受保护；Sites 代理在服务端添加该令牌，浏览器不会接触它。
- 云端拒绝客户端指定 Lean 工程路径，并把 Lean 验证串行化，适合首个 owner-only 版本。
- 内存任务存储最多保留 8 个任务；手写图片在模型完成识别后立即从任务存储释放，终态任务会按容量和 TTL 淘汰。
- 当前仍不是多租户沙箱，也使用内存任务存储。扩大访问范围前，需要为每个 Lean 任务增加一次性容器或 microVM、限流和持久化队列。

## 项目结构

```text
src/client/                 React 工作台
src/server/adapters/model/  OpenAI 与演示模型适配器
src/server/adapters/lean/   Lean 子进程与演示验证器
src/server/domain/          状态机、端口、内存任务存储
src/shared/                 客户端/服务端共享 schema 与类型
test/fixtures/              确定性假 Lean 可执行文件
docs/                       设计、架构与实施计划
lean-project/               固定 Lean 4.24.0 / mathlib 4.24.0 工程
```

更详细的数据流和扩展边界见 [docs/architecture.md](docs/architecture.md)。
