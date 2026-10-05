# BattleCity

1985 年 NAMCO 红白机《Battle City》的 Web 复刻，保留本仓库原来的 Android 学习工程。

## Web 版本

- 单人、电脑同机双人合作、Construction 地图编辑。
- 35 个原版关卡、四类敌人、六种道具、升级、计分和关卡循环。
- 电脑键盘和手机触屏；像素图形与音效由项目重新制作。
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

### 操作

| 模式 | 移动 | 射击 |
|---|---|---|
| 单人 | WASD 或方向键 | J 或空格 |
| 双人 1P | WASD | J |
| 双人 2P | 方向键 | Enter |

Esc 暂停。手机使用画面外的方向和射击按钮，可以同时移动与开火。
切后台后暂停，返回时点击继续。

Construction 可编辑地形并在单人或双人模式试玩；自定义地图替换起始关，过关后继续原版关卡，试玩破坏不会修改编辑草稿。

## 原 Android 工程

基于 Android 的坦克大战游戏开发，采用旧 Eclipse ADT / AndEngine。
原 Java 源码、资源与工程配置保留在根目录，Web 版本不依赖 Android 工具链。

## 许可

沿用仓库现有 [LICENSE](LICENSE)。第三方来源及许可见 [第三方声明](web/THIRD_PARTY_NOTICES.md)。
