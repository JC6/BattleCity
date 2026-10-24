# BattleCity

1985 年 NAMCO 红白机《Battle City》的 Web 复刻：单人、同机双人合作、Construction 地图编辑，包含 35 个原版关卡、四类敌人、六种道具及计分循环。游戏使用 TypeScript + Phaser + Vite，在 256×240 像素画面内操作。

根目录保留旧 Eclipse ADT / AndEngine Android 学习工程，Web 版本独立运行。

## 开发

需要 Node.js 24。在仓库根目录运行：

```sh
cd web
npm ci
npm run dev
```

打开终端显示的地址。在 `web` 目录用 `npm run build` 构建到 `dist/`；单独检查可运行 `npm run typecheck`、`npm test`。
维护约束见 [开发边界](web/docs/architecture.md)，原作资料见 [参考来源](web/docs/references.md)。

## 操作

| 玩家 | 移动 | 射击 |
|---|---|---|
| 1P | WASD | J / K（A / B） |
| 2P | 方向键 | N / M（A / B） |

右 Shift（Select）循环选择单人、双人和 Construction。Enter（Start）确认模式，J / K 在选关页增减关卡，再按 Enter 开始。
战斗中 Enter 暂停或继续；失焦或切后台时暂停，返回后按 Enter 继续。暂停或切换画面后，按住的方向与射击键需要先松开再按下。

Construction 用 WASD 移动光标，J / K 首次绘制当前块、连续按键切换块型，按住 J 或 K 移动可连续绘制。Enter 返回菜单；随后开始单人或双人游戏时，草稿替换第一张地图，过关后继续原版关卡。战斗不会修改草稿，Game Over 或刷新后清空。

失败后自动播放战场 GAME OVER、计分、砖字 GAME OVER；刷新纪录时再播放 HISCORE，随后返回菜单，Start 不能跳过。最高分在砖字 GAME OVER 后更新，仅保留在本次页面运行中，刷新恢复为 20000。

## 浏览器验收

完成上述依赖安装后，在 Linux 或普通 WSL 的 `web` 目录运行：

```sh
npx playwright install --with-deps chromium webkit
npm run validate:desktop
```

首次验收需安装浏览器及宿主依赖；已有依赖时只运行最后一条命令。

| 浏览器 | 验收与支持范围 |
|---|---|
| Chromium | 测试构建完整验收，另做生产冒烟 |
| WebKit / Safari 26+ | 仅承诺基础流程，通过 Linux WebKit 生产冒烟验收 |

完整验收覆盖规则接线、键盘与焦点、原生像素、纹理生命周期、窗口尺寸、像素密度和音频正确性。生产冒烟覆盖资源与许可、单双人启动、移动射击、Construction、真实开场出声及测试接口隔离；WebKit 冒烟失败也会阻止发布。
Firefox、Safari 26 以下及移动端/触控不作兼容承诺。门禁不含真实 Windows 品牌浏览器或物理声画输出检查。

`validate:desktop` 依次执行类型检查、单元测试、Chromium E2E、生产构建和双浏览器生产冒烟，遇错即停；浏览器测试使用单 worker、零重试。检查定义见 [npm 脚本](web/package.json) 和 [Playwright 配置](web/playwright.config.ts)。

HTML 报告在 `web/playwright-report/`，失败附件在 `web/test-results/`，均按 `e2e`、`production` 分目录。[CI](.github/workflows/pages.yml) 使用同一验收入口；推送 `master` 后全部检查通过才部署 GitHub Pages，报告作为构建产物上传。

## 许可

项目许可见 [LICENSE](LICENSE)，第三方来源及许可见 [第三方声明](web/THIRD_PARTY_NOTICES.md)。
