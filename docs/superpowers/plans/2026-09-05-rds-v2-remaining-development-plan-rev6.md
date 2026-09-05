# RDS V2 Remaining Development Implementation Plan — Revision 6

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成可恢复、可验证、单次业务子请求不超过40的RDS V2，先交付算法域闭环，再逐域扩展。

**Architecture:** SQLite先保存本机提交意图；D1原子接收不可变事件和任务；Queue仅唤醒；投影按事件或分页增量处理；Drive保存不可变事件与投影变更包。历史明细分行保存，不在热路径扫描Drive或拼接全部历史。

**Tech Stack:** Node.js 22.22.2/26双版本测试、node:sqlite、JavaScript ESM、Cloudflare Workers/D1/Queues、Google Drive API。保持V1依赖与行为，新增开发依赖须锁版本并提交lockfile。

**Spec:** ../specs/2026-09-05-rds-v2-rev6-design-addendum.md；原规格2026-09-05-reliable-drive-sync-v2-requirements-and-architecture.md仅在不冲突处适用。

## Global Constraints

- 本次交付仅文档；本计划不等于部署、创建远程资源或修改业务数据的授权。
- 存储版本2；业务envelope schemaVersion="1.2"；userId遵守既有UUID契约。
- 业务总预算每invocation≤40；产品硬边界50；禁止未预算化D1/Queue/fetch旁路。
- V2与V1数据库表、Outbox文件、Drive目录隔离；旧数据不迁移、不删除。
- 四队列max_batch_size=1；投影每次1事件或1页，归档每次1对象。
- 所有持久化接收、幂等、租约、CAS验收须在真实Miniflare/workerd D1 binding验证；SQLite模拟测试不能替代。
- 普通新增事件不得随历史数量增长而读取全量历史；纠错重算必须分页续作。
- 单事件输入≤256KiB；单明细JSON≤64KiB；查询响应≤256KiB；查询/重算页≤50行。
- 任何远程命令只能在发布检查点经单独确认后执行。
- 每任务测试先红后绿、独立提交；禁止git add -A、覆盖用户修改或清理主仓库残留。
- 不使用R2，不在这次计划中恢复每日学习自动任务。

## 0. 交付状态、路径与执行方式

编写基线：2026-09-05，`48fa65e`；当前业务代码仍为V1。本计划中的新模块、迁移、测试和脚本**尚未实现**。
这不是测试通过报告，也不宣称Rev5剩余片段可以直接复制执行。
Rev6补充明确提出了批量、分页状态与归档格式调整，实施者应连同该补充一起审核。

执行工作区：`C:/Users/27846/my-chatgpt-mcp-v2`。
下文代码文件路径均相对该工作区；命令均从该目录执行。
W=`services/reliable-drive-sync-worker`仅用于阅读解释，下面Files/命令均展开真实路径。

顺序及检查点：
1. T01–T04：基础契约、真实D1、身份、接收闭环。**G1：同一请求重试不增加事件。**
2. T05–T08：任务恢复、算法投影、归档。**G2：本地合成算法事件完整链路。**
3. T09–T10：本机MCP与只读查询。**G3：断网/重启/响应丢失可恢复。**
4. T11–T13：通用画像、面试、简历逐域。**G4：每域独立Oracle与规模门。**
5. T14–T16：全入口预算、Skills、发布。**G5：完整故障矩阵，然后申请远程canary。**

实施允许在G3完成后暂停扩域，交付算法域；未启用域返回domain_disabled，不能返回空成功。
每个G门要求一次人工审核结果，不要求把所有后续任务提前实施。
不再采用Rev5“先建完全部基础设施再发现第一条业务跑不通”的任务顺序。

## 1. 统一接口

下列数据结构由T01在shared/rds2-types.md落盘，并由契约测试锁定：

```ts
type Scope = { userId: string; namespace: string; projectionName: string };
type TaskLease = {
  taskId: string; owner: string; epoch: number; leaseUntil: string;
};
type WriteReceipt = {
  storageVersion: 2; attemptedRequestId: string; canonicalRequestId: string;
  eventId: string; jobId: string; userId: string;
  disposition: "accepted" | "already_recorded";
  ignoredDuplicate: boolean; cloudPersistence: "d1_committed";
};
type StepResult = {
  outcome: "completed" | "continued" | "retry" | "needs_attention" | "noop";
  taskId: string; code: string | null;
};
type Query = { storageVersion: 2; operation: string; params: Record<string, unknown> };
```

jobId定义为首次事件的投影taskId，不是Queue消息ID。事件原始归档任务有独立taskId。
API不存在以HTTP202代替receipt校验的快捷路径。
所有Service依赖由入口createInvocationIo生成，禁止内部重新读取env.DB绕过预算。
Reducer是计算规则与有限查询计划，不允许内部调用fetch/Queue。

## 2. 文件职责

- shared：V1合法性复用、V2写入/查询分类、canonical hash、共同错误码。
- src/rds2/io：预算、D1语句包装、HTTP与Queue封装。
- src/rds2/identity：鉴权及管理员初始化。
- src/rds2/events：幂等决策、原子接收、状态查询。
- src/rds2/tasks：认领、派发、恢复、DLQ。
- src/rds2/projection：引擎、事务提交、构建续作、领域规则。
- src/rds2/archive：冻结对象、Drive传输、完成记录。
- tools/reliable-drive-sync-mcp：V2本地Outbox与DTO映射；V1文件尽量仅增加显式分流。
- test/rds2-*：放在现有test目录一级，确保现有test:worker通配符实际执行。
- test/support/rds2-*：测试辅助，不放业务逻辑，不用会永远返回成功的假事务。


## T01. 锁定协议分类、身份字段与幂等判定

**Files（新增或修改，以执行时git状态为准）：**

- `shared/rds2-protocol.mjs`
- `shared/rds2-types.md`
- `services/reliable-drive-sync-worker/test/rds2-protocol.test.js`

