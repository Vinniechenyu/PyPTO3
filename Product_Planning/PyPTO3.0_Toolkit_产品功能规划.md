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

产品不以通用 IDE、通用模型训练平台或生产集群运维平台为目标；它聚焦“从模型/算子意图到可验证、可优化、可部署的推理产物”的开发闭环。服务化能力覆盖本地与多卡推理服务的构建、配置、压测、诊断和发布验收，但不替代生产环境中的通用容器编排、租户计费和全局运维系统。

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
| 模型集成工程师 | 将完整模型接入并跑通推理 | 导入权重/配置、映射算子、验证 tokenizer/采样、比较生成结果 | 能跑 kernel 不等于能跑模型，模型接入链路缺少统一验证 | 模型导入向导、Inference Runner、算子覆盖分析、端到端输出对齐 |
| 推理服务工程师 | 将模型能力转成稳定服务 | 配置 batching、KV cache、并行策略，压测长序列和并发，评估 SLO | 能力边界不清，服务配置靠经验，kernel 指标与 TTFT/TPOT 断开 | Service Builder、容量规划、请求级追踪、服务就绪门禁、SLO 下钻 |
| 推理应用开发者 | 调用和验证模型推理 API | 发起对话/补全请求、切换采样参数、做流式与批量测试 | 不清楚模型支持边界、失败原因和响应质量 | Playground、SDK/API 示例、请求重放、输出质量与延迟对比 |
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

#### 流程 D：从模型产物到可用推理

1. 从模型目录或标准模型包导入配置、权重、tokenizer 和 generation config，识别模型架构、精度及算子覆盖情况。
2. Toolkit 将模型节点匹配到 PyPTO 实现或 fallback，并提前列出缺失算子、不支持精度和目标硬件限制。
3. 使用 Inference Runner 运行单 prompt、对话、多轮、批量和数据集推理，覆盖 greedy、sampling、beam 等已支持解码策略。
4. 对齐 reference/library 与 PyPTO 的 logits、token、停止条件和最终文本，定位首个模型节点或 decode step 分歧。
5. 记录模型、权重、tokenizer、算子实现、编译产物和运行参数的完整版本关系，形成可发布的 Inference Bundle。

**完成标准**：模型能够在目标设备上稳定生成正确结果，算子覆盖、fallback、精度差异和资源消耗全部可见。

#### 流程 E：从可用推理到可交付服务

1. 从 Inference Bundle 创建服务项目，选择 API 协议、设备拓扑、并行策略、batching、KV cache、量化与流式输出策略。
2. Capacity Planner 预测权重、workspace、KV cache、ring heap、offload、安全余量以及在不同序列长度/并发下的容量边界。
3. 一键启动开发服务，在 Playground 或 SDK 中执行同步、流式、批量和并发请求，并支持请求保存与重放。
4. Workload Lab 运行 prefill/decode、长 prompt、prefix cache cold/hit/miss、突发流量、取消请求和资源回收场景。
5. 将 TTFT、TPOT、queue wait、batch efficiency、cache hit、NPU memory 下钻至模型节点、kernel 和 runtime 根因。
6. 通过正确性、稳定性、容量、性能和兼容性门禁后，输出可版本化部署清单、推荐配置及服务就绪报告。

**完成标准**：服务在声明的模型、硬件、流量和序列长度边界内满足 SLO，且每次请求可追踪、问题可重放、发布配置可复现。

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

### 4.1 一个底座、三个入口、七个能力中心

**底座：Development Evidence Graph（开发证据图）**

为每次 build/run 生成统一 Run ID，并维护以下对象的稳定关联：

`request/session → model/token/decode step → model node → source span → DSL op → IR op/pass → PTOAS op/sync → ISA instruction/constraint → runtime task/event/fence → KV/memory/tensor → metric/oracle result`

这是 3.0 区别于“命令集合”的核心数据能力，也是错值定位、性能归因、实验对比、复现和 AI 辅助的共同基础。

