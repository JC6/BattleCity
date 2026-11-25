# 英文 Switch 版对照

目标是《南梦宫博物馆档案 Vol. 2》中的《坦克大战》。Web 与 Android TV 使用同一份卡带和同一套 C++ 菜单。下文分别标明直接观察 Switch、用红白机固定输入复验和仍需实机测量的项目。

## 2026-11-24 战场动画、时钟与回退

本轮卡带 SHA-256 为 `72259aab96d617eb7c9feeba91ee9426c4d80e7d3b51b86edf204fecf6789741`。浏览器按实际经过的时间推进游戏。在回到前台、读档或回退时重设时钟。连续回退在核心处理存读档的边界执行，逐次比较战场的全部 2,048 字节工作 RAM。[离线对照报告](../../build/battlecity/Switch-Runtime-Comparison.html) · [时钟测量](../../tests/nes/browser-clock.cjs) · [回退核对](../../tests/nes/rewind-state.lua)

| 项目 | 实测 |
| --- | --- |
| 出生动画 | 对照 Switch 第一关两个独立出生点的四种轮廓。八张 16×16 图共 2,048 个像素，轮廓错格从 228 降至 0。 |
| 护盾与履带 | 含车身遮挡的连续两帧，护盾白色区域的交并比分别从 0.000、0.288 提升到 0.661、0.674。右向玩家坦克轮廓与任天堂截图相符，履带的两个姿态另与移动实录并排展示。 |
| 炮弹与爆炸 | Switch 向上炮弹连续六个取样均为 3×4、10 个可见像素。方向、灰色和相对中心的偏移另在原生核心读取四向 OAM 并解码图块检查。两个大爆炸阶段亮部的交并比为 0.831、0.913。 |
| 结束音乐 | 将同一场基地失守后的卡带录音与 Switch 录音对齐，1.48 秒乐段的平均频谱余弦相似度为 0.824。首段和最后变音段在 5 毫秒搜索步长下给出相同起点。每窗去除直流分量，以峰值 1.2% 判断安静，尾音分别为 1.58 和 1.63 秒。 |
| GAME OVER | 自然结束及进入最高分时完整字样可见 117 个模拟帧，本次固定 Start 输入得到 36 帧。三条路径从同一个基地中弹状态起步，同时记录逐帧事件和 PCM。 |

同机 Chromium 以 30 Hz 调度时，上版在 14.96 秒内推进 450 帧，本版在 14.97 秒内推进 900 帧，模拟速度为 0.5004× 和 1.0004×。本版连续过两轮，全部 274,114 次战斗更新与固定参考输入逐次相符。[连续回放 CSV](../../build/battlecity/Campaign-Runtime-Loop.csv) · [原始测量及录音](../../build/battlecity/Switch-Runtime-Measurements.zip)

