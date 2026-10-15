# 桌面验收

正式门禁为 `npm run validate:desktop`，在 Linux 或普通 WSL 终端运行，覆盖无头桌面 Chromium 和 WebKit。兼容范围见 [README](../../README.md#浏览器验收)。

## 环境与命令

需要 Node 24，依赖版本由 `package-lock.json` 固定。在 `web` 目录运行：

```sh
npm run validate:desktop -- --install
```

`--install` 在依赖不匹配时执行 `npm ci`，并安装两个浏览器及宿主依赖；下载需要网络、足够的临时空间，安装系统依赖可能需要权限。已有依赖时运行 `npm run validate:desktop`，不执行安装。

脚本使用当前终端的 Node，将其目录置于子进程 `PATH` 开头并保留原 `PATH`。需要选择工具链或缓存时，在当前终端显式配置：

- `PATH`：将所选 Node 24 的 `bin` 目录放在前面。
- `TMPDIR`：下载、解压和测试临时文件目录。
- `PLAYWRIGHT_BROWSERS_PATH`：浏览器安装和运行共用的缓存目录。
- `LD_LIBRARY_PATH`：需要自备动态库时指定其目录。

后三项原样继承，脚本不会寻找或切换缓存。安装和验收应使用同一环境配置；临时目录中的缓存可能在重启或清理后消失。

实时 PCM 验收需要宿主及时调度音频与页面线程。诊断软件渲染竞争时，可显式配置 [Mesa 的 `LP_NUM_THREADS`](https://docs.mesa3d.org/envvars.html#envvar-LP_NUM_THREADS) 和 [WebKit 的 CPU 绘制](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/glib/environment-variables.md.in)。脚本不自动设置它们；报告的 `runtime.rendering` 记录传入的 `LP_NUM_THREADS`、`WEBKIT_SKIA_ENABLE_CPU_RENDERING`、`WEBKIT_SKIA_CPU_PAINTING_THREADS`。环境调整不能放宽 PCM 时间或波形断言。

## 检查与通过标准

完整运行依次执行环境预检、类型检查、验收脚本测试、单元测试、两引擎 E2E、生产构建、产物检查和生产冒烟。`typecheck` 覆盖应用、测试、JSON fixture 和 Vite/Vitest/Playwright 配置；`build` 也包含类型检查。

正式通过要求 `browserAcceptance: passed`、源码绑定通过，以及两个浏览器完整执行。每例仅接受一次通过，零失败、跳过、重试、flaky 和全局错误；配置必须为单 worker、不分片、不提前停止、不重复执行。固定用例数量由 [验收脚本的 `expectedCases`](../scripts/validate-desktop.mjs) 唯一维护，增删浏览器用例时同步更新该基准。

命令、报告及每个用例的完整时间区间必须属于本次执行。缺失、过期或只发现用例的报告不能替代实际执行。环境受阻必须报告未验收，不能将未运行视为通过。

验收报告和阶段源码绑定使用 `schemaVersion: 2`。源码指纹覆盖 git 列出的 `web` 文件及根目录 `LICENSE`，同时记录 `LICENSE` 和第三方声明的 SHA-256；运行期间不得修改源码。生产许可证副本必须与初始源码快照一致，生产 JavaScript 必须不含测试接口。旧版报告不能替代这些证据。

| 退出码 | 含义 |
|---|---|
| `0` | 本次命令检查通过 |
| `1` | 检查失败 |
| `2` | 环境受阻或中断 |

`--preflight-only` 仅检查环境，不执行游戏验收用例；即使返回 `0`，`browserAcceptance` 仍为 `unverified`。

## 报告与发布

每次验收保存在 `web/test-results/acceptance/<run>/`：根目录包含 `report.json`、`source-manifest.json` 和命令日志；`e2e/`、`production/` 分别包含阶段 JSON、`source-binding.json`、`results/` 测试附件，以及启用 HTML reporter 时的 `html/`。

验收入口为浏览器子进程设置内部变量 `BATTLECITY_ACCEPTANCE_DIR`，覆盖继承值，使报告直接写入本次目录。顶层旧报告不参与验收。单独运行 `test:e2e`、`test:deploy` 时保持原有 `test-results/` 和 `playwright-report/` 输出位置。

CI 安装依赖和浏览器后使用同一入口，始终尝试上传验收归档到 GitHub Actions Artifacts，保留 7 天。源码、像素、音频和 trace 归档不提交到仓库。推送 `master` 后，全部检查通过才自动部署 GitHub Pages。
