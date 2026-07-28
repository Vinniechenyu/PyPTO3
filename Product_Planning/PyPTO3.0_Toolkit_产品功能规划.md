# PyPTO 3.0 Toolkit 产品功能规划

> 文档版本：v1.0  
> 规划范围：下一代模型—算子开发工具  
> 规划依据：[PyPTO Issues UX 洞察报告](../Insight/pypto_ux_insights_zh（pypto仓）.md)、[PyPTO 开发者体验洞察报告](../Insight/UX_Insight_Report（pypto仓）.md)、[剩余 6 个仓库 Issues UX 洞察报告](../Insight/remaining_repos_ux_insights（剩余6个仓）.md)

---

## 1. 产品结论

PyPTO 3.0 Toolkit 不应只是“更多命令的合集”，而应成为贯穿**模型语义、算子表达、编译变换、指令生成、设备运行、正确性验证、性能优化和服务化验证**的一体化开发控制面。

它要解决的首要问题不是“代码能不能编译”，而是三件更关键的事：

1. **安全地表达意图**：高层 DSL 让开发者表达 shape、layout、并行、依赖和内存意图，减少字节计算、隐式默认和手工同步等 foot-gun。
2. **证明每一步仍然可信**：每个编译阶段都校验不变量；无法证明安全时明确失败，不能把风险静默推迟到错值、死锁或设备异常。
3. **让结果可解释、可复现、可优化**：从一行源码可追踪到 IR、PTOAS、ISA、runtime task、tensor、性能指标及 serving SLO，并能一键生成完整证据包。

### 1.1 一句话定位

> **PyPTO 3.0 Toolkit 是面向 NPU 模型与算子开发者的“意图驱动、证据贯通、默认安全”的开发与优化平台。**

### 1.2 核心价值主张

| 用户问题 | 3.0 的产品承诺 |
|---|---|
| “环境到底对不对？” | 在首次编译前给出确定答案和可执行修复建议 |
| “我的 DSL 会被怎样执行？” | 在编码时预览 shape、layout、scope、依赖和资源意图 |
| “编译成功是否意味着可信？” | 以 Pass verifier、ISA 约束和运行时哨兵建立可信链 |
| “错值从哪里开始？” | 沿 source → IR → codegen → task → tensor 自动定位首个分歧点 |
| “为什么慢？” | 将模型指标分解到 kernel、同步、内存、调度和缓存根因 |
| “调优会不会破坏正确性？” | 正确性、性能与资源预算在同一次实验中联合验收 |
| “怎样把经验复用给团队？” | 将环境、配方、基线、诊断与证据沉淀为可版本化资产 |

### 1.3 产品边界

3.0 Toolkit 负责统一工作流、诊断协议和交互体验，不替代现有核心引擎：

- `pypto`：Python DSL、IR 与编译编排；
- `PTOAS`：低层 DSL、同步、代码生成；
- `pto-isa`：机器可读的指令语义与硬件约束；
- `simpler`：runtime、调度和 DFX；
- `pypto-lib`：模型算子、模型配方与基线；
- `pypto-serving`：服务化验证与资源规划。

产品不以通用 IDE、通用模型训练平台或线上生产运维平台为目标；它聚焦“从模型/算子意图到可验证、可优化、可交付产物”的开发闭环。

---

## 2. 目标角色与真实作业流程

同一个人可能承担多个角色。产品应按“当前任务”切换视图，而不是要求用户先理解仓库边界。

### 2.1 核心角色

