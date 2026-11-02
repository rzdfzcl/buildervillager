# @rzdfzcl/buildervillager

一条命令完成 Minecraft **Paper 26.3** 服务端、**BuilderVillager MCP 服务**与 **Agent 技能**的检查 / 部署 / 更新。

一键下载并运行（在希望存放服务端的目录执行）：

```bash
npx --yes @rzdfzcl/buildervillager@latest
```

命令下载完成后**立即自动安装全部组件**，不再要求输入第二条命令或确认组件菜单。默认部署到当前目录下的 `buildervillager-server/`；需要自己选择组件时加 `--interactive`。

Windows 本地发行包：把 `install.cmd` 和 `rzdfzcl-buildervillager-0.1.4.tgz` 放在同一个目录，**双击 `install.cmd`**。脚本会自动解包并执行安装，无需输入 `-- buildervillager`。完整解压后的 npm 包同样可以直接双击其中的 `install.cmd`。

也可以从 [GitHub Releases](https://github.com/rzdfzcl/buildervillager/releases) 只下载 `install.cmd` 并双击：没有本地包时自动下载完整安装包；npm 暂不可用时改从对应 GitHub Release 下载，并校验 `SHA256SUMS.txt`。

如果已经运行过 `npm install -g @rzdfzcl/buildervillager`，直接执行 `buildervillager` 即可继续部署。`npm install -g` 只安装命令行工具，不会运行部署流程。

也可以选择全局安装，之后重复使用：

```bash
npm install -g @rzdfzcl/buildervillager
buildervillager
```

运行后自动依次：

1. **检查** —— 对比本地现状与随包版本，打印差异表；缺少 Java 或 Agent CLI 会计划自动安装；
2. **部署** —— 校验并释放 JDK、Paper、WorldEdit、WorldGuard、BuilderVillager 插件、MCP 服务、配置、共享密钥与启动脚本；
3. **更新** —— 已有内容按需升级；已有配置与共享密钥默认保留，避免两端密钥漂移。

## 组件（可多选）

| 组件 | 内容 | 来源 |
| --- | --- | --- |
| `paper` | Paper 26.3 服务端，打包时最新 STABLE 构建 | 随包分发；PaperMC v3 API，SHA256 校验 |
| `plugins` | WorldEdit、WorldGuard、BuilderVillager Paper 插件 | 随包分发；前两者来自 Modrinth，SHA512 校验 |
| `mcp` | BuilderVillager MCP 服务 + `mcp.json` + 共享密钥 + Paper 侧配置 + 启动脚本 | 随本包分发（`vendor/`） |
| `skills` | `buildervillager-construction`、`buildervillager-knowledge-curation` | 随本包分发（`vendor/skills/`） |

Windows x64 发布包包含上述全部资源，以及 **JDK 25 ZIP**、**Codex 原生 CLI 安装包**、**DeepSeek Harness 及完整 npm 依赖包**。未配置 `JAVA_HOME`、PATH 中没有 Java、已有 Java 低于 25 时，会自动释放 JDK 到服务目录 `runtime/java/`，无需管理员权限；Paper 和 MCP 启动脚本直接引用它。优先复用已安装的可用 Java、DeepSeek 或 Codex；没有 Agent CLI 时，默认把随包 Harness 安装到 `runtime/deepseek/`，并启用服务端 Agent。指定 `--backend codex` 时自动安装随包 Codex 到 `runtime/agent/`。

Harness 包包含 npm 的完整依赖树，不会只复制 `dsh` 入口；部署时同时复制当前 Node 到其目录，启动脚本不依赖 PATH。其他系统/架构没有对应随包 Harness 时通过 npm 自动补齐；JDK 和 Codex、以及 `--minecraft` 指定的其他版本从官方来源自动补齐。下载、校验或解压失败会报告具体错误，可直接重跑；缺少依赖本身不会阻塞安装。

默认版本的 Windows x64 部署在 npx 下载完成后无需再次下载上述组件；Paper 首次启动仍可能下载其运行库。更新随包组件时重新运行 `npx --yes @rzdfzcl/buildervillager@latest`。

## 命令

```bash
buildervillager                 # 自动检查 → 安装全部组件
buildervillager --interactive   # 按需显示组件选择菜单
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
| `--java-home <路径>` | 优先使用指定 JDK，或探测 `$JAVA_HOME` / `PATH`；不足 Java 25 时自动安装 |
| `--port` / `--bridge-port` | 公开 MCP 端口 / Paper 内部端口，默认 25576 / 25577 |
| `--concurrency <1-4>` | 并行 Agent 任务数，默认 2 |
| `--eula` | 写入 `eula=true`（表示你同意 Mojang EULA） |
| `--force` | 覆盖已有配置并重新下载 |
| `--rotate-secret` | 重新生成共享密钥 |
| `--no-interactive` | 不弹菜单，按默认全选执行（适合脚本/CI） |

## 部署结果

```text
buildervillager-server/
  runtime/java/                       # 缺少 Java 25 时自动安装的本地 JDK
  runtime/deepseek/                   # 缺少 Agent CLI 时自动安装的 Harness + 依赖
  runtime/agent/                      # 选用 Codex 时自动安装
  paper-26.3-<构建>.jar
  start.cmd  start.ps1                # 一键启动 Paper + MCP
  start-paper.cmd                     # 已从 mcp/secret.txt 注入共享密钥
  server.properties  eula.txt
  plugins/worldedit-bukkit-*.jar
  plugins/worldguard-bukkit-*.jar
  plugins/buildervillager-paper.jar
  plugins/BuilderVillager/mcp.json    # Paper 侧 MCP 配置
  mcp/buildervillager-mcp.jar
  mcp/mcp.json  secret.txt  start.cmd  start.ps1  paper-mcp.json
  mcp/agent-state/                    # Agent 临时工作目录
  .buildervillager.json               # 部署记录（版本与哈希）
```

## 启动

**双击服务目录的 `panel.cmd` 打开管理面板**，点击“启动全部”即可在后台启动 Paper 和 MCP，不弹服务控制台。面板显示每个服务的状态、PID、内存和端口，支持正常停止、重启单项或全部服务、查看日志，以及编辑游戏和 MCP/Agent 配置。世界管理可切换已有世界或创建新世界；玩家管理可查看在线及历史角色，授予／取消 OP、切换游戏模式、给予经验、恢复生命，以及按中文名或物品 ID 搜索并给予物品。配置修改会自动备份，并同步相关端口；需要重启对应服务后生效。

面板首次启动服务时会在面板内确认 Minecraft EULA，已经同意后不再询问。也可使用 `start.cmd` 后台启动两个服务；未同意 EULA 时该脚本会询问一次。

```bash
buildervillager-server\start.cmd
```

MCP 使用服务凭据连接，可从面板复制 MCP 地址和凭据。服务凭据保存在 `mcp/secret.txt`，外部 MCP 客户端使用 `Authorization: Bearer <凭据>`；玩家只作为管理操作目标。

游戏客户端会自动连接。进入游戏：`模组 → AI Builder Villager → 配置 → 建筑 MCP → 测试 MCP`。

## 环境要求

- **Node.js 22.16+**（本工具与 Harness）
- **JDK 25** 自动补齐，也可用 `--java-home` 指定。
- **Codex** / **DeepSeek Harness** CLI 自动补齐；账户登录需要用户完成，已有 CLI 则复用该账户配置与登录。

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
npm install
npm test             # 离线测试，不访问网络
npm pack --dry-run   # 查看将发布的文件
```

发布前先构建 `:mcp:jar` 与 `:paper:jar`。Windows x64 环境下 `prepack` 复制这两个程序与技能，从官方来源下载 JDK、Paper、WorldEdit、WorldGuard、Codex，并安装、打包 Harness 的完整 npm 依赖树，写入 `vendor/manifest.json`（来源、版本、哈希），缺少任何必需资源都会拒绝打包。已有资源校验通过时复用，`node scripts/stage-vendor.js --refresh` 刷新为官方最新版本。最终 npm 包自带完整部署资源，用户无需构建 Java 项目。

## License

[MIT](LICENSE)
