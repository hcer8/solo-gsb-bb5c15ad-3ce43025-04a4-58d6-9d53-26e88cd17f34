/* 实验室配液相容性推演台 —— 前端逻辑（原生 JS，无构建依赖） */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  reagents: [],
  plans: [],
  rules: [],
  categories: {},
  revision: "",
  stepRows: [],          // 方案编辑器中的步骤行
  editingStepReagents: [],
  customCats: new Set(),
  report: null,
};

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const opts = { headers: { "Content-Type": "application/json" }, ...options };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `请求失败 (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function toast(msg, isErr = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- Tabs ---------------- */

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === "rules") setTimeout(renderGraph, 60);
    if (btn.dataset.tab === "runs") loadRuns();
  });
});

/* ---------------- 数据加载 ---------------- */

async function loadReagents() {
  state.reagents = await api("/api/reagents");
  renderReagentList();
  renderCategoryChips();
  renderStepRows();
}

async function loadPlans() {
  state.plans = await api("/api/plans");
  renderPlanList();
}

async function loadRules() {
  const data = await api("/api/rules");
  state.rules = data.rules;
  state.categories = data.categories;
  state.revision = data.revision;
  $("#ruleRev").textContent = `规则图版本 ${data.revision} · ${data.rules.length} 条规则 · ${Object.keys(data.categories).length} 个类别`;
  renderRuleList();
  renderCategoryChips();
  renderGraph();
}

const catLabel = (key) => state.categories[key]?.label || key;
const sevRank = { low: 1, medium: 2, high: 3 };
const sevLabel = { low: "提示", medium: "警示", high: "严重" };

/* ---------------- 方案编辑 ---------------- */

function makeStepRow(partial = {}) {
  return {
    order_index: partial.order_index ?? state.stepRows.length,
    time_offset_min: partial.time_offset_min ?? null,
    amount_ml: partial.amount_ml ?? null,
    reagent_id: partial.reagent_id ?? null,
    reagent_name: partial.reagent_name ?? "",
    categories: partial.categories ?? [],
    note: partial.note ?? "",
  };
}

function renderStepRows() {
  const body = $("#stepsBody");
  body.innerHTML = "";
  state.stepRows.forEach((row, idx) => {
    const tr = document.createElement("tr");

    const tdIdx = document.createElement("td");
    tdIdx.className = "step-idx";
    tdIdx.textContent = idx + 1;
    tr.appendChild(tdIdx);

    // 试剂：下拉选择档案 + “使用临时试剂”切换
    const tdReg = document.createElement("td");
    const select = document.createElement("select");
    select.innerHTML =
      '<option value="">— 临时试剂（手动填写）—</option>' +
      state.reagents
        .map((r) => `<option value="${r.id}" ${row.reagent_id === r.id ? "selected" : ""}>${escapeHtml(r.name)}</option>`)
        .join("");
    select.addEventListener("change", () => {
      if (select.value) {
        row.reagent_id = Number(select.value);
        const r = state.reagents.find((x) => x.id === row.reagent_id);
        row.reagent_name = r ? r.name : "";
      } else {
        row.reagent_id = null;
      }
      renderStepRows();
    });
    tdReg.appendChild(select);

    if (row.reagent_id === null) {
      const tmp = document.createElement("input");
      tmp.type = "text";
      tmp.placeholder = "临时试剂名（如：新配制的王水）";
      tmp.value = row.reagent_name;
      tmp.style.marginTop = "5px";
      tmp.addEventListener("input", () => (row.reagent_name = tmp.value));
      tdReg.appendChild(tmp);

      const catInput = document.createElement("input");
      catInput.type = "text";
      catInput.placeholder = "类别，逗号分隔（如 strong_acid, oxidizer）";
      catInput.value = row.categories.join(", ");
      catInput.style.marginTop = "5px";
      catInput.addEventListener("input", () => {
        row.categories = catInput.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      });
      tdReg.appendChild(catInput);
    } else {
      const r = state.reagents.find((x) => x.id === row.reagent_id);
      if (r && r.categories.length) {
        const tags = document.createElement("div");
        tags.style.marginTop = "4px";
        tags.innerHTML = r.categories
          .map((c) => `<span class="badge badge-low">${escapeHtml(catLabel(c))}</span>`)
          .join(" ");
        tdReg.appendChild(tags);
      }
    }
    tr.appendChild(tdReg);

    // 时刻
    const tdTime = document.createElement("td");
    const inTime = document.createElement("input");
    inTime.type = "number"; inTime.min = "0"; inTime.step = "1";
    inTime.value = row.time_offset_min ?? "";
    inTime.addEventListener("input", () => (row.time_offset_min = inTime.value === "" ? null : Number(inTime.value)));
    tdTime.appendChild(inTime);
    tr.appendChild(tdTime);

    // 用量
    const tdAmt = document.createElement("td");
    const inAmt = document.createElement("input");
    inAmt.type = "number"; inAmt.min = "0"; inAmt.step = "0.1";
    inAmt.value = row.amount_ml ?? "";
    inAmt.addEventListener("input", () => (row.amount_ml = inAmt.value === "" ? null : Number(inAmt.value)));
    tdAmt.appendChild(inAmt);
    tr.appendChild(tdAmt);

    // 备注
    const tdNote = document.createElement("td");
    const inNote = document.createElement("input");
    inNote.type = "text"; inNote.value = row.note || "";
    inNote.placeholder = "操作方式/注意";
    inNote.addEventListener("input", () => (row.note = inNote.value));
    tdNote.appendChild(inNote);
    tr.appendChild(tdNote);

    // 删除
    const tdDel = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button"; del.className = "icon-btn"; del.textContent = "✕";
    del.title = "删除此步骤";
    del.addEventListener("click", () => {
      state.stepRows.splice(idx, 1);
      renderStepRows();
    });
    tdDel.appendChild(del);
    tr.appendChild(tdDel);

    body.appendChild(tr);
  });
}

function collectPlanPayload() {
  const name = $("#planName").value.trim();
  if (!name) throw new Error("请填写方案名称");
  if (!state.stepRows.length) throw new Error("请至少添加一个加液步骤");
  state.stepRows.forEach((r, i) => {
    if (r.reagent_id === null && !r.reagent_name.trim()) {
      throw new Error(`第 ${i + 1} 步需要选择试剂或填写临时试剂名`);
    }
  });
  return {
    name,
    description: $("#planDesc").value.trim() || null,
    steps: state.stepRows.map((r, i) => ({
      order_index: i,
      time_offset_min: r.time_offset_min,
      amount_ml: r.amount_ml,
      reagent_id: r.reagent_id,
      reagent_name: r.reagent_id ? null : r.reagent_name.trim(),
      categories: r.reagent_id ? null : r.categories,
      note: r.note || null,
    })),
  };
}

$("#btnAddStep").addEventListener("click", () => {
  state.stepRows.push(makeStepRow());
  renderStepRows();
});

$("#btnPlanReset").addEventListener("click", resetPlanForm);

function resetPlanForm() {
  $("#planForm").reset();
  $("#planId").value = "";
  $("#planFormTitle").textContent = "新建配液方案";
  $("#btnSavePlan").textContent = "💾 保存方案";
  $("#btnSimulateSaved").classList.add("hidden");
  $("#reportWrap").classList.add("hidden");
  state.report = null;
  state.stepRows = [makeStepRow()];
  renderStepRows();
}

$("#planForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = collectPlanPayload();
    const id = $("#planId").value;
    if (id) {
      await api(`/api/plans/${id}`, { method: "PUT", body: payload });
      toast("方案已更新");
    } else {
      const created = await api("/api/plans", { method: "POST", body: payload });
      $("#planId").value = created.id;
      $("#planFormTitle").textContent = "编辑配液方案";
      $("#btnSavePlan").textContent = "💾 保存修改";
      $("#btnSimulateSaved").classList.remove("hidden");
      toast("方案已保存");
    }
    await loadPlans();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btnDryRun").addEventListener("click", async () => {
  try {
    const payload = collectPlanPayload();
    const report = await api("/api/plans/simulate-dry", { method: "POST", body: payload });
    state.report = report;
    renderReport(report, { editable: true });
    toast(report.status === "danger" ? "预检发现严重危险！" : report.status === "warning" ? "预检完成：存在警示" : "预检通过：相容");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#btnSimulateSaved").addEventListener("click", async () => {
  const id = $("#planId").value;
  if (!id) return;
  try {
    const report = await api(`/api/plans/${id}/simulate?persist=true`, { method: "POST" });
    state.report = report;
    renderReport(report, { editable: true });
    loadRuns();
    toast("推演完成并已记录");
  } catch (err) {
    toast(err.message, true);
  }
});

function editPlan(plan) {
  resetPlanForm();
  $("#planId").value = plan.id;
  $("#planName").value = plan.name;
  $("#planDesc").value = plan.description || "";
  $("#planFormTitle").textContent = "编辑配液方案";
  $("#btnSavePlan").textContent = "💾 保存修改";
  $("#btnSimulateSaved").classList.remove("hidden");
  state.stepRows = plan.steps.map((s) => makeStepRow({
    order_index: s.order_index,
    time_offset_min: s.time_offset_min,
    amount_ml: s.amount_ml,
    reagent_id: s.reagent_id,
    reagent_name: s.reagent_name,
    categories: s.categories,
    note: s.note,
  }));
  renderStepRows();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function simulatePlan(plan) {
  editPlan(plan);
  const report = await api(`/api/plans/${plan.id}/simulate?persist=true`, { method: "POST" });
  state.report = report;
  renderReport(report, { editable: true });
  loadRuns();
}

function renderPlanList() {
  const q = ($("#planSearch").value || "").toLowerCase();
  const ul = $("#planList");
  ul.innerHTML = "";
  state.plans
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .forEach((p) => {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML = `
        <div class="item-title">${escapeHtml(p.name)}</div>
        <div class="item-meta"><span>🕐 ${p.steps.length} 步</span><span>更新于 ${fmtTime(p.updated_at)}</span></div>
        ${p.description ? `<div class="item-meta">${escapeHtml(p.description)}</div>` : ""}
      `;
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(
        actionBtn("编辑", "btn-small", () => editPlan(p)),
        actionBtn("⚡ 推演", "btn-small btn-primary", () => simulatePlan(p).catch((e) => toast(e.message, true))),
        actionBtn("导出 JSON", "btn-small", () => exportPlan(p.id)),
        actionBtn("删除", "btn-small btn-danger", () => removePlan(p)),
      );
      li.appendChild(actions);
      ul.appendChild(li);
    });
}

$("#planSearch").addEventListener("input", renderPlanList);

async function exportPlan(id) {
  const data = await api(`/api/plans/${id}/export`);
  downloadJson(data, `plan-${id}-report.json`);
  toast("已导出推演结果 JSON");
}

async function removePlan(plan) {
  if (!confirm(`确定删除方案「${plan.name}」？此操作不可撤销。`)) return;
  await api(`/api/plans/${plan.id}`, { method: "DELETE" });
  if (String($("#planId").value) === String(plan.id)) resetPlanForm();
  await loadPlans();
  toast("方案已删除");
}

function actionBtn(text, cls, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  return b;
}

/* ---------------- 报告渲染 ---------------- */

function renderReport(report, { editable = false, container = $("#reportWrap") } = {}) {
  window.__lastReport = report;
  const wrap = container;
  wrap.classList.remove("hidden");

  const first = report.first_danger;
  const bannerCls = report.status === "danger" ? "danger" : report.status === "warning" ? "warning" : "safe";
  const icon = report.status === "danger" ? "🛑" : report.status === "warning" ? "⚠️" : "✅";
  const title =
    report.status === "danger"
      ? `推演中止：第 ${first.step} 步首次发生严重危险反应`
      : report.status === "warning" ? "推演完成：存在需要关注的警示反应" : "推演完成：各步骤相容";

  let bannerMsg = "";
  if (first) {
    bannerMsg = `
      <p><b>${escapeHtml(first.reagent_name)}</b>（第 ${first.step} 步）与第 ${first.conflicts_with_step} 步加入的
      <b>${escapeHtml(first.conflicts_with_reagent)}</b> 冲突：${escapeHtml(first.title)}</p>
      <p>受影响步骤：${report.affected_steps.length ? report.affected_steps.map((s) => `第 ${s} 步`).join("、") : "无"}；
      阻断步骤：${report.blocked_steps.length ? report.blocked_steps.map((s) => `第 ${s} 步`).join("、") : "无"}</p>`;
  }

  wrap.innerHTML = `
    <div class="report-banner ${bannerCls}">
      <span class="big">${icon}</span>
      <div style="flex:1">
        <h2>${title}</h2>
        ${bannerMsg}
        <p class="item-meta">规则图版本 ${escapeHtml(report.rule_revision)} ·
          共 ${report.summary.total_steps} 步 / 执行 ${report.summary.executed_steps} 步 ·
          命中规则 <span class="badge badge-high">严重 ${report.summary.high}</span>
          <span class="badge badge-medium">警示 ${report.summary.medium}</span>
          <span class="badge badge-low">提示 ${report.summary.low}</span>
        </p>
      </div>
      <div class="form-actions" style="flex-direction:column">
        ${report.plan_id ? `<button class="btn btn-small" id="btnExportShow">⬇ 导出 JSON</button>` : ""}
      </div>
    </div>
    <div class="report-grid">
      <div class="card"><h2 style="margin-bottom:12px">⏱️ 逐步推演时间轴</h2><ul class="timeline">${
        report.timeline.map(renderTimelineItem).join("")
      }</ul></div>
      <div class="card"><h2 style="margin-bottom:12px">🔎 命中规则与判定依据（${report.findings.length}）</h2>
        <div class="finding-list">${
          report.findings.length
            ? report.findings.map(renderFindingCard).join("")
            : '<p class="hint">未命中任何相容性禁忌。</p>'
        }</div>
      </div>
    </div>`;

  const btnExport = $("#btnExportShow", wrap);
  if (btnExport) btnExport.addEventListener("click", () => exportPlan(report.plan_id));

  $$(".mini-rule, .finding-card", wrap).forEach((el) => {
    el.addEventListener("click", () => {
      const f = report.findings.find((x) => x.id === el.dataset.fid);
      if (f) openFindingModal(f, report.rule_revision);
    });
  });

  wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTimelineItem(t) {
  const findings = t.finding_ids
    .map((fid) => window.__lastReport?.findings?.find((x) => x.id === fid))
    .filter(Boolean);
  return `
    <li class="tl-item ${t.state}">
      <span class="tl-dot"></span>
      <div class="tl-body">
        <div class="tl-head">
          <span class="tl-name">第 ${t.order_index} 步 · ${escapeHtml(t.reagent_name)}</span>
          <span class="badge badge-${t.state === "ok" ? "ok" : t.state}">${t.state_label}</span>
        </div>
        <div class="tl-note">
          ${t.time_offset_min !== null ? `🕐 t=${t.time_offset_min} min · ` : ""}
          ${t.amount_ml !== null ? `${t.amount_ml} mL/g · ` : ""}
          ${(t.reagent_categories || []).map((c) => escapeHtml(catLabel(c))).join(" / ")}
          ${t.note ? " · " + escapeHtml(t.note) : ""}
        </div>
        <div class="tl-findings">
          ${findings.map((f) => `
            <button type="button" class="mini-rule ${f.severity}" data-fid="${f.id}">
              <b>[${f.rule_id}]</b> ${escapeHtml(f.title)} —— 与第 ${f.existing_step} 步「${escapeHtml(f.existing_reagent)}」
            </button>`).join("")}
        </div>
      </div>
    </li>`;
}

function renderFindingCard(f) {
  return `
    <div class="finding-card ${f.severity}" data-fid="${f.id}">
      <div class="fc-title">
        <span class="badge badge-${f.severity}">${f.severity_label}</span>
        [${f.rule_id}] ${escapeHtml(f.title)}
      </div>
      <div class="fc-meta">
        第 ${f.incoming_step} 步「${escapeHtml(f.incoming_reagent)}」(${escapeHtml(catLabel(f.incoming_category))})
        ⚠ 第 ${f.existing_step} 步「${escapeHtml(f.existing_reagent)}」(${escapeHtml(catLabel(f.existing_category))})
      </div>
      <div class="fc-meta">${escapeHtml(f.reaction)} · 点击查看机理与参考文献</div>
    </div>`;
}

/* ---------------- 弹层 ---------------- */

function openModal(html) {
  $("#modalBox").innerHTML = html;
  $("#modalBackdrop").classList.remove("hidden");
  const closeBtn = $(".modal-close", $("#modalBox"));
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
}
function closeModal() { $("#modalBackdrop").classList.add("hidden"); }
$("#modalBackdrop").addEventListener("click", (e) => { if (e.target === $("#modalBackdrop")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function openFindingModal(f, revision) {
  openModal(`
    <button class="btn btn-ghost modal-close">✕ 关闭</button>
    <h3><span class="badge badge-${f.severity}">${f.severity_label}</span> [${f.rule_id}] ${escapeHtml(f.title)}</h3>
    <div class="m-row"><div class="m-k">反应 / 现象</div><div class="m-eq">${escapeHtml(f.reaction)}</div></div>
    <div class="m-row"><div class="m-k">判定依据（机理）</div><div>${escapeHtml(f.rationale).replace(/\n/g, "<br>")}</div></div>
    <div class="m-row"><div class="m-k">参与步骤（可追溯）</div>
      <div>第 ${f.incoming_step} 步加入「${escapeHtml(f.incoming_reagent)}」，类别 <b>${escapeHtml(catLabel(f.incoming_category))}</b><br>
      与体系中第 ${f.existing_step} 步已加入的「${escapeHtml(f.existing_reagent)}」，类别 <b>${escapeHtml(catLabel(f.existing_category))}</b> 发生匹配<br>
      匹配方向：${f.match_direction === "incoming->existing" ? "新加入 → 已存在" : "已存在 → 新加入"}
      ${f.rule_directional ? "（有向规则）" : "（无向规则，双向等价）"}</div>
    </div>
    <div class="m-row"><div class="m-k">参考文献</div>
      <ul class="m-refs">${f.references.map((r) => `<li>· ${escapeHtml(r)}</li>`).join("") || "<li>无</li>"}</ul>
    </div>
    <div class="m-row m-k">规则图版本 ${escapeHtml(revision || state.revision)}</div>
  `);
}

function openRuleModal(rule) {
  openModal(`
    <button class="btn btn-ghost modal-close">✕ 关闭</button>
    <h3><span class="badge badge-${rule.severity}">${sevLabel[rule.severity]}</span> [${rule.id}] ${escapeHtml(rule.title)}</h3>
    <div class="m-row"><div class="m-k">规则边</div>
      <div>${escapeHtml(catLabel(rule.source))} <b>→</b> ${escapeHtml(catLabel(rule.target))}
      ${rule.directional ? "（有向）" : "（无向，双向匹配）"} · ${rule.builtin ? "内置规则" : "自定义规则"} · ${rule.active ? "启用中" : "已停用"}</div>
    </div>
    <div class="m-row"><div class="m-k">反应 / 现象</div><div class="m-eq">${escapeHtml(rule.reaction)}</div></div>
    <div class="m-row"><div class="m-k">判定依据（机理）</div><div>${escapeHtml(rule.rationale).replace(/\n/g, "<br>")}</div></div>
    <div class="m-row"><div class="m-k">参考文献</div>
      <ul class="m-refs">${rule.references.map((r) => `<li>· ${escapeHtml(r)}</li>`).join("") || "<li>无</li>"}</ul>
    </div>
  `);
}

/* ---------------- 试剂档案 ---------------- */

function renderCategoryChips() {
  const box = $("#rgCats");
  if (!box) return;
  const selected = new Set(box.dataset.selected ? box.dataset.selected.split(",") : []);
  box.innerHTML = "";
  Object.entries(state.categories).forEach(([key, meta]) => {
    const chip = document.createElement("span");
    chip.className = "chip" + (selected.has(key) ? " on" : "");
    chip.textContent = meta.label || key;
    chip.title = key;
    chip.addEventListener("click", () => {
      chip.classList.toggle("on");
      syncSelectedCats(box);
    });
    box.appendChild(chip);
  });
  state.customCats.forEach((key) => {
    if (state.categories[key]) return;
    const chip = document.createElement("span");
    chip.className = "chip on";
    chip.textContent = key;
    chip.title = key;
    chip.addEventListener("click", () => { chip.remove(); syncSelectedCats(box); });
    box.appendChild(chip);
  });
}

function syncSelectedCats(box) {
  box.dataset.selected = $$(".chip.on", box).map((c) => c.title || c.textContent).join(",");
}

$("#rgCatsCustom").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !state.customCats.has(v)) {
      state.customCats.add(v);
      renderCategoryChips();
    }
    e.target.value = "";
  }
});

$("#reagentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  syncSelectedCats($("#rgCats"));
  const selected = $("#rgCats").dataset.selected.split(",").filter(Boolean);
  const payload = {
    name: $("#rgName").value.trim(),
    cas: $("#rgCas").value.trim() || null,
    formula: $("#rgFormula").value.trim() || null,
    concentration: $("#rgConc").value.trim() || null,
    state: $("#rgState").value,
    categories: selected,
    note: $("#rgNote").value.trim() || null,
  };
  try {
    const id = $("#reagentId").value;
    if (id) await api(`/api/reagents/${id}`, { method: "PUT", body: payload });
    else await api("/api/reagents", { method: "POST", body: payload });
    toast("试剂已保存");
    resetReagentForm();
    await loadReagents();
  } catch (err) { toast(err.message, true); }
});

$("#btnReagentReset").addEventListener("click", resetReagentForm);

function resetReagentForm() {
  $("#reagentForm").reset();
  $("#reagentId").value = "";
  $("#reagentFormTitle").textContent = "新建试剂档案";
  state.customCats.clear();
  renderCategoryChips();
}

function editReagent(r) {
  $("#reagentId").value = r.id;
  $("#rgName").value = r.name;
  $("#rgCas").value = r.cas || "";
  $("#rgFormula").value = r.formula || "";
  $("#rgConc").value = r.concentration || "";
  $("#rgState").value = r.state;
  $("#rgNote").value = r.note || "";
  $("#reagentFormTitle").textContent = "编辑试剂档案";
  $("#rgCats").dataset.selected = r.categories.join(",");
  state.customCats = new Set(r.categories.filter((c) => !state.categories[c]));
  renderCategoryChips();
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === "reagents"));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === "tab-reagents"));
  window.scrollTo({ top: 0 });
}

function renderReagentList() {
  const q = ($("#reagentSearch").value || "").toLowerCase();
  const ul = $("#reagentList");
  ul.innerHTML = "";
  state.reagents
    .filter((r) => !q || [r.name, r.cas, r.formula].some((x) => (x || "").toLowerCase().includes(q)))
    .forEach((r) => {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML = `
        <div class="item-title">${escapeHtml(r.name)}
          ${r.builtin ? '<span class="badge badge-ok">内置</span>' : ""}
        </div>
        <div class="item-meta">
          ${r.formula ? `分子式 ${escapeHtml(r.formula)} · ` : ""}
          ${r.cas ? `CAS ${escapeHtml(r.cas)} · ` : ""}
          ${r.concentration ? escapeHtml(r.concentration) + " · " : ""}
          ${({ liquid: "液体", solid: "固体", gas: "气体" })[r.state]}
        </div>
        <div class="item-meta">${r.categories.map((c) => `<span class="badge badge-low">${escapeHtml(catLabel(c))}</span>`).join(" ")}</div>
        ${r.note ? `<div class="item-meta">${escapeHtml(r.note)}</div>` : ""}
      `;
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(
        actionBtn("编辑", "btn-small", () => editReagent(r)),
        actionBtn("删除", "btn-small btn-danger", () => removeReagent(r)),
      );
      li.appendChild(actions);
      ul.appendChild(li);
    });
}

$("#reagentSearch").addEventListener("input", renderReagentList);

async function removeReagent(r) {
  if (!confirm(`确定删除试剂「${r.name}」？`)) return;
  try {
    await api(`/api/reagents/${r.id}`, { method: "DELETE" });
    toast("试剂已删除");
    await loadReagents();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- 规则列表 / 自定义 ---------------- */

function renderRuleList() {
  const showInactive = $("#showInactive").checked;
  const ul = $("#ruleList");
  ul.innerHTML = "";
  state.rules
    .filter((r) => showInactive || r.active)
    .sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || a.id.localeCompare(b.id))
    .forEach((r) => {
      const li = document.createElement("li");
      li.className = "item";
      li.innerHTML = `
        <div class="item-title">
          <span class="badge badge-${r.severity}">${sevLabel[r.severity]}</span>
          [${r.id}] ${escapeHtml(r.title)}
          ${!r.active ? '<span class="badge badge-off">已停用</span>' : ""}
          ${r.directional ? '<span class="badge badge-blocked">有向</span>' : ""}
        </div>
        <div class="item-meta">${escapeHtml(catLabel(r.source))} → ${escapeHtml(catLabel(r.target))}
          · ${r.builtin ? "内置" : "自定义"} · ${escapeHtml(r.reaction)}</div>
      `;
      const actions = document.createElement("div");
      actions.className = "item-actions";
      actions.append(
        actionBtn("依据", "btn-small", () => openRuleModal(r)),
        actionBtn(r.active ? "停用" : "启用", "btn-small", () => toggleRule(r)),
      );
      if (!r.builtin) actions.append(actionBtn("删除", "btn-small btn-danger", () => removeRule(r)));
      li.appendChild(actions);
      ul.appendChild(li);
    });
}

$("#showInactive").addEventListener("change", renderRuleList);

async function toggleRule(r) {
  await api(`/api/rules/${r.id}`, { method: "PATCH", body: { active: !r.active } });
  await loadRules();
  toast(r.active ? `已停用规则 ${r.id}` : `已启用规则 ${r.id}`);
}

async function removeRule(r) {
  if (!confirm(`确定删除自定义规则 ${r.id}？`)) return;
  await api(`/api/rules/${r.id}`, { method: "DELETE" });
  await loadRules();
  toast("规则已删除");
}

$("#ruleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    id: $("#rlId").value.trim(),
    source: $("#rlSource").value.trim(),
    target: $("#rlTarget").value.trim(),
    directional: $("#rlDirectional").checked,
    severity: $("#rlSeverity").value,
    title: $("#rlTitle").value.trim(),
    reaction: $("#rlReaction").value.trim(),
    rationale: $("#rlRationale").value.trim(),
    references: $("#rlRefs").value.split("\n").map((s) => s.trim()).filter(Boolean),
  };
  try {
    await api("/api/rules", { method: "POST", body: payload });
    e.target.reset();
    toast("自定义规则已加入规则图");
    await loadRules();
  } catch (err) { toast(err.message, true); }
});

/* ---------------- 规则图（力导向 SVG） ---------------- */

const graph = { nodes: {}, edges: [], sim: null };

function renderGraph() {
  const svg = $("#graphSvg");
  if (!svg || !state.rules.length) return;

  const width = svg.clientWidth || 900;
  const height = 560;
  svg.innerHTML = `
    <defs>
      <marker id="arrow" markerWidth="10" markerHeight="10" refX="18" refY="3" orient="auto" markerUnits="strokeWidth">
        <path d="M0,0 L0,6 L9,3 z" fill="#5b6776"></path>
      </marker>
    </defs>
    <g id="viewport"></g>`;
  const vp = $("#viewport", svg);

  // 节点：参与启用规则的类别
  const nodes = new Map();
  state.rules.filter((r) => r.active).forEach((r) => {
    [r.source, r.target].forEach((c) => {
      if (!nodes.has(c)) {
        nodes.set(c, {
          id: c,
          x: width / 2 + (Math.random() - .5) * 300,
          y: height / 2 + (Math.random() - .5) * 300,
          vx: 0, vy: 0,
          worst: "low",
          degree: 0,
        });
      }
    });
    const n = nodes.get(r.source);
    if (sevRank[r.severity] > sevRank[n.worst]) n.worst = r.severity;
    nodes.get(r.target).degree++;
    n.degree++;
  });

  const edges = state.rules
    .filter((r) => r.active && nodes.has(r.source) && nodes.has(r.target))
    .map((r) => ({ source: r.source, target: r.target, rule: r }));

  // 简单力导向：斥力 + 弹簧 + 向心
  const nodeArr = [...nodes.values()];
  for (let iter = 0; iter < 300; iter++) {
    for (let i = 0; i < nodeArr.length; i++) {
      for (let j = i + 1; j < nodeArr.length; j++) {
        const a = nodeArr[i], b = nodeArr[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 1;
        const d = Math.sqrt(d2);
        const force = 26000 / d2;
        a.vx += (dx / d) * force; a.vy += (dy / d) * force;
        b.vx -= (dx / d) * force; b.vy -= (dy / d) * force;
      }
    }
    edges.forEach((e) => {
      const a = nodes.get(e.source), b = nodes.get(e.target);
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 180;
      const force = (d - target) * 0.02;
      a.vx += (dx / d) * force; a.vy += (dy / d) * force;
      b.vx -= (dx / d) * force; b.vy -= (dy / d) * force;
    });
    nodeArr.forEach((n) => {
      n.vx += (width / 2 - n.x) * 0.004;
      n.vy += (height / 2 - n.y) * 0.004;
      n.vx *= .82; n.vy *= .82;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(70, Math.min(width - 70, n.x));
      n.y = Math.max(40, Math.min(height - 40, n.y));
    });
  }

  // 画边
  const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  edges.forEach((e) => {
    const a = nodes.get(e.source), b = nodes.get(e.target);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    line.setAttribute("class", `g-edge ${e.rule.severity}${e.rule.directional ? " directional" : ""}`);
    if (e.rule.directional) line.setAttribute("marker-end", "url(#arrow)");
    line.addEventListener("click", (ev) => { ev.stopPropagation(); openRuleModal(e.rule); });
    line.addEventListener("mouseenter", () => highlight(a.id, b.id));
    line.addEventListener("mouseleave", clearHighlight);
    line.dataset.source = e.source; line.dataset.target = e.target;
    edgeLayer.appendChild(line);
  });
  vp.appendChild(edgeLayer);

  // 画节点
  const colorByWorst = { high: "#dc2626", medium: "#d97706", low: "#2563eb" };
  const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  nodeArr.forEach((n) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "g-node");
    g.setAttribute("transform", `translate(${n.x},${n.y})`);
    g.dataset.id = n.id;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    const label = catLabel(n.id);
    const w = Math.max(46, label.length * 13 + 18);
    el.setAttribute("rx", w / 2); el.setAttribute("ry", 17);
    el.setAttribute("stroke", colorByWorst[n.worst]);
    el.setAttribute("stroke-width", Math.min(3.5, 1.2 + n.degree * 0.25));
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("dy", "4");
    text.textContent = label;
    g.append(el, text);
    g.addEventListener("mouseenter", () => highlight(n.id));
    g.addEventListener("mouseleave", clearHighlight);
    g.addEventListener("click", () => {
      const related = state.rules.filter(
        (r) => r.active && (r.source === n.id || r.target === n.id)
      );
      if (related.length === 1) openRuleModal(related[0]);
      else if (related.length > 1) {
        openModal(`
          <button class="btn btn-ghost modal-close">✕ 关闭</button>
          <h3>类别「${escapeHtml(catLabel(n.id))}」关联的 ${related.length} 条规则</h3>
          <div class="finding-list" style="margin-top:12px">
            ${related.map((r) => `
              <div class="finding-card ${r.severity}" data-rid="${r.id}">
                <div class="fc-title"><span class="badge badge-${r.severity}">${sevLabel[r.severity]}</span>
                [${r.id}] ${escapeHtml(r.title)}</div>
                <div class="fc-meta">${escapeHtml(catLabel(r.source))} → ${escapeHtml(catLabel(r.target))}</div>
              </div>`).join("")}
          </div>`);
        $$(".finding-card", $("#modalBox")).forEach((card) => {
          card.addEventListener("click", () => {
            const r = related.find((x) => x.id === card.dataset.rid);
            if (r) openRuleModal(r);
          });
        });
      }
    });
    nodeLayer.appendChild(g);
  });
  vp.appendChild(nodeLayer);

  // 简单平移缩放
  let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0;
  const apply = () => vp.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? .9 : 1.1;
    scale = Math.max(.4, Math.min(2.5, scale * delta));
    apply();
  }, { passive: false });
  svg.addEventListener("mousedown", (e) => {
    if (e.target.closest(".g-node")) return;
    dragging = true; sx = e.clientX - tx; sy = e.clientY - ty;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    tx = e.clientX - sx; ty = e.clientY - sy; apply();
  });
  window.addEventListener("mouseup", () => (dragging = false));

  function highlight(nodeId, otherId) {
    $$(".g-node", svg).forEach((g) => {
      const on = g.dataset.id === nodeId || (otherId && g.dataset.id === otherId);
      g.classList.toggle("dim", !on);
    });
    $$(".g-edge", svg).forEach((l) => {
      const on = (l.dataset.source === nodeId || l.dataset.target === nodeId)
        && (!otherId || l.dataset.source === otherId || l.dataset.target === otherId);
      l.classList.toggle("dim", !on);
      l.classList.toggle("hl", on);
    });
  }
  function clearHighlight() {
    $$(".g-node,.g-edge", svg).forEach((el) => el.classList.remove("dim", "hl"));
  }

  $("#graphLegend").innerHTML = `
    <span><i style="background:var(--high)"></i>严重禁忌</span>
    <span><i style="background:var(--medium)"></i>警示</span>
    <span><i style="background:var(--low)"></i>提示</span>
    <span>┄ 有向规则</span>`;
}

/* ---------------- 推演记录 ---------------- */

async function loadRuns() {
  if (!$("#tab-runs").classList.contains("active")) return;
  const runs = await api("/api/runs");
  const ul = $("#runList");
  ul.innerHTML = "";
  if (!runs.length) {
    ul.innerHTML = '<p class="hint">暂无推演记录。在「配液方案」中执行推演后会自动保存。</p>';
    return;
  }
  const stMap = { danger: ["严重", "high"], warning: ["警示", "medium"], safe: ["安全", "ok"] };
  runs.forEach((r) => {
    const [label, cls] = stMap[r.status] || ["—", "blocked"];
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `
      <div class="item-title"><span class="badge badge-${cls}">${label}</span>
        ${escapeHtml(r.plan_name)} <span class="item-meta">#${r.id}</span></div>
      <div class="item-meta">${fmtTime(r.created_at)} · 规则图版本 ${escapeHtml(r.rule_revision || "-")}</div>
    `;
    const actions = document.createElement("div");
    actions.className = "item-actions";
    actions.append(
      actionBtn("查看", "btn-small", async () => {
        const report = await api(`/api/runs/${r.id}`);
        const host = $("#runDetail");
        host.innerHTML = "";
        renderReport(report, { container: host });
        host.scrollIntoView({ behavior: "smooth" });
      }),
      actionBtn("导出 JSON", "btn-small", async () => {
        const data = await api(`/api/runs/${r.id}/export`);
        downloadJson(data, `run-${r.id}-report.json`);
      }),
      actionBtn("删除", "btn-small btn-danger", async () => {
        if (!confirm("删除该推演记录？")) return;
        await api(`/api/runs/${r.id}`, { method: "DELETE" });
        loadRuns();
      }),
    );
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

/* ---------------- 工具 ---------------- */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/* ---------------- 启动 ---------------- */

(async function init() {
  state.stepRows = [makeStepRow()];
  renderStepRows();
  renderCategoryChips();
  try {
    await Promise.all([loadReagents(), loadPlans(), loadRules()]);
  } catch (err) {
    toast("初始化失败：" + err.message, true);
  }
})();