| 角色 | 典型目标 | 高频工作 | 当前最痛问题 | 3.0 关键能力 |
|---|---|---|---|---|
| 模型/算法工程师 | 将模型子图高效落到 NPU | 选算子、迁移模型、做多 oracle 对齐、验证 token 输出 | 错值无法判断来自模型、kernel 还是系统层 | 模型配方、分层对齐、首个分歧定位、模型级性能报告 |
| 算子开发工程师 | 编写正确且高性能的 kernel | 写 DSL、调 shape/layout、切 tile、做 fusion、跑 benchmark | API foot-gun、作用域不清、调优靠猜 | 意图式 DSL、实时语义反馈、编译卫士、性能实验室 |
| 编译器工程师 | 保证 lowering/codegen 的正确性与质量 | 开发 Pass、比对 IR、定位 miscompile、做回归 | Pass 静默丢 op、规则多份漂移、人工读 dump | Pass 契约、IR 时间旅行、规则单一事实源、属性测试入口 |
| 性能工程师 | 找到跨层瓶颈并验证优化收益 | profile、对比 CCE、分析同步/内存/调度、做参数实验 | 指标割裂、只能看到“慢”、优化不可归因 | 跨层性能因果图、可比实验、自动搜索、回归归因 |
| Runtime/DFX 工程师 | 保证设备任务稳定执行并快速取证 | 查 hang、507018、饥饿、backpressure、event/fence | 裸错误码、trace 与源码断开、采集本身会扰动 | 任务时间线、等待原因、低干扰取证、复现包 |
| 模型集成/Serving 工程师 | 将模型能力转成稳定服务 | 配容量、KV cache、并行策略、长序列测试、SLO 评估 | 能力边界不清，kernel 指标与 TTFT/TPOT 断开 | 能力矩阵、容量规划、服务就绪门禁、SLO 下钻 |
| 平台/版本维护者 | 提供可重复的开发基线 | 管版本组合、硬件矩阵、CI、文档、问题路由 | 环境差异晚暴露、知识散落于多个仓库和 issue | 环境画像、兼容矩阵、可执行文档、证据化问题路由 |

### 2.2 端到端主作业流

#### 流程 A：从模型子图到首个可信 kernel

1. 从模型图选择目标子图或选用 `prefill / decode / paged attention / RMSNorm+RoPE / MoE expert / lm_head` 配方。
2. Toolkit 读取 shape、dtype、目标硬件和精度要求，生成项目骨架、reference 与测试样例。
3. 开发者用语义化 DSL 表达计算、布局、并行和内存意图，IDE 即时提示不支持特性和危险默认。
4. 编译卫士在每个 Pass 后验证 op、依赖、作用域、liveness、layout、输出方向和 ISA 容量约束。
5. Correctness Lab 同时运行 CPU/reference、库基线、PyPTO device 等 oracle，按模型层、kernel 层和 tensor 层定位首个分歧。
6. 通过后生成带环境指纹、证据链和可复现命令的“可信基线”。

**完成标准**：不是“编译成功”，而是正确性门禁通过、风险有解释、结果可复现。

#### 流程 B：从“能跑”到性能达标

1. 选择可信基线与目标指标，例如 latency、吞吐、GM traffic、TTFT 或 TPOT。
2. Toolkit 自动采集 source、IR、PTOAS、ISA、runtime 和模型/服务层指标。
3. Performance Lab 给出按影响排序的瓶颈：sync/barrier、layout conversion、冗余 TMOV、pipe 空洞、GM round trip、slot wait、cache miss 等。
4. 开发者调整 tile/layout/fusion/parallel/memory policy，或让系统在显式搜索空间内生成候选。
5. 每个候选同时执行正确性、资源和性能门禁；展示相对可信基线的因果 diff，而不只展示一组新数字。
6. 优选方案保存为可复用 tuning recipe，并进入回归基线。

**完成标准**：性能达到目标，且优化收益可以归因、正确性未退化、资源不越界。

#### 流程 C：定位 wrong output / hang / 性能回退

1. 用户从症状入口选择“错值、全零、hang/507018、性能回退、服务不稳”，无需先判断属于哪个仓库。
2. `doctor` 先排除版本、硬件和资源配置问题，自动选择低干扰或完整取证等级。
3. `explain` 将源码 span、Pass 变化、sync、ISA 约束、task/event/fence、tensor 写读关系串成证据图。
4. 系统优先报告“首个异常”：第一个消失的 op、第一次非法复用、第一次 oracle 分歧或最早的长期等待。
5. 用户可逐层下钻，也可一键生成脱敏复现包和带证据的问题单，自动路由到责任模块。

**完成标准**：得到可行动根因或最小复现，而不是得到更多无关联日志。

#### 流程 D：从模型产物到服务就绪

1. 选择模型、硬件、精度、序列长度、并发和并行策略。
2. Capacity Planner 预测权重、workspace、KV cache、ring heap、offload 和安全余量。
3. 运行代表性 prefill/decode/长 prompt/prefix cache 场景，检查正确性与死锁保护。
4. 将 TTFT、TPOT、queue wait、cache hit、NPU memory 下钻至 kernel 和 runtime 根因。
5. 输出“服务就绪报告”：支持边界、推荐配置、容量区间、性能基线、已知限制与证据。

