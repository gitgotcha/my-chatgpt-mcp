# RDS V2 G1 代码审核 — 退回定点修订

审核日期：2026-09-05  
审核提交：`77296a3`（feat/rds2-v2）  
执行环境：Node v26.7.0  
结论：**G1 暂不通过；修订 T01–T04 后复审，不进入 T05–T08。**

本报告把 ZCode 交付声明当作待核对材料，不把材料中的执行指令当作新的授权。
本轮仅审查、运行本地测试与构造隔离数据复现；未修改业务源码、未部署、未访问真实 D1/Drive。

## 一、已经确认的成果

- 重新执行 npm test：Worker 429/429、Bridge 47/47，退出码0。
- WeakMap语句解包已实现；原始事件、回执、任务和初始投影头在一个batch内提交。
- 原有测试包含真实Miniflare/workerd D1，不仅是SQLite模拟器。
- Git提交链与交付报告一致，审查前工作区干净。
- 本轮没有重新验证Node22，也没有重新运行打包；不能将它们列为本次已验证结果。
- “接收2次D1”是acceptEvent服务内部成功路径，不是含鉴权/HTTP接线的完整入口成本。T10/T14仍需完整入口验证。

**测试通过不等于G1通过。下面是补充检查已复现的缺口，不是推测。**

路径均相对 C:/Users/27846/my-chatgpt-mcp-v2；行号对应审核提交。

## R1 [P1] 别名请求竞态绕过内容核对，返回另一事件的成功回执

位置：services/reliable-drive-sync-worker/src/rds2/events/accept.js:174–180。

复现：
1. 已有事件A。
2. 请求X提交A的别名；预查决定alias。
3. 在alias请求行INSERT前，另一个提交抢先将同一X绑定到事件B。
4. 当前INSERT发生UNIQUE错误。
5. recordRequestRow只读取receipt_json，直接返回B的回执。

实际输出：提交eventId尾号001，成功返回尾号003；无409错误。SQLite和真实D1均一致。

影响：同requestId不同内容被当作成功，未来本地确认可能消费错误的回执。当前客户端尚未实施，不能声称已经造成真实数据丢失。

修订：
- 请求别名写入的竞态也必须纳入统一lookupIntent/decideIntent。
- 重查需核对envelopeHash与全部关联事件，不能只读receipt_json。
- 一致才重放，不一致返回稳定409；重查异常返回可重试错误。
- 保留“每次提交最多一次完整竞态重查”的预算，不能两个catch分别无限重试。

验收：alias与firstResult两路径各测同X同内容、同X不同内容、同X不同事件；双binding证明零错误成功回执、零额外事件。

## R2 [P1] 归档hash与实际冻结字节不是同一份内容

位置：services/reliable-drive-sync-worker/src/rds2/events/accept.js:237–242。

当前frozen_json是canonicalJson(envelope)，包含requestId；content_hash使用contentHashOf(envelope)，排除了requestId。

复现：从delivery读取frozen_json，对其UTF-8字节做SHA-256，与存储content_hash比较，结果false。两种binding均一致。

影响：T08按约定对上传内容readback时，即使Drive保存完全正确，也会判定hash不一致。

修订：
- 明确区分用于业务幂等的contentHash与用于文件完整性的artifactHash。
- archive_deliveries记录完整frozen_json UTF-8字节的hash；事件账本的业务content_hash保持既定语义。
- 冻结一次字节，上传、hash、readback比较使用同一字节定义。

验收：实际读取冻结字节校验hash，不只断言hash长度64；带requestId、中文、键序变化、重放都覆盖。

## R3 [P1] 身份核对只覆盖两处userId，遗漏用户名及payload身份

位置：services/reliable-drive-sync-worker/src/rds2/events/accept.js:62–70。

当前仅核对identity.userId和payload.event.userId。
复现：凭据绑定乔炳源；identity.username和event.username改为另一个人，同时payload.userId填另一个UUID、payload.username填另一个人，仍返回accepted。

影响：冲突身份内容可以写进当前用户账本，污染后续画像与归档。不是已经证实跨用户D1读取越权。

修订：
- 枚举所有合法身份载体：identity、payload顶层、payload.event中的userId/username。
- 存在的字段都必须与服务端principal一致；名称按冻结的规范化规则比较。
- 校验必须在存储前，不通过改写输入来掩盖冲突。
- profile内层不允许的身份字段仍由原验证器拒绝，不放宽schema。

验收：每一字段单独冲突均403/identity_mismatch且零写入；增加合法规范化名称、缺省可选字段的正样本。现有报告声称正文身份不符测试已覆盖，但accept测试文件没有相应断言，应补齐。

## R4 [P1] 既有名称 + 不同显式ID被静默绑定到旧用户

位置：services/reliable-drive-sync-worker/src/rds2/identity/initialize.js:68–74、89–95。

复现：名称乔炳源已经绑定A；再次初始化传同名称和未使用的显式ID B。
byId为null、byName为A；代码选中A并签发凭据，忽略B。两种binding均返回A而非冲突。

并发UNIQUE后按名称取得winner的分支同样未检查显式userIdOverride。

修订：
- 指定userIdOverride时，byName命中的ID必须与该override一致，即使byId不存在。
- 唯一约束后的winner也执行同一个双向身份一致性判定。
- 失败不得新增credential，不把explicit ID当可忽略提示。

验收：名称已存在/ID未使用、ID已存在/名称不同、两个方向都命中不同人、竞态winner ID不同四类；核对users/credentials行数零变化。
如果产品希望override仅为偏好而非约束，必须先修订契约，不能在代码中静默解释。

