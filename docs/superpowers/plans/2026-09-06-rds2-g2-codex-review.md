# RDS V2 G2 复审：退回定点修订

日期：2026-09-06  
审核提交：218ff8f；基线：d19d8af。  
结论：**G2 暂不通过；只修 T05–T08，不进入 T09–T10。**

## 1. 验证范围与已确认结果

- 本轮重新执行 npm test，Node v26.7.0：Worker 500/500、Bridge 47/47。
- 阅读了新增任务、投影、构建、算法与归档模块及相关测试。
- 使用隔离内存 SQLite 与真实 Miniflare/workerd D1 运行补充探针；下述数据库问题两种绑定结果一致。
- Drive 使用本地假响应；未访问真实 Drive/D1、未部署、未修改业务源码。
- 本轮没有重复运行 Node22；报告中的 Node22 结果属于 ZCode 提供的证据。
- 新增测试总量按 G1 的452到G2的500计算是48，不是报告中的71；应修正交付数字。
- 当前链路测试证明的是手工调度驱动下的服务组合，不等于恢复器已经能自动接续所有任务。

以下路径相对 C:/Users/27846/my-chatgpt-mcp-v2，行号对应218ff8f。
每项修订均需先添加能在当前版本失败的回归，再修改实现，保留编号。

## G2-R1 [P1] 恢复器遗漏正常pending，接收后主链路不能自动启动

位置：
- services/reliable-drive-sync-worker/src/rds2/tasks/recovery.js:23
- services/reliable-drive-sync-worker/src/rds2/tasks/repository.js:findStaleTaskIds
- services/reliable-drive-sync-worker/test/rds2-g2-chain.test.js:112

recoverOnce只枚举dispatching/queued/processing中过期的租约。
但接收新事件、投影生成归档任务、构建生成下一页、failTask退避和deferTask全部产生pending。
本版accept明确不主动发送Queue，因此不能依靠另一个未实现的入口替恢复器完成派发。

实测：accept一个合法事件后调用recoverOnce，considered=0、dispatched=0、Queue发送0，两个任务仍pending。

现有drainTasks测试自己SELECT pending并调用dispatchOne，恰好绕过了真实恢复器的遗漏。

修订要求：
1. 恢复器同时覆盖到期pending与过期租约；只有需要回收的任务才执行reclaim。
2. 合并去重后每次最多4任务，limit不得被调用者放大；按实际最坏路径预留预算。
3. available_at未到期的pending不发送；普通暂缓不增加failure_count。
4. 测试驱动可以模拟多次独立invocation，但不能用测试私有SQL扫描代替业务调度器。

补测：首次接收、delta新建、build下一页、失败退避到期、等待前序后的pending，均能仅靠recoverOnce和队列消息消费最终推进；预算不足仍可后续恢复。

## G2-R2 [P1] 构建分页的“读到末页”不等于“已经处理完”，且读取越过target

位置：
- services/reliable-drive-sync-worker/src/rds2/projection/builds.js:132–155、207
- services/reliable-drive-sync-worker/src/rds2/projection/algorithm.js:buildPage

有两处独立错误：
1. done在调用reducer前按events.length<pageSize判断；algorithmReducer为满足20行变更上限，每次可能只消费5个事件。
2. SELECT只有event_seq>=nextEventSeq，没有event_seq<=target_event_seq。

实测A：同scope接收6个学习事件，默认pageSize50，一次continueBuild返回build_activated；head已推进到第6个事件，attempts却只有5。
实测B：先接收2个事件并冻结build target，再接收第3个，构建把3个全算进去，游标却仍停在第2个。

修订要求：
- 页查询限定冻结target；分页最大50且必须校验参数。
- reducer显式返回已消费范围/下一游标，激活由消费进度而非仅由读取页长度决定。
- 部分消费必须保存剩余进度并创建下一页任务；不能以缩小测试pageSize掩盖默认路径。
- 中间页与最终页统一检查20行、64KiB单元、256KiB包及32条语句上限。
- continuation中的page编号、游标由引擎控制或严格验证，不能依赖任意领域reducer偶然保留字段。