---

## 3. 产品设计原则

1. **Fail loud, fail early**：缺失必要语义、违反约束或存在静默错误风险时，默认中止并说明原因；危险行为不得依赖隐式默认。
2. **意图优先**：让用户表达 shape、dtype、数据流、并行和资源目标，由系统生成字节数、依赖和同步；底层控制仍可显式覆写。
3. **渐进披露**：默认给出结论、影响和下一步；需要时可下钻到 IR、汇编、ISA、task/event 和原始证据。
4. **证据而非猜测**：诊断、性能建议和 AI 辅助必须引用具体 source span、规则、trace 或实验差异，并标明置信度。
5. **自动化必须可解释**：自动 sync、layout、memory reuse、autotune 和修复建议均需说明“为何发生、代价是什么、怎样覆写”。
6. **一次采集，多层复用**：统一 artifact/correlation ID，避免各仓库生成互不关联的 dump 与报告。
7. **正确性是性能优化的门槛**：任何调优候选先过正确性与资源约束，再讨论性能排名。
8. **本地优先、可离线复现**：核心编译、诊断、报告和复现包不依赖云端；敏感模型与 tensor 默认不外发。

---

## 4. 总体产品架构

### 4.1 一个底座、三个入口、六个能力中心

**底座：Development Evidence Graph（开发证据图）**

为每次 build/run 生成统一 Run ID，并维护以下对象的稳定关联：

`model node → source span → DSL op → IR op/pass → PTOAS op/sync → ISA instruction/constraint → runtime task/event/fence → memory/tensor → metric/oracle result`

这是 3.0 区别于“命令集合”的核心数据能力，也是错值定位、性能归因、实验对比、复现和 AI 辅助的共同基础。

**三个入口**

- CLI：适合自动化、CI、远程环境和专家操作；统一采用 `pypto <verb>`。
- IDE Extension：适合编码时即时语义反馈、source 映射和局部下钻。
- Toolkit Studio：适合时间线、证据图、tensor diff、性能对比和服务容量等可视分析。

三个入口共享同一诊断协议、artifact schema 和项目配置，避免“CLI 与 GUI 结论不一致”。

**六个能力中心**

1. Workspace & Environment：项目、环境与能力画像；
2. Authoring & Compile Safety：DSL 编写、编译契约与硬件约束；
3. Trace & Debug：跨层追踪、运行时观测与复现；
4. Correctness Lab：多 oracle 与分层数值验证；
5. Performance Lab：跨层性能解释、实验与调优；
6. Model & Serving Readiness：模型配方、分布式验证与服务就绪。

### 4.2 统一产物协议

每次实验生成版本化 Manifest，至少包含：

- 源码与模型摘要、commit/pin、编译选项；
- Python、CANN、driver、runtime、PTOAS、ISA 与硬件能力指纹；
- source map、Pass 摘要/diff、PTOAS/ISA 映射；
- task graph、trace、等待原因、错误字典命中；
- oracle、tensor 摘要、精度阈值和首个分歧；
- kernel/model/serving 指标与基线差异；
- 采集等级、估算开销、脱敏状态和复现命令。

---

## 5. 功能规划

### 5.1 Workspace Hub：项目与环境控制面

**目标**：让开发者在写代码前就知道“环境是否可用、能力边界是什么、结果能否复现”。

核心功能：

- `pypto init`：按角色/任务创建 kernel、model-op、distributed、serving 四类项目模板；
- `pypto doctor`：检查 imports、pins、submodules、CANN/driver、runtime、PTOAS、ISA overlay、A2/A3/A5 能力与最小 smoke test；
- Compatibility Profile：显示“当前组合已验证/有风险/不支持”，并给出精确修复命令；
- Resource Preflight：在运行前估算 GM、UB、workspace、ring heap、dependency pool 与 KV cache；
- Capability Matrix：按平台、精度、控制流、指令、并行策略展示支持状态；
- Environment Lock：导出可版本化环境清单，作为 CI、复现与共享实验的输入；
- 错误信息统一为 `code + name + impact + likely cause + evidence + next action`。

先进体验：