**三个入口**

- CLI：适合自动化、CI、远程环境和专家操作；统一采用 `pypto <verb>`。
- IDE Extension：适合编码时即时语义反馈、source 映射和局部下钻。
- Toolkit Studio：适合时间线、证据图、tensor diff、性能对比和服务容量等可视分析。

三个入口共享同一诊断协议、artifact schema 和项目配置，避免“CLI 与 GUI 结论不一致”。

**七个能力中心**

1. Workspace & Environment：项目、环境与能力画像；
2. Authoring & Compile Safety：DSL 编写、编译契约与硬件约束；
3. Trace & Debug：跨层追踪、运行时观测与复现；
4. Correctness Lab：多 oracle 与分层数值验证；
5. Performance Lab：跨层性能解释、实验与调优；
6. Model Inference：模型接入、推理运行、生成质量与端到端验证；
7. Serving Engineering：服务构建、容量规划、负载实验、请求诊断与发布验收。

### 4.2 统一产物协议

每次实验生成版本化 Manifest，至少包含：

- 源码与模型摘要、commit/pin、编译选项；
- Python、CANN、driver、runtime、PTOAS、ISA 与硬件能力指纹；
- source map、Pass 摘要/diff、PTOAS/ISA 映射；
- task graph、trace、等待原因、错误字典命中；
- oracle、tensor 摘要、精度阈值和首个分歧；
- 模型权重/tokenizer/generation config 指纹、算子覆盖与 fallback 清单；
- 服务配置、请求负载、request/session ID、batch/KV cache 生命周期与响应摘要；
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

### 5.9 Model Inference Studio：模型接入与推理开发

**目标**：让开发者从“已有高性能 kernel”自然走到“完整模型能够正确推理”，缩短模型适配、输出验证和问题定位周期。

#### 模型接入与兼容性分析

- Model Importer：导入模型配置、权重索引、tokenizer、generation config 与自定义模型代码；
- Architecture Detector：识别 attention、MoE、RoPE、norm、MLP、lm_head、KV cache 等关键结构；
- Operator Coverage Report：逐模型节点显示 PyPTO native、融合实现、库实现、fallback 或 unsupported，并评估 fallback 的性能影响；
- Precision & Quantization Profile：展示 FP16/BF16/INT8/FP8 等已支持精度、混合精度边界、量化参数和校准要求；
- Model Recipe：提供 prefill、decode、paged attention、RMSNorm+RoPE、MoE expert、lm_head 等可组合配方；
- 每个 recipe 包含适用模型/shape/平台、reference、精度阈值、性能基线、已知限制和调优点；
- 模型子图 pattern matching 生成可编辑实现骨架，并保留从模型节点到 PyPTO 源码的映射。

#### Inference Runner

- 支持单样本、交互式对话、批量数据集和回归集四种运行方式；
- 统一输入输出：prompt、token IDs、embedding 输入，以及 text、token、logits/logprobs 等可配置输出；
- 支持同步与流式生成，并在能力矩阵中明确 greedy、temperature/top-k/top-p、beam、停止词等解码策略的支持状态；
- 支持 prefill-only、decode-only、prefill+decode 分段运行，便于独立验证与性能分析；
- 支持固定随机种子、确定性 profile 和请求重放，区分采样差异与系统错误；
- 保存每次推理的 Model Run：模型/权重/tokenizer 版本、输入、generation 参数、编译产物、设备配置、输出和指标。

建议命令：

```text
pypto model inspect <model-path>
pypto infer --model <model-path> --prompt <text>
pypto infer --model <model-path> --dataset <file> --report
pypto model bundle <validated-run>
```

#### 模型级正确性与输出质量

