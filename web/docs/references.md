# 参考资料与可追溯证据

本页整理仓库已记录的来源。缺失原始链接、版本或录制文件的内容明确标为待补，不把当前实现或自生成的 golden 当作独立原版证据。

| 内容 | 已记录的来源与定位 | 当前证据边界 |
|---|---|---|
| 音轨字节码 | [NES-Games-Disassembly / Battle City](https://github.com/cyneprepou4uk/NES-Games-Disassembly/tree/df2c8e55e7f13e5792482527db9e7c9e4a84c6e1/Battle%20City)，版本 `df2c8e55e7f13e5792482527db9e7c9e4a84c6e1`；`bank_FF.asm` 的 ED36–EF74 | `audio-cues.ts` 已记录 bank SHA-256：`372dcd0e10a7f7d2244bd271f98539d186ff4faae51eb08d8ce23b3619193721`；2026-10-19 重新下载源文件核对，哈希一致；同时核对暂停序列 EE2C–EE39 与声音驱动调用位置 D439 |
| 音轨执行器 | 同一反汇编版本，EA7E–ECAC；定位见 `apu-driver.ts` 注释 | 固定槽位优先级与两遍执行；驱动器寄存器测试提供实现回归证据 |
| NES 四通道 APU | [NESdev APU](https://www.nesdev.org/wiki/APU)，原有第三方声明所列资料 | 动态网页的采集日期和页面修订号待补；模拟滤波是近似，不能据此宣称逐样本等同硬件 |
| Worklet 模块失败缓存 | [HTML Standard：fetch a worklet script graph](https://html.spec.whatwg.org/multipage/webappapis.html#fetch-a-worklet-script-graph) 的 module responses map 算法 | 2026-10-15 实现复核时参考；生命周期回归验证更换 Context 后重新加载，标准是动态页面 |
| 原版像素轮廓/颜色 | `pixel-assets.ts` 记载来自裁切、缩放和压缩后的 NES 录像 | 原始视频链接、版本、逐帧定位及旧审计报告未收录，待补。RGB 是近似值 |
| 计分时序 | `score-timeline.ts` 记载 60fps 候选录像：35 帧前导、每行 30 帧、TOTAL 前 7 帧、TOTAL 保持 135 帧；非零计数间隔 9 个模拟帧 | 原视频链接和片段时间戳待补；共享时序和边界测试保证内部一致性 |
| 35 张地图和敌人队列 | `data/original.ts` 与 `data/levels.ts` | 原始地图数据来源、版本与逐关对照待补；现有关卡测试验证展开、局部砖墙和循环 |
| 基地附近清理 | `levels.ts`：第 10 关录像位置 644.0s、第 21 关 1332.5s | 保留原有时间戳；对应视频身份和原审计报告待补 |
| 游戏规则常量 | `core/rules.ts` 与规则单元测试 | 尚无逐常量外部来源索引，待补；当前确定性测试证明实现行为，不替代原作考据 |

## 仓库内证据

- `tests/game/fixtures/native-golden.json` 是像素回归基线；不因重构重写 golden。
- core/data/game/platform 单元测试验证规则、关卡、绘制、事件时序和音频协议。真实 sender/processor 测试验证实际合成器行为。
- `tests/browser` 验证真实键盘、焦点、画布像素和 PCM；生产冒烟检查发布资源、测试接口隔离与许可文件一致性。
- `validate:desktop` 串联全部检查，以本次命令或 CI 结果判定通过。HTML 报告位于 `playwright-report/`，失败附件位于 `test-results/e2e/` 和 `test-results/production/`；失败、中断或局部通过不能代表完整验收。

补充来源时应记录 URL/仓库路径、不可变版本或采集时间、文件哈希、页码/地址/视频时间戳，以及该证据支持的具体规则。大体积录像、音频和截图使用验收产物或外部归档，不加入源码仓库。许可沿用根目录 LICENSE；现有来源声明见 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)。