**Interfaces：** 产出 classifySubmission(envelope)、validateQuery(dto)、canonicalJson(value)、async hashJson(value)、decideIntent({request,eventId,eventKey,businessKey}, incoming)。classifySubmission返回 read/write/adminOnly/disabled；decideIntent返回 new/replay/alias/firstResult/conflict及稳定code，不能进行I/O。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：18种既有eventType各一合法与非法样本；resolve的displayName合法、username非法；两种system写类型不访问payload.event；键顺序不同hash相同，requestId变化只改变envelopeHash；四种键同时命中不同事件必须冲突；同日重复只用于配置的评分类型。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifySubmission } from "../../../shared/rds2-protocol.mjs";
test("resolve uses displayName and never becomes a write", () => {
  const input = { schemaVersion: "1.2", namespace: "system", requestId: "r6-resolve-test",
    eventType: "system.user.resolve", payload: { displayName: "乔炳源" } };
  assert.equal(classifySubmission(input).kind, "read");
  assert.throws(() => classifySubmission({
    ...input, payload: { username: "乔炳源" }
  }));
});
```

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-protocol.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
import { validateEnvelope } from "../services/reliable-drive-sync-worker/src/protocol.js";

const READ = new Set([
  "system.capabilities.read", "system.user.resolve",
  "interview.session.list", "interview.session.load", "profile.snapshot.read"
]);
export function classifySubmission(input) {
  const envelope = validateEnvelope(input);
  if (READ.has(envelope.eventType)) return { kind: "read", envelope };
  if (envelope.eventType === "system.user-registered")
    return { kind: "adminOnly", envelope };
  if (envelope.eventType === "system.legacy-migration-requested")
    return { kind: "disabled", envelope };
  return { kind: "write", envelope };
}
```

共享模块复用现有纯验证器，不复制18套schema。先证明Node和Wrangler都能打包这条依赖；不能为通过测试放宽V1字段。contentHash保留完整业务event与identity，不含传输requestId；businessKey比较是独立分支。查询枚举逐项实现补充§5，不用缺省scope。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-protocol.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add shared/rds2-protocol.mjs shared/rds2-types.md services/reliable-drive-sync-worker/test/rds2-protocol.test.js
git commit -m "feat(rds2): t01 protocol contract"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T02. 唯一预算封装与真实D1契约测试

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/io/budget.js`
- `services/reliable-drive-sync-worker/src/rds2/io/invocation-io.js`
- `services/reliable-drive-sync-worker/test/support/rds2-d1.js`
- `services/reliable-drive-sync-worker/test/rds2-io.test.js`
- `package.json`
- `package-lock.json`

**Interfaces：** createBudget(limit)→{consume(category,count=1),remaining(),snapshot()}；createInvocationIo({db,queues,fetchImpl,limit})→{db,queues,fetch,budget}；withD1(kind, callback)用sqlite/miniflare两种binding运行同一断言并在finally关闭。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：第41次调用在外发前拒绝；调用抛错仍计费；包装语句bind/first/all/run可组合；batch解包为本db的原生语句；别的db语句拒绝且零外发；INSERT RETURNING和SELECT保留results；失败batch整批回滚；不能出现foreign_statement_object。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { wrapD1 } from "../src/rds2/io/invocation-io.js";
test("batch unwraps statements before invoking native D1", async () => {
  const native = { bind() { return this; } };
  let calls = 0;
  const db = wrapD1({
    prepare() { return native; },
    async batch(rows) {
      assert.equal(rows[0], native);
      return [{ results: [{ id: 1 }], meta: { changes: 1 } }];
    }
  }, { consume() { calls++; } });
  const result = await db.batch([db.prepare("select 1").bind()]);
  assert.equal(result[0].results[0].id, 1);
  assert.equal(calls, 1);
});
```

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-io.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
// invocation-io.js 的D1部分：map必须每个db实例独立。
export function wrapD1(nativeDb, budget) {
  const nativeOf = new WeakMap();
  function wrap(native) {
    const statement = {
      bind: (...values) => wrap(native.bind(...values)),
      first: async (...args) => {
        budget.consume("d1"); return native.first(...args);
      },
      all: async () => {
        budget.consume("d1"); return native.all();
      },
      run: async () => {
        budget.consume("d1"); return native.run();
      }
    };
    nativeOf.set(statement, native);
    return Object.freeze(statement);
  }
  return Object.freeze({
    prepare: sql => wrap(nativeDb.prepare(sql)),
    batch: async statements => {
      if (!statements.length || statements.length > 32)
        throw new Error("invalid_batch_size");
      const raw = statements.map(statement => {
        if (!nativeOf.has(statement)) throw new Error("foreign_statement");
        return nativeOf.get(statement);
      });
      budget.consume("d1");
      return nativeDb.batch(raw);
    }
  });
}
```

Node SQLite模拟器先准备语句，再以columns().length区分有结果集语句和纯写语句，不能对RETURNING统一run后丢results；通过真实binding测试确定支持的精确API。模拟器显式BEGIN/COMMIT/ROLLBACK。预算化fetch一律redirect:manual；3xx抛受控错误。OAuth也用同一fetch。测试依赖miniflare锁精确版本，记录安装的版本和Node兼容范围，不凭记忆写版本号。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-io.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/io/budget.js services/reliable-drive-sync-worker/src/rds2/io/invocation-io.js services/reliable-drive-sync-worker/test/support/rds2-d1.js services/reliable-drive-sync-worker/test/rds2-io.test.js package.json package-lock.json
git commit -m "feat(rds2): t02 budgeted io"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T03. 完整迁移、租约断言与身份初始化

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql`
- `services/reliable-drive-sync-worker/src/rds2/identity/auth.js`
- `services/reliable-drive-sync-worker/src/rds2/identity/initialize.js`
- `services/reliable-drive-sync-worker/test/rds2-schema-identity.test.js`

**Interfaces：** authenticate({db,credential})→{userId,username,status}；initializeUser({db,adminCredential,expectedAdminHash,displayName,userIdOverride,credentialHash})→绑定用户；迁移覆盖补充§6十表、全部唯一键/索引/CHECK/触发器。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：新名称配已有他人userIdOverride必须零写入失败；相同NFKC名称可解析同一个人但不能绕过管理员授权；A凭据不能查B事件；撤销凭据拒绝；两个并发初始化同名只能一身份；陈旧lease_epoch或过期租约的commit guard使整个batch回滚。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-schema-identity.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```sql
-- 对实际DDL中的commit guard执行此约束。
CREATE TRIGGER rds2_guard_task
BEFORE INSERT ON rds2_commit_guards
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM rds2_tasks t
    WHERE t.task_id = NEW.task_id
      AND t.state = 'processing'
      AND t.lease_owner = NEW.owner
      AND t.lease_epoch = NEW.expected_epoch
      AND t.lease_until > NEW.now_utc
  ) THEN RAISE(ABORT, 'stale_task_write') END;
END;
```