- Model Correctness Harness：reference/library、PyPTO simulator、PyPTO device 与 serving 路径多 oracle 对齐；
- 从 logits → sampled token → stop condition → final text 逐 decode step 定位首个分歧；
- 从异常 token 回溯到模型节点、kernel output 和 intermediate tensor；
- 检测重复文本、提前/延迟停止、非法 token、NaN/Inf、KV cache 污染、prefix 丢写和多轮上下文漂移；
- 数据集评测采用可插拔 evaluator，支持任务正确率、文本质量和性能联合报告；
- 对随机采样场景使用分布和统计一致性指标，避免把非确定性误判为错误。

#### Inference Bundle

通过门禁的模型生成自描述推理包，至少包含：

- 模型、权重、tokenizer 与 generation config 指纹；
- 目标硬件、精度、并行与内存要求；
- PyPTO 编译产物、算子实现版本和 fallback 清单；
- 正确性/质量基线、性能基线和已知限制；
- 本地运行、服务启动、回归验证和回滚所需的版本化配置。

### 5.10 Serving Engineering Studio：推理服务构建与验证

**目标**：让模型推理能力能够以稳定 API 对外提供，并在发布前完成容量、性能、稳定性和兼容性验证。

#### Service Builder

- 从 Inference Bundle 一键生成本地单卡、多卡或多实例服务配置；
- API Profile：声明 completion/chat、同步/流式、batch、健康检查、模型信息和错误返回等协议能力；
- 自动生成 Python/C++ 客户端示例和可执行请求，支持应用开发者快速联调；
- 配置设备拓扑、TP/EP、worker 数量、continuous/dynamic batching、最大 batch/token、调度优先级和超时；
- 配置 KV cache block、prefix cache、量化、offload、chunked prefill 和 speculative decoding 等已支持策略；
- 配置校验器在启动前检查模型能力、硬件、并行、内存和 API 组合是否合法；
- 支持 service profile 的版本化、diff、复制、导入和回滚。

建议命令：

```text
pypto serve --bundle <inference-bundle> --profile <service-profile>
pypto serve plan --model <model> --traffic <workload>
pypto serve benchmark --endpoint <url> --workload <workload>
pypto serve explain <request-id>
pypto serve report <service-run>
```

#### Playground 与应用联调

- 内置 Chat/Completion Playground，可调整 system prompt、采样参数、最大输出长度和停止条件；
- 实时显示首 token 时间、token 间延迟、累计 token、停止原因和服务错误；
- 支持同步/流式结果并排对比、不同 service profile A/B 测试；
- 保存、分享和重放请求，自动隐藏敏感 prompt；
- 从异常响应直接进入 request trace，无需先搜索服务日志。

#### Capacity Planner 与部署配置

- 输入模型、硬件、精度、并行策略、最大序列长度、输入/输出长度分布、并发和 SLO；
- 估算权重、workspace、KV cache、ring heap、dependency pool、host memory、offload 与安全余量；
- 输出可服务的 batch/concurrency/token 区间，以及可能首先耗尽的资源；
- 对 prefix cache、chunked prefill、KV offload 和不同并行策略做情景比较；
- 给出推荐配置、降级策略和拒绝策略，并清楚标明推算值与实测值；
- 生成可交付的服务配置清单，供外部部署/运维系统消费。

#### Workload & Benchmark Lab

- 内置交互式、离线批处理、均匀到达、突发流量、长短请求混合和多轮会话等负载模型；
- 覆盖 cold start/warmup、长 prompt、prefix cache cold/hit/miss、请求取消、超时、过载和资源回收；
- 指标包括 TTFT、TPOT、端到端延迟、prefill/decode/output throughput、goodput、queue wait、batch efficiency、cache hit、NPU memory；
- 同时报告 P50/P90/P99 与错误率，避免均值掩盖尾延迟和不稳定性；
- 支持同配置下与 reference/library/其他服务基线对比，并锁定模型、数据、采样和硬件条件；
- 将服务指标回溯到模型节点、kernel latency、runtime queue、sync、memory traffic 和 KV cache 事件。

#### 请求级可观测与故障诊断

