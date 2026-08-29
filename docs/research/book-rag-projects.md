# 面向 AI Reader 的书籍 RAG 开源实现调研

调研日期：2026-08-28

## 结论先行

与 AI Reader 最接近的参考实现不是通用“上传 PDF 聊天”，而是以下三类项目：

1. **Readest、ReadAny**：已经把 EPUB 阅读语义、章节顺序、可点击位置和本地检索放在同一应用中，是最直接的实现参考。
2. **Khoj、Open WebUI、PaperQA2**：分别提供增量索引、混合检索与证据重排等可复用技术，但没有 AI Reader 所需的 EPUB CFI、稳定资料身份和版本迁移语义。

这些项目的共同经验是：**高质量书籍 RAG 的核心不是向量库，而是规范正文、结构感知切分、稳定来源定位、版本失效和可验证引用。** 向量检索通常只是全文检索之外的一条召回路径。

对 AI Reader 的建议是：

- 继续遵守当前 [ADR-0013](../adr/0013-preserve-future-ai-boundaries-without-building-ai.md)，第一版不引入 AI、模型 SDK 或向量索引。
- 后续先实现既有产品愿景中的“三层书籍知识 + 原文章节片段按需披露”，复用 `BookDocument`、规范搜索正文和 Anchor；不要先造第二套 EPUB/PDF 解析器。
- 真正加入向量检索时，把它设计成可重建的派生索引：以 `BookId + Content Fingerprint + 索引算法版本 + Embedding 模型身份` 隔离，检索采用全文/BM25 与向量的混合召回，返回的每条证据必须携带可由阅读器解析的锚点。
- 索引与回答都必须遵守主要阅读材料、显式跨书范围、当前阅读进度（防剧透）、不可信书籍内容和用户明确授权的网络边界。

**book-brain、RAGFlow、Ragmir**：分别展示书籍结构图、父子分块和可靠派生索引工程；适合借鉴思想，不适合整体搬入轻量跨端阅读器。

## 与本项目相关的判断标准

本调研没有按“功能数量”排序，而是按以下约束评估：

- 本地优先，能在桌面或平板降级运行；云模型是可替换选择，不是书库所有者。
- EPUB、PDF、Markdown 都是 `Reading Material`，上层统一依赖 `BookDocument`。
- `BookId` 是稳定资料身份，完整内容指纹负责查重、完整性和派生索引失效。
- EPUB 需要章节/spine 语义和可跳转 CFI；PDF 需要页码及文本/区域定位；Markdown 需要标题结构和保存后的版本失效。
- 引用必须能回到原文，不能只显示文档名或让模型自己编页码。
- 阅读材料是不可信内容；检索到的正文只能作为数据，不能取得工具权限或覆盖系统指令。
- 第一版明确不做 AI、全书库正文索引和 OCR。本报告只为后续阶段提供依据，不改变当前范围。

## 项目对比

| 项目       | 与 AI Reader 的贴合度 | 已核验做法                                                              | 最值得借鉴                                                     | 主要缺口                                                |
| ---------- | --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Readest    | 极高                  | EPUB 章节切分、CFI、书内 RAG、本地数据库、混合检索、防剧透顺序边界      | 阅读语义与检索定位共用；检索失败降级；避免重复全文索引         | 应用层很重；本机 Reedy 与上游后续收口仍在演进           |
| ReadAny    | 极高                  | Tauri/React/foliate-js、EPUB/PDF、多端、本地向量、BM25 + RRF、CFI chunk | 按文本段组合 chunk 并保留 CFI；sqlite-vec 抽象；本地 embedding | 身份、版本迁移和锚点恢复不如 AI Reader 严格             |
| book-brain | 高但不成熟            | EPUB → 结构化 Markdown、SQLite/FTS5/sqlite-vec、概念与交叉引用图       | 章节/小节/图表/代码清单成为独立知识对象                        | 项目很新；不是阅读器；没有阅读位置恢复                  |
| Khoj       | 中高                  | 标题祖先链、chunk hash 增量 embedding、向量召回 + cross-encoder         | 结构前缀和 chunk 级差量更新                                    | 无 EPUB；PDF 回链较弱；不是混合全文/向量检索            |
| Open WebUI | 中                    | 多格式解析、BM25 + vector、RRF、rerank、PDF 页码引用                    | 通用混合检索和 Citation payload                                | 无 EPUB spine/CFI、资料版本和阅读器状态                 |
| PaperQA2   | 中                    | 向量召回后生成针对问题的证据摘要，再由 LLM 重排与回答                   | “证据收集”和“最终回答”分层；引用优先                       | 偏科研 PDF；默认云模型；不是端侧阅读器                  |
| RAGFlow    | 中低                  | Book/Paper 专用解析、布局识别、标题/父子 chunk、多路召回与检索测试      | 小 chunk 召回、父 chunk 补上下文；可视化检查 chunk             | 服务端栈过重；Book 模板不支持 EPUB；OCR 超出当前范围    |
| Ragmir     | 中                    | 本地派生索引、持久进度、原子激活、显式证据阈值、检索评测                | 索引构建可靠性与 golden eval                                   | 面向代码/文档代理，不是阅读器；默认检索模型并非语义模型 |

