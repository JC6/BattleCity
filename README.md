# 坦克大战 · Battle City

项目复刻 Nintendo Switch 英文《南梦宫博物馆档案 Vol. 2》收录的《坦克大战》。从入口直接启动《坦克大战》，支持 Web 键盘和 Android TV 手柄。

Web 与 Android TV 共用一张由 cc65 编译的 NES 卡带，运行在同一版本的 MAME NES 核心上。游戏包含单人、同机双人、35 张地图和 Construction 编辑器。开场、引擎、射击和爆炸由卡带的四个 NES 声道播放。本版本的还原进度、官方参考和测试结果见[复刻验收记录](runtime/cartridge/README.md)和[英文 Switch 画面对照](runtime/cartridge/switch-comparison.md)。

| 目标 | 从仓库根目录构建 | 产物 |
| --- | --- | --- |
| Web | `bash tools/build-mame-runtime.sh web` | `build/mame-runtime/web/battlecity-web.zip` |
| Android TV（ARM64、Android 14 及以上） | `bash tools/build-mame-runtime.sh android` | `runtime/android/build/outputs/apk/debug/BattleCityRuntime-debug.apk` |
| NES 卡带 | `python3 runtime/cartridge/build.py build/battlecity/game.nes` | `build/battlecity/game.nes` |

Web 解压后通过 HTTP 打开，按 Enter 启动。标题滚动时可按 Enter 跳过，坦克游标出现后按 Enter 选择单人。在选关画面按 J 或 K 切换关卡，Enter 开战，WASD 移动，J 或 K 开火。按右 Shift 可在标题画面切换双人或地图编辑。击毁本关最后一辆敌车后自动计分并进入下一关。工具链、存档、回退和完整双人键位见[运行说明](runtime/README.md)。

## 复验

终局计分画面增加了 3 个 NES 帧。零击毁和十击毁的固定输入均测得从 TOTAL 数字出现到 GAME OVER 为 2.379 秒。五段英文 Switch 录像为 2.367–2.417 秒。Web 与 Android TV 支持从上一张卡带复制已有存档、预览和写保护。[英文 Switch 对照](runtime/cartridge/switch-comparison.md)

