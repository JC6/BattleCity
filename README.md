# BattleCity

坦克大战（BattleCity），复刻 1985 年 NAMCO 红白机《Battle City》，提供 Android 与 Web 实现。支持单人、同机双人合作和 Construction 地图编辑，包含 35 个关卡，原生画面为 256×240 像素。

开发需要 Node.js 24。

## Android

Android 适配和验收范围为 Android 14（API 34）的 Leanback TV，使用手柄操作。较新版本的 TV 可安装，兼容性由实际设备验证。`minSdk`、`compileSdk` 和 `targetSdk` 均为 34。

另需 JDK 17、Python 3 和 Android SDK Platform 34；设置 `JAVA_HOME`、`ANDROID_HOME`，确保 `node`、`python3` 在 PATH 中可用。仓库根目录执行：

```sh
bash ./gradlew assembleDebug
```

APK 位于 `build/outputs/apk/debug/BattleCity-debug.apk`。配置见 [build.gradle](build.gradle)。

## Web

仓库根目录执行：

```sh
cd web
npm ci
npm run dev
```

打开终端显示的地址。在 `web` 目录执行 `npm run build`，产物位于 `web/dist/`。

## 操作

Android 手柄在系统设置中连接后，各按 START 加入 1P、2P；双人模式由 1P 确认开始。Switch Pro 或左右合用的一对 Joy-Con 各算一套。遥控器用于菜单和暂停操作。

| 操作 | Android 手柄 | Web 键盘 |
|---|---|---|
| 移动 | 方向键或左摇杆 | 1P：WASD；2P：方向键 |
| A / B（射击、绘制） | A / B，Switch 手柄按实体印字 | 1P：J / K；2P：N / M |
| START（确认、暂停） | ＋ / START | Enter |
| SELECT（切换模式） | − / SELECT | 右 Shift |

标题演出中按 START / SELECT 回菜单。选关用 1P 的 A 加关、B 减关，START 开始。每次按下 A / B 射击一次。

失焦或切后台会暂停，按 START 继续；Android 手柄断开也会暂停，需参战手柄全部在线才能继续。暂停或切页后需松开按键、摇杆回中。Android 系统返回打开退出确认，A 确认当前选项，B 取消。

Construction 中再次点按 A / B 换块，按住并移动连续绘制，START 保存并回菜单。草稿替换新局首图，GAME OVER 后清空。成绩和草稿保留在当前运行会话中。

