(() => {
  'use strict';

  const KEY = 'rwd.wizard.v3';
  const app = document.getElementById('app');
  const stepper = document.getElementById('stepper');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlaySub = document.getElementById('overlay-sub');
  const toastEl = document.getElementById('toast');

  const state = {
    step: 'home',
    eda: null,
    ideas: [],
    selected: null,
    cohort: null,
    stats: null,
    manuscript: '',
    reportFallback: false,
    running: false,
    tab: 'all',
    visible: 9,
    savedAt: null,
    error: '',
  };
  let runToken = 0;
  let updateTimer = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = (n) => (n == null || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('zh-CN');

  class ApiError extends Error {}

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try { res = await fetch(path, init); }
    catch (e) { throw new ApiError('无法连接服务，请检查网络或稍后重试'); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new ApiError((data && (data.error || data.message)) || `请求失败（${res.status}）`);
    return data;
  }

  let busyTimer = null;
  function busy(title, sub = '') {
    overlayTitle.textContent = title;
    overlaySub.textContent = sub;
    overlay.classList.add('show');
    clearInterval(busyTimer);
    const started = Date.now();
    busyTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - started) / 1000);
      overlaySub.textContent = `${sub}${sub ? ' · ' : ''}已等待 ${sec} 秒`;
    }, 1000);
  }
  function idle() {
    clearInterval(busyTimer);
    busyTimer = null;
    overlay.classList.remove('show');
  }
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4200);
  }

  function persist() {
    try {
      const slim = {
        step: state.step,
        selected: state.selected,
        cohort: state.cohort,
        stats: state.stats,
        manuscript: state.manuscript,
        reportFallback: state.reportFallback,
        savedAt: Date.now(),
      };
      localStorage.setItem(KEY, JSON.stringify(slim));
      state.savedAt = slim.savedAt;
    } catch (e) { /* quota */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        Object.assign(state, saved);
        state.running = false;
        state.error = '';
        state.ideas = [];
        state.visible = 9;
        state.tab = 'all';
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- markdown ----------
  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function mdToHtml(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes('-');
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) { out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
        continue;
      }
      if (line.trim().startsWith('|')) {
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i]); i++; }
        if (rows.length >= 2 && isTableSep(rows[1])) {
          const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
          const head = cells(rows[0]);
          let html = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
          for (let r = 2; r < rows.length; r++) {
            const cs = cells(rows[r]);
            html += '<tr>' + head.map((_, idx) => `<td>${inline(cs[idx] || '')}</td>`).join('') + '</tr>';
          }
          out.push(html + '</tbody></table>');
        } else {
          out.push(`<p>${inline(rows.join(' '))}</p>`);
        }
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
          i++;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map(t => `<li>${inline(t)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !lines[i].trim().startsWith('|') && !/^\s*>/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
    return out.join('\n');
  }

  // ---------- streaming ----------
  async function streamSkill(skill, onEvent) {
    const res = await fetch('/api/stream-pipeline', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill }),
    });
    if (!res.ok || !res.body) throw new ApiError(`启动分析失败（${res.status}）`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let finalData = null;
    let errorMsg = null;
    let done = false;
    while (!done) {
      const { value, done: rdone } = await reader.read();
      if (rdone) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (onEvent) onEvent(ev);
          if (ev.event === 'skill_complete') finalData = ev.data;
          if (ev.event === 'error') errorMsg = ev.message || '分析失败';
          if (ev.event === 'done') done = true;
        }
      }
    }
    try { await reader.cancel(); } catch (e) { /* release the connection */ }
    if (errorMsg) throw new ApiError(errorMsg);
    return finalData;
  }

  function setStage(id, status, note) {
    const el = document.querySelector(`[data-stage="${id}"]`);
    if (!el) return;
    el.classList.remove('active', 'done', 'error');
    if (status) el.classList.add(status);
    const noteEl = el.querySelector('.st-note');
    if (noteEl && note) noteEl.textContent = note;
    const order = ['cohort', 'stats', 'report'];
    const doneCount = order.filter(k => {
      const n = document.querySelector(`[data-stage="${k}"]`);
      return n && n.classList.contains('done');
    }).length;
    const bar = document.getElementById('run-progress');
    if (bar) bar.style.width = `${Math.min(100, (doneCount / 3) * 100)}%`;
  }
  function runLog(msg, isErr = false) {
    const box = document.getElementById('run-log');
    if (!box) return;
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const div = document.createElement('div');
    div.className = 'ln' + (isErr ? ' err' : '');
    div.innerHTML = `<b>${esc(t)}</b><em>${esc(msg)}</em>`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ---------- header / stepper ----------
  const steps = [
    { id: 'data', label: '确认数据' },
    { id: 'directions', label: '选择方向' },
    { id: 'protocol', label: '确认方案' },
    { id: 'run', label: '运行分析' },
    { id: 'result', label: '结果与报告' },
  ];
  function stepAvailable(id) {
    if (id === 'data') return true;
    if (id === 'directions') return !!state.eda || state.step !== 'home';
    if (id === 'protocol') return !!state.selected;
    if (id === 'run') return !!state.selected;
    if (id === 'result') return !!(state.stats || state.manuscript);
    return false;
  }
  function renderStepper() {
    if (state.step === 'home') { stepper.classList.add('hidden'); return; }
    stepper.classList.remove('hidden');
    const idx = steps.findIndex(s => s.id === state.step);
    const inner = steps.map((s, i) => {
      const done = i < idx;
      const active = s.id === state.step;
      const avail = stepAvailable(s.id);
      return `<button class="step ${active ? 'active' : ''} ${done ? 'done' : ''}" data-step="${s.id}" ${avail ? '' : 'disabled'} style="${avail ? '' : 'opacity:.45;cursor:not-allowed'}">
        <span class="step-dot">${done ? '✓' : (i + 1)}</span><span>${s.label}</span></button>${i < steps.length - 1 ? '<span class="step-line"></span>' : ''}`;
    }).join('');
    stepper.querySelector('.stepper-in').innerHTML = inner;
    stepper.querySelectorAll('.step[data-step]').forEach(btn => {
      btn.addEventListener('click', () => { if (!btn.disabled) go(btn.dataset.step); });
    });
  }

  function setHash(step) {
    const h = step === 'home' ? '#/' : `#/${step}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  async function go(step) {
    if (step === 'protocol' && !state.selected) { toast('先选择一个研究方向'); step = 'directions'; }
    if ((step === 'run' || step === 'result') && !state.selected) { toast('先确认研究方案'); step = 'directions'; }
    if (step === 'result' && !state.stats && !state.manuscript) step = 'run';
    state.step = step;
    state.error = '';
    persist();
    setHash(step);
    renderStepper();
    if (step === 'home') return renderHome();
    if (step === 'data') return renderData();
    if (step === 'directions') return renderDirections();
    if (step === 'protocol') return renderProtocol();
    if (step === 'run') return renderRun();
    if (step === 'result') return renderResult();
  }

  // ---------- data ----------
  async function loadEDA() {
    if (state.eda) return state.eda;
    const st = await api('/api/skill1/status');
    if (st && (st.status === 'completed' || st.tables_found)) { state.eda = st; return st; }
    busy('正在读取数据', '扫描 8 张表、评估变量质量，通常需要几秒');
    try {
      const out = await api('/api/skill1/run', { method: 'POST', body: {} });
      state.eda = out;
      return out;
    } finally { idle(); }
  }

  function edaSummary(eda) {
    const s = (eda && eda.summary) || {};
    return {
      tables: eda && eda.tables_found || 0,
      patients: eda && eda.total_patients_estimate || 0,
      usable: s.usable_variables || 0,
      cautious: s.cautious_variables || 0,
      columns: s.total_columns_analyzed || 0,
    };
  }

  async function renderHome() {
    const saved = state.selected ? state.selected : null;
    const savedLabel = saved ? (saved.title || saved.title_cn || '上次的研究方案') : '';
    app.innerHTML = `
      <section class="hero">
        <div class="hero-in">
          <div>
            <div class="kicker">RWD Research Agent · 临床研究智能体</div>
            <h1>从一个临床问题，<em>到可复现的研究报告。</em></h1>
            <p class="hero-lead">面向真实世界数据（RWD）的研究工作台。先确认数据能回答什么，再选方向、定方案、跑分析，最后得到带方法、质控和可追溯变量的 IMRAD 报告。</p>
            <div class="hero-actions">
              <button class="btn btn-primary btn-lg" id="start-flow">用示例数据开始 <span class="arw">→</span></button>
              <a class="btn btn-lg" href="#sample">查看示例产出</a>
            </div>
            <div class="hero-note"><span>MIMIC-IV 脓毒症 ICU 队列</span><span>全程可追溯</span><span>不写代码</span></div>
            <div class="hero-stats">
              <div class="hero-stat"><b>12,216</b><span>ICU 患者</span></div>
              <div class="hero-stat"><b>33</b><span>可用变量</span></div>
              <div class="hero-stat"><b>8</b><span>张数据表</span></div>
              <div class="hero-stat"><b>5</b><span>段可追溯流程</span></div>
            </div>
            ${saved ? `<div class="resume"><div><b>继续上次：${esc(savedLabel)}</b><p>已保存方案与阶段结果，可从上次位置接着做。</p></div><button class="btn btn-sm" id="resume-flow">继续 →</button></div>` : ''}
          </div>
          <div class="artifact" id="sample">
            <div class="artifact-top"><span>示例产出 / sample output</span><span>research draft</span></div>
            <h3>乳酸清除率与脓毒症患者住院死亡</h3>
            <div class="q">示例研究问题：24 小时内乳酸清除率是否与住院死亡相关？</div>
            <ul>
              <li><b>研究队列</b><span>cohort</span></li>
              <li><b>Table 1 基线特征</b><span>table 1</span></li>
              <li><b>组间比较 + 回归</b><span>statistics</span></li>
              <li><b>IMRAD 报告草稿</b><span>manuscript</span></li>
            </ul>
            <div class="artifact-foot"><span>结构示例，非真实研究结论</span><span>4 artifacts</span></div>
          </div>
        </div>
      </section>
      <section class="section-home">
        <div class="wrap">
          <div class="home-head"><div class="kicker">工作流 / how it works</div><h2>把研究拆成五个可检查的步骤。</h2><p>每一步都有明确的输入与产出；没确认上一步，不会把你丢进空白聊天框。</p></div>
          <div class="flow-grid">
            ${[
              ['01','确认数据','看数据能回答什么、不能回答什么。'],
              ['02','选择方向','从候选方向里看 PICO、变量与方法。'],
              ['03','确认方案','人群、暴露、对照、结局，先对齐再跑。'],
              ['04','运行分析','队列、统计、报告分阶段执行。'],
              ['05','结果与报告','结论、质控、局限和可下载报告。'],
            ].map(([n,t,d]) => `<div class="flow-card"><div class="num">${n}</div><h3>${t}</h3><p>${d}</p></div>`).join('')}
          </div>
        </div>
      </section>
      <section class="section-home alt">
        <div class="wrap">
          <div class="home-head"><div class="kicker">设计原则 / principles</div><h2>不是一个更长的聊天框。</h2><p>临床研究需要的是可复核的判断，而不是一段看起来合理的文字。</p></div>
          <div class="why-grid">
            <div class="why"><b>先给判断，再给细节</b><p>首页先让你看到产出结构；数据页先讲能回答什么，技术细节折叠在后面。</p></div>
            <div class="why"><b>每一步都能回头改</b><p>方向、PICO、方法在运行前都能确认；运行后保留参数和中间产物。</p></div>
            <div class="why"><b>结果带质控和局限</b><p>样本量、缺失变量、统计假设、探索性结论都写在结果里，不藏在脚注。</p></div>
          </div>
          <div class="home-cta">
            <div><h2>用一份真实队列，走完一遍完整流程。</h2><p>不需要上传数据，先用内置的脓毒症 ICU 队列体验。</p></div>
            <button class="btn btn-primary btn-lg" id="start-flow-2">开始 <span class="arw">→</span></button>
          </div>
        </div>
      </section>`;
    document.getElementById('start-flow')?.addEventListener('click', startFlow);
    document.getElementById('start-flow-2')?.addEventListener('click', startFlow);
    document.getElementById('resume-flow')?.addEventListener('click', () => {
      if (state.manuscript || state.stats) go('result');
      else if (state.selected) go('protocol');
      else go('data');
    });
  }

  async function startFlow() {
    try {
      await loadEDA();
      go('data');
    } catch (e) {
      toast(e.message || '读取数据失败');
    }
  }

  // ---------- data page ----------
  function renderData() {
    const eda = state.eda;
    if (!eda) {
      app.innerHTML = `<div class="wrap page"><div class="empty"><h3>正在准备数据</h3><p>首次进入需要先读取数据表。</p><button class="btn btn-primary" id="load-data">读取数据</button></div></div>`;
      document.getElementById('load-data')?.addEventListener('click', async () => {
        try { await loadEDA(); renderData(); } catch (e) { toast(e.message); }
      });
      return;
    }
    const s = edaSummary(eda);
    const keyVars = ((eda.summary || {}).key_clinical_variables || []).slice(0, 10);
    const tables = (eda.table_names || []).slice(0, 8);
    const rels = (eda.relationships || []).slice(0, 6);
    app.innerHTML = `<div class="wrap page">
      <div class="kicker">Step 01 / 数据</div>
      <h1 class="page-title">先确认，这份数据能回答什么。</h1>
      <p class="page-sub">这是 MIMIC-IV 脓毒症 ICU 队列的 24 小时数据集。先看覆盖范围和变量质量，再决定研究方向。</p>
      <div class="stat-grid">
        <div class="stat"><b>${num(s.tables)}</b><span>数据表</span><em>已扫描并建立关联</em></div>
        <div class="stat"><b>${num(s.patients)}</b><span>可分析患者</span><em>ICU 队列估计值</em></div>
        <div class="stat"><b>${num(s.usable)}</b><span>可用变量</span><em>缺失率 &lt; 5%</em></div>
        <div class="stat"><b>${num(s.cautious)}</b><span>需谨慎变量</span><em>缺失率 5%–30%</em></div>
      </div>
      <div class="quality"><span class="q-mark">✓</span><div><b>数据质量：可进入分析。</b> ${num(s.columns)} 个字段已完成缺失率与类型评估；${num(s.cautious)} 个变量在建模时需要额外处理。</div></div>
      <div class="split">
        <div class="panel"><h3><span class="dot"></span>可以回答</h3><ul>
          <li><b>队列描述</b>：基线特征、合并症、实验室指标分布。</li>
          <li><b>组间比较</b>：暴露组与对照组的结局差异。</li>
          <li><b>时间到事件</b>：住院死亡、ICU 时长等结局。</li>
          <li><b>探索性关联</b>：多变量回归与亚组分析。</li>
        </ul></div>
        <div class="panel negative"><h3><span class="dot"></span>不建议回答</h3><ul>
          <li><b>因果推断</b>：观察性数据，无法排除未测量混杂。</li>
          <li><b>院外人群外推</b>：单中心 ICU 队列，外推需谨慎。</li>
          <li><b>实时预测</b>：24 小时截断数据，不支持在线预警。</li>
          <li><b>罕见结局</b>：事件数不足时，统计功效有限。</li>
        </ul></div>
      </div>
      <div class="section">
        <div class="section-head"><div><h2>数据构成</h2><p>8 张核心表，覆盖入院、诊断、实验室、用药与结局。</p></div><span class="hint">${num(s.columns)} 个字段</span></div>
        <div class="table-list">
          ${tables.map((t, i) => {
            const tr = (eda.table_reports || []).find(r => r.table === t) || {};
            const cols = (tr.columns || []).length;
            return `<div class="trow"><span class="idx">${String(i+1).padStart(2,'0')}</span><div class="nm"><b>${esc(t)}</b><span>${cols ? cols + ' 个字段' : '结构已扫描'}</span></div><span class="sz">${(eda.table_sizes || {})[t] ? ((eda.table_sizes[t]) + ' MB') : ''}</span><span></span></div>`;
          }).join('')}
        </div>
        <details class="tech"><summary>技术细节：表关联、变量质量与扫描范围</summary><div class="tech-body">
          <div class="small muted" style="margin:12px 0 4px">主键与关联关系（前 6 条）</div>
          <div class="rel">${rels.map(r => `<span>${esc(r.left || r.from || '')} ↔ ${esc(r.right || r.to || '')}</span>`).join('') || '<span>暂无关联信息</span>'}</div>
          <div class="small muted" style="margin:16px 0 0">关键临床变量（前 10 个）</div>
          <table class="var-table"><thead><tr><th>变量</th><th>来源表</th><th>缺失率</th><th>质量</th></tr></thead><tbody>
            ${keyVars.map(v => `<tr><td>${esc(v.variable)}</td><td>${esc(v.table || '—')}</td><td>${v.missing_frac != null ? (Number(v.missing_frac)*100).toFixed(1) + '%' : '—'}</td><td>${esc(v.missing_level || '—')}</td></tr>`).join('') || '<tr><td colspan="4">暂无变量明细</td></tr>'}
          </tbody></table>
        </div></details>
      </div>
      <div class="cta-row"><div class="hint">下一步会从候选方向中，按可行性与创新性筛出适合这份数据的方向。</div><button class="btn btn-primary btn-lg" id="to-directions">用这份数据选方向 <span class="arw">→</span></button></div>
    </div>`;
    document.getElementById('to-directions')?.addEventListener('click', () => go('directions'));
  }

  // ---------- ideas ----------
  function feasibility(idea) {
    const s = idea.scores || {};
    if (!Object.keys(s).length) return null;
    const v = Number(s.data_verifiability || 0) + Number(s.statistical_feasibility || 0);
    return v;
  }
  function feasibilityLabel(v) { return v >= 9 ? '高可行' : v >= 7 ? '可尝试' : '需谨慎'; }
  function picoOf(idea) { return idea.pico || {}; }
  function prettyLabel(label) {
    return String(label || '')
      .replace(/Age vs\.?\s*Hospital Mortality/i, '年龄与住院死亡')
      .replace(/Gender vs\.?\s*Hospital Mortality/i, '性别与住院死亡')
      .replace(/vs\.?\s*Hospital Mortality/ig, '与住院死亡')
      .replace(/Hospital Mortality/ig, '住院死亡')
      .replace(/^lab_(?:lab_)?/i, '')
      .replace(/^lactate\b/i, '乳酸')
      .replace(/\s+与住院死亡/g, '与住院死亡')
      .replace(/^Age$/i, '年龄')
      .replace(/^Gender$/i, '性别')
      .replace(/^Lactate$/i, '乳酸')
      .replace(/^Bilirubin$/i, '胆红素')
      .replace(/^Albumin$/i, '白蛋白');
  }
  function ideaCard(idea, rank, compact = false) {
    const p = picoOf(idea);
    const f = feasibility(idea);
    const cls = f == null ? 'mid' : (f >= 9 ? '' : 'mid');
    const vars = idea.data_variables || [];
    return `<article class="idea ${compact ? 'compact' : ''}" data-id="${esc(idea.id)}">
      <div class="top"><span class="rank">${rank ? String(rank).padStart(2,'0') : ''}</span><span class="badge ${cls}">${f == null ? '自定义' : feasibilityLabel(f)}</span></div>
      <h3>${esc(idea.title || idea.title_cn || '未命名方向')}</h3>
      <p class="one">${esc(idea.hypothesis || idea.research_question || idea.rationale || '')}</p>
      ${compact ? '' : `<div class="pico-mini">
        <div><b>P</b><span>${esc(p.P || '—')}</span></div>
        <div><b>I</b><span>${esc(p.I || '—')}</span></div>
        <div><b>O</b><span>${esc(p.O || '—')}</span></div>
      </div>`}
      <div class="meta"><span>可行度 <b>${f}/10</b></span><span>创新 <b>${(idea.scores || {}).innovation || '—'}/5</b></span><span>${vars.length} 个变量</span></div>
      ${compact ? '' : `<button class="btn btn-sm go" data-pick="${esc(idea.id)}">查看方案 <span class="arw">→</span></button>`}
    </article>`;
  }

  function filteredIdeas() {
    let list = state.ideas.slice().sort((a, b) => (b.total_score || 0) - (a.total_score || 0));
    if (state.tab === 'feasible') list = list.filter(i => feasibility(i) >= 9);
    if (state.tab === 'innovative') list = list.filter(i => Number((i.scores || {}).innovation || 0) >= 4);
    return list;
  }

  function renderIdeasGrid() {
    const host = document.getElementById('idea-grid');
    if (!host) return;
    const list = filteredIdeas();
    const shown = list.slice(0, state.visible);
    host.innerHTML = shown.map((i, idx) => ideaCard(i, idx + 1)).join('') || `<div class="empty" style="grid-column:1/-1"><h3>这个筛选下没有方向</h3><p>换一个筛选，或查看全部候选。</p></div>`;
    host.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => pickIdea(b.dataset.pick)));
    const more = document.getElementById('more-ideas');
    if (more) more.style.display = list.length > state.visible ? 'inline-flex' : 'none';
    const count = document.getElementById('idea-count');
    if (count) count.textContent = `${shown.length} / ${list.length}`;
  }

  async function pickIdea(id) {
    if (!id) return;
    const btn = document.querySelector(`[data-pick="${CSS.escape(id)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = '正在载入…'; }
    try {
      const out = await api('/api/skill2/select-idea', { method: 'POST', body: { idea_id: id } });
      if (!out.idea) throw new ApiError(out.error || '没有找到这个方向');
      state.selected = out.idea;
      state.cohort = state.stats = null;
      state.manuscript = '';
      state.reportFallback = false;
      persist();
      go('protocol');
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = '查看方案 →'; }
    }
  }

  async function ensureIdeas() {
    if (state.ideas.length) return;
    const pool = await api('/api/ideas/pool');
    if (pool.ideas && pool.ideas.length) { state.ideas = pool.ideas; return; }
    const out = await api('/api/skill2/status');
    if (out && out.ideas && out.ideas.length) { state.ideas = out.ideas; return; }
    throw new ApiError('EMPTY_POOL');
  }

  async function generateIdeas() {
    busy('正在生成研究方向', '首次使用需要生成候选方向，约 30–60 秒');
    try {
      const out = await api('/api/skill2/run', { method: 'POST', body: { mode: 'ai_assisted' } });
      if (out && out.error) throw new ApiError(out.error);
      state.ideas = (out && out.ideas) || [];
      if (!state.ideas.length) throw new ApiError('生成完成但没有拿到方向，请重试');
      idle();
      renderDirections();
    } catch (e) {
      idle();
      state.error = e.message || '生成失败';
      renderDirections();
    }
  }

  async function renderDirections() {
    app.innerHTML = `<div class="wrap page">
      <div class="kicker">Step 02 / 方向</div>
      <h1 class="page-title">从候选方向里，选一个值得做的。</h1>
      <p class="page-sub">每个方向都带 PICO、所需变量、建议方法和可行性评分。先看能不能做，再看想不想做。</p>
      <div id="ideas-host"><div class="skeleton" style="height:180px"></div><div class="skeleton" style="height:180px;margin-top:14px"></div></div>
    </div>`;
    try {
      await ensureIdeas();
    } catch (e) {
      if (e.message === 'EMPTY_POOL') return renderEmptyIdeas();
      toast(e.message);
      return renderEmptyIdeas(e.message);
    }
    renderDirectionsReady();
  }

  function renderEmptyIdeas(err) {
    const host = document.getElementById('ideas-host');
    if (!host) return;
    host.innerHTML = `<div class="empty">
      <h3>选题库还没有生成</h3>
      <p>${esc(err || '首次使用需要先生成一批候选研究方向；生成后会缓存，后续直接加载。')}</p>
      <button class="btn btn-primary" id="gen-ideas">生成研究方向 <span class="arw">→</span></button>
      ${err ? '<div class="hint" style="margin-top:12px">如果反复失败，检查服务端模型配置。</div>' : ''}
    </div>`;
    document.getElementById('gen-ideas')?.addEventListener('click', generateIdeas);
  }

  function renderDirectionsReady() {
    const host = document.getElementById('ideas-host');
    if (!host) return;
    const list = filteredIdeas();
    host.innerHTML = `
      <div class="toolbar">
        <div class="tabs">
          ${[['all','全部'],['feasible','高可行'],['innovative','高创新']].map(([k,t]) => `<button class="tab ${state.tab===k?'active':''}" data-tab="${k}">${t}</button>`).join('')}
        </div>
        <div class="hint"><b id="idea-count">${Math.min(state.visible,list.length)} / ${list.length}</b> 个方向 · 按综合评分排序</div>
      </div>
      <div class="idea-grid" id="idea-grid"></div>
      <div style="display:flex;justify-content:center;margin-top:22px"><button class="btn" id="more-ideas">显示更多</button></div>`;
    host.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
      state.tab = b.dataset.tab; state.visible = 9;
      host.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
      renderIdeasGrid();
    }));
    document.getElementById('more-ideas')?.addEventListener('click', () => { state.visible += 9; renderIdeasGrid(); });
    renderIdeasGrid();
  }

  // ---------- protocol ----------
  function renderProtocol() {
    const idea = state.selected;
    if (!idea) return go('directions');
    const p = picoOf(idea);
    const vars = idea.data_variables || [];
    const method = idea.suggested_method || '按变量结构与结局类型自动匹配';
    const f = feasibility(idea);
    app.innerHTML = `<div class="wrap page">
      <div class="kicker">Step 03 / 方案</div>
      <h1 class="page-title">先把研究方案对齐，再开始跑。</h1>
      <p class="page-sub">下面这些字段会决定队列怎么建、统计怎么做。确认后再运行，避免跑完才发现人群或结局不对。</p>
      <div class="protocol-grid">
        <div class="form-card">
          <h2>研究方案</h2>
          <p class="sub">标题、问题与 PICO 可以修改；变量和方法由系统根据数据可用性生成。</p>
          <div class="field"><label>研究标题</label><input id="f-title" value="${esc(idea.title || idea.title_cn || '')}" /></div>
          <div class="field"><label>研究问题</label><textarea id="f-rq">${esc(idea.research_question || '')}</textarea></div>
          <div class="field"><label>研究假设</label><textarea id="f-hypo">${esc(idea.hypothesis || '')}</textarea></div>
          <div class="pico-grid">
            <div class="field"><label>P <span>人群</span></label><textarea id="f-P">${esc(p.P || '')}</textarea></div>
            <div class="field"><label>I <span>暴露 / 干预</span></label><textarea id="f-I">${esc(p.I || '')}</textarea></div>
            <div class="field"><label>C <span>对照</span></label><textarea id="f-C">${esc(p.C || '')}</textarea></div>
            <div class="field"><label>O <span>结局</span></label><textarea id="f-O">${esc(p.O || '')}</textarea></div>
          </div>
          <div class="field"><label>分析备注 <span>可选，会随方案保存</span></label><textarea id="f-notes" placeholder="例如：只纳入首次入 ICU、排除年龄 < 18 岁">${esc(idea.protocol_notes || '')}</textarea></div>
          <div class="field"><label>数据变量 <span>来自队列，不可在运行前改</span></label><div class="chips">${vars.length ? vars.map(v => `<span class="chip">${esc(v)}</span>`).join('') : '<span class="hint">系统将按 PICO 自动匹配变量</span>'}</div></div>
          <div class="form-foot">
            <button class="btn" id="back-directions">← 返回改方向</button>
            <div style="display:flex;align-items:center;gap:12px"><span class="hint" id="save-state">已保存</span><button class="btn btn-primary" id="start-run">开始分析 <span class="arw">→</span></button></div>
          </div>
        </div>
        <div>
          <div class="side-card"><h3>系统将执行</h3><ol class="side-steps">
            <li><i>01</i><span><b>队列提取</b><br>按 PICO 从 ${vars.length || '若干'} 个变量构建分析队列，记录每一步排除人数。</span></li>
            <li><i>02</i><span><b>统计检验</b><br>前置校验 → 方法匹配 → 执行；建议方法：${esc(method)}。</span></li>
            <li><i>03</i><span><b>报告生成</b><br>IMRAD 结构，附 Table 1、统计结果与局限。</span></li>
          </ol></div>
          <div class="side-card"><h3>方案评估</h3>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><span>数据可行度</span><b>${f == null ? '待校验' : f + '/10'}</b></div>
            <div class="progress"><i style="width:${f == null ? 0 : Math.min(100, f * 10)}%"></i></div>
            <div class="hint" style="margin-top:9px">${f == null ? '自定义方向，运行前会按实际变量与数据完整性校验。' : '综合数据可验证性与统计可行性。低于 7 分建议换方向或调整变量。'}</div>
          </div>
          <div class="warn"><b>观察性研究，不是因果结论。</b>结果只能说明关联；未测量混杂、选择偏倚和单中心外推限制需要在报告中说明。</div>
        </div>
      </div>
    </div>`;
    bindProtocol(idea);
  }

  function bindProtocol(idea) {
    const map = [
      ['f-title', 'title'], ['f-rq', 'research_question'], ['f-hypo', 'hypothesis'], ['f-notes', 'notes']
    ];
    map.forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        if (key === 'notes') idea.protocol_notes = el.value;
        else idea[key] = el.value;
        scheduleUpdate();
      });
    });
    ['P','I','C','O'].forEach(k => {
      const el = document.getElementById('f-' + k);
      if (!el) return;
      el.addEventListener('input', () => {
        idea.pico = idea.pico || {};
        idea.pico[k] = el.value;
        scheduleUpdate();
      });
    });
    document.getElementById('back-directions')?.addEventListener('click', () => go('directions'));
    document.getElementById('start-run')?.addEventListener('click', startAnalysis);
  }

  function scheduleUpdate() {
    state.selected && persist();
    const tag = document.getElementById('save-state');
    if (tag) tag.textContent = '保存中…';
    clearTimeout(updateTimer);
    updateTimer = setTimeout(async () => {
      try {
        if (!state.selected) return;
        await api('/api/ideas/update', { method: 'POST', body: {
          title: state.selected.title,
          research_question: state.selected.research_question,
          hypothesis: state.selected.hypothesis,
          pico: state.selected.pico || {},
          notes: state.selected.protocol_notes || '',
        }});
        if (tag) tag.textContent = '已保存';
      } catch (e) {
        if (tag) tag.textContent = '保存失败';
      }
    }, 450);
  }

  // ---------- run ----------
  function renderRun() {
    if (state.step !== 'run') {
      // tolerate direct call
    }
    const idea = state.selected;
    if (!idea) return go('directions');
    const running = state.running;
    app.innerHTML = `<div class="wrap page">
      <div class="kicker">Step 04 / 运行</div>
      <h1 class="page-title">${running ? '分析正在按阶段执行。' : (state.stats ? '分析已经完成。' : '分析会按三个阶段执行。')}</h1>
      <p class="page-sub">${esc(idea.title || '')}</p>
      ${!state.stats ? '<p class="run-hint">队列提取会读取 24 小时实验室数据；首次运行可能需要几十秒，阶段完成后结果会保存在本机。</p>' : ''}
      <div class="run-head">
        <div class="run-head-top"><div><h2 id="run-state">${running ? '正在运行' : (state.stats ? '已完成' : '等待开始')}</h2><p id="run-sub">${running ? '可以离开这个页面，回来后仍会从当前阶段继续。' : '确认方案后开始；三步都会留下可检查的产物。'}</p></div><span class="badge" id="run-pct" style="align-self:flex-start">${running ? '进行中' : (state.stats ? '3 / 3' : '待运行')}</span></div>
        <div class="progress"><i id="run-progress" style="width:${state.stats ? 100 : 0}%"></i></div>
        <div class="stages">
          <div class="stage ${state.cohort ? 'done' : ''}" data-stage="cohort"><div class="st-top"><span class="st-dot"></span>STAGE 01</div><b>队列提取</b><span class="st-note">${state.cohort ? num(state.cohort.final_cohort_size || 0) + ' 条记录' : '等待运行'}</span></div>
          <div class="stage ${state.stats ? 'done' : ''}" data-stage="stats"><div class="st-top"><span class="st-dot"></span>STAGE 02</div><b>统计检验</b><span class="st-note">${state.stats ? (state.stats.results || []).length + ' 项分析' : '等待运行'}</span></div>
          <div class="stage ${state.manuscript ? 'done' : ''}" data-stage="report"><div class="st-top"><span class="st-dot"></span>STAGE 03</div><b>生成报告</b><span class="st-note">${state.manuscript ? '已生成' : '等待运行'}</span></div>
        </div>
      </div>
      <div class="run-grid">
        <div class="console" id="run-log">${running ? '' : '<div class="ln"><b>ready</b><em>点击「开始分析」后，这里会显示每一步的执行记录。</em></div>'}</div>
        <div class="artifacts" id="run-artifacts">
          <div class="artifact-row"><div><b>分析队列</b><span>research_cohort.csv</span></div><span class="${state.cohort ? 'ok' : ''}">${state.cohort ? '已生成' : '待生成'}</span></div>
          <div class="artifact-row"><div><b>统计结果</b><span>表 + 方法 + p 值</span></div><span class="${state.stats ? 'ok' : ''}">${state.stats ? '已生成' : '待生成'}</span></div>
          <div class="artifact-row"><div><b>研究草稿</b><span>IMRAD / Markdown</span></div><span class="${state.manuscript ? 'ok' : ''}">${state.manuscript ? '已生成' : '待生成'}</span></div>
        </div>
      </div>
      <div class="run-next">
        ${!running && !state.stats ? '<button class="btn btn-primary btn-lg" id="run-start">开始分析 <span class="arw">→</span></button>' : ''}
        ${state.stats ? '<button class="btn btn-primary btn-lg" id="to-result">查看结果 <span class="arw">→</span></button>' : ''}
      </div>
    </div>`;
    document.getElementById('run-start')?.addEventListener('click', startAnalysis);
    document.getElementById('to-result')?.addEventListener('click', () => go('result'));
  }

  async function startAnalysis() {
    if (state.running) return;
    if (!state.selected) return go('directions');
    state.running = true;
    state.cohort = null; state.stats = null; state.manuscript = ''; state.reportFallback = false;
    state.step = 'run'; setHash('run'); renderStepper();
    renderRun();
    await runAnalysis();
  }

  async function runAnalysis() {
    const token = ++runToken;
    const alive = () => token === runToken;
    state.running = true;
    const start = Date.now();
    try {
      if (document.getElementById('run-state')) document.getElementById('run-state').textContent = '正在运行';
      setStage('cohort', 'active', '正在构建队列…');
      runLog('开始队列提取：按 PICO 映射变量');
      runLog('正在解析研究 idea 的变量需求…');
      const cohort = await api('/api/skill3/run', { method: 'POST', body: {} });
      if (!alive()) return;
      if (!cohort || cohort.error || cohort.status === 'error') throw new ApiError((cohort && cohort.error) || '队列提取没有返回结果');
      runLog(`队列完成：${cohort.final_cohort_size} 条 ICU 记录，${cohort.n_columns || 0} 个变量`);
      state.cohort = cohort;
      setStage('cohort', 'done', `${cohort.final_cohort_size || 0} 条记录`);
      runLog('队列提取完成');

      setStage('stats', 'active', '正在执行统计检验…');
      runLog('开始统计检验：前置校验 → 方法匹配 → 执行');
      const stats = await api('/api/skill4/run', { method: 'POST', body: {} });
      if (!alive()) return;
      if (!stats || stats.error || stats.status === 'error') throw new ApiError((stats && stats.error) || '统计检验没有返回结果');
      runLog(`统计完成：${(stats.results || []).length} 项分析`);
      state.stats = stats;
      setStage('stats', 'done', `${(stats.results || []).length} 项分析`);

      setStage('report', 'active', '正在生成 IMRAD 报告…');
      runLog('开始生成报告：汇总队列与统计结果');
      let manuscript = '';
      try {
        runLog('正在汇总队列与统计结果…');
        const out = await api('/api/skill5/run', { method: 'POST', body: {} });
        if (out && out.manuscript) manuscript = out.manuscript;
        if (out && out.error) throw new ApiError(out.error);
      } catch (e) {
        runLog('报告生成失败：' + e.message, true);
        manuscript = buildFallbackReport();
        state.reportFallback = true;
      }
      if (!manuscript) { manuscript = buildFallbackReport(); state.reportFallback = true; }
      state.manuscript = manuscript;
      setStage('report', 'done', '已生成');
      runLog(`完成：用时 ${Math.round((Date.now() - start) / 1000)} 秒`);
      state.running = false;
      persist();
      const bar = document.getElementById('run-progress'); if (bar) bar.style.width = '100%';
      const st = document.getElementById('run-state'); if (st) st.textContent = '已完成';
      const pct = document.getElementById('run-pct'); if (pct) pct.textContent = '完成';
      const next = document.querySelector('.run-next');
      if (next) next.innerHTML = '<button class="btn btn-primary btn-lg" id="to-result">查看结果 <span class="arw">→</span></button>';
      document.getElementById('to-result')?.addEventListener('click', () => go('result'));
      setTimeout(() => { if (alive() && state.step === 'run') go('result'); }, 700);
    } catch (e) {
      if (!alive()) return;
      state.running = false;
      runLog(e.message || '运行失败', true);
      const active = document.querySelector('.stage.active');
      if (active) { active.classList.remove('active'); active.classList.add('error'); }
      const st = document.getElementById('run-state'); if (st) st.textContent = '运行中断';
      const pct = document.getElementById('run-pct'); if (pct) pct.textContent = '需处理';
      toast(e.message || '分析失败');
      const next = document.querySelector('.run-next');
      if (next) next.innerHTML = '<button class="btn btn-primary" id="run-start">重试</button>';
      document.getElementById('run-start')?.addEventListener('click', startAnalysis);
    }
  }

  function buildFallbackReport() {
    const idea = state.selected || {};
    const stats = state.stats || {};
    const cohort = state.cohort || {};
    const results = stats.results || [];
    const sig = results.filter(r => r.significant);
    const rows = results.map(r => `| ${prettyLabel(r.label) || '—'} | ${r.method || '—'} | ${r.p_value != null ? r.p_value : '—'} | ${r.significant ? '显著' : '不显著'} |`).join('\n');
    return `# ${idea.title || '研究方案'}

> 说明：模型服务未连接，以下为基于队列与统计结果的本地结构化摘要，不是完整的 IMRAD 报告。

## 背景
${idea.research_question || ''}

**研究假设**：${idea.hypothesis || ''}

## 方法
- 研究设计：观察性队列分析
- 数据来源：MIMIC-IV 脓毒症 ICU 24 小时数据集
- 纳入队列：${cohort.final_cohort_size || '—'} 例
- 变量：${(idea.data_variables || []).join('、') || '—'}
- 统计方法：${idea.suggested_method || '按变量结构自动匹配'}
- 显著性阈值：α = 0.05

## 结果
共执行 ${results.length} 项统计检验，其中 ${sig.length} 项达到统计学显著。

| 分析 | 方法 | p 值 | 结论 |
|---|---|---|---|
${rows || '| — | — | — | — |'}

${stats.interpretation || ''}

## 局限
- 观察性数据，不能推断因果。
- 单中心 ICU 队列，外推需谨慎。
- 未测量混杂与选择偏倚可能影响结果。
- 本摘要未经过完整同行评审式校验。
`;
  }

  // ---------- result ----------
  function fmtP(v) {
    if (v == null || Number.isNaN(Number(v))) return '—';
    const n = Number(v);
    if (n < 0.001) return '<0.001';
    return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  function prettyMethod(m) {
    const s = String(m || '');
    if (/wilcoxon/i.test(s)) return 'Mann-Whitney U 检验';
    if (/chi2|chi-square/i.test(s)) return '卡方检验';
    if (/t-test/i.test(s)) return 't 检验';
    return s || '—';
  }

  function polishReport(md, results) {
    let out = String(md || '');
    for (const r of results) {
      if (r.label) out = out.split(r.label).join(prettyLabel(r.label));
    }
    out = out.replace(/p\s*=\s*0(?:\.0+)?/g, 'p < 0.001');
    out = out.replace(/Mann-Whitney U 和检验/g, 'Mann-Whitney U 检验');
    if (!results.some(r => /regression|logistic/i.test(r.method || ''))) {
      out = out.replace(/、逻辑回归/g, '、卡方检验').replace(/逻辑回归/g, '卡方检验');
    }
    out = out.replace(/\n#{2,3}\s*参考文献\s*$/, '').trim();
    return out;
  }

  function renderResult() {
    if (!state.stats && !state.manuscript) return go('run');
    const stats = state.stats || {};
    const cohort = state.cohort || {};
    const results = stats.results || [];
    const sig = results.filter(r => r.significant);
    const idea = state.selected || {};
    const n = stats.sample_size || cohort.final_cohort_size || 0;
    const primaryKey = (idea.data_variables || []).find(v => v !== 'hospital_expire_flag');
    const normExp = v => String(v || '').replace(/^lab_lab_/, 'lab_');
    const primary = results.find(r => normExp(r.exposure) === normExp(primaryKey)) || sig[0] || results[0] || null;
    const ordered = primary ? [primary, ...results.filter(r => r !== primary)] : results;
    const lead = primary
      ? (primary.significant ? `${prettyLabel(primary.label) || '主要暴露'}存在统计学关联` : `未观察到${prettyLabel(primary.label) || '主要暴露'}与结局的显著关联`)
      : '未观察到统计学显著的组间差异';
    const report = polishReport(state.manuscript, results);
    const usedMethods = [...new Set(results.map(r => prettyMethod(r.method)))].filter(Boolean).join('、') || prettyMethod(idea.suggested_method) || '自动匹配';
    const included = cohort.variables_included || [];
    const missingVars = (cohort.variables_not_found || []).filter(v => !included.some(k => String(v).includes(k)));
    const sub = primary
      ? `在 ${num(n)} 条 ICU 记录中，${esc(prettyLabel(primary.label) || '主要暴露')}的 p 值为 ${esc(fmtP(primary.p_value))}${primary.significant ? '' : '，未达到显著水平'}；结果仍需结合效应量与临床意义判断。`
      : `在 ${num(n)} 条 ICU 记录中，当前检验未达到显著水平；可能是效应较小、事件数不足，或暴露定义需要调整。`;
    app.innerHTML = `<div class="wrap page">
      <div class="kicker">Step 05 / 结果</div>
      <div class="conclusion"><div class="eyebrow">研究结论 / result</div><h1>${esc(lead)}</h1><p>${sub}</p><div class="tags"><span>${esc(idea.title || '研究方案')}</span><span>n = ${num(n)}</span><span>${sig.length} / ${results.length} 项显著</span><span>观察性研究</span></div></div>
      ${state.reportFallback ? '<div class="notice"><b>报告为本地摘要。</b>模型服务暂时不可用，已根据队列与统计结果生成结构化草稿；完整 IMRAD 需重新生成。</div>' : ''}
      <div class="metric-row">
        <div class="metric"><b>${num(n)}</b><span>最终队列（ICU 记录）</span></div>
        <div class="metric"><b>${num(results.length)}</b><span>统计检验</span></div>
        <div class="metric"><b>${num(sig.length)}</b><span>显著结果</span></div>
        <div class="metric"><b>${report ? num(report.length) : '—'}</b><span>报告字符</span></div>
      </div>
      <div class="result-grid">
        <div>
          <div class="card"><h2>主要结果 <span>statistical results</span></h2>
            ${results.length ? `<table class="table"><thead><tr><th>分析</th><th>方法</th><th>组间</th><th>p</th><th>结论</th></tr></thead><tbody>
              ${ordered.map(r => `<tr><td>${esc(prettyLabel(r.label) || '—')}</td><td>${esc(prettyMethod(r.method))}</td><td class="num">${esc(r.group0_median != null ? `${r.group0_median} vs ${r.group1_median}` : (r.odds_ratio ? `OR ${r.odds_ratio}` : '—'))}</td><td class="num ${r.significant ? 'sig' : 'ns'}">${esc(fmtP(r.p_value))}</td><td>${r.significant ? '<span class="sig">显著</span>' : '不显著'}</td></tr>`).join('')}
            </tbody></table>` : '<p class="hint">没有统计结果。</p>'}
          </div>
          <div class="card"><h2>方法 <span>methods</span></h2>
            <p class="method-lead">样本量 ${num(n)} 条 ICU 记录，显著性阈值 α = 0.05。分析使用 ${esc(usedMethods)}。</p>
            <ul class="method-list">${ordered.map(r => `<li><b>${esc(prettyLabel(r.label) || '—')}</b>：${esc(prettyMethod(r.method))}，p = ${esc(fmtP(r.p_value))}，${r.significant ? '差异显著' : '差异不显著'}。</li>`).join('')}</ul>
            <p class="hint">结果为观察性关联，需结合效应量、置信区间与临床意义判断，不能直接解释为因果。</p>
          </div>
        </div>
        <div>
          <div class="card"><h2>质量检查 <span>qc</span></h2><ul class="quality-list">
            <li><i>✓</i><span>最终队列 ${num(n)} 条 ICU 记录，来源于 ${num(cohort.n_columns || (idea.data_variables || []).length)} 个变量。</span></li>
            <li><i>✓</i><span>统计方法：${esc(prettyMethod((stats.results || [])[0]?.method) || idea.suggested_method || '自动匹配')}。</span></li>
            ${missingVars.length ? `<li class="warn-i"><i>!</i><span>未找到变量：${esc(missingVars.join('、'))}</span></li>` : ''}
            ${(cohort.warnings || []).length ? `<li class="warn-i"><i>!</i><span>${esc((cohort.warnings || []).join('；'))}</span></li>` : ''}
            <li class="warn-i"><i>!</i><span>观察性设计，不能排除未测量混杂；结论为关联而非因果。</span></li>
            <li class="warn-i"><i>!</i><span>多项目检验未做多重比较校正，显著结果需谨慎解读。</span></li>
          </ul></div>
          <div class="card"><h2>产物 <span>artifacts</span></h2>
            <div class="artifact-row"><div><b>分析队列</b><span>${num(n)} 条记录 · ${num(cohort.n_columns || 0)} 个变量</span></div><span class="ok">已生成</span></div>
            <div class="artifact-row" style="margin-top:8px"><div><b>统计结果</b><span>${results.length} 项检验</span></div><span class="ok">已生成</span></div>
            <div class="artifact-row" style="margin-top:8px"><div><b>研究草稿</b><span>Markdown / IMRAD</span></div><span class="ok">已生成</span></div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:18px"><h2>报告草稿 <span>manuscript</span></h2><div class="report-wrap md" id="manuscript">${mdToHtml(report)}</div>
        <div class="result-actions">
          <button class="btn" id="print-report">打印 / 导出 PDF</button>
          <button class="btn" id="download-report">下载 Markdown</button>
          <button class="btn btn-primary" id="new-run">再做一次 <span class="arw">→</span></button>
        </div>
      </div>
    </div>`;
    document.getElementById('download-report')?.addEventListener('click', () => {
      const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `RWD-report-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    document.getElementById('print-report')?.addEventListener('click', () => window.print());
    document.getElementById('new-run')?.addEventListener('click', () => {
      state.cohort = null; state.stats = null; state.manuscript = ''; state.reportFallback = false;
      persist(); go('directions');
    });
  }

  // ---------- boot ----------
  function bindChrome() {
    document.getElementById('reset-app')?.addEventListener('click', async () => {
      if (!confirm('确定要清空当前进度，重新开始吗？')) return;
      try { await api('/api/reset', { method: 'POST' }); } catch (e) { /* ignore */ }
      localStorage.removeItem(KEY);
      Object.assign(state, { step: 'home', eda: null, ideas: [], selected: null, cohort: null, stats: null, manuscript: '', reportFallback: false, running: false, tab: 'all', visible: 9 });
      history.replaceState(null, '', '#/');
      renderStepper(); renderHome(); window.scrollTo({ top: 0 });
    });
    window.addEventListener('hashchange', () => {
      const s = (location.hash || '#/').replace('#/', '') || 'home';
      if (s !== state.step && ['home','data','directions','protocol','run','result'].includes(s)) go(s);
    });
  }

  async function boot() {
    restore();
    bindChrome();
    const route = (location.hash || '#/').replace('#/', '') || 'home';
    if (route !== 'home' && !state.selected) {
      try {
        const r = await api('/api/ideas/selected');
        if (r && r.idea) { state.selected = r.idea; persist(); }
      } catch (e) { /* ignore */ }
    }
    if (route === 'result' && !state.manuscript && !state.stats) return go('home');
    if (route === 'protocol' && !state.selected) return go('home');
    if (route !== 'home') return go(route);
    state.step = 'home';
    renderHome();
    renderStepper();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