- Doctor 不只判断“组件存在”，还执行端到端能力探针；
- 资源配置从“手填环境变量”升级为自动推荐、预算预览和显式覆写；
- 用户从症状进入，工具自动映射到模块，不暴露仓库组织成本。

### 5.2 Intent Studio：意图驱动的 DSL 开发体验

**目标**：减少因 API 人机工程、类型噪声和隐式语义导致的反复改写与错误。

核心功能：

- 官方 type stubs / type checker 插件，理解 `Scalar`、Tensor、shape、dtype、memory space 与 distributed context；
- 语义化内存 API，如 `alloc(shape, dtype, space, lifetime=...)`，由系统推导字节和对齐；
- Language Feature Lens：在 IDE 中即时说明控制流、dynamic shape、split、scope 在目标平台是否支持；
- Intent Preview：编码时预览 shape/layout、读写集合、依赖、并行域和资源估算；
- Edit-locality 设计：调度、布局、memory policy 与计算主体分离，允许局部替换；
- 安全的 escape hatch：专家可覆写 sync/layout/ISA，但必须记录原因并进入风险审计；
- 真实任务模板：Flash Attention、GEMM、paged attention、MoE、RoPE/RMSNorm 等，而非仅玩具示例。

### 5.3 Compile Guardian：编译可信与约束中心

**目标**：把错值、全零、丢写、陈旧读和硬件越界前移为可读的编译期诊断。

核心功能：

- Pass Contract：每个 Pass 声明输入/输出不变量、允许变化和保留语义；
- Pass 后 verifier：检查 op/输出守恒、作用域、use-def、依赖完整性、alias、liveness、buffer reuse、layout、memory space；
- Known Hazards Pack：覆盖 overlapping store、lost dependency、invalid split、detached output、multi-Out 丢写、WAR/WAW/RAW 风险；
- Codegen Completeness Gate：信息缺失时禁止以默认 layout/stride/memory space 继续生成；
- Machine-readable ISA Constraints：容量、validRow、同步/wait、平台差异和 errata 自动上浮到诊断；
- Rule Registry：shape/layout/type/ISA 规则单一事实源，供 Python、C++、文档、IDE 和 verifier 共同消费；
- 诊断采用“源码位置—规则—影响—最小修复—可选下钻”结构，并区分 error/warning/info。

关键决策：

- 默认安全模式下，无法证明安全即失败；
- 兼容旧行为必须显式使用 legacy profile，并输出迁移清单；
- 每条 suppress 都需要规则 ID、理由和作用域，避免 `ignore all`。

### 5.4 Provenance Explorer：跨层可追踪与 IR 时间旅行

**目标**：让用户快速回答“我的 op 在哪一步消失、改变或变慢”。

核心功能：

- Source-to-runtime 双向导航：从源码下钻，也能从错误 task/fence 返回源码；
- Pass Timeline：按 Pass 展示 op、shape、layout、scope、dependency 和 resource 变化；
- Semantic Diff：高亮消失/新增 op、输出改向、layout/valid_shape 改变、同步增减，而非纯文本 diff；
- 首个异常定位：优先找到最早违反契约或开始偏离基线的阶段；
- Sync Explain：解释每条自动 sync 的依赖来源、作用域、管线和预计开销；
- Runtime Timeline：submit、queue、dep wait、dispatch、run、finish、backpressure，全程显示“正在等什么”；
- 证据强度分层：确定根因、强相关线索、待验证假设清晰区分。

建议命令：

```text
pypto explain <run|source|dump|error-code>
pypto diff <baseline-run> <candidate-run>
pypto trace report <run-id>
```

### 5.5 Correctness Lab：分层正确性验证

**目标**：把“端到端输出不对”变成可定位的首次数值分歧。

核心功能：

- 多 oracle：CPU/reference、CCE/library baseline、PyPTO simulator、PyPTO device、serving output；
- Oracle Independence 提示：当 golden 与被测路径共享实现时提示盲区；
- 分层对齐：token → model node → kernel output → intermediate tensor；
- 数值策略：按 dtype/op 配置 atol/rtol/ULP、NaN/Inf、分布漂移与非确定性重复测试；
- Runtime Sentinel：debug 模式检测未初始化读、全零异常、越界、陈旧版本、丢写和异常重复 token；
- Tensor Diff：统计摘要优先，可按需采样/下钻，支持定位首次异常 index 与来源 producer；
- 自动 delta debugging：在保留失败的前提下裁剪 shape、op、Pass 或输入，生成最小复现；
- Correctness Gate：可信基线、调优候选和发布产物使用同一验收规则。

