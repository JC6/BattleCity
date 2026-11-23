# 英文 Switch 版对照

目标是《南梦宫博物馆档案 Vol. 2》中的《坦克大战》。Web 与 Android TV 使用同一份卡带和同一套 C++ 菜单。下文分别标明直接观察 Switch、用红白机固定输入复验和仍需实机测量的项目。

| 项目 | 本次结果 | 复核方式 |
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


## 成品复验

[三组画面并排对照](../../build/battlecity/Switch-Comparison.html) 包含 Switch 录像取样、上版成品和本次成品。标题用 WebKit 成品截图，GAME OVER 用原生 MAME 运行同一基地失守输入。每行取七排笔画，以 4×4 原生像素为一个单元，比较有无砖纹。该指标只衡量轮廓。[分字统计与原样本摘要](../../build/battlecity/Switch-Lettering.csv)

[音频频谱结果](../../build/battlecity/Switch-Opening-Audio.csv) 使用从上传影片 5:18 开始的片段，以及原生 MAME 运行本作开场用例生成的 WAV。把 WAV 和片段放在本地后可重复测量。

```sh
python3 tests/nes/compare_switch_audio.py switch-5m18.mp4 opening.wav --switch-start 25 --game-start 6
```

标题录像缩至 320×180 后，砖字上缘在片段第 9.20 秒为 y=156，第 12.00 秒为 y=44。换算到 224 行游戏可见区，约为每秒 60 行，本作按每个 NES 显示帧上移一行。该段有人按键，无法测出无人演示的等待时间。

在 30 fps 通关录像中，完整的 GAME OVER 字样连续可见 56 个采集帧，约 1.87 秒。本作基地失守用例的完整字样连续可见 117 个 NES 显示帧，约 1.95 秒。两段可见时长约差 0.08 秒。录像经过剪辑，且没有同步按键记录，这项保留为观察差异。[Switch 结局画面](https://www.youtube.com/watch?v=Xf02flMP7dc&t=2613s) · [逐帧事件用例](../../tests/nes/ending.lua)

本次卡带 SHA-256 为 `3d4b221f7ccd1cab5312221efe6b0d520d5bd12e0cbb55cb6d32a4103affdfe2`。Web ZIP 和 Android TV ARM64 APK 均已核对内置卡带。[双手柄电视任务](https://github.com/JC6/BattleCity/actions/runs/45188419656/job/137740349705) · [Web 成品任务](https://github.com/JC6/BattleCity/actions/runs/45188419656/job/137740349635)