补测：0/1/5/6/49/50/51事件、默认页、reducer部分消费、跨用户event_seq空洞、build启动后持续新事件；不得提前激活、不得越过target计算。

## G2-R3 [P1] 构建激活后旧projection任务仍可重算，甚至倒退游标

位置：
- services/reliable-drive-sync-worker/src/rds2/projection/engine.js:28–43
- services/reliable-drive-sync-worker/src/rds2/projection/commit.js:commitActivation

激活只完成当前projection_build任务，没有处置已被构建覆盖的普通projection任务。
projectOne也没有对eventSeq<=head.lastEventSeq做“已应用”判断；只查询两者之间是否有未处理事件。

实测：构建激活后派发原来的第一个projection任务，返回completed并再次累加。
探针中lastEventSeq从7倒退到2，revision从1变2，attempts再次增加。

修订要求：
1. 普通任务发现事件已在有效游标内时，核对权威状态后仅收敛任务状态，不调用reducer、不加revision、不再归档相同贡献。
2. 新投影提交事务必须防止last_event_seq倒退，不能只靠JS预查。
3. 构建覆盖的任务收敛方案必须有界；不要为一次激活执行无界批量更新。
4. 保留每事件exactly-once业务效果与每任务至少一次消息的区别。

补测：构建后所有旧任务重新派发、乱序重复消息、激活与普通消费者竞态；游标单调、计数不变、无额外delta。

## G2-R4 [P1] 构建租约/CAS未闭环：旧owner谎报成功，陈旧base无法恢复

位置：
- services/reliable-drive-sync-worker/src/rds2/projection/builds.js:60–93、109–115、217–222
- services/reliable-drive-sync-worker/src/rds2/projection/commit.js:commitActivation

问题A：continueBuild捕获提交异常后，只要deferTask写0行，就直接返回completed/build_activated。
写0行可能是租约已被别人接管，不代表构建完成。

实测：在激活batch前由新owner接管租约；guard正确拒绝旧owner。
旧owner仍返回completed/build_activated，但数据库task=processing、新owner持有租约、head revision=0、building=1。

问题B：ensureBuild创建build并设置building=1没有baseRevision条件/原子断言，也没有建立与发起任务租约的约束。
实测：建build前head从revision0变1，仍创建base0的build并标building=1；后续只返回build_base_moved并defer，既不废弃旧build，也不重启，scope被卡住。

修订要求：
- 只有查证task完成且目标build已激活到正确generation/revision时，才能返回completed。
- 丢租约返回retry/noop，不谎报成功；“没有运行中build”也应核对任务最终态，不能留processing却让调用方误ack。
- 启动build对baseRevision/building状态做事务级CAS；发起者失效不能留下半个build。
- base变化要有原子的abort/restart或可诊断收敛流程，不能无限defer。
- build-page任务绑定buildId及预期page/continuation版本；不要仅按scope挑任意当前build处理。
- 明确区分陈旧写、临时存储错误、确定性契约错误；不能全部转为不计失败的永久暂缓。

补测：两owner竞争、同scope双build启动、激活前revision变化、旧build任务遇新build、存储失败、已完成重放；检查响应与D1权威状态一致。

## G2-R5 [P1] 多页构建没有归档前面页，最终摘要也可能丢失

位置：
- services/reliable-drive-sync-worker/src/rds2/projection/builds.js:162–215
- services/reliable-drive-sync-worker/src/rds2/projection/commit.js:125–193
- services/reliable-drive-sync-worker/src/rds2/archive/archiver.js:replayProjection
- services/reliable-drive-sync-worker/src/rds2/projection/algorithm.js:buildPage