### 5.6 Performance Lab：跨层性能解释与安全调优

**目标**：从“哪个数字慢”升级为“为什么慢、改什么、收益是否真实”。

核心功能：

- 统一四层指标：
  - kernel：latency、pipe/sublane utilization、sync/barrier、layout conversion、冗余 move；
  - runtime：queue/dispatch wait、slot、fairness、backpressure、task overlap；
  - model：kernel 占比、GM round trip、fusion、CCE baseline gap；
  - serving：TTFT、TPOT、prefill/decode/output throughput、cache hit、NPU memory；
- Bottleneck Causal View：将高层回退映射到具体源码、Pass、sync、memory 或调度变化；
- Experiment Board：固定环境与输入，对多个候选做可重复 A/B 对比，显示置信区间与噪声；
- Performance Budget：为 kernel/model/serving 设置目标和分层预算；
- Safe Autotune：只在用户声明的 tile/layout/fusion/parallel 搜索空间内探索，候选必须通过正确性和资源门禁；
- Recipe：保存搜索空间、约束、获胜配置、适用 shape/platform 与证据；
- 回归归因：自动回答性能变化主要来自源码、编译器、runtime、环境还是测量噪声。

AI 辅助定位应建立在证据图上：建议必须引用指标和对应工件，不允许只根据日志文本生成无依据结论。

### 5.7 Distributed & Orchestration Builder

**目标**：让 TP/EP/MoE 的通信与条件调度可表达、可验证、可视化。

核心功能：

- 在 DSL 中一等表达 collectives、window buffer、signal、dispatch predicate 与 skip-empty-expert；
- HOST/CHIP/CORE_GROUP 拓扑与 task dependency flow 可视化；
- DistributedTensor 携带 rank、context、provenance、alias 与生命周期；
- 跨 rank verifier：collective 配对、shape/context 一致性、非法 merge、死锁环和资源冲突；
- 通信—计算 overlap 时间线与收益解释；
- 单卡仿真、多卡仿真、真机验证的 conformance matrix，明确各自能证明什么。

### 5.8 Runtime Observatory & Repro Center

**目标**：在低扰动前提下定位 hang、异常码、调度饥饿和资源耗尽。

核心功能：

- 两档采集：低干扰常开模式、完整取证模式；启动前展示预计开销和 backpressure 风险；
- Error Dictionary：统一 507018、scheduler stall、SIGSEGV、ISA errata 等错误的含义和下一步；
- Hang Detector：识别 requeue forever、slot starvation、event/fence 环、task-ring heap 风险；
- 资源水位与自动保护：ring heap、dep pool、dump buffer、GM、KV cache 达阈值前告警或降级；
- 一键 Repro Bundle：环境指纹、命令、最小源码、artifact manifest、task graph、trace、错误、输入摘要；
- 脱敏策略：tensor 默认仅保存 shape/dtype/hash/statistics，原值需显式授权；
- Issue Router：按症状和证据自动选择责任模块、填充模板、提示缺失证据。

### 5.9 Model Recipe Hub & Serving Readiness

**目标**：缩短模型迁移周期，并建立从 kernel 产物到服务能力的验收路径。

核心功能：

- Model Recipe：prefill、decode、paged attention、RMSNorm+RoPE、MoE expert、lm_head；
- 每个 recipe 包含适用模型/shape/平台、reference、精度阈值、性能基线、已知限制和调优点；
- 模型子图导入与 pattern matching，生成可编辑的实现骨架，而非不可解释的黑盒代码；
- Model Correctness Harness：token、节点、kernel 和 tensor 多层对齐；
- Serving Capability Matrix：模型、硬件、精度、batching、prefix cache、KV offload、parallel、quant、API；
- Capacity Planner：基于模型、batch、seq length、KV dtype、parallel strategy 估算容量、安全余量和降级策略；
- Serving Readiness Gate：长 prompt、chunked prefill、prefix cache cold/hit/miss、并发、资源回收与 SLO；
- 输出可交付的服务就绪报告，并能下钻到 kernel/runtime 证据。

