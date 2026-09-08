# RDS2 T15 技能契约矩阵

盘点日期：2026-09-08。源文件位于 `C:/Users/27846/my-chatgpt-skills`；本矩阵不把已安装缓存当作源，也不修改外部技能仓库。

| 技能 | 源 `SKILL.md` | 只读边界 | 写入边界 | 身份与证据 | 回执解释 | 分页/未完成处理 | 启用条件 | 测试证据 |
|---|---|---|---|---|---|---|---|---|
| algorithm-learning | `C:/Users/27846/my-chatgpt-skills/algorithm-learning/SKILL.md` | 通过唯一 `submit_event` 读取画像；技能不直接读写 Drive | 仅在明确学习证据后提交 `algorithm.learning.completed`；不覆盖旧事件 | 姓名解析后绑定 `username/userId`；无掌握证据用 `consulted`，不臆测弱点 | `ok`+真实回执才称已保存；`cloud_persistence_pending`/`profile_cache_pending` 如实保留待处理语义 | 未完成题在下一日优先；快照/画像失败不得据残缺数据声称完成 | 用户请求讲题、代码、提示、完整解法或明确打卡 | T15 单一 submit_event、consulted 与源路径测试 |
| backend-project-learning | `C:/Users/27846/my-chatgpt-skills/backend-project-learning/SKILL.md` | 默认只读源码与文档，先建立源码事实 | 仅用户明确允许时添加中文源码注释；不写远程数据 | 结论区分源码事实/教学假设/优化建议 | 不负责云端回执；若业务交接需遵守目标技能的回执规则 | Mermaid/索引必须基于可验证源码；信息不足不能凭残缺材料补全 | 用户学习陌生后端项目、业务流或面试表达 | T15 默认只读断言 + 源文件盘点 |
| conducting-java-backend-mock-interviews | `C:/Users/27846/my-chatgpt-skills/conducting-java-backend-mock-interviews/SKILL.md` | 身份解析后才读历史会话；不直接访问 Drive/D1/R2/HTTP | 整场结束只提交一次 `interview.session.completed`；本地 JSON 是副本 | 每次新对话按 displayName 解析；原回答永不改写 | `ok` 表示回执真实存在；失败标记 `cloud_persistence_pending`，不谎称保存 | 一次只问一道主问题；不因“不知道”伪造答案或评分 | 用户明确进行 Java 后端模拟面试 | T15 submit_event、review_pending 与只读边界测试 |
| reviewing-java-backend-interviews | `C:/Users/27846/my-chatgpt-skills/reviewing-java-backend-interviews/SKILL.md` | 身份解析成功后按 list/load 读取会话；本地报告不作为画像输入 | 构造完整 `interview.review.completed` 后只提交一次 | 真实会话需用户确认 `applyProfileChanges`；结构化字段才影响画像 | `ok`/`cloud_persistence_pending`/`profile_cache_pending` 分别如实表达 | 未确认时只保存不应用画像；修订用更高 reviewVersion，不覆盖旧事件 | 用户要求面试复盘、评分或报告 | T15 submit_event、applyProfileChanges 与本地输出约束测试 |

## 固定交互契约

1. MCP 对外只暴露 `submit_event`。V2 读操作由桥接层把读取消息转换为 `/v2/query`，写操作先落本地 V2 Outbox；技能层不绕过桥接器直写 Drive。
2. `cloud_accepted` 只证明云端 D1 接收；Drive 归档是异步阶段，不能写成“Drive 已同步”。`projected` 与 `drive_archived` 只有对应状态真实返回时才可使用。
3. 身份不一致、凭据失败、快照/画像不可解析或分页游标失效时立即停止后续出题或写入，不用缓存猜测用户状态。
4. 技能仓库与本项目代码分开管理。任何源技能修改都须在 `C:/Users/27846/my-chatgpt-skills` 独立审查、测试和提交；本项目不会把修改自动安装到 Codex 缓存，也不会自动恢复每日定时任务。

## 验证

```text
node --test --test-concurrency=1 tools/reliable-drive-sync-mcp/test/rds2-skill-contract.test.mjs
```

当前结果：**3/3 通过，Node v26.7.0，退出码 0**。测试锁定四个源技能均使用单一 `submit_event` 交接、算法技能保留中性 `consulted`、后端学习默认只读、面试状态字段，以及本地 README 对 D1 接收和 Drive 异步归档的区分。