中间页只写staging、continuation与下一任务，未冻结build_package/归档任务。
最终activation把“最后一页rowChanges”当普通delta；没有generation切换与前面页的引用。
如果最后一次是空终止页，algorithmReducer返回summary=null，引擎回退head.summary，而不是已累积的构建摘要。

实测：4个事件，pageSize=2，3次构建调用后：
- D1新generation有7行；
- head.summary=null；
- build_package数量=0；
- replayProjection成功返回revision1，但rows数量=0。

这不是T11–T13的复杂域问题；当前算法域多页构建即可复现。

修订要求：
1. 每页冻结有界构建包与归档任务；最终activation显式引用buildId/generation/全部必要页范围或可验证manifest。
2. 构建摘要在continuation或有界状态行中持久保存；空终止页不能清空它。
3. 离线重放支持generation切换，不只是把delta行覆盖到同一个Map。
4. 重放校验expectedScope、kind/storageVersion、revision连续性、页范围及完整性；不能接受缺少前面构建页却“成功”的结果。
5. 比较离线恢复结果与完整D1当前投影，包括摘要，不只验证某个delta哈希。

补测：单页、多页、整除页大小导致空尾页、移除中间包、乱序包、跨scope混入、旧generation条目在新generation消失。

## G2-R6 [P2] 算法摘要与专题—题目关系不符合现有模型

位置：
- services/reliable-drive-sync-worker/src/rds2/projection/algorithm.js:65–70、94–99、154、160–167、231–240

问题A：topic内部和problem.latest使用时间排序，但全局summary.headEventId/currentTopic每次直接使用最后接收事件。
实测：先接收9月6日的hash专题，再接收9月5日的array专题，summary变为array；V1应仍选择较新的hash。
daily-plan还会无条件替换学习headEventId，第一条仅为daily-plan时summary保持null，应明确空画像身份与学习头语义。

问题B：topic_problem的rowKey只有problemId，memberKey不参与主键，也没参与引擎点查。
实测同一题在hash和array两个专题出现，关系表只有hash一行，array关系丢失。

修订要求：
- 存储全局latest排序键，普通增量与buildPage都按V1同一比较器更新学习摘要。
- 如另需“最后接收事件”，新增独立字段，不复用学习headEventId。
- 关系键真正包含topic和problemId，可使用canonical数组编码/哈希；写入和点查使用同一个派生函数。
- 重新比较V1完整语义，而非只比较positive/negative计数。

补测：迟到事件、相同时间eventId决胜、同题多topic、daily-plan前后穿插、只有题单尚无学习事件。

## G2-R7 [P1] Drive精确查找未确认结果完整，就可能判“没有文件”并上传

位置：services/reliable-drive-sync-worker/src/rds2/archive/drive-client.js:41–50。

fields只请求files(id,name)，没有nextPageToken/incompleteSearch；返回值直接是payload.files??[]。
实测假响应{files:[],nextPageToken:"more"}被转换成[]，上层会走upload。
即便测试假响应补了分页token，客户端仍忽略；实际字段投影又让它根本看不到这个token。

Google官方文档明确：存在nextPageToken时files列表可能不完整，incompleteSearch表示结果可能缺失。
依据：[Drive files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)。

修订要求：
- 请求必要的完整性字段，显式小pageSize（只需区分0/1/多）。
- 按Rev6约定，对有nextPageToken/incompleteSearch的结果fail-closed，不在同invocation无界翻页，也不能当不存在后上传。
- 响应JSON格式错误、files形状错误、文件id缺失不能降级为“未找到”。
- 元数据响应也应有界，不能仅content-only读取有256KiB上限。
- 上传后内容校验与任务完成继续沿用已有artifact_hash与guard，不能以修改fake响应掩盖查找遗漏。

补测：空页+token、单条+token、incompleteSearch、多同名、畸形响应；这些场景upload调用次数必须为0，且失败收尾在16预算内。

## 2. 测试覆盖需要同步修正