- 为 request、sequence、batch、prefill/decode step、KV block、runtime task 建立统一 correlation ID；
- Request Timeline 展示 admission、queue、batch formation、prefill、decode、streaming 和 finish/cancel；
- Batch Inspector 解释请求为何被合批、延迟或拆分，以及 padding/token 浪费；
- KV Cache Inspector 展示分配、命中、复用、碎片、eviction、offload、泄漏和生命周期；
- 自动识别 OOM、task-ring heap deadlock、调度饥饿、长请求阻塞、cache thrashing 和设备异常；
- 对单请求执行 `serve explain`，给出用户可见错误、服务层原因与 kernel/runtime 证据；
- 一键生成包含请求负载、服务配置、trace 和环境指纹的脱敏服务复现包。

#### 弹性与服务就绪门禁

- 支持启动、warmup、优雅停止、请求 drain、worker 异常恢复和资源释放验证；
- 支持过载保护：最大在途 token、队列上限、超时、取消、背压和明确拒绝原因；
- 验证服务重启、配置切换、模型重载时不会污染 KV cache 或复用陈旧编译产物；
- Serving Readiness Gate 覆盖 API 兼容、模型正确性、并发稳定性、容量、安全余量、SLO 和长稳测试；
- 输出服务就绪报告：支持边界、推荐配置、容量曲线、SLO 结果、已知风险、证据和回滚配置；
- 3.0 Toolkit 交付发布清单和证据，不承担生产集群的自动扩缩容、租户治理、计费与告警值守。

### 5.11 Developer Portal & Knowledge Loop

**目标**：按任务提供可信入口，让解决问题的证据自动沉淀为可复用知识。

核心功能：

- 顶层架构与角色路径，不要求用户先理解七个仓库；
- Quickstart、DSL 心智模型、依赖/调度、分布式、错值、hang、性能、模型推理和 serving 九类任务式指南；
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

### 6.5 统一“推理与服务实验页”

模型推理和服务压测使用同一种实验对象，避免模型验证、性能报告与服务日志彼此割裂：

- 左侧固定显示模型/权重/tokenizer、设备、精度、并行和 service profile；
- 中央按需切换 Output、Request Timeline、Batch、KV Cache、Model Graph 和 Kernel Trace；
- 顶部同时显示正确性、稳定性、容量、SLO 和兼容性五个服务门禁；
- 任一异常 token、长尾请求或失败 batch 均可下钻到模型节点、kernel 与 runtime 事件；
- 两次实验可以比较输出、服务配置、容量、P50/P99、吞吐和底层根因；
- 支持将当前实验固化为 Inference Bundle、service profile、回归用例或脱敏复现包。

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
- Model Importer、算子覆盖报告与最小 Inference Runner（单 prompt、prefill+decode、流式输出）；
- logits/token/decode step 基础对齐与 Model Run manifest；
- Repro Bundle、脱敏与 Issue Router；
- IDE 中的 source 诊断与下钻入口。

**退出标准**：典型 wrong output/hang 案例可自动定位到首个异常阶段，并生成可重放证据包；至少一个目标模型可通过统一入口完成端到端推理和输出验证。

### Phase 2：模型推理与服务化闭环（6—12 个月）

**目标**：让真实模型的优化可解释、可复用，并能以稳定开发服务完成应用联调和发布前验证。

- 四层统一性能 schema 与 Performance Lab；
- sync explain、pipeline/memory/runtime 因果分析；
- 可信 A/B 实验、性能预算、回归归因；
- Safe Autotune 与 tuning recipe；
- Model Recipe Hub 与模型分层正确性；
- 完整 Inference Runner、Inference Bundle 与批量/数据集评测；
- Service Builder、API/SDK、Playground 与版本化 service profile；
- Capacity Planner、基础 KV Cache Inspector 与 Workload Lab；
- 请求级 correlation ID、TTFT/TPOT/P99 及 SLO → runtime → kernel 下钻；
- Serving Readiness Gate v1：正确性、API、容量、性能和基础稳定性；
- 分布式 context verifier 与 task/communication 可视化；
- Studio 桌面/网页可视分析体验。

