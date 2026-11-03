# BattleCity

坦克大战（BattleCity），复刻 1985 年 NAMCO 红白机《Battle City》，提供 Android 与 Web 实现。支持单人、同机双人合作和 Construction 地图编辑，包含 35 个关卡，原生画面为 256×240 像素。

开发需要 Node.js 24。

## Android

运行要求 Android 14（API 34）及以上的 Leanback 环境，使用手柄操作。

另需 JDK 17、Python 3 和 Android SDK Platform 37.2；设置 `JAVA_HOME`、`ANDROID_HOME`，确保 `node`、`python3` 在 PATH 中可用。仓库根目录执行：

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

## 常亮与屏保

对局进行中和正常编辑时允许常亮；手动暂停、断连暂停、选关、标题与自动演示、确认对话框、失焦和后台立即释放常亮，让系统按设置进入屏保。开始或手动恢复交互后，10 分钟无有效输入也会释放常亮；新的有效输入可重新启用。持续按住已就绪的按键或方向视为操作，中立摇杆噪声、死区内漂移和画面刷新不会续期。取消对话框或切回应用仍保持原有暂停状态。

## 验收

Android 在仓库根目录执行：

```sh
python3 -m unittest discover -s tests/ci -v
bash ./gradlew assembleDebug testDebugUnitTest lintDebug assembleDebugAndroidTest &&
BUILD_STATUS=success python3 tools/check-android-results.py --local
```

报告位于 `build/reports/android-acceptance.md`，自动验收见 [Android CI](.github/workflows/android.yml)。

Android CI 使用两条设备通道，每条要求至少 46 项用例通过，失败、错误和跳过均为零：API 34 Android TV（`android-tv`、`x86`、`tv_1080p`）覆盖最低支持版本的电视环境；API 37.2 手机（`google_apis_ps16k`、`x86_64`、`pixel_2`）覆盖新系统和 16 KB 页大小。脚本预检实际 API、ABI、Leanback 特征和手机页大小，保留独立报告；手机通道会预先确认系统全屏引导。

当前应用及 AndEngine JAR 不含原生 `.so`，保持单 APK 且不限制 ABI；ARMv7 电视仍需满足 API 34 最低系统要求。x86 模拟器回归不代表已完成 ARM 电视的真机验证。

日常构建和 CI 默认关闭引擎诊断；设备测试 APK 内的独立看门狗每 250ms 检查主线程心跳，连续 2 秒和 4 秒未响应时分别保留线程栈、测试名称及执行阶段，每次阻塞最多两份，恢复后重新计时。看门狗不获取引擎锁，清理后停止，输出随现有 logcat 诊断进入报告；测试等待超时也会保留线程栈。需要详细生命周期、引擎启停调用栈和帧计数时，手动运行 Android CI 并勾选 `engine_diagnostics`。在模拟器内运行测试脚本时也可设置 `BATTLECITY_ENGINE_DIAGNOSTICS=true`；测试在 Activity 启动前读取参数，清理结束后复位开关，非可调试构建始终关闭诊断。

Web 在 Linux / WSL 的 `web` 目录执行：

```sh
npx playwright install --with-deps chromium webkit
npm run validate:desktop
```

已有浏览器依赖时可跳过安装。报告位于 `web/playwright-report/`。[Web CI](.github/workflows/pages.yml) 在推送 `master` 且检查通过后部署 GitHub Pages。

## 许可

见 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。
