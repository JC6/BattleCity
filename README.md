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

四个方向已各取两次英文 Switch 发射。48 帧中有 46 帧与正式卡带的炮弹轮廓逐格吻合，另两帧各多一个阈值敏感的边缘像素。玩家坦克向上、向左时仍有一格炮口偏移。一版绘制试验修正了偏移，但改变了三个结局事件的模拟时间，正式包继续沿用已验收版本。打包与 CI 现逐行核对五条结局的全部 830 个事件。[四向逐帧对照及结局报告](build/battlecity/switch-parity-review/Switch-TV-Comparison.html) · [原始测量包](build/battlecity/switch-parity-review/Switch-TV-Measurements.zip) · [可复现的取样](tests/nes/fixtures/switch-shells/README.md)

本地交付的 ARM64 正式版和候选版均沿用了上一版本的签名证书。已核对包名、版本号和所有非签名条目的 SHA-256，两个 APK 的应用内容分别与本轮云端构建一致。Web、两个 x86 APK、卡带、调试标签、离线报告和原始测量包均与云端清单逐字节相同。[Android TV 正式版](build/battlecity/BattleCity-TV.apk) · [Web](build/battlecity/BattleCity-Web.zip) · [离线报告](build/battlecity/Switch-TV-Comparison.html) · [原始测量包](build/battlecity/Switch-TV-Measurements.zip) · [本地校验清单](build/battlecity/SHA256SUMS) · [CI 原包清单](build/battlecity/45915496575/SHA256SUMS) · [云端 APK 签名核验](https://github.com/JC6/BattleCity/actions/runs/45917105691)

Android TV 正式包使用 SDL。1080p x86 电视模拟器在同一 1195×960 窗口交替进行三轮测试。缓存复制实测 44.38–44.83 帧/秒，直接清屏为 44.62–44.71 帧/秒，低于 59.498 帧/秒的实时门槛。六个窗口提交的 8,038 帧都有系统显示回执。四阶段截图逐像素一致，均验证了移动方块旧位置的复原。以上为模拟器纯色画面测量。实体 ARM64 电视实战帧率仍待测。[本轮验收](https://github.com/JC6/BattleCity/actions/runs/45915496575)

Chromium 与 WebKit 使用本轮交付的 Web 包，在原生调度、60 Hz 和 120 Hz 下各测三次。18 个窗口的游戏速度为实时的 99.959%–100.045%，系统 PCM 为 99.923%–100.077%。两种浏览器均成功恢复上一版带写保护的双人存档。[本轮验收](https://github.com/JC6/BattleCity/actions/runs/45915496575)

Save 边框的试验在另一位作者的 Switch 录像上出现退步，交付版恢复了原边框。Web 与 Android TV 的 84 项锚点和留验比较、16 项相邻菜单焦点比较全部通过。五条结局合计 830 个事件，两端记录逐字节相同。[录像与测量方法](runtime/cartridge/switch-comparison.md) · [试验版验收](https://github.com/JC6/BattleCity/actions/runs/45913081159)

终局计分画面增加了 3 个 NES 帧。零击毁和十击毁的固定输入均测得从 TOTAL 数字出现到 GAME OVER 为 2.379 秒。五段英文 Switch 录像为 2.367–2.417 秒。Web 与 Android TV 支持从上一张卡带复制已有存档、预览和写保护。[英文 Switch 对照](runtime/cartridge/switch-comparison.md)

Web 和 Android TV 使用同一张卡带。Chromium 与 WebKit 的 18 个游戏和音频计时窗口均通过。两个浏览器和电视默认版均从上一版恢复了带缩略图和写保护的双人存档。35 关单关回放和 70 关连续战役均通过。英文 Switch 屏摄确认了双人第 18 关刷新纪录和第 42 关保留旧纪录两条结局。第 18 关记录了 178 个结局事件，第 42 关记录了 161 个。每个事件在 Web 与默认电视版的帧号和值都相同。[双人录像与采样方法](runtime/cartridge/switch-comparison.md)

空存档槽徽标和画面设置图标按英文 Switch 录像校准。Web 与 Android TV 均使用原生 720p 和 1080p 截图。以下数值是与主参考轮廓的像素交并比。72 项锚点与留验比较均达到各自的重复截图误差门槛。[离线验收报告](build/stage-validation/tv-swap/ci/45840031317/validated-delivery/Switch-TV-Comparison.html) · [逐帧记录和截图](build/stage-validation/tv-swap/ci/45840031317/validated-delivery/Switch-TV-Measurements.zip)

| 平台 | 输出 | 空存档槽 | 画面设置图标 |
| --- | --- | --- | --- |
| Web | 720p | 84.47% → 88.58% | 84.20% → 87.38% |
| Web | 1080p | 88.55% → 90.67% | 82.56% → 85.79% |
| Android TV | 720p | 84.51% → 88.58% | 84.20% → 87.38% |
| Android TV | 1080p | 88.67% → 89.83% | 82.45% → 85.73% |

Chromium 和 WebKit 的 18 个计时窗口中，游戏速度为实时的 99.982%–100.018%，系统 PCM 为 99.947%–100.050%。两种浏览器均通过键盘、存档保护、重新载入和从上一版升级的验收。[双平台验收](https://github.com/JC6/BattleCity/actions/runs/45840031317) · [独立键盘复测](https://github.com/JC6/BattleCity/actions/runs/45844855487)

Android TV 默认使用 SDL 软件渲染。API 34 的 x86 电视模拟器对 1195×960 的 EGL 窗口进行了 18 次测量，整帧复制后分别执行普通交换和 KHR 变化矩形交换。三种场景的系统回执匹配数与提交数为 23,262/23,262。带提示的 9,311 次交换中，9,308 次只提交局部矩形。六组移动方块截图均验证旧位置复原。[离线验收报告](build/stage-validation/tv-swap/ci/45840031317/validated-delivery/Switch-TV-Comparison.html) · [逐帧记录和截图](build/stage-validation/tv-swap/ci/45840031317/validated-delivery/Switch-TV-Measurements.zip)

普通战斗中，普通交换和变化矩形交换的实际显示帧率中位数分别为 41.86 和 41.81 帧/秒。带提示的普通战斗与连续爆炸的游戏速度中位数分别为 69.57%、70.67%，系统 PCM 分别为 68.96%、70.42%。候选路径未达到晋级所需的 99%–101% 实时门槛。实体 ARM64 电视的速度与端到端延迟仍待测量。[双平台验收](https://github.com/JC6/BattleCity/actions/runs/45840031317)

此前根目录交付的两个 ARM64 安装包沿用该版的本地签名，可覆盖升级。本地校验清单列出重新签名后的 SHA-256。离线 HTML 直接嵌入电视原始截图，本地与 GitHub 独立生成的 HTML 和测量 ZIP 均逐字节相同。[四包签名核验](https://github.com/JC6/BattleCity/actions/runs/45846472783) · [报告独立复建](https://github.com/JC6/BattleCity/actions/runs/45906402534)

上一轮在 1080p Android TV 模拟器对同一候选 APK 做了两次独立冷启动。全分辨率窗口缓冲的游戏速度为实时的 59.76%–60.86%，系统 PCM 输出为 59.63%–60.82%，共 0/6 个窗口同时达到实时与逐帧提交门槛。系统放大的 256×240 小缓冲测得游戏速度 99.76%–99.96%。上一轮每次启动均对八个场景核对 NES 帧、2 KiB RAM、57,344 个原生像素中心、壁纸和全图重复截图误差。该轮 Android TV 默认使用 SDL 软件渲染，这条路径在同一模拟器上的游戏速度为实时的 44.29%–56.82%。旧版双人存档、缩略图与写保护已通过覆盖安装和恢复测试。[上轮验收与原始记录](https://github.com/JC6/BattleCity/actions/runs/45394628713)

[Android TV 默认安装包](build/battlecity/BattleCity-TV.apk) · [Android TV EGL 候选包](build/battlecity/BattleCity-TV-Candidate.apk) · [Web 成品](build/battlecity/BattleCity-Web.zip) · [SHA-256](build/battlecity/SHA256SUMS)

此前已校准出生闪光、护盾与四向炮弹，修正了 Web 在低刷新率下变慢和连续回退后时间线出错的问题。可在离线报告中逐帧对照 Switch 录像、播放两份结束音乐，并查看每次实时时钟测量。[Web 成品](build/battlecity/BattleCity-Web.zip) · [Android TV ARM64 安装包](build/battlecity/BattleCity-TV.apk) · [离线对照报告](build/battlecity/Switch-Runtime-Comparison.html) · [SHA-256](build/battlecity/SHA256SUMS)

此前的卡带验收从第一关连续打过 70 关并回到第一关，274,114 次战斗更新逐次匹配红白机记录。35 场单人和 1 场双人独立回放共 179,466 次更新，无人演示另核对了 3,203 次更新。Chromium 和 WebKit 通过键盘、双人和重启读档测试。两次独立构建的 36 个 30 秒窗口中，游戏与音频速度全部落在实时的 ±1% 内。[卡带与跨平台构建](https://github.com/JC6/BattleCity/actions/runs/45337356115) · [70 关 CSV](build/battlecity/Campaign-Runtime-Loop.csv) · [原始测量](build/battlecity/Switch-Runtime-Measurements.zip)

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