**退出标准**：真实模型可在同一工作流完成推理正确性、性能归因、服务启动、应用联调、代表性负载压测和服务就绪报告。

### Phase 3：高级服务工程与智能开发（12—18 个月）

**目标**：把经过验证的模型—算子产物可靠地推向服务场景。

- 多实例/多卡服务实验、完整 KV cache dashboard、长序列与过载 guard；
- continuous batching、prefix/offload、chunked prefill 等策略的情景模拟与自动推荐；
- 长稳、故障恢复、配置切换、模型重载和服务回滚验证；
- Serving Readiness Gate v2 与可供外部部署系统消费的发布清单；
- 基于证据图的诊断/优化 Agent，支持“提出假设—运行验证—提交建议”；
- 跨版本迁移助手、组织级 recipe/规则治理；
- 仿真—真机 ISA conformance matrix 与硬件差异知识库。

**退出标准**：模型产物可输出带容量曲线、尾延迟、稳定性、SLO、已知限制、回滚配置和完整证据的服务就绪报告。

---

## 8. MVP 定义

MVP 必须形成闭环，不能只交付分散命令。

### 8.1 MVP 用户故事

> 算子工程师拿到一个输出全零的 kernel，在同一个项目中运行 `doctor` 排除环境问题；编译卫士指出或缩小到首个异常 Pass；用户从源码查看 semantic diff 和依赖证据；Correctness Lab 对比 reference 定位首个异常 tensor；最后一键生成可重放的复现包。

> 模型集成工程师导入一个目标模型，Toolkit 展示算子覆盖和不支持项；工程师通过统一 Inference Runner 跑通 prompt → token → text，在 reference 与 PyPTO 间定位输出差异；随后启动最小开发服务，用流式 API 完成应用联调，并得到基础 TTFT/TPOT、容量估算和可重放请求。

### 8.2 MVP 功能包

- Workspace manifest 与 Run ID；
- `pypto doctor` + 资源 preflight；
- 统一诊断协议；
- Pass verifier SDK + 10—15 条高危规则；
- source span 保留、Pass timeline、相邻 Pass semantic diff；
- CPU/reference 与 device 双 oracle；
- 最小 Model Importer、算子覆盖报告与模型/权重/tokenizer 指纹；
- 单 prompt 的 prefill+decode Inference Runner、流式输出与 token 对齐；
- 最小 Service Builder：单机服务启动、同步/流式 API、Playground/示例客户端；
- 基础容量估算、request timeline、TTFT/TPOT 与请求重放；
- task/event 基础 timeline；
- `pypto explain` 聚合报告；
- reproducible bundle；
- IDE 诊断跳转或最小本地报告页。

### 8.3 不纳入首版 MVP

- 全自动通用算子生成；
- 无边界的 AI 自动改代码；
- 大规模 autotune 调度平台；
- 多租户生产运维、跨集群自动扩缩容和完整告警值守平台；
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
| 模型推理 | 已支持模型从导入到首个正确生成结果的中位时间 | ≤ 30 分钟 |
| 模型推理 | 模型图中 native/fused/fallback/unsupported 状态可解释覆盖率 | 100% |
| 服务化 | 从 Inference Bundle 到开发服务首次成功响应的中位时间 | ≤ 10 分钟 |
| 服务化 | 请求可关联到 batch、KV、模型节点和 runtime 证据的比例 | ≥ 95% |
| 服务化 | 容量规划对稳定可服务并发/token 上限的预测误差 | ≤ 15% |
| 服务化 | 服务就绪门禁覆盖的发布前严重问题拦截率 | ≥ 80% |
| 文档 | Quickstart/示例 CI 可执行通过率 | 100% |
| 体验 | 裸错误码占 runtime 用户可见错误的比例 | < 5% |