## 重点项目怎么做

### 1. Readest：最重要的直接参考

Readest 的官方架构说明确认，现有书内 RAG 会在本地按章节建立 embedding，并由 `src/services/ai` 负责聊天、切分、重试和本地 AI Store。[Readest 架构文档](https://github.com/readest/readest/blob/main/apps/readest-app/docs/architecture.md#63-ai--rag)

本机 `C:\code\projects\readest` 还能看到更进一步的 Reedy 实现：

- `CfiChunker.ts` 按章节 DOM 遍历文本节点，避开脚本、样式和 `cfi-inert` 内容；以约 500 字符、最小 100 字符、50 字符重叠切分，并为 chunk 起止位置生成完整 EPUB CFI。
- CFI 入库前会从 CFI 解析回 DOM Range，往返不一致的 chunk 被丢弃，而不是保存一个不可导航的引用。
- `BookIndexer.ts` 对同一本书串行索引，状态区分 `indexing / indexed / empty_index / failed`，更换模型或重建时先清旧 chunk，再分批写入。
- `BookRetriever.ts` 先检查未索引、空索引、Embedding 模型过期等状态；查询 embedding 超时或失败时降级到全文路径；`spoilerBoundPosition` 限制只检索阅读进度之前的片段。
- `ReedyDb.ts` 使用本地 `vector32` 与全文检索，两路结果用 RRF 融合，返回正文、章节、顺序和 CFI。

对应上游源码路径：[CFI 切分](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/reedy/retrieval/CfiChunker.ts)、[索引编排](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/reedy/retrieval/BookIndexer.ts)、[检索状态与降级](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/reedy/retrieval/BookRetriever.ts)、[本地检索存储](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/reedy/db/ReedyDb.ts)。

更值得注意的是，Readest 上游后来记录了一次收口：实时写 Tantivy 全文索引测得约 5.3 秒/书，因此计划让正文全文搜索复用每本书已有的 `search_sections`，Reedy 只保留 embedding 和指向规范正文的 locator range，避免保存第二份全文与第二套全文索引。[迁移文件中的修订说明](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/database/migrations/index.ts#L925-L949)、[`search_sections` schema](https://github.com/readest/readest/blob/main/apps/readest-app/src/services/database/migrations/index.ts#L1056-L1127)

这与 AI Reader 的现状高度吻合：`canonicalSearch.ts` 已按章节建立规范可读文本、文本节点快照、DOM Range 映射、完整指纹和算法版本缓存键。后续 RAG 应消费这份规范正文，而不是再次解压 EPUB、再次清洗 HTML 或另存一份含不同文本语义的全文。

**适合继承：** CFI-aware chunk、CFI 往返校验、顺序型防剧透过滤、索引状态机、全文降级和“向量只引用规范正文”的收口方向。

**不宜照搬：** Readest 的账户、同步、Web/Cloudflare、AI Provider 和复杂 Agent UI；AI Reader 的 SQLite 仍由 Rust 独占，TS 不应直接操作 Turso/SQL。

### 2. ReadAny：技术栈最接近的独立实现

ReadAny 同样使用 Tauri、React、TypeScript、SQLite 和 foliate-js，并明确支持本地 embedding、本地向量库和 EPUB/PDF 语义搜索。[项目说明](https://github.com/codedogQBY/ReadAny)

它的 RAG 实现有三点值得参考：

- 分块输入不是先拼成纯文本，而是带 CFI 的 `TextSegment[]`；连续段落按约 300 token、最小 50 token、20% overlap 组合，chunk 保留 `startCfi`、`endCfi` 和每段 CFI。[chunker.ts](https://github.com/codedogQBY/ReadAny/blob/main/packages/core/src/rag/chunker.ts)
- 向量检索优先走 sqlite-vec，失败时可回退到内存余弦搜索；BM25 使用本地倒排索引，向量与 BM25 扩大候选后用 RRF 融合，向量不可用时明确降级到 BM25。[search.ts](https://github.com/codedogQBY/ReadAny/blob/main/packages/core/src/rag/search.ts)
- 向量存储通过窄 `IVectorDB` 隔离，只暴露按 `bookId` 写入、删除、查询、统计和重建能力。[vector-db.ts](https://github.com/codedogQBY/ReadAny/blob/main/packages/core/src/rag/vector-db.ts)

**适合继承：** 以阅读器产生的 Segment/CFI 为输入、向量库窄接口、BM25 降级、RRF 融合。

**需要加强：** AI Reader 不能只按 `bookId` 判断索引有效；必须同时记录内容指纹、索引算法版本、Embedding 模型标识和维度。Markdown 保存或显式 EPUB 版本迁移后，旧索引必须变成 stale，不能继续命中旧正文。

### 3. book-brain：把书籍结构变成知识对象

book-brain 把 EPUB spine 转成 Markdown，再按 H1/H2 生成章节、小节、代码清单和图片页面；用规则抽取概念与“参见第 N 章”等交叉引用，最后用 SQLite FTS5、sqlite-vec 和图反向链接加权进行混合检索。[官方仓库与架构说明](https://github.com/xjli1972/book-brain)

它说明了一个对文史哲阅读很重要的方向：书籍不仅是均匀文本块，目录层级、概念、人物、章节与交叉引用都可以成为检索路由。其具体规则和数据结构尚不成熟，不应直接复制；但“三层书籍知识”的第一层索引可以吸收这一思路，用人工可见的章节/概念结构先缩小检索范围，再读取原文章节片段。

### 4. Khoj：标题上下文与真正的 chunk 级增量

Khoj 的 Markdown 解析会按标题层级递归拆分，并把祖先标题链前缀到后代 chunk；每段还保留 `file://...#line=N`，使检索文本获得结构上下文但原文位置仍可回链。[Markdown 解析源码](https://github.com/khoj-ai/khoj/blob/master/src/khoj/processor/content/markdown/markdown_to_entries.py)

它对超长内容按段落、句子、词和字符递归缩小到 token 预算；索引更新对 chunk 内容做哈希，只为新增 chunk 生成 embedding，并删除消失的 chunk。[通用切分与增量索引](https://github.com/khoj-ai/khoj/blob/master/src/khoj/processor/content/text_to_entries.py)

**适合继承：** Embedding 输入可带“书名 > 章 > 节”结构前缀，但展示与引用仍使用未污染的原文；chunk fingerprint 可减少 Markdown 小改动后的重嵌入。

**限制：** Khoj 没有 EPUB 支持，其 PDF 路径也没有 AI Reader 所需的稳定页内锚点；检索是向量召回后 cross-encoder 重排，不等于全文 + 向量混合。

### 5. Open WebUI：通用混合检索与引用 payload

Open WebUI 支持 EPUB、PDF 和多种办公文档 loader；默认切分会先利用 Markdown 标题，再做字符/token 切分。其检索支持 BM25、向量召回、RRF、CrossEncoder rerank、阈值和 chunk hash 去重，并能在 citation payload 中携带 document ID、URL、页码和扩展 metadata。[Loader 源码](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/retrieval/loaders/main.py)、[RAG 文档](https://docs.openwebui.com/features/chat-conversations/rag/)、[检索实现](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/retrieval/utils.py)

**适合继承：** 候选扩大后融合/重排、低相关阈值、引用 payload 与 PDF 页码预览。

**限制：** EPUB 仍是通用 loader，没有 spine、href、CFI、阅读进度或版本迁移语义。

### 6. PaperQA2：把“找证据”和“写答案”分开

PaperQA2 的默认流程分三步：先寻找候选文献并索引；再向量召回 top-k chunk，为每个 chunk 生成针对当前问题的证据摘要并让 LLM 重评分；最后只用最优证据摘要生成带文内引用的回答。[官方算法说明](https://github.com/mmrech/paper-qa2#paperqa2-algorithm)

这种 evidence-first 流程比“直接把 top-k 原文塞给模型”更适合复杂比较问题，但成本较高。AI Reader 可以在后期把它作为可选重排层：默认混合检索已经足够时不调用；只有跨书、多跳或高风险回答才生成证据摘要。任何摘要仍必须指向原文 Anchor，不能成为无来源的事实副本。

### 7. RAGFlow：父子分块和可见的解析质量

RAGFlow 的 Book 模板会针对 PDF/DOCX/TXT 做标题与层级处理，然后按 token 和中英文标点合并；通用管线同时建立全文与向量索引。[Book parser 源码](https://github.com/infiniflow/ragflow/blob/main/rag/app/book.py)、[知识库配置](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configure_knowledge_base.md)

其父子分块解决了一个典型矛盾：较小 child chunk 用于精确召回，命中后带回较完整的 parent section 供回答理解。[父子分块文档](https://github.com/infiniflow/ragflow/blob/main/docs/guides/dataset/configure_child_chunking_strategy.md)

**适合继承：** “小块召回、章节/小节补上下文”，以及索引后可检查 chunk 和运行 retrieval test 的产品思路。

**不宜照搬：** Docker 服务端、Elasticsearch/Infinity、Redis、对象存储、OCR/VLM；其 Book 模板不支持 EPUB，也没有阅读器锚点。

### 8. Ragmir：派生索引也要有工程完整性

Ragmir 把索引当成本地派生状态，但仍实现了每文件持久进度、并发边界、串行 writer、原子 rebuild 激活、显式证据阈值、稳定排序和 golden retrieval eval；引用可覆盖文件行、PDF 页和 EPUB 位置。[官方仓库](https://github.com/jcode-works/jcode-ragmir)

这些能力适合 AI Reader 的 Rust 持久化边界：索引失败不能破坏当前可用索引；新 generation 构建完成并校验后才切换；应用崩溃后可恢复或丢弃 staging generation；质量门禁至少测 hit@k、MRR、引用可解析率和错误版本零命中。

## 明确反例与非 RAG 对照

### AnythingLLM：支持 EPUB，不代表理解书籍结构

AnythingLLM 的 EPUB loader 明确关闭章节拆分，再把 loader 文本拼成一个 `pageContent`；后续统一使用通用递归字符切分。因此 EPUB spine、章节 href 和 CFI 都会丢失。[EPUB 转换源码](https://github.com/Mintplex-Labs/anything-llm/blob/master/collector/processSingleFile/convert/asEPub.js)、[切分说明](https://docs.anythingllm.com/setup/embedder-configuration/text-splitting)

它适合参考本地模型配置与简单 UX，不适合复用 EPUB 入库方式。AI Reader 已有更可靠的 `BookDocument` 和规范 DOM，退回“抽纯文本再切块”会造成阅读正文、搜索正文和 RAG 正文三套语义。

### Paige：短书可以不用 RAG

Paige 是防剧透 EPUB 聊天项目，但明确不使用 RAG：把用户已读章节的完整正文作为稳定 prompt prefix，利用长上下文与 prompt caching。[官方说明](https://github.com/derekmpeterson/paige#how-it-works)

这说明 RAG 不是每次回答的强制路径。对于当前选区、当前短章节或已经很小的第二层知识对象，直接披露完整上下文通常比检索更可靠；只有全书、跨章或跨书问题才需要检索。

### 未纳入核心样本：Alambique Index

该项目 README 描述了 EPUB/PDF/Markdown、本地混合检索、OCR 和评测，但当前仓库根目录实际只有 `assets`、`README.md`、`config.yaml`，README 提到的实现源码不在仓库中。它可以作为设计清单阅读，不能作为“已有源码实现”的证据，因此未进入对比表。

## 这些实现的共同管线

经过筛选，成熟实现大致收敛为以下流程：

```text
托管阅读材料
  → 格式拥有者产生规范章节/页面正文
  → 结构优先切分，附稳定来源定位和顺序
  → 记录内容/算法/模型版本
  → 全文索引 + 可选 embedding 索引
  → 查询范围过滤（材料、版本、已读位置）
  → 全文与向量多路召回
  → RRF 融合，可选 rerank/父块扩展
  → 证据 ID + 原文 + 可解析 Anchor
  → LLM 仅基于证据回答
  → UI 根据证据 ID 跳回原文
```

关键规律如下：

1. **先按结构，再按大小。** EPUB 不跨 spine section；Markdown 先按标题；PDF 先按页/段。达到预算后才在段落或句子附近继续切分。
2. **Embedding 文本与展示原文可以不同。** 检索输入可前置书名和章节路径，引用展示仍使用原文，避免模型生成的上下文污染可复制引文。
3. **向量不能单独承担召回。** 专名、原句、术语、页码和中文短语常由全文/BM25 更可靠地命中；RRF 比直接混合两个不可比较的分数更稳健。
4. **引用是检索结果的字段，不是模型生成的文本。** 模型只输出证据 ID；应用把 ID 映射到可信的 Anchor、标题和预览。
5. **索引必须可失效、可重建、可降级。** 内容或算法改变时标 stale；Embedding 服务失败时仍能全文检索；新索引原子激活，旧索引在切换前保持可用。
6. **检索质量需要小型真实题集。** 至少覆盖原句、同义表达、跨章节关系、专名、中文长句、错误版本、防剧透和引用跳转。

## 建议 AI Reader 后续采用的形状

以下是调研结论，不是已接受架构决策；正式实施前需要新增或修订 ADR，并征得范围确认。

### 1. 规范内容来源

建议在 TypeScript 阅读领域提供一个窄的“可索引内容”能力，内部继续由格式实现拥有：

- EPUB：复用清洗后的规范章节 DOM 和 `canonicalSearch` 文本，chunk 不跨 spine section；起止位置生成并校验 CFI。
- Markdown：复用保存后的 Markdown → 安全 HTML → 内存 EPUB 章节；只索引正式保存版本，不索引 Recovery Snapshot 或未保存缓冲区。
- PDF：逐页读取 PDF.js 文字层，保存页码及文本范围定位；扫描页无文字层时标记不可索引，不因为 RAG 偷偷加入 OCR 或上传图片。

不要让 Agent、Workbench 或 RAG 模块直接操作 Foliate/PDF.js 对象。它们只消费格式中立的 `IndexableSection`/`EvidenceAnchor` 一类领域值。

### 2. 建议的派生 chunk 元数据

每个 chunk 至少需要：

- `materialId`（稳定 `BookId`）
- `contentFingerprint`
- `indexSchemaVersion` 与 `chunkAlgorithmVersion`
- `sourceKind`（原文、章节知识笔记、书籍索引、用户/AI Markdown 笔记）
- `sectionIndex`、`chapterPath`、`positionIndex`
- 版本化 `startAnchor`/`endAnchor`
- 原文 `text` 与可选的 embedding 上下文前缀
- `chunkFingerprint`
- `embeddingProvider/model/dimension`（只有向量索引需要）

这样才能安全支持资料版本、Markdown 保存、模型切换、跨书比较、防剧透和可点击引用。

### 3. TS/Rust 边界

- **TypeScript 拥有：** 规范正文、章节结构、CFI/PDF Anchor、chunk 语义、主要阅读材料和已读位置过滤意图。
- **Rust 拥有：** SQLite/向量扩展、索引 generation、事务、原子激活、文件与空间预算、按稳定 MaterialId 校验的 typed Repository。
- **Agent Runtime 拥有：** 查询改写、工具调用、证据预算和回答；它既不解析书籍，也不写 SQL。

应当有内存 Adapter 与 Tauri Adapter 共享检索 Repository 契约测试，保持与当前仓储策略一致。

### 4. 检索顺序

建议的初始参数只作为实验起点：

1. 先按 `materialId + contentFingerprint + sourceKind + position bound` 过滤。
2. 全文/BM25 与向量分别 over-fetch（例如最终 top-k 的 2–3 倍）。
3. 用 RRF 融合，不直接加权原始距离和 BM25 分数。
4. 相邻 chunk 合并或提升到 parent section，消除重叠重复。
5. 低相关时明确回答“未找到足够证据”，不要让模型凭常识补写。
6. 跨书检索只有在用户显式选择材料范围后开启；默认围绕主要阅读材料。

### 5. 索引生命周期

- 导入材料后不应无条件后台向云发送正文；本地全文索引可自动构建，embedding 需按产品隐私策略显式开启。
- 同一材料索引任务串行；状态至少为 `not_indexed / indexing / indexed / empty / failed / stale`。
- Markdown 正式保存后，按 chunk fingerprint 尽量复用未变 embedding；第一版实现可以先整书重建，但必须在新 generation 完整后再切换。
- EPUB 显式版本迁移预览期间只构建候选索引；迁移事务确认后才能激活。取消迁移时旧索引不变。
- 索引是可再生成缓存，默认不进入完整书库备份或未来同步；跨端各自重建。若以后同步索引，必须单独做加密、兼容和空间 ADR。

### 6. 安全与隐私

- 书籍正文和检索片段始终按不可信数据包装，禁止其中的“忽略规则”“调用工具”等文本成为指令。
- 检索工具只返回白名单字段，不返回路径、SQL、任意文件句柄或 Tauri Capability。
- 使用云 embedding/LLM 前应明确显示将发送的范围；默认不发送原始全书，只发送构建 embedding 或回答所需的最小片段。
- 本地 embedding 可通过可替换 Provider 支持桌面 Ollama 或端内模型；平板能力不足时退化为全文检索，而不是阻塞阅读。

## 推荐推进顺序

1. **保持当前第一版不变。** 完成阅读、批注、备份与跨端验收，不创建 AI 空模块。
2. **AI 第一个切片仍不使用向量。** 实现书籍索引、章节知识笔记、原文章节片段和可点击 Anchor；问题通过结构路由 + 现有全文搜索工具取材。
3. **建立检索评测。** 从真实 EPUB/PDF/Markdown 生成中文题集，记录 hit@k、MRR、引用跳转成功率、防剧透违规率和旧版本误命中率。
4. **只在评测证明需要时加入 embedding。** 先做单书、桌面、本地派生索引，全文 + 向量 + RRF，Embedding 不可用时全文降级。
5. **再考虑 rerank、父子 chunk 与跨书比较。** 这些都应建立在稳定引用和可观测评测之上。

## 最终建议

如果只选三个实现深入研究：

1. **Readest**：直接继承 CFI-aware chunk、顺序过滤、索引状态与规范正文复用方向。
2. **ReadAny**：借鉴 TypeScript 端 Segment/CFI 输入、`IVectorDB` 窄接口、BM25 + RRF 与离线降级。
3. **Khoj + Open WebUI（各取一半）**：Khoj 提供结构前缀和 chunk hash 增量；Open WebUI 提供通用混合召回、rerank 与 Citation payload。

PaperQA2 的证据重排、RAGFlow 的父子 chunk、Ragmir 的原子索引与评测适合作为后续增强，不应进入首个 AI 切片。

任何直接移植的代码都必须按仓库规则登记到 `docs/legal/third-party.md`；本报告当前只做调研与架构建议，没有复制第三方代码。