GitHub Actions 两次从源码构建并复验 Chromium、WebKit 的原生、60 Hz 和 120 Hz 调度。两次各 18 个 30 秒窗口，36 个窗口的游戏和 PCM 全部落在 ±1% 内。游戏速度合计为 0.99952–1.00046 倍，PCM 为 0.99920–1.00063 倍。三条结局的逐帧事件也与本地原生核心相符。[首轮 Web 作业](https://github.com/JC6/BattleCity/actions/runs/45327163577/job/138220921697) · [最终 Web 作业](https://github.com/JC6/BattleCity/actions/runs/45337356115/job/138252845359)

Android TV API 34 的 1080p x86 模拟器以软件图形后端运行已安装的 APK。默认设置下，三个约 30 秒窗口的模拟速度为 0.524、0.535、0.534 倍，48 kHz PCM 与模拟时钟同步。三条结局的音频指令、完整字样的帧数及返回标题的帧号均与原生核心一致。这组采样包含运行观察器及写 WAV 的开销，实体电视速度和输入延迟仍待实测。[电视计时与结局任务](https://github.com/JC6/BattleCity/actions/runs/45330116914/job/138229595879)

同一 APK 在独立验收机上通过双手柄测试。两次右肩键依次恢复到第 10 秒、第 9 秒的检查点，逐个字节核对全部 2,048 字节工作 RAM。重启后读档，两辆坦克的 Y 坐标均恢复为 186。二号手柄热重连后可继续移动。离开应用并返回，两辆坦克的 Y 坐标保持为 186 和 183。[电视双手柄任务](https://github.com/JC6/BattleCity/actions/runs/45333482160/job/138239902571)

自动跳帧试验使用同一张卡带、同一 x86 APK 和相同的第一关输入。两台运行机分别测得 0.915–0.922 倍和 0.971–0.973 倍。跳帧会减少繁忙时提交的画面，两组时钟均低于实时目标。成品保留完整画面，以上读数用于评估负载。[第一组时钟附件](https://github.com/JC6/BattleCity/actions/runs/45335900237) · [第二组时钟附件](https://github.com/JC6/BattleCity/actions/runs/45333482160)

在第三台运行机上，两种设置依次使用同一台 1080p 模拟器、同一份 APK、同一关卡输入，各测三次，每次 30 秒。默认完整绘制为 0.557–0.566 倍，自动跳帧为 0.975–0.981 倍。该机也通过了独立双手柄、连续两次回退和三条结局的测试。[配对复验及原始附件](https://github.com/JC6/BattleCity/actions/runs/45336728995/job/138250452886)

集成任务的另一台模拟器在默认设置下测得 0.372–0.375 倍。两支手柄、回退和自然结局均已通过，最高分录制在旧的 90 秒主机时限处中断。该时刻已写出 33.64 秒 PCM，最高分路径需要约 34.49 秒模拟时间。验收现按 WAV 输出是否持续增长判断停滞，并按卡带用例自身的帧数上限排除脚本未结束的情况。同一集成 APK 复验后取得三条完整的 48 kHz WAV，时长分别为 26.98、34.74、25.64 秒，关键事件逐帧通过原生核心对照。[同一 APK 结局复验](https://github.com/JC6/BattleCity/actions/runs/45341282725/job/138265269210) · [集成设备记录](https://github.com/JC6/BattleCity/actions/runs/45337356115/job/138252845209)

本地 Chromium 与 WebKit 的原生回调、标称 60 Hz 和 120 Hz 各测三次。首轮 18 个窗口中有 15 个的游戏和 PCM 同时落在 ±1% 内。报告保留 WebKit 的慢速窗口和追加采样的回调耗时。停止本项目已空闲的 Gradle 进程后，WebKit 60 Hz、120 Hz 共六个窗口的游戏和 PCM 全部回到 ±1%。这些读数描述具体主机当时的运行条件。[离线报告](../../build/battlecity/Switch-Runtime-Comparison.html) · [原始数据](../../build/battlecity/Switch-Runtime-Measurements.zip)

向上炮弹的逐格结论来自 Switch；另外三个方向的形状与定位来自红白机对照。数字 2、3、4、6、7 的最高分大字、Switch 无人演示与双人片尾、回退的原机跨度及实体电视输入延迟仍缺直接测量。参考材料使用任天堂一方截图、发行方说明及能看清相关帧的英文实录。[任天堂原图](https://www.nintendo.com/eu/media/images/06_screenshots/games_5/nintendo_switch_download_software_2/nswitchds_namcomuseumarchivesvolume2/NSwitchDS_NamcoMuseumArchivesVolume2_01.jpg) · [第一关录像](https://www.youtube.com/watch?v=S26lUv598_o&t=349s) · [回退说明](https://nc.bn-ent.net/product/useful.php)

电视验收工具将设备截图缩为 RGB 以识别光标。运行机缺少 FFmpeg 时，从 7.1.1 官方源码构建 PNG 解码器，并先用仓库图片核对输出字节数。它与原有 FFmpeg 对同一张 1080p 设备截图缩放后得到相同的 172,800 字节。[FFmpeg 官方源码](https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz) · [电视验收工作流](../../.github/workflows/mame-runtime.yml)

用同批次卡带、录音和留存的 Switch 片段可复算图像和音频。画面脚本先核验两个来源文件的 SHA-256。报告内嵌了对照图和声音，可直接离线打开。

```sh
data=build/stage-validation/switch-clock/delivery
old=build/stage-validation/switch-menu-round
video="$old/references/battle.mp4"
python3 tests/nes/switch_motion.py "$video" build/stage-validation/switch-clock/references/official.jpg \
  "$old/game.nes" "$data/game.nes" "$data/motion"
python3 tests/nes/ending_audio.py "$video" "$data/native-neutral/events.csv" "$data/native-neutral/game.wav" "$data/audio"
python3 tests/nes/runtime_report.py "$data" "$data/motion" "$data/audio" "$data/comparison.html" \
  --ci-clocks build/stage-validation/switch-clock/45337356115/web-clock-and-endings \
  --tv build/stage-validation/switch-clock/45341282725/tv-device-results \
  --tv-controls build/stage-validation/switch-clock/45333482160/tv-device-results \
  --tv-repeat build/stage-validation/switch-clock/45336728995/tv-device-results \
  --web-clock "GitHub Actions · 首轮" build/stage-validation/switch-clock/45327163577/web-clock-and-endings \
  --tv-clock "首次默认采样" build/stage-validation/switch-clock/45330116914/tv-device-results/timing/clock.jsonl \
  --tv-clock "独立自动跳帧试验" build/stage-validation/switch-clock/45335900237/tv-device-results/auto-frameskip/clock.jsonl \
  --tv-clock "集成机默认采样" build/stage-validation/switch-clock/45337356115/tv-device-results/timing/clock.jsonl
```

## 2026-11-24 菜单与画面对照基线

显示设置现在使用同一张按英文录像重绘的射击场景。按 1280×720 图像测得，四档缩略图的场景尺寸依次为 76×56、86×75、65×56、134×75。选中 Zoom 时主预览为 164×144。四档均区分当前生效项和正在浏览的光标。两端共用常规字重的菜单字库、滚动提示及圆角边框。Web 成品在 720p 与 1080p 均核验四个缩略图。在 1280×720 取样网格中，开启抗锯齿后主预览选区的 RGB 通道平均绝对变化为 2.25，随后开启扫描线为 15.47（每通道满刻度 255）。字库由固定版本 MAME 文档随附的 Lato Regular 制作，授权文本随 Web 与 APK 分发。片尾仍展示合集原版英文署名，成品可读出 Jérôme Châtelain 和末尾制作方。[片尾姓名](../../build/battlecity/Staff-Accent.png) · [末尾制作方](../../build/battlecity/Staff-Credits-Final.png)。[显示设置实拍](https://www.youtube.com/watch?v=S26lUv598_o&t=65s) · [Switch／上版／本版对照](../../build/battlecity/Switch-Comparison.html)

在 43:36 附近的通关录像可读出大字 HISCORE 及得分 185900。标题七字母的 392 格和五种不同数字的 280 格与新卡带吻合。其余五种数字沿用同一字模规则，仍缺同屏录像证明。独立的原生 MAME 测试设定失守前累计分数，随后让游戏执行失守、结算、绘制最高分和返回标题。测试读取最终显示的像素，并在两行的实测位置校验笔画。[最高分实拍](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2616s) · [卡带字模验收](../../tests/nes/switch_lettering.py) · [显示帧验收](../../tests/nes/ending.lua)

三次完整 GAME OVER 分别持续 56、54、54 个采集帧，对应 1.867、1.802、1.802 秒。后两次来自同一作者。录像的采样间隔约 33 毫秒，第一段之后出现最高分，后两段回到标题。现有基地失守用例为 117 个 NES 显示帧。由于录像缺少同步按键且结局路径有别，本轮保留原计时。无人演示的完整 Switch 固定输入、双人结局、实际回退跨度和物理电视输入延迟仍待测。[通关末段](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2613s) · [第二关结束](https://www.youtube.com/watch?v=S26lUv598_o&t=451s) · [自建地图结束](https://www.youtube.com/watch?v=S26lUv598_o&t=650s)

战斗录音取自同一段英文 Switch 无解说录像。按画面确定开炮、玩家爆炸、非零击破数的计分和结束音乐片段，在限定范围内寻找与卡带独立声道输出最接近的时间位置。四段频谱余弦分别为 0.852、0.858、0.725、0.561。最后一段的主频带差值中位数约 219 Hz，计分窗口仅 25 毫秒。这些结果保留为差异观测，游戏音轨未按混合录音重新调音。[四段逐项数据](../../build/battlecity/Switch-Event-Audio.csv) · [事件测量程序](../../tests/nes/switch_cues.py)

Web ZIP 已由 Chromium 与 WebKit 从解压目录驱动键盘验收，覆盖单人、双人、回退和重启读档，另留存 44.1 kHz 的 Web 开场 PCM。[Web 录音](../../build/battlecity/Web-Opening.wav)

Android TV API 34 的 x86 模拟器用两只独立手柄逐档确认预览，采集片尾中段与末尾制作方，并通过手柄热重连、回退、后台恢复和重启读档。重新加载后两名玩家的纵坐标均恢复到 182。附件包含 48 kHz 游戏录音。ARM64 APK 另行通过签名与内置卡带校验。本轮验收共 10 项通过，Pages 的两项发布任务按验收分支规则跳过。[电视任务](https://github.com/JC6/BattleCity/actions/runs/45310454441/job/138164751261) · [设备附件](../../build/battlecity/TV-Acceptance.zip) · [70 关连续回放 CSV](../../build/battlecity/Campaign-Loop.csv)

该基线卡带 SHA-256 为 `b76693002049acbe2a972abe0d5ee71c1b4a409306606bc1116553a70310a41f`。标题和 GAME OVER 原有的 1,008 格继续通过。每个卡带摘要使用各自的存档目录。下方命令使用本轮留存的录像片段、卡带音轨和成品截图离线复算，报告会校验录像文件摘要。要重新录制独立音效，可用 MAME 0.285，令 BATTLECITY_LABELS 指向同批次 game.lbl，以 -wavwrite 录制并通过 -autoboot_delay 0 -autoboot_script 加载 [录音脚本](../../tests/nes/record_switch_cues.lua)。

```sh
samples=build/stage-validation/switch-menu-round
python3 tests/nes/switch_cues.py "$samples/references/battle.mp4" "$samples/reference-cues.wav" > "$samples/Switch-Event-Audio.csv"
python3 tests/nes/switch_report.py "$samples/references" "$samples/previous" "$samples/chromium" \
  build/battlecity/Switch-Comparison.html --commit 8162e98 --audio "$samples/Switch-Event-Audio.csv" \
  --web-wav "$samples/Web-Opening.wav" --tv "$samples/television"
```

## 2026-11-23 基线

| 项目 | 上轮结果 | 复核方式 |
| --- | --- | --- |
| 系统菜单与保存 | 按 16:9 画面重画按钮、四角光标、四槽日期栏和锁标志。选中空槽后先弹窗，确认才写入。写保护、取消覆盖及重启读档有独立测试。 | [系统菜单和确认对话框，10:52 起](https://www.youtube.com/watch?v=S26lUv598_o&t=652s) |
| 显示设置 | 主预览位于上方正中，四个小预览横排。亮色边框标记生效的模式，四角标记当前光标。Switch 的预览是另一款游戏，独立版用暂停时的《坦克大战》画面。 | [实拍设置页，1:05 起](https://www.youtube.com/watch?v=S26lUv598_o&t=65s) |
| Staff Credits | 按画面转录 879 行标题、职务、姓名及末尾制作方。居中黑底上滚，片头为蓝字，最后的制作方文字停在正中。两档移动速度约为每秒 80、640 个 720p 参考像素，独立版按住向下加速。录像未显示操作者按下的键。 | [英文实机完整片尾，1:11:49 起](https://www.youtube.com/watch?v=S26lUv598_o&t=4309s) · [逐行文本](../staff-roll.inc) |
| 标题与 GAME OVER | 逐个 4×4 笔画单元对照实拍。BATTLE、CITY、GAME、OVER 的 1,008 格从 619 格吻合提高到全部吻合。CITY 的半图块横移和 OVER 的半图块纵移已修正。标题录像从下向上卷动，稳定后显示 ©1985 BNEI。 | [标题，5:31](https://www.youtube.com/watch?v=S26lUv598_o&t=331s) · [结束画面，43:34](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2614s) · [卡带验收](../../tests/nes/switch_lettering.py) |
| 第一关战场 | 已按任天堂 1280×720 原图对齐边界、砖墙、钢墙和灰框颜色。较高播放量的英文录像用于确认合集入口及战场。 | [任天堂原图](https://www.nintendo.com/eu/media/images/06_screenshots/games_5/nintendo_switch_download_software_2/nswitchds_namcomuseumarchivesvolume2/NSwitchDS_NamcoMuseumArchivesVolume2_01.jpg) · [Xupgeeks，约 3:00](https://www.youtube.com/watch?v=uc_If5fksfA&t=180s) |
| 开场声音 | 对齐首次可闻的开场音乐，取两个录音各自起音后 0.05 至 1.24 秒。降采样到 8 kHz 单声道，用 256 点 Hann 窗、10 ms 步长比较幅度谱。120 个窗口的平均余弦相似度为 0.956。该数字仅表示这段开场的频谱接近。 | [对照录像，约 5:48](https://www.youtube.com/watch?v=S26lUv598_o&t=348s) · [本作开场输入](../../tests/nes/opening.lua) · [音频测量脚本](../../tests/nes/compare_switch_audio.py) |
| 演示、通关与回退 | 另一个完整单人实拍可见最后几关的结算、回到第一关地图及之后的 GAME OVER。无人演示、35 关及第二轮结局按红白机固定输入轨迹复验。两端可回退、继续给出不同输入并恢复游戏。当前核心每个模拟秒记录一次。 | [轨迹及逐项验收](README.md) · [回退调度](../rewind-scheduler.patch) · [万代南梦宫公布的回退操作](https://nc.bn-ent.net/product/useful.php) |

取样时 Xupgeeks 的录像约 1.86 万次观看，My Gameplay Videos 的录像约 872 次。后者清晰展示了按钮、空槽对话框和完整英文片尾，这三个画面决定了该处的选源。Crolister 的 35 关通关录像约 178 次观看，能补齐前两段资料缺少的末关和结束画面。作者注明使用采集卡，在 Switch／Switch 2 上运行本合集。[单人通关末段](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2500s)

仍有可见差异。系统界面使用运行时字体，设置页图标和空槽标识为重绘，底部提示使用对应平台的按键。独立入口以及确认返回的目的地均为《坦克大战》标题。公开视频没有提供固定输入下完整的 Switch 无人演示、双人结局或回退前后逐帧状态。整机混音、绝对音画延迟、回退跨度和实体电视的输入延迟仍缺少同步测量。


## 上轮标题与开场测量

[上轮三组画面并排对照](../../build/stage-validation/switch-menu-round/previous/Title-Ending-Comparison.html) 包含 Switch 录像取样、上版成品和本次成品。标题用 WebKit 成品截图，GAME OVER 用原生 MAME 运行同一基地失守输入。每行取七排笔画，以 4×4 原生像素为一个单元，比较有无砖纹。该指标只衡量轮廓。[分字统计与原样本摘要](../../build/battlecity/Switch-Lettering.csv)

[音频频谱结果](../../build/battlecity/Switch-Opening-Audio.csv) 使用从上传影片 5:18 开始的片段，以及原生 MAME 运行本作开场用例生成的 WAV。把 WAV 和片段放在本地后可重复测量。

```sh
python3 tests/nes/compare_switch_audio.py switch-5m18.mp4 opening.wav --switch-start 25 --game-start 6
```

标题录像缩至 320×180 后，砖字上缘在片段第 9.20 秒为 y=156，第 12.00 秒为 y=44。换算到 224 行游戏可见区，约为每秒 60 行，本作按每个 NES 显示帧上移一行。该段有人按键，无法测出无人演示的等待时间。

在 30 fps 通关录像中，完整的 GAME OVER 字样连续可见 56 个采集帧，约 1.87 秒。本作基地失守用例的完整字样连续可见 117 个 NES 显示帧，约 1.95 秒。两段可见时长约差 0.08 秒。录像经过剪辑，且没有同步按键记录，这项保留为观察差异。[Switch 结局画面](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2613s) · [逐帧事件用例](../../tests/nes/ending.lua)

上轮卡带 SHA-256 为 `3d4b221f7ccd1cab5312221efe6b0d520d5bd12e0cbb55cb6d32a4103affdfe2`。Web ZIP 和 Android TV ARM64 APK 均已核对内置卡带。[双手柄电视任务](https://github.com/JC6/BattleCity/actions/runs/45192497635/job/137754917134) · [Web 成品任务](https://github.com/JC6/BattleCity/actions/runs/45192497635/job/137754917372)

在 API 34 电视模拟器上，两次截屏均识别出黑底青色的合集标题，并确认标题向上移动超过 12 个采样像素。完整附件另含手柄事件、保存确认截图、重启后双人战场及一秒 PCM 录音。[电视验收附件](../../build/battlecity/TV-Acceptance.zip)

## 弹道和结局音乐的追加实录

在英文 Switch 实录中连续跟踪向上 39 帧、向右 33 帧、向下 36 帧和向左 31 帧。每帧均有 10 个可见弹丸像素，四个方向的实录轮廓均与卡带图形一致。另取 31 帧护盾和 12 帧爆炸，按可见白色区域比较。护盾的交并比为 0.547–0.750，两种大爆炸为 0.831–0.913。可用 `tests/nes/switch_battle_samples.py` 对照同一录像片段和编译后的卡带，导出帧位置、像素差及截图。[原作者的英文实录](https://www.youtube.com/watch?v=S26lUv598_o&t=352s)

两位作者的三次结束音乐在同一阈值下，首音至静音均为 1.63 秒，当前卡带为 1.58 秒。整段频谱余弦相似度为 0.824、0.814 和 0.768。末和弦的两个脉冲声道共享约 261.4 Hz 的基频。离线表保留混音包络和频谱，供复测这个约 50 毫秒的差异。[第二次结束音乐](https://www.youtube.com/watch?v=S26lUv598_o&t=650s) · [通关录像的结束音乐](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2614s)

另有一段日语解说录像显示最高分 26800。以英文实录已确认的 HISCORE、8 和两个 0 校准，三个闪烁相位下，2 和 6 各 56 格均匹配卡带。作者标题标注 Switch，录像片段未显示可独立确认英文合集版本的系统界面。复测脚本为 `tests/nes/switch_score_sample.py`。[日语解说原片，13 分 22 秒](https://www.youtube.com/watch?v=aRGjPGSfBmk&t=802s)

Nenriki 发布的两段 Famicom 实录分别显示 196500 和 441900。本轮记录的播放量约为 171.8 万和 18.9 万。每段各验三个时刻，4 和 6 也与编译后的卡带逐格一致。[一轮录像](https://www.youtube.com/watch?v=fuMYsGiS33k&t=2283s) · [两轮录像](https://www.youtube.com/watch?v=Xww2jXpQSwQ&t=4128s)

英文 PS4 合集的 430200 和 KinjoGameChannel 的 Famicom 攻略录像（约 1.19 万次播放）中的 256700 分别补上了 3 和 7。用 HISCORE 和 0 定位后，三个采样时刻里两个数字各 56 格均与卡带匹配。英文 Switch 画面直接覆盖 0、1、5、8、9，其余五个数字按录像来源单列。可运行 `tests/nes/switch_lettering.py --secondary` 检查卡带。[PS4 合集 1:03:46](https://www.youtube.com/watch?v=LgMNFRP_LxE&t=3826s) · [Famicom 攻略 29:29](https://www.youtube.com/watch?v=mRNyb2IGjSY&t=1769s)

另找到一段能连续看到双人结局的 NES 录像。第 34 关结算显示 1P 122800 和 2P 89500，随后依次出现 GAME OVER、HISCORE 122800 和标题的双人游标。该片能交叉核对画面顺序，英文 Switch 版本的按键与帧数仍待直接测量。[双人原片 34:53](https://www.youtube.com/watch?v=mV4AnvS300Y&t=2093s)

将结算页 TOTAL 数字第一次连续可见的采集帧作为独立画面标记，三段英文 Switch 录像从该帧到结束音乐起音分别为 2.543、2.548 和 2.667 秒。本作固定输入回放为 2.314 秒。录像里三次 TOTAL 分别为 0、10、0，只有中间一次能用连续计分声再校准。录像的采集音画偏移未知。本作两个脉冲声道均在首个音符指令约 1.797 秒后执行最终静音，此时混音已低于测量阈值。现有测量无法把约 50 毫秒的可听尾音差归因到其中一个声道的静音指令。[三次起音与包络](../../build/battlecity/Switch-TV-Comparison.html)

### 结算页与音画同步

五段英文 Switch 录像中，从 TOTAL 数字稳定出现到 GAME OVER 字样首次可读，分别测得 2.402、2.367、2.402、2.417、2.400 秒。前两段来自不同作者，用于校准。其余三段用于复验，包括 Xupgeeks 的 13 击毁和 itFredda 的 17 击毁。复刻卡带的单人终局从 2.329 秒调至 2.379 秒，每段差值均小于该录像的一帧。只在失守或生命耗尽后额外等待三个垂直消隐；正常过关与双人奖励沿用原有节奏。[第二关](https://www.youtube.com/watch?v=S26lUv598_o&t=449s) · [第二轮首关](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2611s) · [十击毁](https://www.youtube.com/watch?v=S26lUv598_o&t=647s) · [Xupgeeks](https://www.youtube.com/watch?v=uc_If5fksfA&t=270s) · [itFredda](https://www.youtube.com/watch?v=hlJ4skgnFko&t=306s)

以同一音画文件里可见的最后一个击毁数和对应计分声估计采集偏移。四段可校准录像的起音残差在 −19 至 +27 毫秒之内，低于各自的单帧采集时长。首段最终计数为零，缺少这个独立音频标记。五份混音在 1.2% 峰值阈值下的尾音为 1.63–1.64 秒，当前卡带为 1.58 秒。音序与声道包络仍按当前卡带播放。[时间线测量脚本](../../tests/nes/terminal_tally.py) · [同一录音内的音画校准](../../tests/nes/terminal_av_sync.py)

另复查了三段社区上传的时间线。两个可辨认英文 Switch 界面的片段进入了单人结算，读取到的 13 和 17 属于小号 TOTAL 字体。另一段合集直播的设备与输入无法从片段确认。英文 Switch 双人完整结局、两次回退的精确跨度、无人操作演示以及 HISCORE 大数字 2、3、4、6、7，继续保留为未验证项。万代南梦宫的 Switch 资料明确列出双人同时游玩和回退功能。[官方游戏介绍](https://nc.bn-ent.net/title-lineup/title.php?tit=battle-city) · [官方回退说明](https://nc.bn-ent.net/product/useful.php)

11 月 25 日新增检查了一段作者明确标注为日版 Switch《Namcot Collection》的直播（核查时 1,218 次播放）。第 35 关按单人结算后进入下一关。约 2:02:55 可见地图编辑器的原作隐藏留言。该视频能确认日版的这两个画面，英文版隐藏留言的触发和显示仍待直接核对。[单人结算实录](https://www.youtube.com/watch?v=90hI6s_3iZ4&t=7166s) · [原作隐藏留言](https://www.youtube.com/watch?v=90hI6s_3iZ4&t=7375s)

同一段复刻无损录音按五段英文 Switch 视频各自的声道数、采样率和 AAC 码率重新编码。以 100 ms 连续低能量段作为结束点，先加 25 Hz 高通抑制直流偏置后，五组复刻录音均在起音后 1.59 秒达到阈值，Switch 录像为 1.63–1.64 秒。起音频谱相关度至少 0.996。现有测量无法把这 40–50 ms 分配给原作音源、主机混音或采集链路，卡带的音符释放时序沿用现有实现。[录音与阈值测量](../../build/battlecity/Switch-TV-Measurements.zip)