guard列固定guard_id/task_id/owner/expected_epoch/now_utc/expected_revision；expected_revision可空用于归档。另一个触发器通过task作用域查projection，expected_revision非空时必须相等。首次projection行在接收事务播种revision=0/last_event_seq=0，不使用空{}假画像。冻结artifact的不同hash冲突使用唯一约束后内容核对，不能INSERT OR IGNORE静默接受。初始化在签发凭据前同时查询byId和byName，冲突时禁止ON CONFLICT DO NOTHING继续授权。DDL对task类型关联列做CHECK；公开错误不泄漏SQL。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-schema-identity.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/migrations/0006_rds2_v2_tables.sql services/reliable-drive-sync-worker/src/rds2/identity/auth.js services/reliable-drive-sync-worker/src/rds2/identity/initialize.js services/reliable-drive-sync-worker/test/rds2-schema-identity.test.js
git commit -m "feat(rds2): t03 schema and identity"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T04. 一个事件原子接收与竞态重查

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/events/accept.js`
- `services/reliable-drive-sync-worker/src/rds2/events/repository.js`
- `services/reliable-drive-sync-worker/test/rds2-accept.test.js`

**Interfaces：** acceptEvent({io,principal,envelope,now})→WriteReceipt；lookupIntent({db,principal,envelope})→T01四键结果；事务同时写requests/events/projection初始头/tasks/archive_deliveries。禁止accept调用Queue。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：一个合法事件：events+1、requests+1、projection任务+1、原事件archive任务+1；request重试全部计数不变；event别名只增加requests；注入每一条SQL失败后均无半条事件；预查conflict和UNIQUE后conflict返回同一code；响应丢失后重试拿到原jobId。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-accept.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```sql
// 查询同作用域下一事件，禁止用全局序号加一。
SELECT event_seq, event_id, envelope_json
FROM rds2_events
WHERE user_id = ? AND namespace = ? AND projection_name = ?
  AND event_seq > ?
ORDER BY event_seq ASC
LIMIT 1;
```

固定taskId由作用域+eventId+type做SHA-256派生，receipt中保存原canonicalRequestId，不依赖尚未取得的自增序号生成任务名。event_seq仅作顺序游标。所有插入通过同一D1batch与精确INSERT...SELECT关联；先冻结原事件canonical字节。最多一次唯一约束重查；不是所有异常都当重复。HTTP流式读取计字节，缺Content-Length仍在256KiB拒绝；不等待无限大请求读完。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-accept.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/events/accept.js services/reliable-drive-sync-worker/src/rds2/events/repository.js services/reliable-drive-sync-worker/test/rds2-accept.test.js
git commit -m "feat(rds2): t04 atomic event acceptance"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T05. 统一task认领、派发、恢复与DLQ

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/tasks/repository.js`
- `services/reliable-drive-sync-worker/src/rds2/tasks/dispatcher.js`
- `services/reliable-drive-sync-worker/src/rds2/tasks/recovery.js`
- `services/reliable-drive-sync-worker/src/rds2/tasks/dlq.js`
- `services/reliable-drive-sync-worker/test/rds2-tasks.test.js`

**Interfaces：** claimForDispatch({taskId,owner,now})→lease|null；claimForProcessing({taskId,owner,now})→lease|null；dispatchOne({io,taskId,owner,now})→StepResult；recoverOnce({io,now,limit:4})→处理统计；handleDlq({io,taskId,now})→StepResult。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：pending未到available_at零发送；Queue发送成功而markQueued失败最终可恢复；consumer早于markQueued完成时不退回queued；重复消息不重复attempt；过期租约新owner完成后旧owner不能覆盖；DLQ遇completed只ack；实际多消息只处理第一条、其余retry。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-tasks.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```sql
UPDATE rds2_tasks
SET state='dispatching', lease_owner=?, lease_until=?,
    lease_epoch=lease_epoch+1, attempt=attempt+1
WHERE task_id=? AND state='pending' AND available_at<=?
RETURNING task_id, lease_owner, lease_until, lease_epoch;
```

RETURNING results长度0表示没认领，不凭success:true判断。发布失败只由当前owner/epoch条件更新为pending或needs_attention。consumer认领接受dispatching/queued并递增epoch，但不再加attempt；cron回收超时任务不覆盖活跃租约。DDL另存failure_count，用连续真实故障而不是累计派发次数判断5次阈值；等待前序事件、正常续页、预算暂缓不得增加该计数。恢复最多4项，开始一项前预留该项最坏完成/失败收尾预算；没有余量就结束。DLQ不依赖queue_message_id。Queue消息只含taskId/type，内容从D1加载。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-tasks.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/tasks/repository.js services/reliable-drive-sync-worker/src/rds2/tasks/dispatcher.js services/reliable-drive-sync-worker/src/rds2/tasks/recovery.js services/reliable-drive-sync-worker/src/rds2/tasks/dlq.js services/reliable-drive-sync-worker/test/rds2-tasks.test.js
git commit -m "feat(rds2): t05 recoverable tasks"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T06. 有限投影事务与分页构建基础

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/projection/engine.js`
- `services/reliable-drive-sync-worker/src/rds2/projection/commit.js`
- `services/reliable-drive-sync-worker/src/rds2/projection/builds.js`
- `services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`

**Interfaces：** projectOne({io,taskId,owner,now,reducer})→StepResult；reducer.plan({scope,event,head,rows})→{rowChanges,summary,continuation}|{rebuild}；commitProjection({io,lease,baseRevision,changes,artifact,now})；continueBuild({io,taskId,owner,now,reducer})→StepResult。rowChanges每次最多20条；每条≤64KiB，总delta≤256KiB，超出进入分页build，不截断。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：两用户序号交错互不推进；首次事件返回真实身份；并发相同revision只有一份有效delta；批次内任何写失败都回滚；build崩溃后重复页不重复贡献；旧版本在新generation完成前仍可读；needs_attention任务不能被顺手完成。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
// 每次提交的固定顺序；以下为有意显式的事务步骤契约：
// 1 INSERT rds2_commit_guards（触发器检查租约、epoch、base_revision）
// 2 写本页rowChanges；任何immutable冲突中止batch
// 3 更新projection头或build continuation（不能两者提前发布）
// 4 INSERT冻结projection_delta与archive task
// 5 UPDATE当前task，谓词再次绑定owner/epoch
// 6 DELETE该guard_id
// 以上全在一个db.batch内；总语句数不得超过32。
```