### 5.10 Developer Portal & Knowledge Loop

**目标**：按任务提供可信入口，让解决问题的证据自动沉淀为可复用知识。

核心功能：

- 顶层架构与角色路径，不要求用户先理解七个仓库；
- Quickstart、DSL 心智模型、依赖/调度、分布式、错值、hang、性能与 serving 七类任务式指南；
- 文档签名、指令与示例从规则/源码生成，并在 CI 真机或仿真执行；
- 报告中的规则 ID、错误码、known errata 可直接跳转对应文档；
- 已解决复现包可抽取为回归用例和故障条目，经人工审核后发布；
- 版本化迁移助手：展示 breaking change、自动修复建议和仍需人工处理的语义差异。

---

## 6. 关键交互设计

### 6.1 统一“运行详情页”

每个 Run 不是一堆目录，而是一个可共享、可比较的对象，默认只显示：

- 状态：环境、编译、正确性、资源、性能五个门禁；
- 首要结论：最可能阻塞用户的 1—3 个问题；
- 影响：错值风险、不可复现风险或预计性能损失；
- 下一步：可执行命令、源码修复或建议实验；
- 证据：可下钻的 source/IR/trace/tensor/metric 链。

### 6.2 三层信息密度

| 层级 | 面向场景 | 展示内容 |
|---|---|---|
| L1 结论层 | 模型工程师、首次使用者 | 发生了什么、影响什么、下一步做什么 |
| L2 工程层 | 算子/性能/Runtime 工程师 | shape/layout、Pass diff、依赖、timeline、指标归因 |
| L3 专家层 | 编译器/ISA 专家 | 原始 IR、PTOAS、汇编、ISA constraint、event/fence、原始 trace |

### 6.3 诊断信息标准

每条诊断包含：

```text
[严重度] [稳定规则 ID] 一句话结论
位置：用户源码 span
影响：可能导致的错值、hang 或性能代价
依据：违反的不变量 / ISA 约束 / trace 事实
建议：最小修改或下一步命令
下钻：相关 IR、task、tensor、文档
```

### 6.4 自动化的用户控制权

- 自动修复默认只生成 diff，不直接改写用户代码；
- autotune 必须显示搜索空间、预算、停止条件和被淘汰原因；
- 自动 sync/layout/memory 决策均可查看理由并锁定；
- AI 结论区分“事实、推断、建议”，并允许一键验证推断；
- 所有自动决策写入 manifest，确保团队复现相同结果。

---

## 7. 分阶段路线图

优先级依据不是功能新颖度，而是“降低静默错误风险 × 贯穿角色数量 × 对后续能力的基础性”。

### Phase 0：可信底座（0—3 个月）

**目标**：先止住信任流失，并建立后续跨层体验的公共协议。

- 统一 Run ID、artifact manifest、source span 与 correlation ID；
- `pypto doctor`、兼容矩阵、最小 smoke test、资源建议；
- Pass verifier 框架与首批高危规则：op/输出守恒、scope、use-def、layout/memory 完整性；
- 统一诊断格式与 error dictionary；
- CLI 的 `explain` 最小闭环：source ↔ Pass diff ↔ error；
- 可执行 Quickstart 与基础 CI 门禁。

**退出标准**：高危静默行为能在编译期被拦截；任何运行产物都有稳定身份与可复现环境摘要。

### Phase 1：正确性与调试闭环（3—6 个月）

**目标**：将跨层定位从“专家考古”变为标准工作流。

- Evidence Graph v1 与 Provenance Explorer；
- Pass Timeline / Semantic Diff / 首个异常定位；
- 依赖、liveness、buffer reuse、multi-Out、WAR/WAW/RAW verifier；
- Runtime Sentinel 与低干扰 task timeline；
- Correctness Lab：CPU/reference + library + device 多 oracle；
- Repro Bundle、脱敏与 Issue Router；
- IDE 中的 source 诊断与下钻入口。

**退出标准**：典型 wrong output/hang 案例可自动定位到首个异常阶段，并生成可重放证据包。

### Phase 2：性能与模型规模化（6—12 个月）

**目标**：让真实模型的优化可解释、可复用。