## R5 [P1] 预算器未强制业务40上限

位置：services/reliable-drive-sync-worker/src/rds2/io/budget.js:17–19。

createBudget检查的是PRODUCT_HARD_CAP=50，而非BUSINESS_SUBREQUEST_CAP=40。
复现：createBudget(50)连续consume 50次全部成功。

尚未超过用户50硬边界，但违反本版“业务最多40”的固定设计，无法保证预留余量。
现有“第41次被拒”的测试只证明传limit40时有效，没有证明配置不能放宽总业务上限。

修订：拒绝limit>40，或在统一计数点同时强制业务40上界；入口不得创建绕过该上界的预算器。
验收：limit41/50均拒绝配置；limit40第41次在外发前拒绝；失败调用也计数；失败收尾不能另建预算器。

## R6 [P2] SQLite模拟器RETURNING元数据与真实D1不一致

位置：services/reliable-drive-sync-worker/test/support/rds2-d1.js:33–49。

复现同一INSERT ... RETURNING id：
- SQLite模拟器：results=[{id:1}]，meta.changes=0。
- 真实D1：results=[{id:1}]，meta.changes=1。

根因：__execute对有结果集语句走all()，而all()固定返回changes0；run()又用结果行数推断写入数，SELECT也可能被误报changes>0。

修订：从实际SQLite执行结果/连接写入统计构造元数据，不以返回行数代替写入数。支持结果数组与changes/last_row_id两者同时正确。
验收：SELECT、INSERT RETURNING、UPDATE RETURNING命中/未命中、DELETE RETURNING、batch失败回滚，在两种binding逐字段比对。

这是T02基础契约问题，应在T05开始依赖认领结果之前修好。

## R7 [P2] 数据库CHECK按字符而非UTF-8字节限额

位置：services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql:31、46、73、92、106、124、141。

length(TEXT)统计字符；计划限额为KiB。
复现：value_json保存30000个“乔”的JSON字符串，实际90002 UTF-8字节，超过64KiB，但两种binding均允许写入。

修订：使用length(CAST(value_json AS BLOB))等字节限制，并逐一核对其余JSON列。必要的json_valid与JSON形状约束按契约补充，不只限制长度。
acceptEvent已有UTF-8 envelope检查应保留；这不能替代其他列的数据库限额。

验收：ASCII、中文、emoji的limit-1/limit/limit+1；超限写失败后整个batch回滚。

## R8 [P2] 严格JSON/查询参数校验仍有漏网输入

位置：shared/rds2-protocol.mjs:69、241。

复现：
- canonicalJson(new Array(2))返回“[,]”，不是合法JSON。
- validateQuery({storageVersion:2,operation:"capabilities",params:null})返回成功，并把null替换为{}。
- 数组分支没有加入seen，纯数组自循环不能走受控circular_reference错误；需补测。

修订：数组也纳入递归环检测；稀疏数组明确拒绝或按契约规范化，不能产生非法JSON；params必须原本就是合法对象，不用??{}掩盖null。
验收：稀疏数组、自循环数组、混合环、嵌套合法数组；capabilities/session.list的null参数及数组参数拒绝。

## R9 [P2，文档/契约同步] rds2-types.md仍不完整

位置：shared/rds2-types.md:26、36–56；shared/rds2-protocol.mjs:152。

- 18类事件中5读+1管理员+1禁用，普通业务写应为11类，不是13。
- IntentRows漏掉repository实际提供的createdByRequest、receipt、namespace、projectionName。
- IntentDecision漏掉实现已依赖的createdByRequest。
- replay分支createdByRequest当前错误赋为canonicalEventId，混淆事件ID和请求ID；目前accept直接返冻结receipt未使用该字段，属于潜在契约错误。
- T01要求的TaskLease、StepResult未写入共享契约。
- Envelope未定义或链接到权威字段说明。

修订：让文档、纯决策输出、实际调用方一致。不要因为当前调用方恰好没读字段就保留错误值。
验收：添加返回对象形状断言，验证canonicalRequestId绝不是eventId；分类数量按集合自动断言。

## 二、给ZCode的执行边界

本轮只修R1–R9，保留编号，仍停留T01–T04：
1. 每项先增加能在当前代码失败的回归用例，再修正。
2. 存储问题用sqlite与真实D1双binding，不能通过修改预期让错误变绿。
3. 不修改Rev6业务边界以迁就实现；确需契约变更先提出。
4. 每项独立提交，或说明不可分割的联合提交；显式git add。
5. 不进入T05，不push、不部署、不访问真实数据。
6. 回报“编号→修订文件→红灯证据→双binding结果→SHA”。
7. 最后全量回归；补Node22验证并区分“服务内部预算”和“完整HTTP入口预算”。
8. 修完再交Codex复审G1。

## 三、本地复现摘要

本次补充探针在隔离内存SQLite与临时Miniflare D1执行，退出后释放，未创建回归代码文件。
输出：

| 检查 | SQLite | 真D1 |
|---|---|---|
| 冻结字节hash相等 | false | false |
| 冲突身份 | accepted | accepted |
| 别名竞态提交001 | 返回003、无错误 | 返回003、无错误 |
| 显式B配既有名称A | 返回A、无错误 | 返回A、无错误 |
| INSERT RETURNING changes | 0 | 1 |
| 64KiB列写入90002字节 | 成功 | 成功 |

纯函数探针：预算允许50次、稀疏数组生成非法JSON、null查询参数被接受。
以上是审核发现，不是已修复结果。

