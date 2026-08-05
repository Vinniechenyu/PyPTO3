(function () {
  const recipes = [
    { id: 'prefill', label: 'Prefill', meta: 'dense attention' },
    { id: 'decode', label: 'Decode', meta: 'single token' },
    { id: 'paged_attention', label: 'Paged Attention', meta: 'selected · layer.18' },
    { id: 'rmsrope', label: 'RMSNorm + RoPE', meta: 'fused recipe' },
    { id: 'moe', label: 'MoE Expert', meta: 'grouped GEMM' },
    { id: 'lm_head', label: 'LM Head', meta: 'vocab parallel' }
  ];
  const passes = ['Semantic Lowering', 'Layout Planning', 'Parallel Mapping', 'Memory Scheduling', 'ISA Emission'];
  const guards = ['Op legality', 'Dependencies', 'Scope', 'Liveness', 'Layout', 'Output direction', 'ISA capacity', 'Precision'];
  const state = { step: 0, activityView: 'explorer', productMode: 'ide', selectedRecipe: 'paged_attention', fixed: false, compiled: false, verified: false, soloFollow: true, soloRunning: false, soloPaused: false, soloComplete: false, soloStep: -1, soloTool: 'context' };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function renderRecipes() {
    $('#recipeGrid').innerHTML = recipes.map((r, index) => `<button class="kf-recipe${r.id === state.selectedRecipe ? ' is-active' : ''}" data-recipe="${r.id}"><span>0${index + 1}</span><b>${r.label}</b><small>${r.meta}</small></button>`).join('');
  }

  function renderPasses() {
    $('#passStrip').innerHTML = passes.map((name, index) => `<button class="kf-pass" data-pass="${index}"><span>PASS 0${index + 1}</span><b>${name}</b></button>`).join('');
    $('#guardGrid').innerHTML = guards.map(name => `<div class="kf-guard"><i>·</i>${name}</div>`).join('');
  }

  function renderOracles() {
    const cards = [
      ['CPU', 'CPU / Torch reference', '12 checkpoints', 'MATCH', false],
      ['LIB', 'FlashInfer baseline', '12 checkpoints', 'MATCH', false],
      ['PTO', 'PyPTO device', '11 / 12 match', state.verified ? 'MATCH' : 'DIFF', !state.verified]
    ];
    $('#oracleCards').innerHTML = cards.map(c => `<article class="kf-oracle${c[4] ? ' is-fail' : ''}"><span>${c[0]}</span><div><b>${c[1]}</b><small>${c[2]}</small></div><em>${c[3]}</em></article>`).join('');
  }

  function renderTensorCompare() {
    const values = ['-.041', '.104', '.236', '-.118', '.009', '.482', '.171', '-.056', '.093', '.015', '-.274', '.332', '.145', '-.081', '.226', '.019'];
    const tensor = (title, device) => `<section class="kf-tensor"><header><span>${title}</span><span>BF16 · 16 values</span></header><div class="kf-tensor-grid">${values.map((v, i) => `<span class="${device && i === 10 ? 'diff' : ''}">${device && i === 10 ? '-.258' : v}</span>`).join('')}</div></section>`;
    $('#tensorCompare').innerHTML = tensor('CPU / library oracle', false) + tensor('PyPTO device output', true);
  }

  function renderGraph() {
    const mount = $('#irGraph');
    mount.innerHTML = '';
    const helper = window.PtoPassIrGraphNodePattern;
    if (helper) {
      const cards = [
        { type: 'tensor', data: { symbol: 'q_tile', shape: [1, 8, 1, 128], rawShape: [1, 32, 1, 128], dtype: 'bf16', format: 'BHSD' } },
        { type: 'op', data: { opType: 'MatMul', stage: 'qk_matmul', latency: '2.8 μs', outShape: [1, 8, 1, 2048], subgraphId: 18 }, accent: '#4369EF' },
        { type: 'op', data: { opType: 'Softmax', stage: 'softmax', latency: '1.1 μs', outShape: [1, 8, 1, 2048], subgraphId: 18 }, accent: '#9B60AA' },
        { type: 'outcast', data: { name: 'out', shape: [1, 32, 1, 128], rawShape: [1, 32, 1, 128], dtype: 'bf16', format: 'BHSD', slotIdx: 0 } }
      ];
      cards.forEach(card => mount.appendChild(helper.buildNodeCardElement(card, { compact: true })));
    } else {
      mount.innerHTML = '<code>q_tile → qk_matmul → softmax → out</code>';
    }
  }

  const inspectorContent = [
    `<section class="kf-inspector-section"><h2 class="kf-inspector-title">目标契约</h2><dl><div><dt>Source</dt><dd>Qwen3 · layer.18</dd></div><div><dt>Recipe</dt><dd>paged_attention</dd></div><div><dt>Target</dt><dd>Ascend 950B</dd></div><div><dt>Precision</dt><dd>rtol 1e-3</dd></div></dl></section><section class="kf-inspector-section"><h2 class="kf-inspector-title">Toolkit 读取</h2><div class="kf-evidence-list"><div class="kf-evidence"><span>✓</span><b>12 tensors</b><small>shape</small></div><div class="kf-evidence"><span>✓</span><b>3 dtypes</b><small>contract</small></div><div class="kf-evidence"><span>✓</span><b>7 constraints</b><small>hardware</small></div></div></section><div class="kf-inspector-card"><b>为什么从契约开始？</b><p>后续每条诊断、测试结果和基线签名都会引用同一份输入事实，避免“修好一个 shape，破坏另一个 shape”。</p></div>`,
    `<section class="kf-inspector-section"><h2 class="kf-inspector-title">语义意图</h2><dl><div><dt>Compute</dt><dd>QK → Softmax → PV</dd></div><div><dt>Layout</dt><dd>tile [1,8,1,128]</dd></div><div><dt>Parallel</dt><dd>head × core</dd></div><div><dt>Memory</dt><dd>L1 reuse · 2 stages</dd></div></dl></section><section class="kf-inspector-section"><h2 class="kf-inspector-title">即时诊断</h2><div class="kf-inspector-card"><b style="color:var(--warning)">PTO-DIR-001</b><p id="inspectorDiagnostic">输出方向使用 AUTO。编译可继续，但 Correctness Lab 将把它标记为风险来源。</p></div></section>`,
    `<section class="kf-inspector-section"><h2 class="kf-inspector-title">卫士覆盖</h2><div class="kf-evidence-list">${guards.map(g => `<div class="kf-evidence"><span>○</span><b>${g}</b><small>pending</small></div>`).join('')}</div></section><div class="kf-inspector-card"><b>验证粒度</b><p>卫士在每个 Pass 之后运行。失败时保留前后 IR、约束快照与最小复现入口。</p></div>`,
    `<section class="kf-inspector-section"><h2 class="kf-inspector-title">分歧证据</h2><dl><div><dt>First layer</dt><dd>layer.18</dd></div><div><dt>Kernel</dt><dd>paged_attention</dd></div><div><dt>Tensor</dt><dd>out</dd></div><div><dt>Tile</dt><dd>[0,7,0,96:112]</dd></div></dl></section><section class="kf-inspector-section"><h2 class="kf-inspector-title">关联证据</h2><div class="kf-evidence-list"><div class="kf-evidence"><span>↗</span><b>DSL line 6</b><small>direction</small></div><div class="kf-evidence"><span>↗</span><b>Layout Pass</b><small>outcast</small></div><div class="kf-evidence"><span>↗</span><b>Device trace</b><small>store</small></div></div></section>`,
    `<section class="kf-inspector-section"><h2 class="kf-inspector-title">可信状态</h2><div class="kf-inspector-card"><b style="color:var(--success)">可用于性能优化</b><p>此基线冻结 correctness 契约。之后的 tile、pipeline 或内存优化都可与它自动比对。</p></div></section><section class="kf-inspector-section"><h2 class="kf-inspector-title">签名摘要</h2><dl><div><dt>Evidence</dt><dd>sha256:91b4…0e2c</dd></div><div><dt>Environment</dt><dd>sha256:8da1…bf09</dd></div><div><dt>Artifact</dt><dd>sha256:13fe…8c71</dd></div></dl></section>`
  ];

  function updateInspector() {
    $('#inspector').innerHTML = inspectorContent[state.step];
    $('#inspectorMeta').textContent = state.step === 4 ? 'sealed' : 'live';
    if (state.step === 1 && state.fixed) {
      $('#inspectorDiagnostic').textContent = '输出方向已显式设为 BHSD。即时诊断已清除。';
    }
  }

  function setActivityView(view) {
    state.activityView = view;
    $$('[data-side-view]').forEach((panel) => {
      const active = panel.dataset.sideView === view;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    $$('[data-activity-view]').forEach((button) => {
      const active = button.dataset.activityView === view;
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-expanded', String(active));
    });
    $('#sidePaneTitle').textContent = view === 'explorer' ? '资源管理器' : '任务路线';
    $('#sidePaneMeta').textContent = view === 'explorer' ? 'workspace' : `${state.step + 1} / 5`;
  }

  function toggleTreeGroup(name, expanded) {
    const group = $(`[data-tree-group="${name}"]`);
    const toggle = $(`[data-tree-toggle="${name}"]`);
    if (!group || !toggle) return;
    group.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    const caret = $('.kf-caret', toggle);
    if (caret) caret.textContent = expanded ? '⌄' : '›';
  }

  const titles = [
    ['定义目标', 'recipe · paged_attention'],
    ['编写 Kernel', 'kernels/paged_attention.pypto'],
    ['编译卫士', '5 passes · 8 guards'],
    ['Correctness Lab', '3 oracles · tensor checkpoints'],
    ['可信基线', 'ptok · signed evidence']
  ];

  function goTo(step) {
    state.step = Math.max(0, Math.min(4, step));
    $$('.kf-stage').forEach((el, i) => el.classList.toggle('is-active', i === state.step));
    $$('#stepNav button').forEach((button, i) => {
      button.classList.toggle('is-active', i === state.step);
      button.classList.toggle('is-complete', i < state.step || (i === 3 && state.verified));
    });
    $('#progressBar').style.width = `${(state.step + 1) * 20}%`;
    if (state.activityView === 'workflow') $('#sidePaneMeta').textContent = `${state.step + 1} / 5`;
    $('#stageTitle').textContent = titles[state.step][0];
    $('#stageMeta').textContent = titles[state.step][1];
    $('#statusText').textContent = ['目标契约已就绪', 'DSL 即时诊断运行中', 'Pass 不变量验证', 'Oracle 三角比对', '可信基线已签发'][state.step];
    updateInspector();
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('is-visible'), 1800);
  }

  function setEnvironmentPanel(open) {
    const control = $('#envControl');
    const panel = $('#envFingerprintPanel');
    panel.hidden = !open;
    control.setAttribute('aria-expanded', String(open));
  }

  const soloToolNames = { context: '工程上下文', editor: 'Kernel Editor', guard: 'Compiler Guard', lab: 'Correctness Lab' };
  const soloToolStatus = { context: 'Context indexed', editor: 'Editing paged_attention.pypto', guard: 'Validating pass invariants', lab: 'Comparing three oracles' };
  const soloRunSteps = [
    { tool: 'context', title: '上下文与目标契约已锁定', detail: '读取 12 个 tensor contract、Ascend 950B 容量约束和 BF16 精度目标。' },
    { tool: 'editor', title: 'Kernel DSL 已生成并自修复', detail: '生成语义 DSL，并将危险默认 direction=AUTO 修正为显式 BHSD。' },
    { tool: 'guard', title: '所有编译 Pass 不变量成立', detail: 'Semantic、Layout、Parallel、Memory 与 ISA 五个 Pass 的 8 类卫士全部通过。' },
    { tool: 'lab', title: '三路 Oracle 已完成交叉验证', detail: '定位并消除首个 tensor 分歧；12 / 12 checkpoint 满足 rtol 1e-3。' },
    { tool: 'lab', title: '可信基线已签发', detail: '生成环境指纹 env:8da1bf09、证据链和可复现命令，基线已封存。' }
  ];

  function setProductMode(mode) {
    state.productMode = mode;
    const solo = mode === 'solo';
    $('[data-ide-frame]').dataset.productMode = mode;
    $('#ideActivityRail').hidden = solo;
    $('#ideWorkarea').hidden = solo;
    $('#soloWorkarea').hidden = !solo;
    $$('.kf-mode-switch [data-product-mode]').forEach((button) => {
      const active = button.dataset.productMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $('.kf-command').textContent = solo ? 'SOLO 正在编排 Context · Editor · Guard · Lab' : '⌘ K　搜索命令、tensor 或 pass';
    setEnvironmentPanel(false);
  }

  function setSoloTaskModal(open) {
    const modal = $('#soloTaskModal');
    modal.hidden = !open;
    $('#soloNewTaskTrigger').setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => $('#soloNewTaskGoal').focus());
  }

  function setAgentTeamDrawer(open) {
    const drawer = $('#agentTeamDrawer');
    const toggle = $('#agentTeamToggle');
    drawer.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '收起 Agent Team 成员' : '展开 Agent Team 成员');
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function setSoloFollow(active) {
    state.soloFollow = active;
    $('#soloFollow').classList.toggle('is-active', active);
    $('#soloFollow').setAttribute('aria-pressed', String(active));
  }

  function showSoloTool(tool, fromAgent = false) {
    state.soloTool = tool;
    $$('[data-solo-tool]').forEach((button) => {
      const active = button.dataset.soloTool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $$('[data-solo-tool-panel]').forEach((panel) => {
      const active = panel.dataset.soloToolPanel === tool;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    $('#soloToolTitle').textContent = soloToolNames[tool];
    $('#soloToolStatus').innerHTML = `<i></i> ${soloToolStatus[tool]}`;
    if (!fromAgent) setSoloFollow(false);
  }

  function appendSoloEvent(step, complete = false) {
    const event = document.createElement('article');
    event.className = `kf-solo-event${complete ? ' is-complete' : ''}`;
    event.innerHTML = `<header><b>${step.title}</b><span>${complete ? 'COMPLETE' : 'DONE'}</span></header><p>${step.detail}</p>`;
    $('#soloFeed').appendChild(event);
    $('#soloFeed').scrollTop = $('#soloFeed').scrollHeight;
  }

  async function soloDelay(ms) {
    let elapsed = 0;
    while (elapsed < ms) {
      if (!state.soloPaused) elapsed += 80;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }

  function setSoloTask(index, status) {
    const item = $(`[data-solo-task="${index}"]`);
    item.classList.toggle('is-active', status === 'active');
    item.classList.toggle('is-done', status === 'done');
    if (status === 'done') $('i', item).textContent = '✓';
  }

  function selectAgentMember(member, followTool = false) {
    $$('.kf-agent-member').forEach(agent => agent.classList.toggle('is-selected', agent === member));
    const detail = $('#agentTeamDetail');
    $('b', detail).textContent = member.dataset.agentName;
    $('span', detail).textContent = member.dataset.agentDetail;
    $('em', detail).textContent = member.classList.contains('is-active') ? '正在协作' : member.classList.contains('is-complete') ? '产物已交付' : '等待接力';
    if (followTool) showSoloTool(member.dataset.agentTool, false);
  }

  function setAgentTeamStep(stepIndex) {
    const activeAgent = [0, 1, 2, 3, 0][stepIndex];
    const completedBeforeStep = [[], [0], [0, 1], [0, 1, 2], [1, 2, 3]][stepIndex];
    $$('.kf-agent-member').forEach((member, index) => {
      const active = index === activeAgent;
      const complete = completedBeforeStep.includes(index);
      member.classList.toggle('is-active', active);
      member.classList.toggle('is-complete', complete);
      $('.kf-agent-member-copy em', member).textContent = active ? (stepIndex === 4 ? 'SEALING' : 'WORKING') : complete ? 'DONE' : 'STANDBY';
    });
    const member = $(`[data-agent-index="${activeAgent}"]`);
    selectAgentMember(member);
  }

  function completeAgentTeam() {
    $$('.kf-agent-member').forEach(member => {
      member.classList.remove('is-active');
      member.classList.add('is-complete');
      $('.kf-agent-member-copy em', member).textContent = 'DONE';
    });
    const detail = $('#agentTeamDetail');
    $('b', detail).textContent = 'Kernel Alpha Team';
    $('span', detail).textContent = '四个 Agent 的产物已汇入同一条可信证据链。';
    $('em', detail).textContent = '协作完成';
  }

  async function runSolo() {
    if (state.soloRunning || state.soloComplete) return;
    state.soloRunning = true;
    state.soloPaused = false;
    $('#soloReady').hidden = true;
    $('#soloPause').disabled = false;
    $('#soloRunStatus').className = 'is-running';
    $('#soloRunStatusText').textContent = '自主执行中';

    for (let index = 0; index < soloRunSteps.length; index += 1) {
      const step = soloRunSteps[index];
      state.soloStep = index;
      setAgentTeamStep(index);
      setSoloTask(index, 'active');
      $('#soloProgress').textContent = `${index} / 5`;
      if (state.soloFollow) showSoloTool(step.tool, true);

      if (index === 1) $('#soloEditorState').textContent = 'Agent editing';
      if (index === 2) {
        $('#soloGuardState').textContent = '运行中';
        const passRows = $$('#soloGuardPasses > span');
        for (const row of passRows) {
          row.classList.add('is-active');
          await soloDelay(150);
          row.classList.remove('is-active');
          row.classList.add('is-done');
        }
        $('.kf-solo-guard-matrix').classList.add('is-pass');
        $('#soloGuardState').textContent = '5 / 5 PASS';
      } else if (index === 3) {
        $('#soloLabResult').className = 'kf-solo-lab-result is-running';
        $('#soloLabResult').innerHTML = '<span class="kf-solo-spinner"></span><h3>正在比对 Tensor checkpoints</h3><p>CPU reference · FlashInfer · PyPTO device</p>';
        await soloDelay(650);
        $('#soloDeviceResult').textContent = 'PASS';
        $('#soloLabResult').className = 'kf-solo-lab-result is-pass';
        $('#soloLabResult').innerHTML = '<span class="kf-solo-spinner"></span><h3>3 / 3 Oracle 一致</h3><p>12 / 12 checkpoints match · max diff 0.0009766</p>';
      } else {
        await soloDelay(620);
      }

      if (index === 1) $('#soloEditorState').textContent = 'Saved · diagnostic cleared';
      setSoloTask(index, 'done');
      $('#soloProgress').textContent = `${index + 1} / 5`;
      appendSoloEvent(step, index === soloRunSteps.length - 1);
    }

    state.soloRunning = false;
    state.soloComplete = true;
    $$('.kf-pass').forEach(item => item.classList.add('is-pass'));
    $$('.kf-guard').forEach(item => { item.classList.add('is-pass'); $('i', item).textContent = '✓'; });
    $('#compileStatus').textContent = '5 / 5 Pass 通过';
    $('#compileStatus').className = 'kf-state-chip good';
    $('#guardSummary').textContent = '8 / 8 约束通过';
    $('#runCompile').hidden = true;
    $('#toLab').hidden = false;
    state.compiled = true;
    verifyAndFinish();
    $('#soloPause').disabled = true;
    $('#soloRunStatus').className = 'is-complete';
    $('#soloRunStatusText').textContent = 'Agent Team 已完成可信基线';
    completeAgentTeam();
    $('#soloToolStatus').innerHTML = '<i></i> Baseline sealed · 9f2a71c';
    toast('SOLO 已完成：首个可信 Kernel 基线已签发');
  }

  function applyDslFix() {
    state.fixed = true;
    $('#directionToken').textContent = 'direction="BHSD"';
    $('#directionToken').style.color = 'var(--success)';
    $('#warningLine').classList.remove('has-warning');
    $('#dslDiagnostic').innerHTML = '<span style="color:var(--success)">✓</span><div><b style="color:var(--success)">输出方向已显式固定为 BHSD</b><small>危险默认已清除；布局契约将在每个 Pass 后持续验证。</small></div>';
    $('#dslStatus').textContent = '诊断已清除';
    $('#dslStatus').className = 'kf-state-chip good';
    updateInspector();
    toast('已应用修复：direction="BHSD"');
  }

  async function runCompile() {
    const button = $('#runCompile');
    button.disabled = true;
    $('#compileStatus').textContent = '正在验证…';
    const passEls = $$('.kf-pass');
    for (let i = 0; i < passEls.length; i += 1) {
      passEls[i].classList.add('is-running');
      $('#activePassName').textContent = passes[i];
      $('#guardSummary').textContent = `Pass ${i + 1} / 5 · 验证 8 项约束`;
      await new Promise(resolve => setTimeout(resolve, 260));
      passEls[i].classList.remove('is-running');
      passEls[i].classList.add('is-pass');
    }
    $$('.kf-guard').forEach((el) => { el.classList.add('is-pass'); $('i', el).textContent = '✓'; });
    state.compiled = true;
    $('#compileStatus').textContent = '5 / 5 Pass 通过';
    $('#compileStatus').className = 'kf-state-chip good';
    $('#guardSummary').textContent = '8 / 8 约束通过';
    button.hidden = true;
    $('#toLab').hidden = false;
    toast('编译完成：所有 Pass 不变量成立');
  }

  function verifyAndFinish() {
    applyDslFix();
    state.verified = true;
    renderOracles();
    $('#labStatus').textContent = '3 / 3 oracle 一致';
    $('#labStatus').className = 'kf-state-chip good';
    $('.kf-divergence').style.opacity = '.42';
    $('.kf-root-cause').innerHTML = '<span style="color:var(--success)">✓</span><div><b style="color:var(--success)">修复已验证</b><p>12 / 12 tensor checkpoints 一致，最大绝对误差 0.0009766，满足 rtol 1e-3。</p></div><button class="btn btn-solid" id="issueBaseline">签发可信基线 →</button>';
    $('#issueBaseline').addEventListener('click', () => goTo(4));
    toast('复验通过：首个分歧已消除');
  }

  renderRecipes();
  renderPasses();
  renderOracles();
  renderTensorCompare();
  renderGraph();
  goTo(0);
  setProductMode('ide');

  $$('[data-activity-view]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopImmediatePropagation();
    setActivityView(button.dataset.activityView);
  }, true));
  setActivityView('explorer');

  document.addEventListener('click', (event) => {
    if (!event.target.closest('#envControl') && !event.target.closest('#envFingerprintPanel')) setEnvironmentPanel(false);
    const recipe = event.target.closest('[data-recipe]');
    if (recipe) { state.selectedRecipe = recipe.dataset.recipe; renderRecipes(); toast(`已选择 ${$('b', recipe).textContent}`); }
    const step = event.target.closest('[data-step]');
    if (step) { setActivityView('workflow'); goTo(Number(step.dataset.step)); }
    const treeToggle = event.target.closest('[data-tree-toggle]');
    if (treeToggle) toggleTreeGroup(treeToggle.dataset.treeToggle, treeToggle.getAttribute('aria-expanded') !== 'true');
    const file = event.target.closest('[data-file]');
    if (file) {
      $$('[data-file]').forEach(item => item.classList.remove('is-selected'));
      file.classList.add('is-selected');
      const openStep = file.dataset.openStep;
      if (openStep != null) {
        setActivityView('workflow');
        goTo(Number(openStep));
        toast(`已打开 ${file.dataset.file} · 定位到${titles[Number(openStep)][0]}`);
      } else {
        toast(`已选择 ${file.dataset.file}`);
      }
    }
    if (event.target.closest('[data-next]')) goTo(state.step + 1);
    if (event.target.closest('[data-prev]')) goTo(state.step - 1);
  });
  $('#applyFix').addEventListener('click', applyDslFix);
  $$('[data-product-mode]').forEach((button) => button.addEventListener('click', () => {
    const mode = button.dataset.productMode;
    if (mode === 'ide' && state.soloRunning) {
      state.soloPaused = true;
      $('#soloPause').textContent = '继续';
    }
    setProductMode(mode);
    if (mode === 'ide' && state.soloStep >= 0) {
      setActivityView('workflow');
      goTo(state.soloComplete ? 4 : state.soloStep);
    }
  }));
  $('#soloNewTaskTrigger').setAttribute('aria-haspopup', 'dialog');
  $('#soloNewTaskTrigger').setAttribute('aria-expanded', 'false');
  $('#soloNewTaskTrigger').addEventListener('click', () => setSoloTaskModal(true));
  $('#soloNewTaskClose').addEventListener('click', () => setSoloTaskModal(false));
  $('#soloNewTaskCancel').addEventListener('click', () => setSoloTaskModal(false));
  $('#soloTaskModal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) setSoloTaskModal(false);
  });
  $('#soloNewTaskForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const goal = $('#soloNewTaskGoal').value.trim();
    if (!goal) return;
    const recipe = $('#soloNewTaskRecipe').value;
    const target = $('#soloNewTaskTarget').value;
    const item = document.createElement('button');
    item.className = 'kf-solo-history-item is-selected';
    item.type = 'button';
    item.dataset.historyTask = goal;
    item.innerHTML = `<span class="kf-solo-history-icon is-queued">↗</span><span><b>${escapeHtml(goal)}</b><small>排队中 · ${escapeHtml(recipe)} · ${escapeHtml(target)}</small></span><time>刚刚</time>`;
    $$('[data-history-task]').forEach(historyItem => historyItem.classList.remove('is-selected'));
    $('#soloHistoryList').prepend(item);
    $('#soloHistoryCount').textContent = `${$$('[data-history-task]').length} 项`;
    event.currentTarget.reset();
    setSoloTaskModal(false);
    toast('新任务已创建，并加入 SOLO 任务队列');
  });
  $('#soloHistoryList').addEventListener('click', (event) => {
    const item = event.target.closest('[data-history-task]');
    if (!item) return;
    $$('[data-history-task]').forEach(historyItem => historyItem.classList.toggle('is-selected', historyItem === item));
    toast(`已打开任务摘要：${item.dataset.historyTask}`);
  });
  $('#agentTeamToggle').addEventListener('click', () => {
    const open = $('#agentTeamToggle').getAttribute('aria-expanded') !== 'true';
    setAgentTeamDrawer(open);
  });
  $('#soloStart').addEventListener('click', runSolo);
  $('#soloPause').addEventListener('click', () => {
    state.soloPaused = !state.soloPaused;
    $('#soloPause').textContent = state.soloPaused ? '继续' : '暂停';
    $('#soloRunStatusText').textContent = state.soloPaused ? '已暂停 · 等待接管' : '自主执行中';
    toast(state.soloPaused ? 'SOLO 已暂停' : 'SOLO 已继续执行');
  });
  $('#soloTakeover').addEventListener('click', () => {
    state.soloPaused = true;
    setProductMode('ide');
    setActivityView('workflow');
    goTo(Math.max(0, state.soloStep));
    toast(`已切换到 IDE · 定位到${titles[Math.max(0, state.soloStep)][0]}`);
  });
  $('#soloFollow').addEventListener('click', () => {
    setSoloFollow(!state.soloFollow);
    if (state.soloFollow && state.soloStep >= 0) showSoloTool(soloRunSteps[state.soloStep].tool, true);
  });
  $('.kf-agent-team-grid').addEventListener('click', (event) => {
    const member = event.target.closest('.kf-agent-member');
    if (!member) return;
    selectAgentMember(member, true);
    toast(`${member.dataset.agentName} · 已打开对应工作现场`);
  });
  $$('[data-solo-tool]').forEach((button) => button.addEventListener('click', () => showSoloTool(button.dataset.soloTool, false)));
  $('#soloOpenTool').addEventListener('click', () => {
    const toolStep = { context: 0, editor: 1, guard: 2, lab: 3 }[state.soloTool];
    setProductMode('ide');
    setActivityView('workflow');
    goTo(toolStep);
    toast(`已在 IDE 中打开 ${soloToolNames[state.soloTool]}`);
  });
  $('#soloComposer').addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = $('#soloPrompt').value.trim();
    if (!prompt) return;
    const message = document.createElement('article');
    message.className = 'kf-solo-message is-user';
    message.innerHTML = `<span>你</span><div><p>${prompt.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])}</p><time>刚刚</time></div>`;
    $('#soloFeed').appendChild(message);
    $('#soloPrompt').value = '';
    $('#soloFeed').scrollTop = $('#soloFeed').scrollHeight;
    toast('约束已加入 SOLO 当前上下文');
  });
  $('#envControl').addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const open = event.currentTarget.getAttribute('aria-expanded') !== 'true';
    setEnvironmentPanel(open);
  });
  $('#envFingerprintPanel').addEventListener('click', (event) => event.stopPropagation());
  $('#copyFingerprint').addEventListener('click', () => { navigator.clipboard?.writeText('env:8da1bf09'); toast('环境指纹已复制'); });
  $('#runCompile').addEventListener('click', runCompile);
  $('#toLab').addEventListener('click', () => goTo(3));
  $('#fixAndRerun').addEventListener('click', verifyAndFinish);
  $('#copyBaseline').addEventListener('click', () => { navigator.clipboard?.writeText('ptok://qwen3-32b/l18/paged-attn@9f2a71c'); toast('基线 ID 已复制'); });
  $('#copyRepro').addEventListener('click', () => { navigator.clipboard?.writeText('pypto trust replay ptok://qwen3-32b/l18/paged-attn@9f2a71c'); toast('复现命令已复制'); });
  $('#viewEvidence').addEventListener('click', () => toast('证据包：24 项事实 · 3 个 oracle · 5 个 Pass 快照'));
  $('#newBaseline').addEventListener('click', () => toast('已创建性能优化分支：opt/paged-attn-from-9f2a71c'));
  $('#resetDemo').addEventListener('click', () => window.location.reload());
  $('#collapseTree').addEventListener('click', () => {
    $$('[data-tree-toggle]').forEach(toggle => toggleTreeGroup(toggle.dataset.treeToggle, false));
    toast('工程目录已折叠');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#soloTaskModal').hidden) {
      setSoloTaskModal(false);
      $('#soloNewTaskTrigger').focus();
      return;
    }
    if (event.key === 'Escape' && $('#agentTeamToggle').getAttribute('aria-expanded') === 'true') {
      setAgentTeamDrawer(false);
      $('#agentTeamToggle').focus();
      return;
    }
    if (event.key === 'Escape' && $('#envControl').getAttribute('aria-expanded') === 'true') {
      setEnvironmentPanel(false);
      $('#envControl').focus();
    }
  });
  $$('#tabs button').forEach((button, index) => button.addEventListener('click', () => { $$('#tabs button').forEach(b => b.classList.remove('is-active')); button.classList.add('is-active'); if (index === 1) { goTo(4); toast('已打开签名证据摘要'); } }));

  // Product interactions are bound before the shared frame initializes so a
  // non-critical resize/chrome failure can never disable the workbench UI.
  try {
    window.PtoIdeFrame?.initAll();
  } catch (error) {
    console.warn('IDE frame enhancement unavailable; core interactions remain active.', error);
  }
  try {
    window.kernelForgeSoloSplit = window.PtoWorkbenchShell?.initResizablePanes({
      root: $('#soloWorkarea'),
      panes: ['#soloPlanPane', '#soloAgentPane', '#soloToolsPane'],
      direction: 'horizontal',
      sizes: [24, 42, 34],
      minSize: [210, 360, 300],
      gutterSize: 8,
      keyboardStep: 24,
      storageKey: 'pypto-studio-solo-split-v1',
      gutterLabel: '调整 Solo 相邻栏宽度',
    });
  } catch (error) {
    console.warn('SOLO pane resizing unavailable; default layout remains active.', error);
  }
  document.documentElement.dataset.kernelForgeReady = 'true';
})();