- 四层统一性能 schema 与 Performance Lab；
- sync explain、pipeline/memory/runtime 因果分析；
- 可信 A/B 实验、性能预算、回归归因；
- Safe Autotune 与 tuning recipe；
- Model Recipe Hub 与模型分层正确性；
- 分布式 context verifier 与 task/communication 可视化；
- Studio 桌面/网页可视分析体验。

**退出标准**：真实模型 kernel 可在同一工作流完成正确性、性能归因和方案复用。

### Phase 3：服务就绪与智能开发（12—18 个月）

**目标**：把经过验证的模型—算子产物可靠地推向服务场景。

- Capacity Planner、KV cache dashboard、长序列 guard；
- Serving Readiness Gate 与 SLO → runtime → kernel 下钻；
- 基于证据图的诊断/优化 Agent，支持“提出假设—运行验证—提交建议”；
- 跨版本迁移助手、组织级 recipe/规则治理；
- 仿真—真机 ISA conformance matrix 与硬件差异知识库。

**退出标准**：模型产物可输出带容量、SLO、已知限制和完整证据的服务就绪报告。

---

## 8. MVP 定义

MVP 必须形成闭环，不能只交付分散命令。

### 8.1 MVP 用户故事

> 算子工程师拿到一个输出全零的 kernel，在同一个项目中运行 `doctor` 排除环境问题；编译卫士指出或缩小到首个异常 Pass；用户从源码查看 semantic diff 和依赖证据；Correctness Lab 对比 reference 定位首个异常 tensor；最后一键生成可重放的复现包。

### 8.2 MVP 功能包

- Workspace manifest 与 Run ID；
- `pypto doctor` + 资源 preflight；
- 统一诊断协议；
- Pass verifier SDK + 10—15 条高危规则；
- source span 保留、Pass timeline、相邻 Pass semantic diff；
- CPU/reference 与 device 双 oracle；
- task/event 基础 timeline；
- `pypto explain` 聚合报告；
- reproducible bundle；
- IDE 诊断跳转或最小本地报告页。

### 8.3 不纳入首版 MVP

- 全自动通用算子生成；
- 无边界的 AI 自动改代码；
- 大规模 autotune 调度平台；
- 完整 serving 运维 dashboard；
- 覆盖所有 ISA 与所有历史错误码。

---

## 9. 产品指标与验收

### 9.1 北极星指标

> **从首次运行到“可信达标产物”的中位时间（Time to Trusted Target, TTTT）**

“可信达标”同时要求：环境可复现、正确性门禁通过、目标性能/资源预算达标、证据完整。

### 9.2 核心结果指标

| 维度 | 指标 | 12 个月建议目标 |
|---|---|---:|
| 上手 | 新环境首次 smoke test 成功率 | ≥ 90% |
| 上手 | 环境问题中能给出可执行修复建议的比例 | ≥ 90% |
| 可信 | 已知高危静默错误被编译期/运行时门禁捕获比例 | ≥ 80% |
| 调试 | wrong output 的首个异常阶段自动定位率 | ≥ 70% |
| 调试 | 典型错值/hang 的中位定位时间 | 降低 60% |
| 复现 | 问题单首次提交即具备完整环境与证据的比例 | ≥ 85% |
| 性能 | 性能回退可归因到具体层级的比例 | ≥ 75% |
| 效率 | 从可信 baseline 到达性能目标的实验次数 | 降低 40% |
| 文档 | Quickstart/示例 CI 可执行通过率 | 100% |
| 体验 | 裸错误码占 runtime 用户可见错误的比例 | < 5% |

### 9.3 护栏指标

- verifier 编译时延增幅：默认模式目标 < 10%；重检查可在 CI/debug profile 开启；
- 低干扰 trace 性能开销：目标 < 3%；完整取证必须在启动前明确预计开销；
- 诊断假阳性率：高危 error 级规则目标 < 1%；
- autotune 产生但未过正确性门禁的候选不得进入性能排名；
- 默认复现包不得包含原始模型权重或完整敏感 tensor。

---

## 10. 平台依赖与组织协同

