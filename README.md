# @rzdfzcl/buildervillager

[![npm](https://img.shields.io/npm/v/@rzdfzcl/buildervillager.svg)](https://www.npmjs.com/package/@rzdfzcl/buildervillager)
[![license](https://img.shields.io/npm/l/@rzdfzcl/buildervillager.svg)](LICENSE)
[![CI](https://github.com/rzdfzcl/buildervillager/actions/workflows/ci.yml/badge.svg)](https://github.com/rzdfzcl/buildervillager/actions/workflows/ci.yml)

一条命令完成 Minecraft **Paper 26.3** 服务端、**BuilderVillager MCP 服务**与 **Agent 技能**的检查 / 部署 / 更新。

## 安装

任选一种，**效果完全相同**。

### 方式一：直接从 GitHub 安装（无需 npm 账号，立即可用）

```bash
npm install -g github:rzdfzcl/buildervillager
buildervillager
```

固定版本：

```bash
npm install -g github:rzdfzcl/buildervillager#v0.1.0
```

`git` 地址安装会从仓库拉取源码；`prepack` 会用仓库里已提交的 `vendor/`（MCP 服务程序 + 技能模板），不需要本地编译。

### 方式二：Release 压缩包

```bash
npm install -g https://github.com/rzdfzcl/buildervillager/releases/download/v0.1.0/rzdfzcl-buildervillager-0.1.0.tgz
```

### 方式三：npm 官方源

```bash
npm install -g @rzdfzcl/buildervillager
```

> 若镜像源尚未同步，加 `--registry=https://registry.npmjs.org/`。

安装完成后 `buildervillager`、`bv` 两个命令都可用。

运行后进入多选菜单（方向键移动、**空格勾选**、`a` 全选、回车确认），工具随后依次：

1. **检查** —— 对比本地现状与官方最新版本，打印差异表；有阻塞问题时直接退出，不改任何文件；
2. **部署** —— 下载并校验 Paper、WorldEdit、WorldGuard，写入 MCP 服务、配置、共享密钥与启动脚本；
3. **更新** —— 已有内容按需升级；已有配置与共享密钥默认保留，避免两端密钥漂移。

## 组件（可多选）

| 组件 | 内容 | 来源 |
| --- | --- | --- |
| `paper` | Paper 26.3 服务端，最新 STABLE 构建 | PaperMC v3 API，SHA256 校验 |
| `plugins` | WorldEdit、WorldGuard | Modrinth，SHA512 校验 |
| `mcp` | BuilderVillager MCP 服务 + `mcp.json` + 共享密钥 + Paper 侧配置 + 启动脚本 | 随本包分发（`vendor/`） |
| `skills` | `buildervillager-construction`、`buildervillager-knowledge-curation` | 随本包分发（`vendor/skills/`） |

## 命令

```bash
buildervillager                 # 交互多选 → 检查 → 部署/更新
buildervillager check           # 只看差异，不改动
buildervillager update          # 升级后重跑即可（幂等）
buildervillager doctor          # 部署后自检：Java、文件、密钥一致性、CLI、技能
buildervillager skills          # 只安装 Agent 技能
```

## 常用选项

| 选项 | 说明 |
| --- | --- |
| `-d, --dir <目录>` | 服务目录，默认 `./buildervillager-server` |
| `-m, --minecraft <版本>` | Paper 版本，默认 `26.3` |
| `--only <组件,...>` | 只处理指定组件，如 `--only paper,mcp` |
| `--skip <组件,...>` | 跳过指定组件 |
| `--backend codex\|deepseek` | Agent 后端，默认按 `PATH` 探测（优先 `dsh`） |
| `--executable <路径>` | 指定 CLI 完整路径 |
| `--java-home <路径>` | JDK 25 目录，默认 `$JAVA_HOME` 或 `PATH` |
| `--port` / `--bridge-port` | 公开 MCP 端口 / Paper 内部端口，默认 25576 / 25577 |
| `--concurrency <1-4>` | 并行 Agent 任务数，默认 2 |
| `--eula` | 写入 `eula=true`（表示你同意 Mojang EULA） |
| `--force` | 覆盖已有配置并重新下载 |
| `--rotate-secret` | 重新生成共享密钥 |
| `--no-interactive` | 不弹菜单，按默认全选执行（适合脚本/CI） |

## 部署结果

```text
buildervillager-server/
  paper-26.3-<构建>.jar
  start-paper.cmd                     # 已从 mcp/secret.txt 注入共享密钥
  server.properties  eula.txt
  plugins/worldedit-bukkit-*.jar
  plugins/worldguard-bukkit-*.jar
  plugins/BuilderVillager/mcp.json    # Paper 侧 MCP 配置
  mcp/buildervillager-mcp.jar
  mcp/mcp.json  secret.txt  start.cmd  start.ps1  paper-mcp.json
  mcp/agent-state/                    # Agent 临时工作目录
  .buildervillager.json               # 部署记录（版本与哈希）
```

## 启动

先启动 Paper，再另开一个窗口启动 MCP：

```bash
buildervillager-server\start-paper.cmd
buildervillager-server\mcp\start.cmd
```

然后进入游戏：`模组 → AI Builder Villager → 配置 → 建筑 MCP → 绑定当前玩家 → 测试 MCP`。

## 环境要求

- **Node.js 18+**（本工具自身）
- **JDK 25**（Paper 26.3 与 MCP 服务；`--java-home` 可指定）
- 已安装并登录 **Codex** 或 **DeepSeek Harness** CLI（服务端 Agent 使用其运行账户已有的配置与登录）

## 边界

- 只写上面列出的文件；不触碰 `world/`、其他插件、玩家数据。
- 已存在的 `mcp.json`、`secret.txt`、Paper 侧 `mcp.json` 默认保留；需要覆盖用 `--force`，换密钥用 `--rotate-secret`。
- `eula.txt` 默认写 `false`，不会替你同意 Mojang 协议。
- 技能只增删自己的两个目录，不改动其他技能与 CLI 全局配置。
- 所有下载都做哈希校验，不一致立即丢弃并报错。

## 开发

```bash
git clone https://github.com/rzdfzcl/buildervillager.git
cd buildervillager
npm test             # 离线测试，不访问网络
npm pack --dry-run   # 查看将发布的文件
```

`vendor/` 里放的是随包分发的 MCP 服务程序与技能模板，由上游构建产出后提交，因此本仓库可以独立安装与发布：

- 从上游同步：把新的 `buildervillager-mcp.jar` 覆盖到 `vendor/`，技能模板放到 `vendor/skills/<技能名>/SKILL.md`；
- 执行 `npm pack --dry-run` 确认文件清单，再 `npm publish` 或建立 Release。

### 从 GitHub 安装的原理

`npm install -g github:rzdfzcl/buildervillager` 会克隆仓库、安装依赖并执行 `prepack`。`scripts/stage-vendor.js` 在没有上游构建产物时会保留已提交的 `vendor/`，所以安装不需要任何编译步骤。若希望固定到某个版本，用 `#v0.1.0` 这样的 tag。

### 发布新版本

```bash
# 1. 更新版本号（两处保持一致）
#    package.json 的 version
npm version patch --no-git-tag-version

# 2. 确认内容
npm pack --dry-run

# 3. npm（需要开启 2FA）
npm publish --registry=https://registry.npmjs.org/

# 4. Release 压缩包（供无法访问 npm 的用户）
npm pack
gh release create v0.1.1 *.tgz --title "v0.1.1" --notes "变更说明"
```

## License

[MIT](LICENSE)