guard是事务正确性，不只是JS预检查。rowChanges20+固定收尾须用实际语句计数证明≤32。认领的task若不是该scope最小未处理事件，应暂缓而非应用后续事件；暂缓不增加failure_count。普通delta包含storageVersion/kind/scope/baseRevision/revision/eventSeq/changes/hash；不能称snapshot。重算分页时每页存可审计构建包，最终activation包引用buildId、目标generation及有序页范围；Drive可离线重建，热路径不读取这些包。只有最终激活才推进该事件游标。补充分页构建stage CHECK，禁止任意字符串步骤。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/projection/engine.js services/reliable-drive-sync-worker/src/rds2/projection/commit.js services/reliable-drive-sync-worker/src/rds2/projection/builds.js services/reliable-drive-sync-worker/test/rds2-projection-engine.test.js
git commit -m "feat(rds2): t06 bounded projection engine"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T07. 算法域先行：普通事件常量增量与题单查询

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/projection/algorithm.js`
- `services/reliable-drive-sync-worker/test/rds2-algorithm.test.js`

**Interfaces：** algorithmReducer提供plan和buildPage；updateTopic(previous,event)为纯函数；查询行类型固定topic/problem/topic_problem/evidence/daily_plan。摘要只保留identity、headEventId、currentTopic、计数，不嵌入全量证据数组。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：consulted只计neutral、不独自生成弱点；negative=incorrect/stuck/partial，positive=completed/correct；同题迟到旧结果不覆盖新结果；同event重投不累加；daily-plan不增加学习次数；100/10000/100000历史量下单次新增读取行数不增长；分页拼回小fixture后与rebuildAlgorithmProfile语义相同。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { updateTopic } from "../src/rds2/projection/algorithm.js";
test("asking for help is not negative mastery evidence", () => {
  assert.deepEqual(updateTopic(null, { outcome: "consulted" }),
    { attempts: 1, negative: 0, positive: 0, neutral: 1 });
});
```

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-algorithm.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
const negative = new Set(["incorrect", "stuck", "partial"]);
const positive = new Set(["completed", "correct"]);
export function updateTopic(previous, event) {
  const next = { attempts: 0, negative: 0, positive: 0, neutral: 0,
    ...previous };
  next.attempts++;
  if (negative.has(event.outcome)) next.negative++;
  else if (positive.has(event.outcome)) next.positive++;
  else next.neutral++;
  return next;
}
```

updateTopic只处理计数，latest字段另以V1相同(observedAt,eventId)比较。problemId严格复用source:title规则，不自行换成题号。计数、题目最新结果、topic_problem关系、证据行同事务。生成画像时间由固定now传入便于Oracle。需要完整证据时分页查询，不把完整sourceEventKeys塞回摘要。7天不重复与未完成优先由题单查询读取已保存daily_plan和problem状态完成，未完成不意味着允许绕过7天规则。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-algorithm.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/projection/algorithm.js services/reliable-drive-sync-worker/test/rds2-algorithm.test.js
git commit -m "feat(rds2): t07 algorithm projection"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T08. 单对象Drive归档与离线重放证据

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/archive/drive-client.js`
- `services/reliable-drive-sync-worker/src/rds2/archive/archiver.js`
- `services/reliable-drive-sync-worker/test/rds2-archive.test.js`

**Interfaces：** createArchiveClient({env,io,tokenProvider,folderId})→findExact(name)/upload(name,bytes)/readContent(fileId)；archiveOne({io,taskId,owner,now,client})→StepResult。folderId从受信配置或管理员登记读取，不从用户payload决定。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：不存在时find/upload/readback；已存在时find/readback；同名两个文件或nextPageToken暗示歧义时停止；内容不一致不覆盖；上传响应丢失后重查成功；readback失败不标delivered；旧owner完成更新零行不ack成功；OAuth失败、Drive429、3xx、D1完成失败均预算内。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-archive.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
// 复用原语时参数位置必须保持：
await googleUpload(env, folderId, name, bytes,
  "application/json", io.fetch, tokenProvider);
// V2 content-only读取不得调用V1 readJson（后者还读取metadata）。
// 传入io.fetch必须保留唯一预算器，tokenProvider也用它。
```

googleUpload从../../google-drive.js导入，env/bytes等由createArchiveClient参数与方法显式传入；不要使用函数.length作为签名证明。无缓存OAuth记一次；HTTP不自动重试/跟随重定向。完成事务先guard再写delivery结果与task completed，检查确定目标；失败收尾也是预算内D1调用。读取整对象有256KiB上限，若Drive返回超限或非JSON则内容错误，不能尝试无限下载。离线测试从原事件+delta/build包重建到相同revision，缺页必须拒绝。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-archive.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/archive/drive-client.js services/reliable-drive-sync-worker/src/rds2/archive/archiver.js services/reliable-drive-sync-worker/test/rds2-archive.test.js
git commit -m "feat(rds2): t08 immutable drive archive"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T09. SQLite本机可靠队列与确认回执

**Files（新增或修改，以执行时git状态为准）：**

- `tools/reliable-drive-sync-mcp/local-outbox-v2.mjs`
- `tools/reliable-drive-sync-mcp/delivery-service-v2.mjs`
- `tools/reliable-drive-sync-mcp/test/local-outbox-v2.test.mjs`
- `tools/reliable-drive-sync-mcp/test/delivery-service-v2.test.mjs`

**Interfaces：** LocalOutboxV2({path,clock,owner})提供enqueue/claimDue(limit=20)/confirm(receipt)/fail/recoverExpired/close；createDeliveryServiceV2({outbox,send,clock})提供submit/flushDue/close。send为一次HTTP调用，返回经校验receipt；不生成新IDs。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：Node22/26均无db.transaction；重复enqueue相同req不同内容阻塞；进程A租约未到期B不抢；发送后断电、云端回包丢失、本机confirm事务失败都不丢行；首次退避30s；blocked不重发；ack清理不删pending/blocked；路径父目录不存在可创建。

- [ ] 运行 `node --test tools/reliable-drive-sync-mcp/test/local-outbox-v2.test.mjs tools/reliable-drive-sync-mcp/test/delivery-service-v2.test.mjs`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
function transaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
// action只允许同步SQLite操作；网络请求必须在事务外。
```

