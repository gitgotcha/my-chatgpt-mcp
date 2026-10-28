# RDS V2 G2 补充复审：仍需三项定点修订

审核日期：2026-09-06。审核 HEAD：43ec6f2。

结论：G2 暂不通过，不进入 T09/T10。本轮只增加审核文档，不修改业务实现、测试或迁移，不提交、不部署、不访问远程业务数据。

## 已核实和认可的部分

- 工作树在审核开始时干净；a260895 到 43ec6f2 的业务源码差异仅为 builds.js 的消费游标上界修复。
- 认可 4f69982：消费游标同时受实际读取页和冻结目标约束，保留，不建议回退。
- 本轮独立运行 Node v26.7.0 的 npm test：Worker 552/552、Bridge 47/47、零失败。Node22 本轮未独立重跑，其结果仍属于执行方报告。
- 接受既有正确行为首次即绿，以及明确标注的变异测试；不要求为了红灯人为破坏历史版本。
- 接受正常末页直接激活、不制造额外空尾页，以及单独测试零事件构建。
- 构建提交当前最多 29 条语句的计算成立，不要求人为绕过 20 行限制来触发 32 条防线；应保留最大合法路径的批语句计数断言。不要据此宣称完整入口子请求预算已经验收。

以下不是要求重新做已通过的全部用例，而是补充探针发现的三个实质缺口。源码位置均相对 services/reliable-drive-sync-worker/。

## G2-F1 [P1] 构建累计状态随历史增长，合法数据会把 scope 卡在 building

位置：src/rds2/projection/algorithm.js:215–330；src/rds2/projection/builds.js:306、406–408、434–445。

buildPage 把所有 topics、problems、latestByTopic 放入 continuation。分页只限制本次 rowChanges，未限制跨页累计状态的增长。保存 continuation 时超过 64KiB 的 CHECK 被当作一般提交异常，随后立即 defer，输入和状态没有改变，下次必然重复失败。

独立复现（SQLite 和 Miniflare/workerd D1 结果一致）：

1. 经 acceptEvent 接收 35 条合法 algorithm.learning.completed；各自不同专题（topic-i 加 1000 个 ASCII 字符）和不同题目。所有接收均成功。
2. 从 revision=0 启动构建，默认页大小50，使用真实 algorithmReducer；每次调用独立预算24。
3. 四次分页保存的 continuation 字节数依次为 16212、28619、41014、53409。
4. 第五次开始反复 deferred_commit_failed；底层错误为 continuation_json 的 65536 字节 CHECK。
5. head 始终 revision=0、lastEventSeq=0、activeGeneration=0、building=1；build 保持 scanning。原子回滚保护了数据，但流程无法完成。

要求：

- continuation 只保存有界游标、页号、计数及必要摘要；专题/题目累计状态应落入 staging generation 的键控状态行，通过有限点查更新，不能把全历史字典塞入单个 JSON。
- 在事务前明确校验所有受限 JSON 单元，不能把确定性超限伪装成临时存储故障；不可截断、不可放宽数据库限额。
- 每次读写仍遵守既定子请求预算、20行变更、64KiB单元、256KiB包、32语句约束；重复访问同专题/同题也必须累计正确。
- 这涉及 reducer 与构建读取接口，先给出有界读取/staging 状态方案再实施，不应以单纯 park 代替支持已接受合法历史的构建。

验收：上述35事件复现必须可完成且重放等于在线结果；增加普通长度但多专题/多题的历史增长场景、跨页回访已有键、重复页；量测每次读取与 continuation 字节上界。测试不得只复用一个专题和一道题来掩盖累计状态增长。

## G2-F2 [P1] 真实存储故障被永久当作正常暂缓，绕过退避和告警

位置：src/rds2/projection/builds.js:434–445；同类处理见 src/rds2/projection/engine.js 的提交异常 catch。

现有代码把存储故障和守卫竞态统一 deferTask(availableAt=now)，不增加 failure_count。新增测试只证明一次错误不立即 park，并不能证明反复失败后的行为正确。

