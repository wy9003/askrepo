# askrepo v2 — Text-to-SQL 规格书（2026-10-24）

> 自包含派单文档：执行者无需其他上下文。v1 代码在本仓库（RAG+Agent 主线已完成并上线），v2 是在它之上的新能力线。
> 决策来源：主会话 2026-10-23/24 研讨定案（市场信号：Text-to-SQL+RAG 细分挂 $80-120/hr；定位 = 能力证明作品，非产品）。

## 〇、定位与红线（先读这个）

1. **这是作品集/能力证明，不是要打赢任何开源库**。README **只介绍自己，不做任何竞品对比**（用户明确指令）。
2. 保持 v1 的工程品味：**TypeScript、零运行时依赖**（node: 内置模块 + fetch）、node:test 离线测试、MIT。
3. 公开 repo = 假数据演示库（合成电商数据），零真实敏感数据。
4. 与 Upwork 每日筛单并行推进，不因为本线停任何既有节奏。

## 一、v2 目标（一句话）

`askrepo sql "show me top 10 customers by revenue last quarter"` —— 对一个配置好的 SQL 库做自然语言查询，产出：**SQL + 执行结果 + 命中表/列的溯源**，且全程带安全护栏、可评测、LLM 端点可插拔。

## 二、管线设计（核心章节）

```
问题 → [本地 embedding] → schema 检索（列级索引, top-k 表）
     → ★FK 图闭包（补齐连接路径上的中间表）
     → Prompt 组装（方言注入 + DDL + FK 路径 + 可选 few-shot）
     → LLM 生成 SQL（ChatProvider 抽象，模型可插拔）
     → ★护栏层（确定性代码，非 LLM）：
         ① 标识符核验：正则抽取 FROM/JOIN 表名与列引用，对照 DB catalog，幻觉表/列直接打回
         ② 只读强制：仅允许 SELECT/WITH 开头（含嵌套检查），否则拒绝
         ③ LIMIT 强制注入（无 LIMIT 自动补 LIMIT 1000）
         ④ EXPLAIN 预检：EXPLAIN QUERY PLAN 先跑，行数预估超阈值（如 1e6）打回重写
     → 执行 → 错误回喂自修复循环（≤3 轮）
     → 结果 + SQL + provenance（命中表/列/连接路径）
```

标 ★ 的两块是本设计的核心技术签名：

- **FK 图闭包（Join-Path Closure）**：从 DB catalog（SQLite `PRAGMA foreign_key_list` / PG `information_schema`）构建表-外键无向图；向量检索命中的表集合若不连通，用 BFS 补最短路径中间表。解决"检索出的表连不起来 → LLM 幻觉连接键 → 静默错误结果"这一 Text-to-SQL 第一大死因。纯确定性代码，微秒级。
- **护栏层**：全部是模型无关的确定性代码。安全不能靠 prompt。

## 三、模块拆解与文件规划

| 模块 | 文件 | 说明 |
|---|---|---|
| 库内省 | `src/sql/introspect.ts` | 读 catalog → 表/列元数据 + FK 边 |
| FK 图 | `src/sql/fkgraph.ts` | 建图 + 闭包（BFS 最短路径补全） |
| 检索 | 复用 v1 `store.ts` | DDL 按表切块 embedding（本地模型或 API，可配） |
| 生成 | `src/sql/generate.ts` | prompt 组装（方言/DDL/FK 路径/few-shot 可选）→ ChatProvider |
| 护栏 | `src/sql/guardrails.ts` | 标识符核验/只读/LIMIT/EXPLAIN 预检 |
| 执行与修复 | `src/sql/execute.ts` | node:sqlite 执行 + 自修复循环 |
| 评测 | `src/sql/eval/*.ts` + `eval/questions.json` | 40 题 + 执行等价判定 + 归因 |
| CLI | 扩展 `src/cli.ts` | `askrepo sql init|ask|eval` 子命令 |

**DB 选择**：默认 SQLite（`node:sqlite`，Node 22 内置，维持零依赖）；`DATABASE_URL` 存在时支持 Postgres（方言自动切换，验证方言注入设计）。种子数据：合成电商 8-10 张表（customers/orders/order_items/products/categories/events/returns/addresses），每表几百到几千行，脚本生成。

## 四、评测设计（README 的灵魂）

1. **题集**：40 题（easy 15 / medium 15 / hard 10，hard 含多表连接、时间窗、聚合嵌套、歧义题），每题附 ground-truth SQL；
2. **判定**：**执行结果等价**（结果集比对），非字符串匹配；
3. **归因**：错题分四类——schema 链接错 / 连接错 / 聚合逻辑错 / 其他；
4. **三张表进 README**：
   - 基准表：主模型管线全开 vs 全关（无闭包/无修复）的对比 → 量化各层贡献；
   - **模型矩阵**：同一管线 × ≥3 个模型（至少 1 个 API 前沿 + 1 个本地开源 Ollama）→ 准确率/延迟/单题成本；
   - **隐私模式表**（P2，若做化名模式）：真名 vs 化名准确率差 = 量化"隐私税"。
5. 所有数字**可复现**：`askrepo sql eval --model x` 一条命令重跑。

## 五、LLM 端点与数据边界（部署作为一等公民）

复用 v1 `ChatProvider` 抽象，v2 增加实现：

| Provider | 数据去向 | 状态 |
|---|---|---|
| OpenAI / Anthropic | 公共 API | v1 已有 |
| **LocalOllama**（`http://localhost:11434`） | 完全本地 | v2 新增，P1 |
| GLM API | 公共 API | P2 顺手加 |

**化名模式（P2）**：本地把表/列名映射为 t1/c1 式化名进 LLM，出 SQL 后本地逆向还原再执行；评测量化准确率损失。

## 六、四级排期（每周 5-8h）

- **W1**：内省 + FK 图 + 闭包 + 检索 + 生成 + 执行 → 无护栏端到端跑通；种子库就绪
- **W2**：护栏四件套 + 自修复循环 + LocalOllama provider
- **W3**：评测集 40 题 + 判定器 + 归因 + 基准表/模型矩阵跑分
- **W4**：README（架构图、三张数字表、quickstart、设计注记）+ Upwork 作品集条目 + （P2: 化名模式/级联路由，时间够才做）

## 七、验收标准

1. `askrepo sql ask "..."` 在 SQLite 演示库端到端可用，输出 SQL+结果+溯源；
2. 评测：`askrepo sql eval` 产出报告；至少 1 个 API 模型 + 1 个本地模型有数字；
3. 闭包 A/B：连接错误类归因在开/关闭包下有可测差异；
4. 护栏：注入 `DROP TABLE` / 假表名 / 无 LIMIT 大表查询 三个攻击用例全部被拦（写成测试）；
5. 全部测试离线（mock provider），tsc 零错；
6. README 无任何竞品提及（用户指令）。

## 八、设计决策备注（防执行时跑偏）

- 标识符核验用"定向正则抽取 + catalog 对照"，**不引入 SQL parser 依赖**（维持零依赖；若实测漏检率高，devDependency 里引 node-sql-parser 重议）；
- 自修复循环的报错信息要完整回喂（含 DB 原始错误）；
- few-shot 检索（历史问答对）是 P2——W3 评测若显示瓶颈在 schema 链接再做；
- 歧义题不追求全对，评测里单列"歧义类"，展示"知道自己错哪"比硬蒙对更有说服力；
- 提交规范沿用 v1（英文 conventional commits），仓库保持单人节奏，无需分支策略。
