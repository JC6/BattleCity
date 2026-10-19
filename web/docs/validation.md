# 桌面验收

`npm run validate:desktop` 在 Linux 或普通 WSL 终端运行，覆盖无头桌面 Chromium 和 WebKit。兼容范围见 [README](../../README.md#浏览器验收)。

## 环境与命令

需要 Node 24。在 `web` 目录安装锁定依赖、浏览器及宿主依赖，然后运行检查：

```sh
npm ci
npx playwright install --with-deps chromium webkit
npm run validate:desktop
```

已有依赖时只运行最后一条命令。安装浏览器需要网络，安装宿主依赖可能需要系统权限；验收命令本身不执行安装。

工具使用当前终端的环境。需要选择 Node、临时目录、浏览器缓存或动态库时，分别配置 `PATH`、`TMPDIR`、`PLAYWRIGHT_BROWSERS_PATH`、`LD_LIBRARY_PATH`；安装与运行使用相同配置。

## 检查流程

命令依次执行类型检查、单元测试、双浏览器 E2E、生产打包和双浏览器生产冒烟。任一步失败即停止，全部成功时退出码为零。类型检查覆盖应用、测试和构建配置；E2E 使用 test 模式构建，随后重新打包生产版本，避免将测试构建发布。

Playwright 使用单 worker、零重试，CI 禁止独占用例。E2E 覆盖游戏规则接线、键盘、焦点、原生像素、纹理生命周期、窗口尺寸和实际音频 PCM。生产冒烟验证键盘流程、画面、音频、所有产出资源可加载、所有 JavaScript 均无测试接口，以及发布的许可文件与当前源码一致。

可以分别运行 `npm run typecheck`、`npm test`、`npm run test:e2e`；单独验证生产版本时先运行 `npm run build`，再运行 `npm run test:deploy`。以本次命令或 CI 执行结果判定通过，环境受阻或未执行的检查不能记为通过。

## 音频检查

音频检查使用真实 PCM、波形断言和失败附件，详见 [音频验证](audio.md#验证)。开场须在 500ms PCM 窗口内起音；90ms 为性能观察目标。热态射击、手动暂停采用 50ms 响应目标与 150ms 验收上限，暂停完整乐句及结束静音相对实际起音验证。射击保留原音高特征与幅值余量，失焦静音要求不变。150ms/300ms 主线程阻塞回归检查已经开始的播放是否连续。

实时 PCM 检查需要宿主及时调度音频与页面线程。软件渲染环境可显式配置 `LP_NUM_THREADS`、`WEBKIT_SKIA_ENABLE_CPU_RENDERING`、`WEBKIT_SKIA_CPU_PAINTING_THREADS`；测试不自动设置它们，也不因此放宽断言。通过检查不代表已验证真实扬声器输出或设备听感。

## 报告与发布

本地输出终端列表和 HTML 报告，CI 输出 GitHub 注解和 HTML 报告。E2E 与生产测试分别写入 `playwright-report/e2e/`、`playwright-report/production/`；截图、trace、PCM 等附件分别保存在 `test-results/e2e/`、`test-results/production/`。每阶段重用自己的输出目录，不维护历史运行归档。

CI 使用相同验收入口，并在失败时也尝试上传上述报告和附件，保留 7 天。测试产物不提交到仓库。推送 `master` 后，全部检查通过才自动部署 GitHub Pages。