1. G2链路测试通过recoverOnce启动pending与推进后续任务；仅消费实际发送的Queue消息，不让测试私有SQL成为隐藏调度器。
2. 使用默认构建pageSize，增加reducer部分消费；现有算法构建测试pageSize=2无法暴露默认50读取/5消费的错配。
3. “重放不重复贡献”不能只断言行数相同，应同时比较计数、summary、continuation、cursor与归档集合。
4. 现有100/10000/100000测试主要播种projection_rows中的topic，不能称作完整事件历史/乱序积压性能证明。补事件表前序积压场景；projectOne使用COUNT范围统计，仅判断存在前序时应使用有界存在性查询并核对索引。
5. 保持每invocation独立io，预算耗尽不能通过在同一次业务调用中更换client/io重置。跨真实独立invocation的新预算是合法的。
6. 记录实际新增48例；独立分支断言若未作为test注册，不计入测试总量。
7. 修订范围只在G2及必要的迁移/类型契约，不回退G1已修身份、hash或预算保护。

## 3. 给ZCode的执行顺序

- 先修G2-R1，得到真实业务调度驱动的最小链路。
- 再修G2-R2/R3/R4，锁定构建游标、租约与失败收敛。
- 修G2-R5，证明归档可恢复完整构建结果。
- 修G2-R6/R7，校正业务等价性与Drive完整性判断。
- 每项提交“失败样本→红灯→修订→双binding绿→SHA”，保留编号。
- 全量Node26/Node22回归，再交G2复审；不进入T09、不push、不部署、不操作真实数据。

不要求重写架构或重编全部开发计划。这里是现有G2实现与已批准Rev6契约之间的具体缺口。

## 4. 补充探针结果摘要

| 检查 | SQLite | 真实D1 |
|---|---|---|
| 新pending只调用恢复器 | 0派发 | 0派发 |
| 默认页构建6事件 | 计数5却激活 | 计数5却激活 |
| build target为2事件、随后新增第3个 | 计数3，cursor只到2 | 一致 |
| 构建覆盖后的原任务再消费 | 重复计数、cursor倒退 | 一致 |
| 4事件/页大小2的离线恢复 | D1有7行，replay为0行，summary=null | 一致 |
| 旧owner被抢租约后激活 | 返回completed，实际building=1 | 一致 |
| 构建启动前base变化 | 陈旧base build留存，后续只defer | 一致 |
| 同题跨专题、迟到旧事件 | 第二关系丢失，全局latest倒退 | 一致 |

Drive部分页检查使用本地fake：存在nextPageToken仍返回空数组。以上均为审核复现，未声称已修复。

## 5. 验收调整说明（后续追加，不改写上文）

本节为复审方后续补充。**上文所有审核结论与复现证据原样保留**，均为当时的实测结果。

- **R5「整除页大小导致空尾页」**：确认该路径在当前 continuation 协议下不可达（`nextEventSeq > target` 即判定完成，不再创建下一页任务）。该要求正式替换为「当最后一个非空页消费到冻结目标时，在该次调用完成激活；不再创建额外分页任务，最终摘要与归档清单完整」。**零事件构建是另一条独立路径，仍须覆盖**，不得由「正常构建无空尾页」推出「所有空页路径都不测」。
- **新增测试数修正**：48（G2 提交口径：T05–T08 共 45 + 链路验收 3）+ 32（本轮修订新增）= **80**，修订记录此前误写为 79。
- **C5 红灯性质**：该用例钉住的是既有契约，回退实现无法使其失败，故采用变异测试（故意让预算跨 invocation 共享）验证测试敏感性。这是**变异测试证据，不是历史缺陷的回退红灯**。
- **R2 补充发现**：reducer 消费游标此前只校验冻结目标上界，未校验本次实际读取页，存在「reducer 声称消费了未交给它的事件、事件被静默跳过且构建照常激活」的缺口；由新增测试暴露后已修复。
- 逐项测试映射、SHA、双绑定结果与全量回归见 `2026-09-06-rds2-g2-fix-record.md`。