电视原生窗口的初次试验中，普通战斗和连续爆炸分别达到实时的 57.01% 和 56.60%，锁定缓冲区占约 24 毫秒／帧。候选版改为整块写入窗口，并在窗口尺寸变化时重新提交。验收会分别测量两种负载，全部通过才进行两次冷启动和八场景逐像素比对。[第一次测量](https://github.com/JC6/BattleCity/actions/runs/45417789873) · [后续验收记录](https://github.com/JC6/BattleCity/actions/workflows/pages.yml?query=branch%3Avalidation%2Fswitch-parity-native-window-20261124-final)

上一轮在 1080p Android TV 模拟器对同一候选 APK 做了两次独立冷启动。全分辨率窗口缓冲的游戏速度为实时的 59.76%–60.86%，系统 PCM 输出为 59.63%–60.82%，共 0/6 个窗口同时达到实时与逐帧提交门槛。系统放大的 256×240 小缓冲测得游戏速度 99.76%–99.96%。每次启动均对八个场景核对 NES 帧、2 KiB RAM、57,344 个原生像素中心、壁纸和全图重复截图误差。该轮 Android TV 默认使用 SDL 软件渲染，这条路径在同一模拟器上的游戏速度为实时的 44.29%–56.82%。旧版双人存档、缩略图与写保护已通过覆盖安装和恢复测试。[离线报告](build/battlecity/Switch-TV-Comparison.html) · [原始记录](build/battlecity/Switch-TV-Measurements.zip) · [同提交验收](https://github.com/JC6/BattleCity/actions/runs/45394628713)

[Android TV 默认安装包](build/battlecity/BattleCity-TV.apk) · [Android TV 窗口缓冲候选版](build/battlecity/BattleCity-TV-Candidate.apk) · [Web 成品](build/battlecity/BattleCity-Web.zip) · [SHA-256](build/battlecity/SHA256SUMS)

此前已校准出生闪光、护盾与四向炮弹，修正了 Web 在低刷新率下变慢和连续回退后时间线出错的问题。可在离线报告中逐帧对照 Switch 录像、播放两份结束音乐，并查看每次实时时钟测量。[Web 成品](build/battlecity/BattleCity-Web.zip) · [Android TV ARM64 安装包](build/battlecity/BattleCity-TV.apk) · [离线对照报告](build/battlecity/Switch-Runtime-Comparison.html) · [SHA-256](build/battlecity/SHA256SUMS)

本轮卡带从第一关连续打过 70 关并回到第一关，274,114 次战斗更新逐次匹配红白机记录。35 场单人和 1 场双人独立回放共 179,466 次更新，无人演示另核对了 3,203 次更新。Chromium 和 WebKit 通过键盘、双人和重启读档测试。两次独立构建的 36 个 30 秒窗口中，游戏与音频速度全部落在实时的 ±1% 内。[卡带与跨平台构建](https://github.com/JC6/BattleCity/actions/runs/45337356115) · [70 关 CSV](build/battlecity/Campaign-Runtime-Loop.csv) · [原始测量](build/battlecity/Switch-Runtime-Measurements.zip)

Android TV API 34 的 1080p 模拟器已通过双手柄独立开火、二号手柄重连、重启读档和返回前台。连续两次回退分别恢复到模拟时钟第 10 秒和第 9 秒，两次的 2,048 字节工作 RAM 均与原检查点相同。1080p 模拟器的同机速度为完整绘制 0.557–0.566 倍、自动跳帧试验 0.975–0.981 倍。成品保留完整绘制。[电视双手柄任务](https://github.com/JC6/BattleCity/actions/runs/45333482160/job/138239902571) · [集成 APK 三条结局复验](https://github.com/JC6/BattleCity/actions/runs/45341282725/job/138265269210)

在已安装 cc65 和 MAME 0.285 的 Linux 环境中，以下命令从同一张卡带复验战场图块、敌车编成和固定手柄输入。原生测试按第一次出现差异的战斗更新报告关卡、字段、期望值和实测值。

```sh
python3 runtime/cartridge/build.py build/battlecity/game.nes --labels build/battlecity/game.lbl
python3 tests/nes/catalogue.py build/battlecity/game.nes --labels build/battlecity/game.lbl
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite field
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite battle
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite battle --players 2 --stages 1
```

GitHub Actions 为 Web、ARM64 电视和 x86 电视模拟器构建同一份卡带。Pages 在回放、浏览器和电视设备检查都通过后部署。具体步骤见[复刻版工作流](.github/workflows/mame-runtime.yml)和[Pages 工作流](.github/workflows/pages.yml)。

## 操作

| 操作 | Web 键盘 | Android TV 手柄 |
| --- | --- | --- |
| 移动 | 1P 用 WASD，2P 用方向键 | 各自手柄的方向键 |
| 射击或绘制 | 1P 用 J / K，2P 用 N / M | A / B |
| 选择模式、开始或暂停 | 右 Shift 切换模式，Enter 确认 | Select 切换模式，Start 确认 |
| 存档、读档和显示设置 | Esc | 左肩键 |
| 直接回退 | R | 右肩键 |

System Menu 提供四个横排存档槽。左右选择槽位，已用槽位显示日期和画面预览，覆盖时可取消。在槽位上按 Delete 或手柄西侧面键可切换写保护。Web 在同一浏览器和站点下保留存档，Android TV 存在应用私有目录。在 Settings 里打开 Screen Settings，可以选择 4:3、Zoom、Dot-by-Dot 和 Full Screen，也可切换抗锯齿与扫描线。

## 许可

见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
