(function registerQwen3ModelViz() {
  'use strict';

  const graph = {
    width: 1180,
    height: 2050,
    clusters: [
      { id: 'decoder-stack', label: '_decode_layer × 40', x: 185, y: 300, width: 810, height: 1450, repeat: 40 },
      { id: 'scope-1-cluster', label: 'Scope 1 · Input RMS + QKV', x: 245, y: 440, width: 690, height: 330, parent: 'decoder-stack' },
      { id: 'scope-2-cluster', label: 'Scope 2 · Paged Flash Attention', x: 245, y: 790, width: 690, height: 430, parent: 'decoder-stack' },
      { id: 'scope-3-cluster', label: 'Scope 3 · Output + MLP', x: 245, y: 1240, width: 690, height: 440, parent: 'decoder-stack' },
    ],
    nodes: [
      { id: 'hidden-input', label: 'hidden_states', typeLabel: 'Input · [16,5120] · BF16', kind: 'tensor', x: 590, y: 38, width: 270, height: 50, colorKey: 'io:input', phase: 'boundary-in' },
      { id: 'copy-hidden', label: 'copy_hidden', typeLabel: 'CORE_GROUP · BF16 → FP32', kind: 'op', x: 590, y: 112, width: 280, height: 56, colorKey: 'sem:linear', phase: 'boundary-in' },
      { id: 'fp32-carry-in', label: 'cur', typeLabel: 'Inter-layer carry · [16,5120] · FP32', kind: 'tensor', x: 590, y: 190, width: 318, height: 52, colorKey: 'io:activation', phase: 'boundary-in' },
      { id: 'x-gamma0', label: 'x_gamma0', typeLabel: 'Layer 0 only · FP32 × γ → BF16', kind: 'op', x: 590, y: 264, width: 298, height: 56, colorKey: 'sem:norm', phase: 'boundary-in' },

      { id: 'layer-input', label: 'cur + normed_in', typeLabel: 'FP32 residual / BF16 x×γ', kind: 'tensor', x: 590, y: 354, width: 318, height: 52, parent: 'decoder-stack', phase: 'scope-1' },
      { id: 'rms-recip', label: 'rms_recip', typeLabel: 'Input RMS reciprocal · FP32', kind: 'op', x: 410, y: 500, width: 248, height: 56, colorKey: 'sem:norm', parent: 'scope-1-cluster', phase: 'scope-1' },
      { id: 'qkv-weight', label: 'Stacked Q/K/V Weights', typeLabel: 'Parameter · per layer slice', kind: 'state', state_type: 'parameter', x: 105, y: 580, width: 188, height: 48, colorKey: 'io:parameter', phase: 'scope-1' },
      { id: 'qkv-proj', label: 'q_proj · k_proj · v_proj', typeLabel: 'Split-K + atomic add · FP32', kind: 'op', x: 680, y: 580, width: 326, height: 58, colorKey: 'sem:linear', parent: 'scope-1-cluster', phase: 'scope-1' },
      { id: 'qk-norm', label: 'qk_norm', typeLabel: '8 tasks · gamma + reciprocal', kind: 'op', x: 590, y: 680, width: 270, height: 56, colorKey: 'sem:qknorm', parent: 'scope-1-cluster', phase: 'scope-1' },

      { id: 'fa-work-build', label: 'fa_work_build', typeLabel: 'Dense real-block work table · AIV', kind: 'op', x: 405, y: 850, width: 286, height: 56, colorKey: 'sem:comm', parent: 'scope-2-cluster', phase: 'scope-2' },
      { id: 'rope-qkv', label: 'rope_qkv', typeLabel: 'RoPE + Q pad + paged K/V write', kind: 'op', x: 730, y: 850, width: 310, height: 56, colorKey: 'sem:rope', parent: 'scope-2-cluster', phase: 'scope-2' },
      { id: 'paged-kv-cache', label: 'k_cache · v_cache', typeLabel: 'Paged state · layer_cache_base', kind: 'state', x: 1070, y: 970, width: 196, height: 52, colorKey: 'io:state', phase: 'scope-2' },
      { id: 'fa-fused', label: 'fa_fused', typeLabel: 'QK → local softmax → SV · SPMD', kind: 'op', x: 590, y: 980, width: 316, height: 60, colorKey: 'sem:attention', parent: 'scope-2-cluster', phase: 'scope-2' },
      { id: 'online-softmax', label: 'online_softmax', typeLabel: 'Cross-block reduction · attn_out BF16', kind: 'op', x: 590, y: 1110, width: 316, height: 58, colorKey: 'sem:attention', parent: 'scope-2-cluster', phase: 'scope-2' },

      { id: 'output-weight', label: 'Wo / Gate / Up / Down', typeLabel: 'Stacked parameters · per layer', kind: 'state', state_type: 'parameter', x: 105, y: 1320, width: 194, height: 48, colorKey: 'io:parameter', phase: 'scope-3' },
      { id: 'out-proj', label: 'out_proj', typeLabel: '10 × 5 split-N/K · FP32 atomic', kind: 'op', x: 590, y: 1300, width: 298, height: 58, colorKey: 'sem:linear', parent: 'scope-3-cluster', phase: 'scope-3' },
      { id: 'residual-cast', label: 'residual_rms_cast', typeLabel: 'Residual FP32 + post γ → BF16', kind: 'op', x: 430, y: 1390, width: 294, height: 58, colorKey: 'sem:norm', parent: 'scope-3-cluster', phase: 'scope-3' },
      { id: 'post-rms-reduce', label: 'post_rms_reduce', typeLabel: 'Deferred post-RMS reciprocal', kind: 'op', x: 750, y: 1390, width: 278, height: 58, colorKey: 'sem:norm', parent: 'scope-3-cluster', phase: 'scope-3' },
      { id: 'gate-up-proj', label: 'gate_proj · up_proj', typeLabel: 'Split-K interleaved · FP32', kind: 'op', x: 590, y: 1480, width: 292, height: 58, colorKey: 'sem:gate', parent: 'scope-3-cluster', phase: 'scope-3' },
      { id: 'silu', label: 'silu', typeLabel: 'Deferred RMS scale + SwiGLU · BF16', kind: 'op', x: 590, y: 1565, width: 284, height: 58, colorKey: 'sem:mlp', parent: 'scope-3-cluster', phase: 'scope-3' },
      { id: 'down-proj', label: 'down_proj', typeLabel: '17 × 5 split-K/N · FP32 atomic', kind: 'op', x: 590, y: 1645, width: 302, height: 58, colorKey: 'sem:linear', parent: 'scope-3-cluster', phase: 'scope-3' },
      { id: 'dcr-xgamma', label: 'dcr_xgamma', typeLabel: '5-way SPMD · outside manual_scope', kind: 'op', x: 590, y: 1722, width: 314, height: 60, colorKey: 'sem:comm', phase: 'scope-3' },
      { id: 'fp32-carry-out', label: 'out / next_hidden', typeLabel: 'FP32 · next layer carry', kind: 'tensor', x: 405, y: 1810, width: 258, height: 52, colorKey: 'io:activation', phase: 'scope-3' },
      { id: 'next-normed', label: 'normed_out', typeLabel: 'BF16 · next layer x×γ', kind: 'tensor', x: 765, y: 1810, width: 242, height: 52, colorKey: 'io:activation', phase: 'scope-3' },

      { id: 'cast-lmhead', label: 'cast_lmhead_in', typeLabel: 'Final FP32 → BF16 · once', kind: 'op', x: 590, y: 1885, width: 282, height: 56, colorKey: 'sem:linear', phase: 'boundary-out' },
      { id: 'lm-weight', label: 'Final Norm + LM Head', typeLabel: 'Parameter', kind: 'state', state_type: 'parameter', x: 105, y: 1960, width: 192, height: 48, colorKey: 'io:parameter', phase: 'boundary-out' },
      { id: 'rms-lm-head', label: 'rms_lm_head', typeLabel: 'Final RMSNorm + vocabulary projection', kind: 'op', x: 590, y: 1960, width: 320, height: 58, colorKey: 'sem:head', phase: 'boundary-out' },
      { id: 'logits', label: 'out · logits', typeLabel: 'Output · [16,VOCAB]', kind: 'tensor', x: 1010, y: 1960, width: 222, height: 52, colorKey: 'io:output', phase: 'boundary-out' },
    ],
    edges: [
      { source: 'hidden-input', target: 'copy-hidden', tag: 'BF16' }, { source: 'copy-hidden', target: 'fp32-carry-in', tag: 'FP32 once' }, { source: 'fp32-carry-in', target: 'x-gamma0' }, { source: 'x-gamma0', target: 'layer-input', tag: 'layer 0 seed' },
      { source: 'layer-input', target: 'rms-recip', tag: 'cur FP32' }, { source: 'layer-input', target: 'qkv-proj', tag: 'normed_in BF16' }, { source: 'qkv-weight', target: 'qkv-proj', dashed: true, tag: 'Wq/Wk/Wv' }, { source: 'qkv-proj', target: 'qk-norm' }, { source: 'rms-recip', target: 'qk-norm', dashed: true, tag: 'inv_rms' },
      { source: 'qk-norm', target: 'rope-qkv' }, { source: 'layer-input', target: 'fa-work-build', dashed: true, waypoints: [{ x: 270, y: 354 }, { x: 270, y: 850 }], tag: 'seq_lens' }, { source: 'fa-work-build', target: 'fa-fused', tag: 'dense blocks' }, { source: 'rope-qkv', target: 'fa-fused', tag: 'Q padded' }, { source: 'rope-qkv', target: 'paged-kv-cache', dashed: true, tag: 'paged write' }, { source: 'paged-kv-cache', target: 'fa-fused', dashed: true, tag: 'paged read' }, { source: 'fa-fused', target: 'online-softmax', tag: 'block partials' },
      { source: 'online-softmax', target: 'out-proj', tag: 'attn_out BF16' }, { source: 'output-weight', target: 'out-proj', dashed: true, tag: 'Wo' }, { source: 'out-proj', target: 'residual-cast' }, { source: 'out-proj', target: 'post-rms-reduce' }, { source: 'layer-input', target: 'residual-cast', dashed: true, waypoints: [{ x: 960, y: 354 }, { x: 960, y: 1390 }], tag: 'residual FP32' }, { source: 'layer-input', target: 'post-rms-reduce', dashed: true, waypoints: [{ x: 930, y: 354 }, { x: 930, y: 1390 }] },
      { source: 'residual-cast', target: 'gate-up-proj', tag: 'mlp_norm_in BF16' }, { source: 'post-rms-reduce', target: 'silu', dashed: true, tag: 'post inv_rms' }, { source: 'output-weight', target: 'gate-up-proj', dashed: true, tag: 'Wgate/Wup' }, { source: 'gate-up-proj', target: 'silu' }, { source: 'silu', target: 'down-proj' }, { source: 'output-weight', target: 'down-proj', dashed: true, tag: 'Wdown' }, { source: 'down-proj', target: 'dcr-xgamma' }, { source: 'residual-cast', target: 'dcr-xgamma', dashed: true, waypoints: [{ x: 875, y: 1390 }, { x: 875, y: 1722 }], tag: 'post_norm_partial' },
      { source: 'dcr-xgamma', target: 'fp32-carry-out', tag: 'out FP32' }, { source: 'dcr-xgamma', target: 'next-normed', tag: 'x×γ BF16' }, { source: 'fp32-carry-out', target: 'layer-input', dashed: true, waypoints: [{ x: 205, y: 1810 }, { x: 205, y: 354 }], tag: 'next layer ×40' }, { source: 'next-normed', target: 'layer-input', dashed: true, waypoints: [{ x: 970, y: 1810 }, { x: 970, y: 354 }] },
      { source: 'fp32-carry-out', target: 'cast-lmhead', tag: 'after layer 39' }, { source: 'cast-lmhead', target: 'rms-lm-head', tag: 'BF16 once' }, { source: 'lm-weight', target: 'rms-lm-head', dashed: true }, { source: 'rms-lm-head', target: 'logits', tag: 'logits' },
    ],
  };

  const phaseCopy = {
    all: ['Qwen3 14B · Fused Decode', 'decode_fwd 全链路 · 40 × Decoder Layer · FP32 跨层 carry', '完整链路', '按 decode_layer.py 的实际任务依赖展示输入边界、Scope 1/2/3 与输出边界。'],
    'boundary-in': ['输入边界', 'copy_hidden · x_gamma0 · 仅在 40 层循环前执行', '输入边界', '外部 BF16 hidden_states 只在入口转换为 FP32；layer 0 单独生成首份 BF16 x×γ。'],
    'scope-1': ['Scope 1 · RMS + QKV', 'rms_recip 与 Split-K Q/K/V 投影并行，随后执行 fused qk_norm', 'SCOPE 1', '输入 RMS reciprocal 延后应用，使归约可与 QKV 投影重叠；Q/K Norm 合并 gamma 与 reciprocal。'],
    'scope-2': ['Scope 2 · Paged Flash Attention', 'fa_work_build → rope_qkv → fa_fused → online_softmax', 'SCOPE 2', '仅真实 KV block 进入稠密工作表；fa_fused 逐块计算 QK/Softmax/SV，再跨块归并。'],
    'scope-3': ['Scope 3 · Output + MLP', 'out_proj → residual/RMS → gate/up → SiLU → down → dcr_xgamma', 'SCOPE 3', '层尾 5-way SPMD 同时写出 FP32 residual carry 与下一层 BF16 x×γ，避免层间往返转换。'],
    'boundary-out': ['输出边界', 'cast_lmhead_in → rms_lm_head → logits', '输出边界', '第 40 层 FP32 hidden 只在进入既有 BF16 RMS LM Head 前转换一次。'],
  };

  const phaseBounds = {
    'boundary-in': { x: 250, y: 0, width: 680, height: 320 },
    'scope-1': { x: 190, y: 320, width: 790, height: 470 },
    'scope-2': { x: 190, y: 760, width: 970, height: 490 },
    'scope-3': { x: 175, y: 1200, width: 850, height: 650 },
    'boundary-out': { x: 0, y: 1800, width: 1160, height: 250 },
  };

  const details = {
    'copy-hidden': ['copy_hidden', 'Fused decode 的首次精度边界：把外部 BF16 hidden_states 一次性转换为 FP32 cur。', ['阶段', 'decode_fwd pre-loop'], ['代码', 'decode_layer.py:1155'], ['输出', 'cur · [16,5120] · FP32']],
    'qkv-proj': ['q_proj · k_proj · v_proj', '三路投影使用 Split-K、内部 N/K tiling 与 FP32 atomic accumulation；读取上一层预先生成的 BF16 normed_in。', ['阶段', 'Scope 1'], ['并行', 'Q: 10×5 · K/V: 2×5'], ['代码', 'decode_layer.py:429–505']],
    'fa-fused': ['fa_fused', '基于稠密真实块工作表的 block-level SPMD：每个工作项完成 QK、局部 softmax 与 SV。', ['阶段', 'Scope 2'], ['调度', 'NUM_CORES grid-stride'], ['缓存', 'Paged K/V · block_table']],
    'dcr-xgamma': ['dcr_xgamma', '在 manual_scope 外以 5-way SPMD 同时产出层输出和下一层 x×gamma，恢复跨层自动依赖。', ['阶段', 'Scope 3 tail'], ['输出 1', 'out · FP32 carry'], ['输出 2', 'normed_out · BF16']],
    'rms-lm-head': ['rms_lm_head', '消费最后一次 BF16 转换后的 hidden，执行最终 RMSNorm 与词表投影。', ['阶段', 'decode_fwd tail'], ['输入', 'cur_bf16 · [16,5120]'], ['输出', 'logits · [16,VOCAB]']],
    'rms-recip': ['rms_recip', '只计算输入 RMS 的倒数标量；x×gamma 已由上一层 dcr_xgamma 提前生成，因此可与 QKV 投影重叠。', ['阶段', 'Scope 1'], ['精度', 'FP32 reduction'], ['策略', 'deferred scaling']],
    'fa-work-build': ['fa_work_build', '根据 ragged seq_lens 仅压紧真实序列块，构建无空洞工作表。', ['阶段', 'Scope 2 prep'], ['设备', 'AIV task'], ['输出', 'fa_work_table + fa_total']],
    'online-softmax': ['online_softmax', '合并每个 KV block 的局部 m/l/o 中间量，直接写出 BF16 attn_out。', ['阶段', 'Scope 2'], ['工作项', 'BATCH × NUM_KV_HEADS = 128'], ['输出', 'attn_out · BF16']],
  };

  let controller = null;
  let initialized = false;
  let activePhase = 'all';

  function renderInspector(title, badge, description, rows) {
    document.getElementById('modelInspectorTitle').textContent = title;
    document.getElementById('modelInspectorBody').innerHTML = `<div class="kf-model-inspector__hero"><span>${badge}</span><b>${title}</b><p>${description}</p></div>${rows?.length ? `<dl class="kf-model-node-detail">${rows.map((row) => `<div><dt>${row[0]}</dt><dd>${row[1]}</dd></div>`).join('')}</dl>` : ''}`;
  }

  function nodeDetail(nodeId) {
    const node = graph.nodes.find((item) => item.id === nodeId);
    const data = details[nodeId] || [node?.label || nodeId, node?.typeLabel || 'PyPTO execution task', ['阶段', node?.phase || 'shared']];
    renderInspector(data[0], node?.phase?.toUpperCase() || 'CODE NODE', data[1], data.slice(2));
    document.querySelectorAll('[data-model-focus]').forEach((button) => button.classList.toggle('is-active', button.dataset.modelFocus === nodeId));
  }

  function focusPhaseViewport(phase) {
    if (!controller) return;
    if (phase === 'all' || !phaseBounds[phase]) {
      controller.fit();
      document.getElementById('modelZoomReadout').textContent = '适应';
      return;
    }
    const bounds = phaseBounds[phase];
    const rect = document.getElementById('qwen3ModelGraph').getBoundingClientRect();
    const padding = 34;
    const zoom = Math.max(.18, Math.min(1.05, (rect.width - padding * 2) / bounds.width, (rect.height - padding * 2) / bounds.height));
    controller.setTransform({
      zoom,
      tx: (rect.width - bounds.width * zoom) / 2 - bounds.x * zoom,
      ty: (rect.height - bounds.height * zoom) / 2 - bounds.y * zoom,
    });
    document.getElementById('modelZoomReadout').textContent = `${Math.round(zoom * 100)}%`;
  }

  function applyPhase(phase) {
    activePhase = phase;
    const copy = phaseCopy[phase] || phaseCopy.all;
    document.querySelector('.kf-model-toolbar h1').textContent = copy[0];
    document.getElementById('modelPhaseSummary').textContent = copy[1];
    document.querySelectorAll('[data-model-phase]').forEach((button) => button.classList.toggle('is-active', button.dataset.modelPhase === phase));
    document.querySelectorAll('#qwen3ModelGraph .pto-model-graphviz-node').forEach((element) => {
      const node = graph.nodes.find((item) => item.id === element.dataset.nodeId);
      element.classList.toggle('is-phase-muted', phase !== 'all' && node?.phase !== phase);
      element.classList.toggle('is-phase-active', phase !== 'all' && node?.phase === phase);
    });
    document.querySelectorAll('#qwen3ModelGraph .pto-model-graphviz-edge, #qwen3ModelGraph .pto-model-graphviz-edge-tag').forEach((element) => {
      const source = graph.nodes.find((node) => node.id === element.dataset.source);
      const target = graph.nodes.find((node) => node.id === element.dataset.target);
      element.classList.toggle('is-phase-muted', phase !== 'all' && source?.phase !== phase && target?.phase !== phase);
      element.classList.toggle('is-phase-active', phase !== 'all' && (source?.phase === phase || target?.phase === phase));
    });
    controller?.clearSelection();
    focusPhaseViewport(phase);
    renderInspector(copy[0], copy[2], copy[3], [['源码', 'decode_layer.py'], ['模型', 'Qwen3-14B · 40 layers']]);
  }

  function updateZoom(delta) {
    if (!controller) return;
    const current = controller.getTransform();
    const next = Math.max(.18, Math.min(2.6, current.zoom * delta));
    controller.setTransform({ zoom: next });
    document.getElementById('modelZoomReadout').textContent = `${Math.round(next * 100)}%`;
  }

  function init() {
    if (initialized) return;
    const stage = document.getElementById('qwen3ModelGraph');
    if (!stage || !window.PtoModelGraphvizPattern) return;
    controller = window.PtoModelGraphvizPattern.renderController(stage, graph, {
      ariaLabel: 'Qwen3 14B fused decode execution graph',
      colormap: window.PtoModelGraphvizPattern.modelArchitectureColormap(graph),
      fitMode: 'full', viewportPadding: 36,
      interaction: { panZoom: true, selectableClusters: true }, overlays: { edgeTags: true },
      onSelect: ({ nodeId }) => nodeDetail(nodeId),
    });
    document.querySelectorAll('[data-model-phase]').forEach((button) => button.addEventListener('click', () => applyPhase(button.dataset.modelPhase)));
    document.querySelectorAll('[data-model-focus]').forEach((button) => button.addEventListener('click', () => controller?.selectNode(button.dataset.modelFocus, { source: 'outline' })));
    document.querySelector('[data-model-fit]')?.addEventListener('click', () => { controller?.fit(); document.getElementById('modelZoomReadout').textContent = '适应'; });
    document.querySelector('[data-model-zoom="in"]')?.addEventListener('click', () => updateZoom(1.18));
    document.querySelector('[data-model-zoom="out"]')?.addEventListener('click', () => updateZoom(1 / 1.18));
    initialized = true;
    applyPhase(activePhase);
  }

  function show() {
    init();
    requestAnimationFrame(() => { controller?.fit(); applyPhase(activePhase); document.getElementById('modelZoomReadout').textContent = '适应'; });
  }

  init();
  window.PtoQwen3ModelViz = { show, fit: () => controller?.fit(), setPhase: applyPhase, graph };
})();