| 公共依赖 | 责任建议 | 首个交付物 |
|---|---|---|
| Artifact/diagnostic schema | Toolkit 架构组牵头，各仓共建 | versioned manifest 与稳定 Rule ID |
| Source/provenance ID | pypto + PTOAS + simpler | source/IR/task 双向映射最小链路 |
| ISA constraint registry | pto-isa | machine-readable capacity/platform/errata schema |
| Pass contract/verifier SDK | pypto 编译器团队 | 高危 Pass 接入模板与 CI 门禁 |
| Runtime trace protocol | simpler | task/event/fence/wait-reason 标准事件 |
| Oracle/benchmark protocol | pypto-lib | 可复用 correctness 与 performance case schema |
| Serving metric/capacity schema | pypto-serving | TTFT/TPOT/KV/resource 标准定义 |
| Developer Portal | 顶层文档仓 | 角色路径、故障入口、可执行示例 |

建议设立跨仓“Developer Contract Review”：任何新增 DSL 特性、Pass、ISA 约束或 runtime 事件，都需要同时评审其诊断、可追踪性、文档和回归证据，避免 3.0 再次形成层间知识漂移。

---

## 11. 主要风险与应对

| 风险 | 表现 | 应对 |
|---|---|---|
| 只统一 UI，不统一数据 | 页面好看但仍无法跨层定位 | 优先交付 manifest、ID、schema，再扩展界面 |
| verifier 假阳性导致用户关闭检查 | 诊断噪声重演 type checker 问题 | error 规则高精度门槛；低置信度降为 warning；提供最小复现 |
| trace 开销改变问题本身 | full dump 引发 backpressure/deadlock | 两档采集、预算预估、环形缓冲与自监控 |
| 自动化不可解释 | 用户不信任 sync/autotune/AI 结果 | 所有决策绑定证据、成本与覆写路径 |
| 规则单一事实源推进困难 | Python/C++/文档继续各写一份 | schema 先覆盖最高风险 layout/type/ISA 规则，并设 CI 漂移门禁 |
| 产品范围过大 | 同时做 IDE、Studio、serving 导致无闭环 | 以 wrong output MVP 主线交付，入口可简、证据链必须完整 |
| 专家工具对新用户仍过载 | 大量 IR/trace 信息造成理解负担 | 严格执行 L1/L2/L3 渐进披露与任务式入口 |

---

## 12. 需求追溯矩阵

| 洞察证据 | 规划响应 |
|---|---|
| 静默误编译、Pass 丢 op、全零/错值 | Compile Guardian、Pass Contract、Correctness Gate |
| C++/Python 的 layout/type 规则漂移 | Rule Registry 与 machine-readable constraints |
| 环境、版本、heap 配置晚暴露 | Doctor、Compatibility Profile、Resource Preflight |
| 调试依赖人工逐 Pass 读 dump | Evidence Graph、Pass Timeline、Semantic Diff |
| runtime 裸错误码、hang、饥饿、backpressure | Error Dictionary、Runtime Timeline、Hang Detector |
| 模型错值跨 pypto/PTOAS/runtime/lib | 多 oracle、分层 tensor 对齐、首个分歧定位 |
| 性能指标跨 kernel/runtime/model/serving 割裂 | 四层指标 schema、因果视图、可信 A/B 实验 |
| PTODSL/ISA 能力边界和文档不清 | Capability Matrix、Intent Preview、可执行文档 |
| TP/EP/MoE provenance 和通信约束复杂 | DistributedTensor provenance、跨 rank verifier |
| KV cache、长 prompt、容量与 SLO 风险 | Capacity Planner、Serving Readiness Gate |
| 多仓库职责与 issue 路由不清 | 症状式入口、Repro Bundle、Issue Router、Developer Portal |

---

## 13. 最终产品判断

PyPTO 3.0 的先进性不应体现在“加入一个 AI 聊天框”，而应体现在系统本身具备以下能力：

- **知道开发者想表达什么**，而不只接受底层参数；
- **知道每一步应该保持什么不变量**，而不是编译后把风险交给设备；
- **知道一个结果从哪里来**，能够沿完整证据链解释；
- **知道一次优化为什么有效**，并能证明它没有破坏正确性；
- **知道何时信息不足**，明确告诉用户，而不是静默猜测。

因此，3.0 的首要建设顺序应是：**可信编译底座 → 跨层证据链 → 正确性闭环 → 性能因果与安全调优 → 模型/服务规模化**。只有这个顺序，才能把现有多个强大但割裂的仓库能力，真正升级成下一代模型—算子开发产品。
