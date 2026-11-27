# 英文 Switch 的炮弹与炮口

原片取自英文《Namco Museum Archives Vol. 2》的《Battle City》。下载切片从原片第 318 秒开始，视频 SHA-256 为 `53da1aa22185034240566726ec4173691df1115c3c106a1996facf7b3f8630a0`。同一作者的八次发射各取六个连续采集帧，分辨率为 1280×720。保留每次发射的原始局部截图，以及采用既有 208×208 战场标定、最近邻降采样的六帧 PNG。每份六帧 PNG 从左向右依时间排列。[Switch 实录](https://www.youtube.com/watch?v=S26lUv598_o&t=350s)

运行 `python3 tests/nes/switch_shell_capture.py build/battlecity/game.nes /tmp/bc-shells` 可通过已收录的 PNG 复测。使用 `--video battle.mp4 --fixture DIR --oam tests/nes/fixtures/switch-shells/accepted-oam.txt` 可将原始视频重新采样至单独目录。脚本检查原文件摘要和逐帧显示时间。主阈值取 RGB 最暗分量大于 60、最亮与最暗分量之差小于 26，50 和 70 用于观察边缘像素对阈值的敏感程度。PNG 中的像素颜色经过原作者的采集和视频编码。帧 1081 和 1084 在主阈值下各多一个边缘像素。

正式卡带 SHA-256 为 `1537e0332a916dfea21627c56ad354fcefbd73e6439092436c86c194b25a842f`。`accepted-oam.txt` 和 `accepted-barrels.txt` 取自这张卡带在已交付 Web 核心中的实际运行。前者记录精灵编号、翻转、调色板和位置。后者读取玩家、普通敌车车身四块精灵的像素，以及卡带开火例程写入的初始坐标。此后新卡带需要使用相同脚本在该版本上取样。[弹体采样](../../shells.lua) · [炮口采样](../../shell_barrels.lua)

炮口试验基于同一正式卡带源码，试验卡带 SHA-256 为 `ef7908a7f9c436eb40659f3a6b62bc6ac43c65d552d16a147c69261985938beb`。补丁可在单独检出目录使用 `git apply tests/nes/fixtures/switch-shells/barrel-trial.patch` 复现。用同一版 cc65 构建，两版的调试标签逐字节相同。两张卡带分别在同一版已交付 Web 核心运行相同的中性结局输入。正式版的 179 个事件与归档完全吻合，试验版的事件依次保留在 `trial-neutral.csv`。原模拟时钟由核心记录，单位为秒。第 3、4、5 个事件仍在相同显示帧，模拟时间分别变化 1.12、1.12、107.27 微秒。试验卡带未进入交付包。