### 9.3 护栏指标

- verifier 编译时延增幅：默认模式目标 < 10%；重检查可在 CI/debug profile 开启；
- 低干扰 trace 性能开销：目标 < 3%；完整取证必须在启动前明确预计开销；
- 诊断假阳性率：高危 error 级规则目标 < 1%；
- autotune 产生但未过正确性门禁的候选不得进入性能排名；
- 服务性能结论必须同时报告负载分布、P50/P90/P99、错误率和 goodput，不以单一平均吞吐替代；
- 服务就绪报告只能对已实测的硬件、模型、序列长度和并发边界作出承诺；外推值必须显式标记；
- prompt、响应、权重和 KV 内容默认不进入 trace 与共享报告，仅保存脱敏摘要；
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
| Model adapter/inference protocol | pypto-lib + pypto-serving | 模型导入、tokenizer、generation、Inference Bundle 协议 |
| Serving API/profile schema | pypto-serving | API、batching、parallel、KV、请求生命周期与版本化配置 |
| Serving metric/capacity schema | pypto-serving + simpler | TTFT/TPOT/P99/goodput/KV/resource 标准定义及 request-to-task ID |
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
| “服务化”膨胀为生产运维平台 | 范围失控，核心开发闭环延期 | 明确边界在构建、联调、压测、诊断和发布验收；生产编排交给外部平台 |
| 服务 benchmark 不可比较 | 请求分布、采样和 warmup 不同导致误判 | 版本化 workload，锁定模型/数据/采样/硬件，报告尾延迟、错误率和置信区间 |
| 模型输出非确定性造成误报 | sampling 差异被当作编译错误 | 支持确定性 profile、固定种子、logits/token 分层对齐和统计一致性 |
| 推理数据泄露 | prompt、响应或 KV 内容进入 trace/报告 | 默认只采集 hash/shape/statistics，分级授权、脱敏与可审计导出 |
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
| 完整模型接入缺少算子覆盖与版本闭环 | Model Importer、Coverage Report、Inference Bundle |
| logits 正确但生成文本异常 | decode step 对齐、采样/停止条件验证、输出质量检测 |
| 性能指标跨 kernel/runtime/model/serving 割裂 | 四层指标 schema、因果视图、可信 A/B 实验 |
| PTODSL/ISA 能力边界和文档不清 | Capability Matrix、Intent Preview、可执行文档 |
| TP/EP/MoE provenance 和通信约束复杂 | DistributedTensor provenance、跨 rank verifier |
| 服务启动和应用联调链路分散 | Service Builder、API/SDK、Playground、请求重放 |
| batching、KV cache、长 prompt、容量与 SLO 风险 | Workload Lab、Capacity Planner、Request/KV Inspector、Serving Readiness Gate |
| 多仓库职责与 issue 路由不清 | 症状式入口、Repro Bundle、Issue Router、Developer Portal |

---

## 13. 最终产品判断

PyPTO 3.0 的先进性不应体现在“加入一个 AI 聊天框”，而应体现在系统本身具备以下能力：

- **知道开发者想表达什么**，而不只接受底层参数；
- **知道每一步应该保持什么不变量**，而不是编译后把风险交给设备；
- **知道一个结果从哪里来**，能够沿完整证据链解释；
- **知道一次优化为什么有效**，并能证明它没有破坏正确性；
- **知道一个模型如何完成推理并成为稳定服务**，能够解释每个 token、请求、batch 和 KV 状态；
- **知道何时信息不足**，明确告诉用户，而不是静默猜测。

因此，3.0 的首要建设顺序应是：**可信编译底座 → 跨层证据链 → 模型推理正确性闭环 → 性能因果与安全调优 → 服务构建与就绪验证 → 规模化智能开发**。只有这个顺序，才能把现有多个强大但割裂的仓库能力，真正升级成下一代模型—算子开发产品。
