# BattleCity

1985 年 NAMCO 红白机《Battle City》的 Web 复刻，保留本仓库原来的 Android 学习工程。

## Web 版本

- 单人、电脑同机双人合作、Construction 地图编辑。
- 35 个原版关卡、四类敌人、六种道具、升级、计分和关卡循环。
- 电脑键盘映射两个红白机手柄；游戏、选关和编辑均在 256×240 像素画面内完成。
- TypeScript + Phaser + Vite，纯 TypeScript 管理游戏规则。

### 开发

需要 Node.js 24 LTS。

```sh
cd web
npm ci
npm run dev
```

打开终端显示的地址。

在 `web` 目录检查和构建：

```sh
npm run typecheck
npm test
npm run build
```

`typecheck` 同时检查应用、测试和构建配置；也可分别执行 `typecheck:app`、`typecheck:tests`。
开发边界见 [Web 架构](web/docs/architecture.md)、[应用状态与时序](web/docs/state-machine.md)、[音频协议与恢复](web/docs/audio.md) 和 [参考资料索引](web/docs/references.md)。

### 操作

| 模式 | 移动 | 射击 |
|---|---|---|
| 单人 / 双人 1P | WASD | J / K（A / B） |
| 双人 2P | 方向键 | N / M（A / B） |

右 Shift 对应 Select，在主菜单循环选择 1 PLAYER、2 PLAYERS、CONSTRUCTION。
Enter 对应 Start：确认模式后进入选关页，J / K 增减关卡，再按 Enter 开始。
战斗中按 Enter 暂停或继续；切后台或失去窗口焦点时暂停，返回后按 Enter 继续。
按住的方向或射击键在暂停、切换画面后需要先松开，再重新按下。

Construction 使用 WASD 移动光标，J / K 首次绘制当前地形块，连续按键切换块型，按住 J 或 K 移动时连续绘制。
Enter 完成编辑并返回主菜单；随后选择单人或双人模式，自定义地图替换第一张地图，过关后继续原版关卡。
游戏中的破坏不会修改编辑草稿。自定义地图在本次页面运行内有效，Game Over 或刷新后清空。
失败后依次显示战场 GAME OVER、计分、砖字 GAME OVER；本次游戏刷新纪录时再显示 HISCORE，之后自动返回菜单。
结算与终局自动播放，Start 不跳过；最高分在砖字 GAME OVER 结束后更新。

最高分仅保存在本次页面运行中，刷新恢复为 20000，不读取或保存浏览器持久化偏好。
音效通过 AudioWorklet 实时合成，画面与音轨按同一游戏帧推进；四通道波形遵循参考音轨，模拟滤波为近似。

### 浏览器验收

正式门禁为 `validate:desktop` 自动验收，范围是 Linux 无头桌面 Chromium 和 WebKit；检查包含键盘流程、原生像素、纹理生命周期、实际音频 PCM、窄窗口、不同像素密度及焦点事件处理。
Firefox 不主动拦截，但不属于本轮兼容承诺或发布门禁；移动端和触控也不提供兼容承诺。
真实 Windows 品牌浏览器、系统切窗和物理显示、扬声器输出不属于必做门禁；不要求人工检查或填写检查表。

在 `web` 目录运行：

```sh
npm run validate:desktop -- --install
```

从 Linux 或普通 WSL 终端运行；已有依赖时使用 `npm run validate:desktop`。环境准备、完整验收标准、报告和 CI 说明集中在 [桌面验收](web/docs/validation.md)。

## 原 Android 工程

基于 Android 的坦克大战游戏开发，采用旧 Eclipse ADT / AndEngine。
原 Java 源码、资源与工程配置保留在根目录，Web 版本不依赖 Android 工具链。

## 许可

沿用仓库现有 [LICENSE](LICENSE)。第三方来源及许可见 [第三方声明](web/THIRD_PARTY_NOTICES.md)。
