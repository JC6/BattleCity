# 参考来源

## 固定反汇编版本

[Battle City / bank_FF.asm](https://github.com/cyneprepou4uk/NES-Games-Disassembly/blob/df2c8e55e7f13e5792482527db9e7c9e4a84c6e1/Battle%20City/bank_FF.asm) 固定版本为 `df2c8e55e7f13e5792482527db9e7c9e4a84c6e1`，文件 SHA-256 为 `372dcd0e10a7f7d2244bd271f98539d186ff4faae51eb08d8ce23b3619193721`。

| 内容 | 地址与用途 |
|---|---|
| 音轨及暂停乐句 | ED36–EF74、EE2C–EE39；对应 [audio-cues](../src/platform/audio-cues.ts) |
| 声音驱动 | D439 调用，EA7E–ECAC 执行；槽位优先级与先写寄存器再解码见 [apu-driver](../src/platform/apu-driver.ts) |
| 手雷与携带者道具 | EA17–EA3D：手雷不生成道具；E7D1–E7E0 调用 E8BE：子弹命中携带者触发掉落；E393–E3A7：第 4、11、18 辆敌人出场清除旧道具 |

## 其他资料与证据缺口

| 内容 | 来源及边界 |
|---|---|
| 四通道 APU | [NESdev APU](https://www.nesdev.org/wiki/APU)；采集日期与修订号待补，模拟滤波为近似 |
| Worklet 模块缓存 | [HTML Standard](https://html.spec.whatwg.org/multipage/webappapis.html#fetch-a-worklet-script-graph) 的 module responses map；用于解释失败后更换 Context，来源为动态页面 |
| 像素轮廓与颜色 | [pixel-assets](../src/game/pixel-assets.ts) 记载来自处理过的 NES 录像；RGB 近似，原始链接、版本、逐帧定位及审计报告待补 |
| 计分时序 | [score-timeline](../src/game/score-timeline.ts) 记录候选录像的帧数；原视频链接和片段时间戳待补 |
| 35 张地图与敌人队列 | [original](../src/data/original.ts) / [levels](../src/data/levels.ts)；原始数据来源、版本与逐关对照待补 |
| 基地附近清理 | `levels.ts` 记载第 10 关 644.0s、第 21 关 1332.5s；对应录像身份和审计报告待补 |
| 游戏规则常量 | [rules](../src/core/rules.ts)；逐常量的外部来源索引待补 |

[像素 golden](../tests/game/fixtures/native-golden.json) 和测试提供实现回归证据，不能代替原作资料。补充来源应记录 URL、版本或采集时间、哈希、定位及支持的具体规则；大体积录像和采样使用外部归档或验收产物。许可及来源声明见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