实现到shared的import为../../shared/rds2-protocol.mjs，test目录为../../../shared。confirm必须核对attemptedRequestId及userId/eventId或明确canonical引用，之后SQLite commit成功才增加本机acknowledged。ack保留30天，清理每次≤100行。启动恢复仅过期sending；无数据库时纯读不可为恢复而创建文件。定时扫描只在首次写入后启动，close取消timer，测试使用可控时钟。

- [ ] 重新运行 `node --test tools/reliable-drive-sync-mcp/test/local-outbox-v2.test.mjs tools/reliable-drive-sync-mcp/test/delivery-service-v2.test.mjs`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add tools/reliable-drive-sync-mcp/local-outbox-v2.mjs tools/reliable-drive-sync-mcp/delivery-service-v2.mjs tools/reliable-drive-sync-mcp/test/local-outbox-v2.test.mjs tools/reliable-drive-sync-mcp/test/delivery-service-v2.test.mjs
git commit -m "feat(rds2): t09 local durable outbox"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T10. 只读DTO、Worker接线与本地配置

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/query.js`
- `services/reliable-drive-sync-worker/src/rds2/routes.js`
- `services/reliable-drive-sync-worker/src/index.js`
- `tools/reliable-drive-sync-mcp/v2-routing.mjs`
- `tools/reliable-drive-sync-mcp/stdio-bridge.mjs`
- `tools/reliable-drive-sync-mcp/setup-local-clients.ps1`
- `services/reliable-drive-sync-worker/test/rds2-routes.test.js`
- `tools/reliable-drive-sync-mcp/test/v2-routing.test.mjs`

**Interfaces：** handleV2Request(request,env,ctx)→Response；handleV2Queue(batch,env,ctx)；handleV2Scheduled(controller,env,ctx)；toV2Query(v1ReadEnvelope)→Query。setup增加WriteVersion(v1/v2)、OutboxPath显式参数。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：五类读不建Outbox、不建job；event.status两目标严格恰一；profile的domain被绑定为projectionName；分页cursor换用户/域拒绝；revision改变提示重读；空白名单、无凭据、关闭域均fail-closed；V1模式完全保持原路由；setup在临时配置文件验证真实环境变量与传入值一致。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-routes.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
// v2-routing.mjs中的固定映射：
const operations = {
  "system.capabilities.read": "capabilities",
  "system.user.resolve": "user.resolve",
  "interview.session.list": "interview.session.list",
  "interview.session.load": "interview.session.load",
  "profile.snapshot.read": "projection.read"
};
```

读取响应按补充§5逐字段构造，不把payload原样作为params（profile需domain转换，resolve只有displayName）。分页HMAC密钥独立于用户credential；游标最长有效15分钟。一次D1batch读projection头与条目以取一致版本；limit与bytes双限。环境变量RELIABLE_DRIVE_SYNC_WRITE_VERSION/RELIABLE_DRIVE_SYNC_OUTBOX_PATH由setup真实写入，stdout仅打印非敏感配置。首次支持V2状态查询的MCP输入协议需在此任务给出显式schema和测试，不能伪造V1事件类型；推荐工具参数union为旧envelope或{storageVersion:2,operation:'event.status',params}，并保持工具名称submit_event。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-routes.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/query.js services/reliable-drive-sync-worker/src/rds2/routes.js services/reliable-drive-sync-worker/src/index.js tools/reliable-drive-sync-mcp/v2-routing.mjs tools/reliable-drive-sync-mcp/stdio-bridge.mjs tools/reliable-drive-sync-mcp/setup-local-clients.ps1 services/reliable-drive-sync-worker/test/rds2-routes.test.js tools/reliable-drive-sync-mcp/test/v2-routing.test.mjs
git commit -m "feat(rds2): t10 query and routing"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T11. 通用画像：纠正、撤销与受影响范围重算

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/projection/generic-profile.js`
- `services/reliable-drive-sync-worker/test/rds2-generic-profile.test.js`
- `docs/superpowers/plans/2026-09-05-rds2-generic-profile-parity-evidence.md`
- `services/reliable-drive-sync-worker/migrations/0007_rds2_generic_projection.sql`

**Interfaces：** genericProfileReducer.plan/buildPage使用T06契约；新增row_kind observation/event_activity/source_signal/member，键包括dimensionKey与subjectKey；evidence引用以行保存。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：一个event含多条observations；observe→supersede→invalidate；目标不存在、已失活、时间不严格递增、跨domain均稳定错误；负向后两个不同sourceRef正向才能关闭；两个正向同sourceRef不能关闭；撤销较早负向可重开/改变状态；乱序结果对齐V1。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-generic-profile.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```sql
// 索引页查询必须同时限制scope和受影响member：
SELECT row_key, value_json, sort_key
FROM rds2_projection_rows
WHERE user_id=? AND namespace=? AND projection_name=?
  AND generation=? AND row_kind='observation'
  AND member_key=? AND (sort_key,row_key)>(?,?)
ORDER BY sort_key,row_key LIMIT 50;
```

本任务先交付parity-evidence文档：源模型字段→行模型→排序规则→撤销规则→Oracle逐项映射，再实现。上面的member_key需本任务增量迁移为0007_rds2_generic_projection.sql（已列入本任务Files）。不能只累计正负次数；必须保留可撤销贡献与活跃目标。若纠正依赖当前尚未收到的目标，事件状态标semantic_rejected并留审计，不能伪称applied；其他无关scope继续。对于同scope迟到事件会改变先前纠正关系的情况，使用固定target_event_seq完整作用域分页重算，明确构建错误不发布半成品。拒绝与V1不同的业务策略时需在证据文档明确裁定，不能悄悄吞错。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-generic-profile.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/projection/generic-profile.js services/reliable-drive-sync-worker/test/rds2-generic-profile.test.js docs/superpowers/plans/2026-09-05-rds2-generic-profile-parity-evidence.md services/reliable-drive-sync-worker/migrations/0007_rds2_generic_projection.sql
git commit -m "feat(rds2): t11 generic profile projection"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T12. 面试域：版本替换与撤销旧贡献

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/projection/interview.js`
- `services/reliable-drive-sync-worker/test/rds2-interview.test.js`
- `docs/superpowers/plans/2026-09-05-rds2-interview-parity-evidence.md`

