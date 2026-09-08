# My Chatgpt Skills 全面切换 V2

授权：用户要求全部技能接入 V2，并允许清空 V1 数据。

实施顺序：
1. 修复 MCP V2 查询公开契约、服务复用、独立 Outbox 和启动配置。
2. 补齐面试读取及跨域事件状态查询，验证真实 D1 表结构。
3. 更新本机 personal marketplace 插件的全部技能与依赖引用；无云端数据业务的技能保留本地功能，明确可选画像仅使用 V2。
4. 为乔炳源建立凭据绑定身份，启用 algorithm/interview/resume-knowledge/profile 四域，保存可重复部署的生产配置。
5. 验证各域读写后停止 V1 回调/定时器，导出备份，再清理明确的 V1 D1 表和本机旧 Outbox。不得删除 rds2_*、d1_migrations 或未知表；Drive 必须先解析具体 V1 目录，不能按根目录递归删除。
6. 重新安装插件并给出部署、测试、清理证据；新会话加载更新后的工具契约。

硬约束：单 invocation 不超过 50 子请求，现有预算器上限不放宽。D1 接收、投影完成、Drive 归档独立报告。无自动业务事件或学习成绩伪造。

## 实施证据（2026-09-08）

- Worker 生产版本：5712239a-81ae-43b1-afea-5c42bda0b094。后续生产发布显式使用 services/reliable-drive-sync-worker/wrangler.production.toml；默认 wrangler.toml 保留暗部署安全配置。
- 四域启用；V1_RETIRED=true，V1_WRITE_ENABLED=false，V1 cron 已移除。初始化入口仍关闭。
- 乔炳源凭据身份：3837e7fa-cbe5-4ad9-afa7-064b7f0fe089。凭据以 Windows DPAPI 存放于本机 ReliableDriveSync/v2-client.credential.xml，不入库。
- personal 插件实际源为 C:/Users/27846/plugins/my-chatgpt-skills；六个技能已更新并重装，版本 1.0.0+codex.20260908093542。未修改另一个旧 my-chatgpt-skills GitHub checkout；需要新会话加载插件。
- 回归：相关综合套件 127/127，Worker routes 双绑定 9/9，画像生成器验证器 29/29，六技能格式验证通过；最终定向 23/23。未声称执行全量 Worker 长套件。
- 真实身份、能力与空面试列表查询通过。四域合成事件均 d1_committed；异步投影与归档仍由恢复 cron 分批执行，接收成功不等于归档完成。
- V1 七张表共清除 50 行，表结构保留；rds2_* 未清理。D1 导出与旧本机 Outbox 备份位于 C:/Users/27846/AppData/Local/ReliableDriveSync/v1-retirement-20260908/。旧本机三个业务表已清空。
- Drive 历史目录保留：V1 文件夹与 V2 平铺归档共用父目录，未执行根目录删除。备份文件可用于人工恢复；V2 不读取旧 Drive 画像。

只读核验：在仓库根执行 `node tools/reliable-drive-sync-mcp/test-live-v2.mjs`。不要在真实用户上添加 --write；合成写入必须同时指定 --canary。
