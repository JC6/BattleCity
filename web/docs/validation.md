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

## 音频功能与性能观察

开场功能检查要求按键前 120ms 静音，真实 Enter 后在 AudioContext/PCM 时间坐标的 500ms 内起音，并采集完整 500ms 窗口检查峰值 `<0.5`。音质在实际首音后 15–100ms 检查 `RMS >0.008` 和峰值 `<0.5`；正常开场还须通过原声部及完整乐句检查。采样覆盖保留 15 秒墙钟超时，缺失、重复、乱序及非有限数据仍使验收失败。150ms/300ms 主线程阻塞回归先确认正常播放，再检查阻塞期间声音连续。细节见[音频验证](audio.md#验证)。

90ms 保留为非阻断的历史观察目标，附件记录实际首音延迟、超标标记、采样率和功能上限；无首音保持为空。500ms 是项目 CI 故障上限，不是玩家日常听感目标或统一行业标准。报告通过只证明这些功能条件及其余验收项通过，不证明硬件输出链路或真实设备听感已经验证。既有 24 组配对和五对改善等实验采纳条件只留在历史归档，不增加日常验收步骤。

## 射击与失焦的独立诊断

`opening-latency` 工具的 `lifecycle` 模式只在冻结的临时源码副本插桩，记录发送、接收、命令执行或丢弃、暂停应用和实际输出。正式生产源码、TTL、Gain 和 PCM 验收窗口保持原样。Worklet 使用有界记录，播放期间不回传；测量完成后才一次取回。溢出、图身份变化或数据缺失视为证据不完整，不能据此判断功能正常。

在 `web` 目录使用同一 Node、浏览器和音频环境运行以下命令。将 `REPOSITORY` 替换为仓库绝对路径，`NATIVE_WEB` 替换为已安装依赖的原生文件系统 `web` 目录，`NEW_ARCHIVE` 替换为尚不存在的归档目录：

```sh
node scripts/diagnostics/opening-latency/build.mjs REPOSITORY NATIVE_WEB NEW_ARCHIVE --scenario lifecycle
LIFECYCLE_ARCHIVE=NEW_ARCHIVE node --experimental-vm-modules --test --test-isolation=none scripts/diagnostics/opening-latency/lifecycle-diagnostic.test.mjs
node NEW_ARCHIVE/runner/run.mjs NEW_ARCHIVE/config.json
node NEW_ARCHIVE/runner/analyze.mjs NEW_ARCHIVE
```

先通过原样与插桩 Worklet 的 PCM 逐样本等价性检查，再运行固定 8 次生命周期尝试：E2E 和 production 两种构建模式各执行 Chromium 1 次诊断、WebKit 1 次原样及 2 次诊断；单 worker、零重试、每次新 context。诊断专用流程保存射击失败后继续失焦检查，不改变正式测试的失败语义。所有尝试保留；未复现时不追加循环。

归档包含源码与构建哈希、插桩差异、原始 PCM、接收端时间线和 trace。可将完整目录保存在 `web/test-results/audio-lifecycle/<run>/`。诊断完成、退出码为零或本轮未复现都不代表产品通过验收，不能替代 `validate:desktop` 或覆盖原失败报告；旧开场诊断模式保持原口径。

## 报告与发布

每次验收保存在 `web/test-results/acceptance/<run>/`：根目录包含 `report.json`、`source-manifest.json` 和命令日志；`e2e/`、`production/` 分别包含阶段 JSON、`source-binding.json`、`results/` 测试附件，以及启用 HTML reporter 时的 `html/`。

验收入口为浏览器子进程设置内部变量 `BATTLECITY_ACCEPTANCE_DIR`，覆盖继承值，使报告直接写入本次目录。顶层旧报告不参与验收。单独运行 `test:e2e`、`test:deploy` 时保持原有 `test-results/` 和 `playwright-report/` 输出位置。

CI 安装依赖和浏览器后使用同一入口，始终尝试上传验收归档到 GitHub Actions Artifacts，保留 7 天。源码、像素、音频和 trace 归档不提交到仓库。推送 `master` 后，全部检查通过才自动部署 GitHub Pages。