按[原版程序](https://github.com/cyneprepou4uk/NES-Games-Disassembly/blob/df2c8e55e7f13e5792482527db9e7c9e4a84c6e1/Battle%20City/bank_FF.asm)的出生、受击和计分规则，第 4、11、18 辆敌车携带道具，白红闪烁与耐久独立。装甲车包括红色闪烁装甲车均需命中四次；首击掉落一次道具，第四击才计击杀和 400 分，三星子弹也逐次扣除耐久。手雷直接消灭已出生的敌车，不触发其道具或击杀分；拾取手雷本身仍得 500 分。两端成绩均为七位十进制，超过 9,999,999 后回绕，首次 20,000 分奖励仅触发一次。

## 常亮与屏保

对局进行中和正常编辑时允许常亮；手动暂停、断连暂停、选关、标题与自动演示、确认对话框、失焦和后台立即释放常亮，让系统按设置进入屏保。开始或手动恢复交互后，10 分钟无有效输入也会释放常亮；新的有效输入可重新启用。持续按住已就绪的按键或方向视为操作，中立摇杆噪声、死区内漂移和画面刷新不会续期。取消对话框或切回应用仍保持原有暂停状态。

## 验收

Android 在仓库根目录执行：

```sh
python3 -m unittest discover -s tests/ci -v
bash ./gradlew assembleDebug testDebugUnitTest lintDebug assembleDebugAndroidTest &&
BUILD_STATUS=success python3 tools/check-android-results.py --local
```

报告位于 `build/reports/android-acceptance.md`，JVM 验收至少 173 项，自动验收见 [Android CI](.github/workflows/android.yml)。

Android CI 使用 API 34 官方 TV 镜像（`android-tv`、`x86`、`tv_4k`）。验收至少 46 项设备用例，失败、错误、跳过和应用 ANR 均为零，并要求成功采集 logcat。脚本预检实际 API、ABI、Leanback 特征、3840×2160 物理显示和 1920×1080 有效显示。

[AOSP TV 设置了 UI 宽度上限](https://android.googlesource.com/device/google/atv/+/d0325a2098ba9691efd4c268d64cb391d94a9b02/overlay/TvFrameworkOverlay/res/values/config.xml)。GL 像素用例单独校验 1920×1080 应用窗口，确认游戏 Surface 以 256×240 的正整数倍显示且位于窗口内。CI 通过 `-gpu swiftshader` 指定渲染后端，报告校验实际 renderer 并拒绝 ANGLE。各轮的 `diagnostics/emulator-api-34/<轮次>/` 保存模拟器版本、镜像 revision 和 ADB 启动记录。设备指纹、启动快照和测试 logcat 位于 `diagnostics/api-34/<轮次>/`。每个 job 为自己的模拟器和 ADB server 生成共享认证密钥。

当前应用及 AndEngine JAR 不含原生 `.so`，保持单 APK 且不限制 ABI；ARMv7 电视仍需满足 API 34 最低系统要求。x86 模拟器回归不代表已完成 ARM 电视的真机验证。

一次 Android CI 构建生成一对 APK，自动运行生产基线和关闭 VBO 的诊断轮。构建与设备测试使用同一 Android 用户目录，Gradle 通过增量构建复用编译和打包输出。每轮独立冷启动，在测试前后核对两份 APK 的 SHA-256，并将 Gradle 输出保存到该轮的 `gradle-device.txt`。关闭 VBO 由设备测试 APK 在首帧前配置，清理时注销回调。在模拟器内手动排查可使用 `BATTLECITY_TV_VBO_MODE=disabled bash tools/run-android-device-tests.sh 34`。

原生 GL 像素测试在首帧后记录实际 VBO 状态、引擎选项和 GL renderer/version。设备日志里的 AndEngine renderer/version 可用于像素用例未产出时的环境对照，正式验收仍要求原生像素证据。报告汇总 `glGenBuffers` 与主线程等待 GL 退出同时出现的看门狗样本，并标注是否观察到 AndEngine VBO 上传。

如果生产基线复现 VBO 上传阻塞及应用 ANR，且首轮诊断通过，CI 自动复验两次。复验要求模拟器 build、镜像 revision、设备指纹和应用内 GL renderer/version 一致。每轮最多执行设备测试 20 分钟，失败或证据不匹配时停止剩余复验。诊断三轮均通过才将关闭 VBO 列为 API 34、4K 真机验证候选，正式 CI 结果仍由生产基线和共同的构建验收决定。一次工作流上传一个归档，保留总报告和各轮独立的测试报告及日志。

三个新纪录自动返回场景使用 30 秒等待预算：手柄断开重连、编辑器与选关返回链路、START 跳过 Game Over。测试 APK 的进度观察器每 250ms 更新缓存，每秒最多输出一次 `BATTLECITY_PRESENTATION_PROGRESS` 日志，记录展示阶段、`elapsed`、观察到的更新帧数、暂停与运行状态、最近推进时间，以及前台、焦点和销毁状态。超时和看门狗直接读取缓存并标注样本年龄，不等待 UI 或引擎锁；清理后停止采样。报告优先展示断言超时当时的快照，证据不足时保留“原因未确认”；不会据此自动放宽超时或判定软件渲染慢。

日常构建和 CI 默认关闭引擎诊断；设备测试 APK 内的独立看门狗每 250ms 检查主线程心跳，连续 2 秒和 4 秒未响应时分别保留线程栈、测试名称及执行阶段，每次阻塞最多两份，恢复后重新计时。看门狗不获取引擎锁，清理后停止，输出随现有 logcat 诊断进入报告；测试等待超时也会保留线程栈。需要详细生命周期、引擎启停调用栈和帧计数时，手动运行 Android CI 并勾选 `engine_diagnostics`。在模拟器内运行测试脚本时也可设置 `BATTLECITY_ENGINE_DIAGNOSTICS=true`；测试在 Activity 启动前读取参数，清理结束后复位开关，非可调试构建始终关闭诊断。

Web 在 Linux / WSL 的 `web` 目录执行：

```sh
npx playwright install --with-deps chromium webkit
npm run validate:desktop
```

已有浏览器依赖时可跳过安装。报告位于 `web/playwright-report/`。[Web CI](.github/workflows/pages.yml) 在推送 `master` 且检查通过后部署 GitHub Pages。

## 许可

见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
