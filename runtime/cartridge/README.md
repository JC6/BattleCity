# Battle City 复刻验收记录

对照目标为 Nintendo Switch 英文合集《NAMCO MUSEUM ARCHIVES Volume 2》内的 Battle City。卡带使用 C 和 6502 汇编，构建脚本将项目的像素图、字体和图块转换成 NES 图形数据，35 张地图与出敌顺序取自仓库关卡表。卡带采用 iNES mapper 0、32 KiB PRG、8 KiB CHR 和两个 NES 手柄端口。Web 与 Android TV 封装使用同一卡带和 MAME 修订版。[任天堂 Switch 商店](https://www.nintendo.com/en-gb/Games/Nintendo-Switch-download-software/NAMCO-MUSEUM-ARCHIVES-Volume-2-1800373.html) · [关卡数据](../../web/src/data/original.ts) · [项目署名](../../THIRD_PARTY_NOTICES.md)

本轮核验了出生闪光、护盾、四个方向的炮弹、基地失守后的三条结局及核心连续回退。离线报告包含逐帧对照、两段可播放的结束音乐和实际输出的时钟数据。[本轮详细记录](switch-comparison.md) · [离线报告](../../build/battlecity/Switch-Runtime-Comparison.html)

## 玩家操作

| 场景 | Web 键盘 | Android TV 手柄 |
| --- | --- | --- |
| 标题 | 右 Shift 切换单人、双人、Construction，Enter 确认 | Select 切换，Start 确认 |
| 选关 | J 加一关，K 减一关，Enter 开始 | A / B 切换，Start 开始 |
| 对局 | 1P 用 WASD 和 J / K，2P 用方向键和 N / M，Enter 暂停 | 两支手柄各控制一辆车，方向移动，A / B 开火，Start 暂停 |
| Construction | 1P 移动，点按 J / K 绘制和轮换地形，按住并移动连续绘制，Enter 回标题 | 方向移动，A / B 绘制，Start 回标题 |
| 四槽存档、读档与显示设置 | Esc 打开菜单 | 左肩键打开菜单 |
| 直接回退 | R | 右肩键 |

Construction 提供 14 种图块组合。退出编辑后选择单人或双人，草稿用于开局首图。每张标准地图有 20 辆敌车。第 36 至 70 关循环使用前 35 张地图及第 35 关的出敌编成。双人通关时，尚未出局且击破数严格领先的一方获得 1,000 分，平局双方都没有奖励。基地失守或耗尽残机后会显示结算与 GAME OVER。若本局分数打破开机以来的纪录，还会显示变色砖字 HISCORE 并播放三声部音乐。Web 存档写入当前站点的 IndexedDB，Android TV 存档写入应用私有目录。

## 对照证据

| 参考 | 用于核对 | 仍需实测 |
| --- | --- | --- |
| [任天堂 Switch 第一关原图，1280×720](https://www.nintendo.com/eu/media/images/06_screenshots/games_5/nintendo_switch_download_software_2/nswitchds_namcomuseumarchivesvolume2/NSwitchDS_NamcoMuseumArchivesVolume2_01.jpg) | 可见第一关砖墙布局、中央钢墙、底部基地、灰色边框，以及右栏的双列敌车图标、残机数和关卡旗帜。Web 与 Android TV 按该图设置约占屏高 83% 的 4:3 窗口、红色水平光带以及上下各 8 行的裁切。 | 这张图只对应一关中的一个瞬间。已据此校准砖墙、钢墙、基地、履带及右栏图块。其他关卡与动画仍缺逐帧画面。 |
| [任天堂 Switch 官方预告片，约 00:06–00:07](https://assets.nintendo.eu/video/private/f_auto,q_auto/bndb9thgongqseldnoqo.mp4) | 约 00:06 的合集预览清晰展示上下两行砖字标题、左侧坦克游标、三项菜单与最高分。00:07 左右能看到第一关演示。在 00:06.25 可辨认菜单下方的 `namcot` 和 `©1985 BNEI`。卡带已按这一帧调整署名、位置与游标。 | 预览位于合集选游戏画面的小窗口中，无法测量按键延迟或完整音轨。 |
| [任天堂 Wii U VC《Battle City》官方说明书](https://www.nintendo.co.jp/data/software/manual/man_FCTJ_00.pdf) | 第 2 至 8 节说明单人、双人、选关、友军定身、特殊敌人、六种道具、三级武器及编辑器，是核对基础游戏规则的资料。 | Switch 版的输入延迟、随机数、移动和出弹的帧数，以及音乐和音效时序。 |
| [万代南梦宫合集介绍](https://www.bandainamcoent.com/games/namco-museum-archives-vol-2) | 标明收录游戏及合集的存档与回退功能。两端提供共用的游戏菜单。 | 菜单布局、过渡、回退间隔与 Switch 的逐项一致性。 |
| [万代南梦宫日版 Switch 合集功能说明](https://nc.bn-ent.net/product/useful.php) | 官方说明列出每款游戏四个存档点和独立回退键。画面设置示意图给出 4:3、放大、方形像素和全屏四档。 | 英文版录像也显示存档预览、日期和锁定标记。两端共用这组存档功能。英文显示菜单里的抗锯齿及扫描线均可独立开关。 |

红白机版的声音和敌车行为另有程序级对照。敌车在关卡初期随机选择方向，中段按槽位追击玩家，后段转向基地。普通敌车交替移动，高速车逐次移动。撞墙后会等待或掉头。开火独立于移动，每辆可行动的敌车每次更新都有一次低五位为零的判定，同时只能保有一发在途炮弹。闪烁敌车掉落道具时，八个等权位置中星星与手雷各占两个，其余四种各占一个。该参考仓库热度低于 2,000 stars，采用它是因为能定位转向、掉落和音频的具体程序指令。它仅用于研究，构建与运行均不需要下载。[固定修订的 Battle City 程序](https://github.com/cyneprepou4uk/NES-Games-Disassembly/tree/df2c8e55e7f13e5792482527db9e7c9e4a84c6e1/Battle%20City)

卡带在每个 NES 垂直消隐期更新两个方波声道、三角波声道和噪声声道。测试逐个触发全部 27 条有效音轨，按视频帧、声道、寄存器及写入值计算摘要，与独立译码的红白机记录比对。开场的三个声部覆盖到第 266 帧，两个引擎循环各观察 601 帧。实际对局另测开场时浏览器输出的 PCM 波形。游戏结束音乐为 109 帧，最高分演出为 461 帧。[音轨表](../../web/src/platform/audio-cues.ts) · [独立寄存器基准](../../web/tests/platform/audio-driver.test.ts) · [卡带回归脚本](../../tests/nes/audio.lua)

在 1280×720 的成品浏览器截图中实测到，第一关黑色战场左右边界为 x=292、937，上下边界为 y=83、636，和任天堂原图相同。测量使用零起点像素坐标。

同一张任天堂原图也提供了固定地形的颜色基准。左侧灰框矩形从 (248, 70) 起，宽 36、高 560，20,160 个像素均为 RGB (98, 98, 98)。对左下砖墙和中央钢墙按材质采样，砖面、砖缝阴影和钢墙中灰的 RGB 中位数分别为 (147, 64, 0)、(93, 0, 0) 和 (165, 165, 165)。Web 与 Android TV 的共用 NES 显示核心据此调整四项颜色。浏览器用例在最终截图中核对这四种颜色。[取样结果](../../build/battlecity/Switch-Colors.csv) · [显示核心校准](../nes-palette.patch) · [成品截图检查](../../tests/nes/browser-game.cjs)

两端共用一张独立生成的背景图，包含暖灰色渐变、红色光带和四条细线。以 1280×720 官方图为对照，从坐标 (2, 2) 开始每 3 像素取样，排除 x 为 240 至 1039、y 为 58 至 661 的游戏区域。48,348 个背景像素的 RGB 通道平均绝对误差从 15.24 降到 4.62，通道范围为 0 至 255。[共用背景](../android/src/main/res/drawable-nodpi/battle_surround.jpg)

GetNavi 的 Switch 日版实机挑战还提供了第 33 和 35 关的战局截图。按每关 26×26 个小格对照地图，第 33 关的 108 格树林全部可见且位置一致。第 35 关的 96 格水面及 111 格树林可见且位置一致，第 112 格树林被星星道具遮挡。照片拍摄于战斗中，只将可辨认的水面和树林用于这一项验收。[拍摄者的原文与录像](https://getnavi.jp/entertainment/534122/) · [截图复核程序](../../tests/nes/verify_switch_fields.py) · [逐项结果](../../build/battlecity/Switch-Late-Stages.csv)

1920×1080 的 Web 视口沿用相同的裁切比例。[第一关 720p](../../build/battlecity/Stage-1.png) · [第一关 1080p](../../build/battlecity/Stage-1-1080.png)

当前版本直接进入 Battle City。标题与 GAME OVER 已核对 1,008 个砖字单元，HISCORE 和录像中可读的五种数字另核对 672 个单元。显示设置使用固定的射击场景，片尾保留英文合集署名。菜单图标、预览场景和字形均为重绘，回退跨度、整机混音及物理电视输入延迟仍缺直接测量。[英文 Switch 对照及可复算数据](switch-comparison.md)

## 第一关开场帧数

同一台原生 MAME 0.285 分别运行调整前的卡带、红白机参考程序和当前卡带。以确认第一关时的显示帧为 0。脚本在同一个显示帧送入相同的按键边沿，持续按上并交替点按 A / B，分别记录首次实际移位与首次产生炮弹。幕布一项观察屏幕像素，生成、可行动和出敌三项监听 CPU 事件。红白机参考程序 SHA-1 为 `e1061c9241b06a965fb7845cb951d921aca010ef`。Switch 商店截图用于核对可见布局，以下时序的实测来源是红白机程序。[开场测量脚本](../../tests/nes/opening.lua)

| 从确认第一关起计 | 调整前单人 | 参考单人 | 当前单人 | 调整前双人 | 参考双人 | 当前双人 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 幕布从中央可见地打开 | 无此过场 | 81 | 81 | 无此过场 | 81 | 81 |
| 玩家进入出生状态 | 8¹ | 94 | 94 | 8¹ | 94 | 94 |
| 第一辆敌车生成 | 33 | 97 | 97 | 34 | 97 | 97 |
| 玩家状态允许行动 | 8¹ | 133 | 133 | 8¹ | 133 | 133 |
| 第一发玩家炮弹 | 41 | 134 | 134 | 44 | 134 | 134 |
| 玩家首次向上移位 | 29 | 135 | 135 | 29 | 135 | 135 |
| 第二辆敌车生成 | 423 | 284 | 284 | 443 | 264 | 264 |
| 第三辆敌车生成 | 874 | 471 | 471 | 841 | 431 | 431 |

¹ 调整前直接把玩家设为可行动，开场画面准备完毕后才处理移动。当前版的两辆玩家坦克在双人模式均于第 94 帧进入出生状态、第 133 帧可操作。单人前三辆敌车依次使用内部槽位 5、4、3，双人使用 7、6、5。出生点均按中央、右、左轮换，战场内横坐标分别为 96、192、0 像素。

上述三辆敌车在单人模式对应第 1、188、375 次战斗更新，双人模式为第 1、168、335 次。显示帧包含选关和幕布时间，也能体现旧版运算跨越一个垂直消隐周期时造成的延迟。对照图分别取自首辆敌车生成后 13 次更新和战斗第 45 次更新的原生 NES 输出。[开场前后对照图](../../build/battlecity/Opening-Comparison.png) · [开场原始计帧表](../../build/battlecity/Opening-Timeline.csv)

## 第一关战斗轨迹

同一组脚本分别驱动红白机参考程序、上一版卡带和当前卡带。从第一关确认时起，按显示帧送入两支手柄的输入。每次战斗更新结束后记录显示帧、各活动敌车的槽位、位置和朝向，以及在途炮弹的槽位、位置、方向和生灭事件。一次更新之内发射又撞墙的炮弹也会留下两个事件。三组自然对局只发送手柄输入。[输入和采样脚本](../../tests/nes/combat.lua) · [红白机基准](../../tests/nes/fixtures/combat) · [三版本逐次对照 CSV](../../build/battlecity/Combat-Trajectories.csv)

| 第一关输入 | 更新次数 | 上一版与参考有差异的更新 | 当前版与参考有差异的更新 |
| --- | ---: | ---: | ---: |
| 单人静止 | 600 | 523 | 0 |
| 单人移动并开火 | 600 | 532 | 0 |
| 双人分别移动并开火 | 600 | 534 | 0 |

三组场景中，首辆敌车均在第 59 次更新首次移动，第 99 次更新首次开火，分别对应确认后的第 156 和 196 个显示帧。上一版在第 58 和第 73 次更新发生这两个事件。当前版按槽位轮换处理移动，另行判定开火，炮弹从炮口生成，命中后仍按爆炸时序占用发射槽。随机数逐次混合计时、输入、坦克、炮弹和音轨等运行状态。

CSV 每行是一组输入的一次更新。列后缀 `reference`、`previous`、`current` 分别代表红白机参考、上一版与当前卡带。实体之间用点号分隔，每个实体的六位编码依次为一位槽号、两位横坐标、两位纵坐标及一位方向，均为十六进制。方向 0、1、2、3 对应上、右、下、左，事件中的加号表示发射，减号表示停止飞行。

另用受控命中场景固定道具抽取的起始状态。八个种子覆盖六类道具及完整八项掉落表，各消耗三次随机抽取。第九组中玩家占据首选落点，前三组候选坐标均被拒绝，道具最终落在场内坐标 (24, 168)，共消耗九次抽取。每组同时比较道具类型、横纵坐标和抽取次数。[九组参考结果](../../tests/nes/fixtures/combat/drops.csv)

## 标题、完整第一关与关末

无人按键冷启动时，红白机参考在第 266 个显示帧进入标题选择，第 854 帧准备演示，第 881 帧开始更新演示战场。现在标题会上卷，空闲时进入双车演示。按 Start 或 Select 可以回到标题并开始自己的游戏。运行下方的 `verify_match.py` 并指定 `--traces` 后，`attract-natural.csv` 会记录第一次标题游标出现、演示准备、首次战斗更新、开始返回标题和游标再次可用的显示帧。表中还记录战斗更新总数、两行砖字各自的初始砖块数，以及演示结束时被摧毁的砖块数。[演示验收](../../tests/nes/attract.lua)

四组受控输入从最后一发命中前开始。表中为相对于发射的显示帧，双人样例由击破数领先而且存活的玩家获得 1,000 分。计分逐辆进行，同一类型每 9 帧发出一次计分音。基地被击中和两人都耗尽残机是两种独立的结束条件。[参考事件](../../tests/nes/fixtures/ending) · [实测事件表](../../build/battlecity/Ending-Timeline.csv) · [同帧对照图](../../build/battlecity/Match-Comparison.png)

| 场景 | 进入计分 | 第一次计分音 | 后续事件 |
| --- | ---: | ---: | --- |
| 单人击毁末敌 | 175 | 215 | 第 658 帧进入下一关流程 |
| 双人击毁末敌 | 175 | 217 | 第 486 帧发放奖励，第 606 帧进入下一关流程 |
| 基地失守 | 296 | 336 | 第 770 帧进入 GAME OVER，第 892 帧回标题 |
| 最后残机阵亡 | 288 | 328 | 第 762 帧进入 GAME OVER，第 884 帧回标题 |

完整对局从冷启动开始。每个显示帧只送入事先保存的两支手柄按键。每次战斗更新比对显示帧、活动坦克和飞行炮弹、玩家残机、升级、护盾、分数、四类击破数、剩余敌车、基地状态，以及 676 个地形单元的摘要。终点另行比对。单人参考在第一关击毁全部 20 辆敌车，得到 2,700 分，以一条命在第 5,473 帧进入第二关。双人参考经历两名玩家分别阵亡和重生，最终各得 200 和 700 分，第 3,898 帧回到标题。[两组固定输入与参考轨迹](../../tests/nes/fixtures/campaign) · [三版本逐次对照](../../build/battlecity/Campaign-Comparison.csv)

单人 4,358 次、双人 2,891 次战斗更新及两场终点全部一致。上一版单人录像在第 388 次更新首次出现炮弹差异，双人录像在第 261 次更新首次出现显示帧差异。计分中途和跨关前各保存一次，再从存档施加同样的输入，分别核对随后 90 帧的画面和实体状态。

35 张地图的 5,915 个地块、140 组出敌数量及 700 个按顺序出场的敌车类型另行核对。空组保留在四组编成的原位置。测试分别解码红白机程序和编译后的自制卡带，逐关比较 SHA-256。[独立解码器](../../tests/nes/catalogue.py) · [逐关摘要](../../tests/nes/fixtures/catalogue.csv)

在仓库根目录运行以下命令，可以复验关卡数据、无人演示、四个关末场景的无按键、点按与长按 Start，以及两场完整对局。参考数据已随测试提供。加上 `--traces 目录` 可保存本次实测结果。

```sh
python3 tests/nes/verify_match.py build/battlecity/game.nes
```

## 构建与复验

本次选用的核心项目均超过 2,000 stars。2026-11-21 经 GitHub 官方 API 核对，MAME 为 10,734、cc65 为 2,714、Emscripten 为 27,789、SDL 为 17,042、Gradle 为 18,936、Playwright 为 100,713。Android SDK / NDK 随官方平台工具链使用。[MAME](https://github.com/mamedev/mame) · [cc65](https://github.com/cc65/cc65) · [Emscripten](https://github.com/emscripten-core/emscripten) · [SDL](https://github.com/libsdl-org/SDL) · [Gradle](https://github.com/gradle/gradle) · [Playwright](https://github.com/microsoft/playwright)

安装 Python 3 和 cc65 后，可在仓库根目录构建卡带和测试所需的符号表。

```sh
python3 runtime/cartridge/build.py build/battlecity/game.nes --labels build/battlecity/game.lbl
```

**原生 MAME 0.285**。运行下列命令前先准备一个可写的临时目录。测试会创建即时存档。脚本检查双手柄输入、编辑草稿、选关、射击、暂停，以及存档恢复后 90 帧实际双人输入的逐像素回放，同时比较全部坦克、炮弹记录与随机数状态。35 关的测试在每关设置剩最后一辆敌车的场景，经实际弹道、命中和结算逻辑进入下一关，最后用炮弹命中基地结束游戏。定向用例覆盖 4 像素砖墙分层破坏、六种道具的拾取效果、中后段目标切换、撞墙等待、非移动帧开火以及冻结期间的行动。出生点用例覆盖地形清除、玩家与敌车重叠后离开、爆炸占用槽位、旧炮弹继续飞行、阵亡扣命及重生保护。设置环境变量 `BATTLECITY_LIVE_CHECK=1` 后重复执行，会从标题开始，通过两个手柄在标准第一关移动与开火，直到击毁自然出生的敌车并计分。

```sh
repo="$PWD"
work=$(mktemp -d)
(cd "$work" && BATTLECITY_LABELS="$repo/build/battlecity/game.lbl" SDL_VIDEODRIVER=dummy \
  mame nes -cart "$repo/build/battlecity/game.nes" -video none -sound none -skip_gameinfo \
  -nothrottle -seconds_to_run 800 -autoboot_delay 0 -autoboot_script "$repo/tests/nes/game.lua") >"$work/result.log" 2>&1
grep -Fx BATTLECITY_GAME_OK "$work/result.log"
```

同一 MAME 可直接运行音频回归。脚本读取独立基准并监听实际 NES 声音寄存器。

```sh
(cd "$work" && BATTLECITY_LABELS="$repo/build/battlecity/game.lbl" \
  BATTLECITY_GOLDENS="$repo/web/tests/platform/audio-driver.test.ts" SDL_VIDEODRIVER=dummy \
  mame nes -cart "$repo/build/battlecity/game.nes" -video none -sound none -skip_gameinfo \
  -nothrottle -seconds_to_run 120 -autoboot_delay 0 -autoboot_script "$repo/tests/nes/audio.lua") >"$work/audio.log" 2>&1
grep -F 'BATTLECITY_AUDIO_OK 27 full APU register traces' "$work/audio.log"
```

第一关开场的回归从标题开始，以手柄输入进入单人或双人，记录每个事件的视频帧与战斗更新序号。同一脚本还逐格读取 PPU，核对第一关战场的全部 676 个 8×8 图块与第一辆敌车出生后右栏剩余的 19 个图标。下列命令分别复验两种人数。

```sh
for players in 1 2; do
  (cd "$work" && BATTLECITY_LABELS="$repo/build/battlecity/game.lbl" BATTLECITY_PLAYERS="$players" \
    SDL_VIDEODRIVER=dummy mame nes -cart "$repo/build/battlecity/game.nes" -video none -sound none \
    -nothrottle -skip_gameinfo -seconds_to_run 30 -autoboot_delay 0 \
    -autoboot_script "$repo/tests/nes/opening.lua") >"$work/opening-$players.log" 2>&1
  grep -Fx BATTLECITY_OPENING_OK "$work/opening-$players.log" || exit 1
done
```

战斗轨迹可直接与仓库里的固定 CSV 逐行比对。若需要重新采集参考，以同一脚本运行上文 SHA-1 对应的红白机程序，设置 `BATTLECITY_CLASSIC=1`，以 `BATTLECITY_TRACE` 指定输出文件。

```sh
for scenario in idle solo coop drops; do
  (cd "$work" && BATTLECITY_LABELS="$repo/build/battlecity/game.lbl" BATTLECITY_SCENARIO="$scenario" \
    BATTLECITY_GOLDENS="$repo/tests/nes/fixtures/combat/$scenario.csv" SDL_VIDEODRIVER=dummy \
    mame nes -cart "$repo/build/battlecity/game.nes" -video none -sound none -nothrottle \
    -skip_gameinfo -seconds_to_run 36 -autoboot_delay 0 -autoboot_script "$repo/tests/nes/combat.lua") \
    >"$work/combat-$scenario.log" 2>&1
  grep -Fx BATTLECITY_COMBAT_OK "$work/combat-$scenario.log" || exit 1
done
```

**Web**。按[构建说明](../README.md)生成站点，安装 web 目录中的 Playwright 依赖及 Chromium、WebKit。启动 HTTP 服务后在另一终端执行第二条命令。键盘用例通过成品入口操作游戏，只读观察卡带状态。Chromium 还在成品 WebAssembly 内运行标题、开场、战斗、关末和完整对局脚本。自动回放按 MAME 的仿真帧计数，直接读取 NES 画面和 APU 寄存器。键盘验收采用浏览器正常显示和 Web Audio 输出。

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory build/mame-runtime/web/site
node tests/nes/browser-game.cjs http://127.0.0.1:8765/
```

要单独复验 Chromium 内的卡带用例，可指定符号表、浏览器名和测试名，将末尾的 `opening` 换成 `attract`、`combat`、`ending`、`campaign`、`game` 或 `audio` 即可复验相应部分。

```sh
node tests/nes/browser-game.cjs http://127.0.0.1:8765/ build/mame-runtime/web/game.lbl chromium opening
```

**Android TV**。电视安装包面向 Android TV 14+ ARM64，另构建 x86 版用于官方 API 34 电视模拟器。每个包都要核对 v2 签名、原生库 ABI 和卡带摘要。设备测试通过两支独立的虚拟手柄操作已安装的 APK，记录屏幕、回退后的移动、重新启动后的读档及 PCM。运行需要已经完成启动并可通过 ADB 连接的电视模拟器。[设备测试](../../tests/nes/television.py)

```sh
python3 tests/nes/television.py BattleCity-AVD.apk game.lbl build/tv-result
```

## 全关场景与自然录像

战场测试逐关从标题选关，读取 NES 显存。35 关共核对 23,660 个地形图块、右栏的 700 个敌车图标位置和开场出生点。另有从标题画面开始、只记录手柄输入的 35 份单人通关录像和 1 份双人第一关通关录像。36 份输入已在参考程序中逐一回放，合计 179,466 次战斗更新。测试逐次比较坦克、炮弹、地形、基地、敌车余数、玩家残机、武器、护盾与得分，并跟踪结算后下一关的前 90 次战斗更新。参考程序经过 SHA-1 校验，仓库只包含输入与观测结果。[关卡测试](../../tests/nes/verify_stages.py) · [关卡对照数据](../../tests/nes/fixtures/stages)

```sh
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite field
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite battle --report single-player.csv
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite battle --players 2 --stages 1 --report two-player.csv
```

CSV 记录卡带 SHA-256、关卡、人数、参考更新总数、是否通过，以及首次不同的更新序号和字段。脚本比较到下一关的第 90 次战斗更新。提前结束或采样有差异都会使测试失败。

## 当前验证范围

整轮回放从开机开始，仅向手柄端口发送按键。玩家依次打过第 1 至 70 关，回到第 1 关后继续 90 次战斗更新。对红白机参考程序与复刻卡带分别执行 6502 指令，记录到的 274,114 次更新全部匹配，包括显示帧号、坦克与炮弹的位置和方向、残机、武器、防护、得分、击破数、基地与地形。最后一次更新位于显示帧 316,277，得分 409,600。未压缩观测记录的 SHA-256 为 `8336186c7e44314be205aef3812e8d8aa34e786dbd90825796048a57f2a06ea7`。原生 MAME 0.285 分别从开机回放红白机参考程序和从源码重建的复刻卡带，两者全部 274,114 次更新通过。第 316,188 帧从第 70 关回到第 1 关。[双程序核对报告](../../build/battlecity/Campaign-Reference.csv) · [原生 MAME 运行记录](https://github.com/JC6/BattleCity/actions/runs/45192497635/job/137754917074) · [控制器录像](../../tests/nes/fixtures/stages/loop.pads.gz) · [逐次更新基准](../../tests/nes/fixtures/stages/loop.csv.gz) · [逐关 CPU 对照](../../build/battlecity/Loop-CPU.csv)

```sh
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite loop --report loop.csv
```

35 份单人参考录像覆盖 175,335 次更新，另有一份双人第一关录像覆盖 4,131 次更新。各场分别从开机开始，便于在不运行整轮的情况下复现某一关的问题。五组原生 MAME 任务都已通过，每场都核对至下一关的前 90 次更新。下列本地 CSV 附有每组的远端任务链接。[逐场回放报告](../../build/battlecity/Stage-Replays.csv) · [开局显存报告](../../build/battlecity/Stage-Fields.csv)

空闲演示的首帧为 881。红白机和复刻程序都在第 4,083 帧离开演示，在第 4,327 帧重新接受标题选择。3,203 次战斗更新均已逐次核对，覆盖两辆玩家坦克、敌车、炮弹、时钟、演示手柄输入和 10,060 次随机取值。BATTLE 和 CITY 分别由 143 和 84 块可破坏的 4×4 像素砖组成，演示结束时共减少 176 块。[完整演示对照](../../tests/nes/fixtures/stages/attract.csv.gz) · [计帧及砖块验证](../../tests/nes/attract.lua)

```sh
python3 tests/nes/verify_stages.py build/battlecity/game.nes --suite attract --report attract.csv
```

Switch 英文实机录像可核对系统菜单的 Save、Load、四个横排存档槽、Settings 和 Game Reset。已有存档有日期及画面预览，锁定槽位可防止误覆盖。Screen Settings 显示 4:3、Zoom、Dot-by-Dot、Full Screen。两端按 16:9 展开系统菜单，退出时恢复游戏原有的显示比例。壁纸页显示四种预览图。Controller Settings 在 Web 上显示双人键盘，在电视上可打开系统蓝牙配对。Staff Credits 按英文 Switch 画面滚动显示制作名单。写入空槽和覆盖旧存档都需确认。Return to Main Menu 经确认后回到本作标题，取消系统菜单即可续玩。[实机片尾](https://www.youtube.com/watch?v=S26lUv598_o&t=4309s) · [菜单、署名和音频对照](switch-comparison.md)

较高播放量的录像显示了本作在合集中的入口，另一段在《坦克大战》结束后直接打开了系统菜单，可看清每个槽位。[任天堂产品页](https://www.nintendo.com/us/store/products/namco-museum-archives-vol-2-switch/) · [合集入口与战场，约 3 分钟](https://www.youtube.com/watch?v=uc_If5fksfA&t=180s) · [本作系统菜单，约 11 分钟](https://www.youtube.com/watch?v=S26lUv598_o&t=659s) · [显示和壁纸选项，约 1 分钟](https://www.youtube.com/watch?v=S26lUv598_o&t=65s)

Android TV 已在 Android SDK 的 API 34 电视镜像上通过验收。两支独立的内核手柄分别移动和开火，右肩键回退，第二支断开重连后继续控制玩家二。两辆坦克的位置、双人模式与暂停状态在进程重启读档后恢复。测试还覆盖了存档写保护和游戏音频，并保存了 48 kHz PCM 录音及屏幕截图。从系统桌面返回后，游戏保留了同一进程、暂停状态和两辆坦克的位置。恢复后的战场以及第一槽的缩略图均已在电视截屏中核对。首次双人游玩请先连接两支手柄，再打开游戏。[电视任务和原始附件](https://github.com/JC6/BattleCity/actions/runs/45192497635) · [设备验收工作流](../../.github/workflows/mame-runtime.yml)

Switch 录像没有同步手柄输入。输入到画面的延迟、回退的精确跨度、逐帧音画同步以及实体电视的手柄与音响表现仍待实机测量。

最终 Web 包在 Chromium 和 WebKit 均已通过键盘测试，覆盖 720p 与 1080p、单人和双人、选关、Construction、系统菜单、回退、存档保护以及刷新后的读档。[键盘端到端测试](../../tests/nes/browser-game.cjs)

两端按内置卡带的 SHA-256 隔离即时存档。Web 使用 IndexedDB，Android 使用应用私有目录。每个版本的四个存档槽都在该版本的目录下。