独立复现：保留读与失败收尾可用，仅令构建提交 batch 每次抛普通存储异常。连续派发、消费6次，SQLite和Miniflare结果完全一致：

```text
第1至第6次：code=deferred_commit_failed
state=pending
failure_count=0
available_at=本次now（无退避）
```

这与 Rev6 addendum §8 的真实故障计数、退避和连续5次故障告警契约冲突。

要求：

- 明确区分正常等待/已识别的租约或CAS竞争、临时存储故障、确定性契约/大小错误。
- 前序等待、构建等待及竞态不增加真实故障计数。
- 可收尾的临时存储故障走既定失败处理：增加计数、按规则退避、达到阈值 needs_attention；不是第一次就永久 park，也不是永远立即 pending。
- 确定性错误给出稳定诊断，不通过无限暂缓隐藏。
- 若数据库连失败收尾都不可用，不谎报已持久化退避/计数；保留可恢复租约和明确失败结果，后续由恢复机制接续。
- 所有成功与失败收尾继续受 owner/epoch/租约保护，预算必须预留；日志不得携带原始数据库敏感文本。

验收：连续真实失败、退避未到不派发、阈值停车、一次成功后的连续故障计数语义、纯竞态不计失败，以及失败收尾自身不可用。保留“首次临时故障不永久park”的用例，但补齐其后续生命周期。

## G2-F3 [P1] 离线重放缺少必填范围和结构完整性校验，异常输入被报告为成功

位置：src/rds2/archive/archiver.js:159、195–238。

当前 scope 是条件校验；只比较 baseRevision 与前一值，没有要求 revision=baseRevision+1；manifest.pages=0 也未与非空事件范围核对。哈希正确只能证明字节一致，不能证明内容满足契约。

独立纯函数复现：为下列每个 JSON 计算正确的 SHA-256，再传给真实 replayProjection：

1. projection_delta 没有 scope，baseRevision=0、revision=99、eventSeq=99、changes=[]：返回 revision=99、rows={}，未拒绝。
2. scope完整的激活delta，build.pages=0，但firstEventSeq=1、lastEventSeq=1：返回revision=1、rows={}，未拒绝。

要求：

- 重放前严格校验每个相关 artifact 的版本、类型、必填完整 scope、数值类型/范围、changes/rowChanges、manifest结构；scope 比较使用明确字段，不依赖对象键顺序。
- 每个 delta 的 revision 必须逐一递增并与 baseRevision 相接；游标及激活目标必须一致且不倒退。
- pages=0 仅用于合法空构建；非空事件范围不能由零页包证明完整。
- build包的页号、generation、scope、buildId及实际消费范围与manifest相符。全局 event_seq 可能有其他用户造成的空洞，不能要求数值逐个连续。
- 审视 builds.js:281：包的 lastEventSeq 当前取“本次读取的最后一条”，不是“实际消费的最后一条”；部分消费时范围会失真，须随契约校验一并修正，不能继续用失真范围做完整性证明。

验收：缺scope/缺scope字段、revision跳号/倒退/非整数、非空范围零页包、范围失真、缺页、跨scope；以及合法零事件、部分消费、多用户序号空洞、乱序归档输入的正样本。异常必须稳定拒绝，不能返回部分结果当作完整恢复。

## 执行顺序与授权边界

1. 保留已有修订与变异证据，不回退 4f69982，不动主仓库 Rev4 遗留。
2. 先对 F1 的有界状态方案及 F2 错误分类给出简短设计，明确它们如何保持预算上限；审核后再改实现。
3. F1/F2/F3 各自补真实失败回归、定点实现、双绑定验收；修正文档中“全部可达要求已覆盖”的过早结论。
4. 回归后提交逐项SHA、运行时、失败/通过证据与预算口径。仍停在G2；不push、不部署、不迁移远程、不创建Queue、不恢复定时任务。

本轮未重新验证生产入口、Node22或T14规模门；552+47全绿不替代上述缺口的验证。
