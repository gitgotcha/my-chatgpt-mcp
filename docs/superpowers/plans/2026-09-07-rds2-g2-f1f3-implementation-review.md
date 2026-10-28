# G2 F1–F3 实现复审（45ff5f1）

日期：2026-09-07。结论：G2 暂不通过，保留已有效的修订，只补齐下列三项。

## 1. 队列接线裁定

不另立项目，不在本轮越过 G2 补接线。

既有 `2026-09-05-rds-v2-remaining-development-plan-rev6.md` 的 T10 已列明 `handleV2Queue(batch,env,ctx)`、`handleV2Scheduled(controller,env,ctx)` 和 Worker 接线；完整入口预算与多消息测试继续归后续入口/T14验收。

目前只能声称服务级测试与本地合成链路通过，不能声称生产消费者或生产入口预算已验收。方案中“需决定是否单独立项”应改为“待原定T10实施”。

## 2. F2-R1 [P1] 分类收尾没有覆盖整个处理生命周期

位置（相对 services/reliable-drive-sync-worker）：

- src/rds2/projection/builds.js：294 行 staging 读取在 340 行 try 之前；519 行 catch 仍把 changes_too_large/commit_batch_too_large 直接抛出。
- src/rds2/projection/engine.js：读取、reducer执行、ensureBuild在提交try外。
- src/rds2/errors/close-out.js：verifyAuthoritative、parkNeedsAttention、failTask 的异常没有再归一为 E 类。
- src/rds2/errors/storage-error.js：未识别内部确定性 code 白名单，只解析原生触发器/CHECK文本。

独立复现：

1. 经真实accept建立一个算法事件和build，只在staging SELECT的底层all注入存储错误。SQLite和Miniflare均直接抛原始Error（code缺省），任务留在processing、failure_count=0。与仅在最终commit注入故障的测试不是同一路径。
2. 分别让C类的failTask、D类的park在存储访问时失败，closeOutFailure均向外抛原始Error，而不是稳定E类结果；探针中的合成SQL文本也原样出现在异常message中。这是服务边界未脱敏，不声称已发生生产对外泄漏。
3. 把内部code=build_state_too_large/build_read_limit_exceeded/invalid_page_size交给真实分类器，三者均返回C/storage_error，而非批准方案中的D类。

要求：

- 建立覆盖取得租约后的加载、staging读取、reducer、序列化、提交与收尾的错误边界；未取得租约时不可伪造可收尾状态。
- 内部稳定code与原生数据库标记分开识别；预算不足保持批准的A/E语义，不恢复一律停车。
- C类阶段性读取失败也必须能计数、退避，阈值停车；租约丢失零写入不能声称保存了失败计数。
- 收尾或权威核对自身失败返回稳定E类，不把底层message/SQL/cause送出服务边界，不谎报状态已保存；保留恢复路径，不为收尾无限重试。
- 确定性错误按D停车，不能靠外抛后恢复器反复取回同任务掩盖。
- 批准的“状态转换成功后的脱敏结构化日志”在当前rds2生产模块未找到实现，须补齐并测试；这不等于外部通知送达。

验收：对每个读取和提交阶段注入失败；C连续失败生命周期、D不增计数、B零行、E核对/收尾不可用；预算不足无额外外发；结构化日志只在持久化转换成功后产生，不含用户内容/原生错误。

## 3. F1-R1 [P1] 摘要仍重复存储，构建状态也未做事务前字节校验

位置：src/rds2/projection/algorithm.js 的返回continuation；src/rds2/projection/builds.js:388–395、490。

全历史topics/problems字典已移出，这是有效修复。但continuation顶层仍保存counts/latest/headIdentity/lastReceivedEventId，builds又附加一份包含这些内容的summary；与批准方案的“只存一份”不一致。源码中也没有build_state_too_large的实现，continuation/summary仍主要依赖数据库CHECK拒绝。

独立双绑定复现：

- 两条合法算法事件，topic均为23000个ASCII字符，经accept全部成功；pageSize=1。
- 第一页提交返回needs_attention/storage_check_violation，head仍revision=0、building=1。
- 单个专题字符串及行值没有超过64KiB，归档对象也未超过256KiB；失败来自重复摘要撑大continuation，而不是必须拒绝的历史规模。

要求：

- summary与顶层累计标量只保留一套权威表示；下一页从这套表示恢复，不重复保存相同长字符串。
- 对最终将写入的continuation和summary先canonical化、计算UTF-8字节，超过64KiB才抛build_state_too_large并由F2归D；包仍为256KiB，不降低限额。
- 对合法长字段，不能以“已有CHECK会停车”代替去重方案。
- 当前测试只统计不同topic名称出现的种类数，未统计同一长字段被重复保存的问题；补两条长专题用例和状态表示断言，不能只保留短字段、多专题测试。

验收：上述两事件能完成且重放一致；35/200事件原回归保留；状态确实超限时，在commit外发前拒绝且稳定停车；64KiB与256KiB边界口径保持不变。

## 4. F3-R1 [P1] 结构校验仍缺跨字段一致性

位置：src/rds2/archive/replay-validate.js 的validateDelta/validatePackage/validateWindowCoverage；src/rds2/archive/archiver.js 的重放循环。

独立纯函数复现（每个输入均重新计算正确hash，不是哈希失败）：

1. 激活delta eventSeq=999，manifest却是合法零事件编码（pages=0、first=null、last=0）：replayProjection仍成功返回revision=1、rows={}。
2. 一个manifest范围[5,5]的页包：scanFirstCursor=5、scanCursorAfter=6，但实际firstEventSeq=1、lastEventSeq=5、consumedCount=999；重放仍成功。该页声称消费了窗口之前的事件，数量也不可能成立。

要求：

- 激活delta.eventSeq必须等于manifest.lastEventSeq；空构建对应eventSeq=0。
- 普通增量必须正序推进事件游标；与允许在同一目标重建的激活分开判断。
- 页内要求scanFirstCursor <= firstEventSeq <= lastEventSeq，lastEventSeq=scanCursorAfter-1；count为正安全整数，不能大于实际首尾跨度所容纳的整数个数。count=1时首尾必须相同。
- 第一页的实际首事件必须与manifest.firstEventSeq一致；页包与manifest的范围/窗口关系全部验证后才能接受。
- 仍允许他用户造成的序号空洞，不要求相邻实际event_seq数值连续；窗口衔接和输入乱序正样本保留。
- 这些校验是结构一致性证明，不应把“自带正确hash”当作业务正确性证明。

验收：上述两反例、激活目标矛盾、普通增量重复游标、实际首事件早于窗口、不可能的消费数量，以及正常空构建、跨用户空洞、部分消费、跨页同键。

## 5. 证据与执行边界

- 审核HEAD为45ff5f1；业务源码未修改。独立故障注入只使用本地内存SQLite和Miniflare/workerd D1；重放使用合成数据；未访问远程业务数据。
- 本轮只新增本审核文档，不提交、不部署，不清理原有未跟踪审核文档。
- 保留有效的staging、游标、分类和清零修订；这三项是批准方案的落实缺口，不需要再开启架构讨论或重新做全部历史变异。
- WorkBuddy可在既有G2修复范围内补测试、定点修复并独立提交；如需改契约/配额则先报告。不进入T09/T10，不push、不部署、不恢复定时任务。
- 每次修复需提供真实失败断言、双绑定结果、服务预算trace和运行时回归；不能仅以变异数量证明生命周期已覆盖。