**Interfaces：** interviewReducer.plan/buildPage；row_kind session/review/selected_review/contribution/weakness；query的session.list/load使用同用户session行。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：applyProfileChanges=false不改变能力；同session更高reviewVersion替换旧贡献而非累加；旧版本迟到不覆盖新版本；同version tie按V1比较器；两个passingSession但同variant不关闭；会话与评估乱序；撤销贡献后弱点正确恢复。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-interview.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
// 选择版本的持久化指针必须携带原贡献引用：
const selection = {
  sessionId: review.sessionId,
  reviewVersion: review.reviewVersion,
  eventId: review.eventId,
  applyProfileChanges: review.applyProfileChanges
};
```

先从profile-model.js原函数导出Oracle证据，逐字段覆盖8个profileChanges字段、evidenceConfidence、evidenceRefs及outcome；不得自行读不存在的status字段。旧贡献分行撤销并对受影响弱点重算，整个generation完成后发布。单条大session响应超出256KiB需明确返回response_too_large及后续分段读取设计，不能截断经历证据后冒称完整。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-interview.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/projection/interview.js services/reliable-drive-sync-worker/test/rds2-interview.test.js docs/superpowers/plans/2026-09-05-rds2-interview-parity-evidence.md
git commit -m "feat(rds2): t12 interview projection"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T13. 简历知识域：题库版本与同日第一次评分

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/src/rds2/projection/resume-knowledge.js`
- `services/reliable-drive-sync-worker/test/rds2-resume-knowledge.test.js`
- `docs/superpowers/plans/2026-09-05-rds2-resume-knowledge-parity-evidence.md`

**Interfaces：** resumeKnowledgeReducer.plan/buildPage；row_kind resume/claim/bank/question/first_score/mastery；businessKey由服务端使用JSON数组[userId,eventType,questionKey,localDate]规范化哈希。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：同日两个并发评分仅首次事件成为有效结果；第二天可更新；分数使用total和feedback.issues/issueCategories；首次80后次日60得到68；后到旧日评分需按原时间顺序分页重算；未测试题不能假设掌握0；无题库返回resume_required；旧题库晚到不覆盖当前resumeVersion。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-resume-knowledge.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
import test from "node:test";
import assert from "node:assert/strict";
import { updateMastery } from "../src/resume-knowledge-model.js";
test("oracle: first score then weighted next-day score", () => {
  assert.equal(updateMastery(null, 80), 80);
  assert.equal(updateMastery(80, 60), 68);
});
```

测试先锁源函数行为，再用同数据验证V2状态与分页完整结果。固定首评与V1最早时间排序不完全相同：接受先后由补充§4明确变更，Oracle在此处使用先去除服务端拒绝的重复事件再全量fold。每天首评保留不可变row，不在后台按客户端时间重新选首次。当前简历激活规则、题库匹配和review时间依赖均列入parity-evidence，不只验证平均分。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-resume-knowledge.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/src/rds2/projection/resume-knowledge.js services/reliable-drive-sync-worker/test/rds2-resume-knowledge.test.js docs/superpowers/plans/2026-09-05-rds2-resume-knowledge-parity-evidence.md
git commit -m "feat(rds2): t13 resume knowledge projection"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T14. 全入口预算、规模与故障证明

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/test/rds2-budget-entrypoints.test.js`
- `services/reliable-drive-sync-worker/test/rds2-faults.test.js`
- `services/reliable-drive-sync-worker/test/rds2-scale.test.js`
- `docs/superpowers/plans/2026-09-05-rds2-budget-proof.md`

