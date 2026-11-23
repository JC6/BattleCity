# 坦克大战 · Battle City

项目复刻 Nintendo Switch 英文《南梦宫博物馆档案 Vol. 2》收录的《坦克大战》。从入口直接启动《坦克大战》，支持 Web 键盘和 Android TV 手柄。

Web 与 Android TV 共用一张由 cc65 编译的 NES 卡带，运行在同一版本的 MAME NES 核心上。游戏包含单人、同机双人、35 张地图和 Construction 编辑器。开场、引擎、射击和爆炸由卡带的四个 NES 声道播放。本版本的还原进度、官方参考和测试结果见[复刻验收记录](runtime/cartridge/README.md)。

| 目标 | 从仓库根目录构建 | 产物 |
| --- | --- | --- |
| Web | `bash tools/build-mame-runtime.sh web` | `build/mame-runtime/web/battlecity-web.zip` |
| Android TV（ARM64、Android 14 及以上） | `bash tools/build-mame-runtime.sh android` | `runtime/android/build/outputs/apk/debug/BattleCityRuntime-debug.apk` |
| NES 卡带 | `python3 runtime/cartridge/build.py build/battlecity/game.nes` | `build/battlecity/game.nes` |

Web 解压后通过 HTTP 打开，按 Enter 启动。标题滚动时可按 Enter 跳过，坦克游标出现后按 Enter 选择单人。在选关画面按 J 或 K 切换关卡，Enter 开战，WASD 移动，J 或 K 开火。按右 Shift 可在标题画面切换双人或地图编辑。击毁本关最后一辆敌车后自动计分并进入下一关。工具链、存档、回退和完整双人键位见[运行说明](runtime/README.md)。

## 复验

红白机参考程序与复刻卡带从开机连续打过 70 关并回到第一关，274,114 次战斗更新逐次匹配。另有 35 场单人和 1 场双人录像，合计核对 179,466 次更新。Web 通过 Chromium 和 WebKit 键盘测试，Android TV 通过 API 34 电视镜像上的双手柄、热重连和重启读档测试。[验收记录](runtime/cartridge/README.md) · [电视截图和录音](https://github.com/JC6/BattleCity/actions/runs/45106009654)

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
