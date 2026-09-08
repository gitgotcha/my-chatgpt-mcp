# RDS2 Resume-Knowledge Parity Evidence

## Scope

T13 复用 `src/resume-knowledge-model.js` 作为业务 Oracle，V2 只增加服务端
业务去重键和有界的题目/掌握点读计划。

## Oracle 映射

| V1 规则 | V2 证据/接口 |
| --- | --- |
| 同用户、同题、同自然日只取最早评分 | `firstScorePerDay` |
| 后续自然日按 `0.6 * new + 0.4 * previous` | `updateMastery` |
| `feedback.issues/issueCategories` 原样进入 recentIssues | `rebuildResumeKnowledgeProfile` |
| 未测试题保持 `untested`，不填 0 分 | `knowledgePointStats` |
| 缺题库不可出题 | `reduceResumeKnowledgeProfile` 返回 `resume_required` |
| 旧题库不得覆盖当前版本 | `questionBank.resumeVersion` 由调用方绑定 |

## 服务端业务键

`businessDedupeKey(event)` 对以下数组做 canonical JSON：

```text
[userId, eventType, questionKey, localDate]
```

该键不是客户端可覆盖字段；客户端 eventKey 仍保留用于审计和幂等追踪。

## V2 读计划

每页按去重后的 `questionKey` 声明 `question` 与 `mastery` 两类 point read，
不读取全量历史。题库/掌握点的 staged paginator 和真实 D1 build 接线仍由后续
集成门完成；当前测试只证明 Oracle 与读计划契约，不宣称完整发布链路。

## 测试证据

`test/rds2-resume-knowledge.test.js` 覆盖首评/次日加权、业务键、untested、
`resume_required`、版本绑定与有界读计划。