**Interfaces：** 所有真实入口注入可统计的外部binding；trace记录category/operation/index/outcome而非payload/credential。budget-proof记录每入口每分支实际次数、断言上限、测试名称与提交SHA。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：写入正常/别名/冲突重查；query各operation；OAuth冷启动；上传后D1失败；每个外部调用位置抛错；queued超时；陈旧owner；两用户并发；4任务recovery；实际10消息batch；已用39预算再申请2拒绝且零外发；正常新增历史100/10000/100000读取常量。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-budget-entrypoints.test.js services/reliable-drive-sync-worker/test/rds2-faults.test.js services/reliable-drive-sync-worker/test/rds2-scale.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
import assert from "node:assert/strict";
export function assertBudgetTrace(trace, cap) {
  assert.ok(trace.length <= cap);
  assert.ok(trace.length <= 40);
  assert.ok(trace.every(item =>
    ["d1", "queue", "http"].includes(item.category)));
}
```

trace只能在实际I/O边界记录，不能把budget.consume日志当成外发证明。D1/Queue/HTTP的故障注入后要继续检查权威状态可恢复，不能只有throws。禁止在projectOne外直接调用env.DB；用AST/依赖边界扫描发现别名旁路。新增单事件读取须有索引EXPLAIN QUERY PLAN与rows-read指标；分页重算允许总工作增长但单次行数和I/O不增长。guard总上限不替代入口配额。此门不通过，不能用升级Cloudflare套餐代替修复。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-budget-entrypoints.test.js services/reliable-drive-sync-worker/test/rds2-faults.test.js services/reliable-drive-sync-worker/test/rds2-scale.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/test/rds2-budget-entrypoints.test.js services/reliable-drive-sync-worker/test/rds2-faults.test.js services/reliable-drive-sync-worker/test/rds2-scale.test.js docs/superpowers/plans/2026-09-05-rds2-budget-proof.md
git commit -m "feat(rds2): t14 budget and failure proofs"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T15. 技能契约与状态文案

**Files（新增或修改，以执行时git状态为准）：**

- `docs/superpowers/plans/2026-09-05-rds2-skill-contract-matrix.md`
- `tools/reliable-drive-sync-mcp/test/rds2-skill-contract.test.mjs`
- `tools/reliable-drive-sync-mcp/README.md`

**Interfaces：** 产出逐技能矩阵：真实源路径/只读操作/写事件/身份字段/receipt解释/分页处理/启用条件/测试证据。外部skills仓库修改独立提交，不直接修改已安装缓存。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：algorithm-learning、backend-project-learning、conducting-java-backend-mock-interviews、reviewing-java-backend-interviews各自盘点；只读不写；用户没答题不捏造评分；cloud_accepted不说Drive已同步；只读分页未完成不据残缺画像出题；身份不符立即停止；工具仍只暴露submit_event。

- [ ] 运行 `node --test tools/reliable-drive-sync-mcp/test/rds2-skill-contract.test.mjs`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```js
const expectedPersistence = {
  local_retained: "已保留在本机，云端尚未确认",
  cloud_accepted: "云端D1已接收，Drive归档可能仍在进行",
  projected: "画像已更新，Drive归档状态另查",
  drive_archived: "Drive内容已校验并记录归档完成",
  needs_attention: "需要处理同步问题，数据未被丢弃"
};
```

实施此任务必须加载skill-creator/writing-skills与适用插件管理技能。先在C:/Users/27846/my-chatgpt-skills用rg --files定位源SKILL.md，冻结矩阵后才能修改；当前计划不猜测插件目录。新增pagination和projection_delta语义不能只换三句文案。算法每日计划是否允许自动写题单应以更新后的技能明示权限为准，不自动恢复原定时任务。安装/更新插件是另一个用户确认点，不能把修改源码当成已安装。

- [ ] 重新运行 `node --test tools/reliable-drive-sync-mcp/test/rds2-skill-contract.test.mjs`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add docs/superpowers/plans/2026-09-05-rds2-skill-contract-matrix.md tools/reliable-drive-sync-mcp/test/rds2-skill-contract.test.mjs tools/reliable-drive-sync-mcp/README.md
git commit -m "feat(rds2): t15 skill contract alignment"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## T16. 本地打包、远程canary与可逆发布

**Files（新增或修改，以执行时git状态为准）：**

- `services/reliable-drive-sync-worker/wrangler.toml`
- `tools/reliable-drive-sync-mcp/rds2-canary.mjs`
- `docs/runbooks/rds2-release.md`
- `services/reliable-drive-sync-worker/test/rds2-release-config.test.js`

**Interfaces：** canary脚本提供--local或--remote显式模式；remote缺参数拒绝执行，输出requestId/eventId/jobId及四维状态，不输出凭据。runbook包含版本SHA、资源名、开关值、人工确认记录与回滚目标。

- [ ] 先写失败测试，逐项使用独立test名称，覆盖这些具体输入/结果：四队列消费者含DLQ均max_batch_size1；新增cron不改V1三条；默认全开关false；恢复开关真实接线；本地dry-run不访问Drive；无凭据/无白名单拒绝；暂停新写后现有任务可以排空；已接受V2写不能自动fallback V1。

- [ ] 运行 `node --test services/reliable-drive-sync-worker/test/rds2-release-config.test.js`。新文件初次预期因模块缺失/功能未实现而失败；模块接入后，必须见到至少一个业务断言红灯，不能只把语法错误当TDD证据。
- [ ] 按以下关键实现约束编码；片段是该任务的关键算法/语句，不是声称整模块已实现。

```powershell
npx wrangler deploy --dry-run --config services/reliable-drive-sync-worker/wrangler.toml --outdir C:/Users/27846/my-chatgpt-mcp-v2/.rds2-dry-run
```

先检查上述输出目录是否存在及是否包含用户文件；不能删除未知目录。远程资源创建/迁移/部署均需独立确认。runbook按资源准备→全闭暗部署→只启synthetic用户→启恢复器→算法canary→本地显式切换→其余逐域→关V1接收执行。回滚优先关闭V2新写而保持兼容消费者排空；只有故障消费者才暂停消费并保留任务，回退到已验证兼容schema的构建，绝不DROP表、删除Drive或将V2pending改投V1。

- [ ] 重新运行 `node --test services/reliable-drive-sync-worker/test/rds2-release-config.test.js`，预期所有本任务断言通过；涉及D1任务同时跑sqlite和真实binding两套用例，不得跳过后者。
- [ ] 运行 `npm test`，确认既有Worker/Bridge测试无回归。记录实际Node版本、测试数量及命令退出码，不复制历史380/47作为本次结果。
- [ ] 复核只包含本任务文件后独立提交：

```powershell
git add services/reliable-drive-sync-worker/wrangler.toml tools/reliable-drive-sync-mcp/rds2-canary.mjs docs/runbooks/rds2-release.md services/reliable-drive-sync-worker/test/rds2-release-config.test.js
git commit -m "feat(rds2): t16 release gates"
```

**回退：** 未发布时按本任务提交执行非破坏性revert；已发布后数据库迁移不做down/drop，先按T16停止新增写入、保留账本与待处理任务，再评估兼容回退。

## 3. 必须逐个模拟的失败窗口

| 窗口 | 重启/重试后应看到 | 验收任务 |
|---|---|---|
| 本地入库后、请求发出前断电 | pending仍在，IDs不变 | T09 |
| D1提交成功、HTTP响应丢失 |重试回原receipt，不增事件 | T04/T09 |
| Queue发送成功、D1回写失败 | dispatching超时可重发，业务只应用一次 | T05 |
| consumer快于dispatcher回写 | completed不被改回queued | T05 |
| 处理租约过期，旧owner迟到 | guard拒绝整个写batch | T03/T06/T08 |
| 投影写明细后、推进游标前异常 | 整批回滚，无半份画像 | T06 |
| 重算第2页保存后进程退出 | continuation继续，无重复贡献 | T06/T11–13 |
| 上传成功、响应丢失 | 精确查找+内容核对，不盲覆盖 | T08 |
| readback成功、D1完成失败 | 重放再核对并补记录，不报假成功 | T08 |
| needs_attention遭旧消息重放 | 不自动复活，显式人工重放才恢复 | T05 |
| 查询第一页后画像版本变化 | projection_changed，不混页出题 | T10/T15 |
|预算将耗尽 | 未发出的调用零发生，持久任务仍可恢复 | T14 |

## 4. 验收交付物，不以grep代替证明

每个检查点提交：
1. 本次代码SHA与实际变更文件。
2. 新增失败测试的失败输出、对应修复后通过输出。
3. 真D1事务/并发结果，不只SQLite模拟结果。
4. 完整入口I/O trace与上限，包含失败收尾。
5. 若涉及业务：小样本全量Oracle与增量结果对比、乱序/撤销样本、100000历史规模数据。
6. 未通过项逐项列出；不填“全部通过”后再备注未运行。

五审阻断覆盖：

| 阻断面 | 本计划处理 |
|---|---|
| D1 wrapper/adapter混用、RETURNING丢失 | T02的WeakMap解包及真实binding同套测试 |
| 显式userIdOverride错绑 | T03双向核对及并发零残留 |
| ingress漏账、batch预算失真 | 无即时派发；T02/T14完整入口trace；每消息独立预算 |
| 预查与竞态冲突分支不一致 | T01统一decideIntent，T04两处调用 |
| 查询协议/系统无event字段冲突 | 补充§3/§5与T01/T10明确分类 |
| 归档双租约/陈旧完成/恢复缺口 | task唯一租约，guard保护完成，T05/T08 |
| 状态数组随历史增长停服 | 明细分行、分代构建、T06/T07/T11–13规模门 |
| 本地ack所有权、启动恢复、导入路径/配置 | 补充§10与T09/T10 |
| 未计重定向与目录扫描 | 禁自动重定向、目录独立准备，T08/T14 |
| 大规模完整snapshot的隐性全量成本 | 显式projection_delta与构建包，不冒称完整snapshot |
| 业务状态与持久化状态混淆 | WriteReceipt只证D1；event.status分维度，T04/T10/T15 |

## 5. 发布runbook必须包含的实际配置

以下为T16需写入并测试的配置契约，不是本轮已修改值。

| 名称 | 暗部署 | 算法canary |
|---|---|---|
| RDS2_WRITE_ENABLED | false | true，仅canary白名单 |
| RDS2_QUERY_ENABLED | false | true |
| RDS2_PROJECTION_ENABLED | false | true |
| RDS2_ARCHIVE_ENABLED | false | true |
| RDS2_RECOVERY_ENABLED | false | true |
| RDS2_ENABLED_DOMAINS | 空 | algorithm |
| RDS2_ALLOWED_USER_IDS | 空，fail-closed | 已初始化canary UUID |
| RELIABLE_DRIVE_SYNC_WRITE_VERSION | v1 | 用户确认后本机v2 |
| RELIABLE_DRIVE_SYNC_OUTBOX_PATH | 不改V1 | 显式独立绝对路径 |

开关parse只接受字符串"true"，缺失/拼错视false，不能用Boolean("false")。
远程队列固定名字：rds2-projection、rds2-archive、rds2-projection-dlq、rds2-archive-dlq。
对应binding：RDS2_PROJECTION_QUEUE、RDS2_ARCHIVE_QUEUE；两个DLQ按queue名称路由，不作为普通任务生产目标。
接收投影类型白名单和初始化scope保持一致；禁用域不能先accepted再永远不处理。

远程步骤仅在授权后执行，runbook中必须写全：
- 创建四个队列并记录资源存在性；配置两个主队列的dead_letter_queue。
- 应用完整V2迁移；确认V1表行数与结构未改。
- 准备隔离Drive根目录并逐步骤登记folderId；不在归档请求中自动递归创建。
- 独立设置admin凭据、用户凭据、查询游标签名密钥与Drive凭据；不把它们写入日志或版本库。
- 全闭部署，再仅启canary用户，打开恢复器；验证两个cron分支互不串用。
- 合成合法学习事件提交一次，重复提交一次，确认一个账本事件、一个业务结果、归档内容一致。
- 本机断网提交→联网→重启→回执核对；本地确认后保留ack审计行。
- 算法域观察至少24小时，检查任务最老等待时长、needs_attention、预算max、Drive一致性。
- 其余领域分别通过G4后启用，不一次开放全部。
- V1停止接收需要再次确认；原V1 pending逐条处置，不删除历史数据。
- 关闭V2写入的回滚演练必须证明已有accepted任务仍保留且可恢复。

## 6. 估算与实施节奏

这是工程估算，不是交付保证；以测试与G门为准。单名熟悉仓库的开发者：
- T01–T04：3–5个工作日。
- T05–T08：4–7个工作日。
- T09–T10：2–3个工作日。
- T11–T13：每域2–4个工作日，纠错/乱序是主要不确定性。
- T14–T16：3–5个工作日，包含故障演练，不包含等待审批。

算法域可先独立交付，不必等待所有领域。全域预计约18–32个工作日；发现领域语义差异应更新证据文档，不偷偷降低正确性目标。
初版恢复器4任务/5分钟约为48次派发/小时，这只是保守可靠性基线，不是高吞吐验收结果。大型分页重算在此调度下可能很慢，必须实测总完成时长。需要提高吞吐时，新增独立的快速派发入口/唤醒路径，仍通过同一D1 dispatcher且每invocation受限；先提交入口预算证明再启用，不把增加单次循环量当优化。G4报告必须列出规模与完成耗时，不能只报告单次不超限。
R2费用和迁移工作均不在此范围。平台查询/存储容量仍需监控，“每次≤40调用”不等于无限免费额度。

## 7. 本轮文档自检与诚实边界

- 不继承Rev4/Rev5代码片段；关键契约在补充和本计划明示。
- 基础模块接口、调用归属、身份、幂等、预算、恢复、发布均有对应任务。
- 计划包含关键实现片段与具体测试案例；不是完整源码生成稿。
- 尚未实施的SQL、真实D1测试、四域规模测试、远程canary均不能报告已通过。
- T11–T13明确要求先产出字段级等价证据，这是实际开发步骤，不以现有摘要代替源码核实。
- 全量独立快照导出、R2、旧数据迁移、自动重启每日推送不包含在本次开发范围。
- 如果需要一份可脱离主计划逐函数直接编码的某阶段施工稿，应在对应G门前基于已验证接口细化；不能再跨多版复制矛盾的伪代码。

## 8. 技术依据

- D1 batch接收prepared statements、按序返回结果，失败会回滚整个批次：[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)。T02仍必须实测包装器兼容性。
- Queue批次与逐消息确认/重试行为：[Batching, Retries and Delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)。本版主动选择单消息批次。
- 平台限制核对入口：[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)。不论未来套餐变化，本项目继续按用户指定50硬边界、业务40预算设计。
