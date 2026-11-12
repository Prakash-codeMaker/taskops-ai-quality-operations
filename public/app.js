const API = "/api";
const state = {
  view: "overview",
  page: 1,
  limit: 12,
  search: "",
  status: "",
  project: "",
  importRecords: [],
  importFileName: "",
  reviewers: [],
  activeTask: null,
  searchTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[char]);
}
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function formatNumber(value) {
  return new Intl.NumberFormat("en-IN").format(number(value));
}
function formatDate(value, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-IN", withTime
    ? { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" }
    : { day:"2-digit", month:"short" }).format(date);
}
function relativeTime(value) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}
function statusLabel(status) {
  return String(status || "unknown").replaceAll("_", " ");
}
function statusBadge(status) {
  const safe = escapeHtml(status || "queued");
  return '<span class="status-badge status-' + safe + '">' + escapeHtml(statusLabel(status)) + '</span>';
}
function priorityBadge(priority) {
  const p = Math.max(1, Math.min(5, number(priority) || 3));
  return '<span class="priority-pill priority-' + p + '">P' + p + '</span>';
}
function toast(message, type = "success") {
  const region = $("#toast-region");
  if (!region) return;
  if (Array.from(region.children).some(node => node.textContent === message)) return;
  while (region.children.length >= 3) region.firstElementChild.remove();
  const node = document.createElement("div");
  node.className = "toast" + (type === "error" ? " error" : "");
  node.textContent = message;
  region.appendChild(node);
  window.setTimeout(() => node.remove(), 3800);
}
function loginRedirect() {
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = "/login?next=" + next;
}
async function api(path, options = {}) {
  const activeWorkspaceId = localStorage.getItem("taskops_workspace_id");
  if (activeWorkspaceId && !path.includes("workspace_id=")) {
    path += (path.includes("?") ? "&" : "?") + "workspace_id=" + encodeURIComponent(activeWorkspaceId);
  }
  const headers = { "Accept":"application/json", ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const response = await fetch(API + path, {
    credentials:"same-origin",
    ...options,
    headers
  });
  if (response.redirected && response.url.includes("/login")) {
    loginRedirect();
    throw new Error("Sign in required.");
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { error: raw.slice(0, 300) || "Unexpected server response." }; }
  if (!response.ok) {
    if (response.status === 401) {
      loginRedirect();
      throw new Error("Your session has expired. Redirecting to sign in.");
    }
    if (response.status === 403) {
      const message = data.error || "Your account does not have permission to perform this action.";
      toast(message, "error");
      throw new Error(message);
    }
    throw new Error(data.error || ("Request failed (" + response.status + ")."));
  }
  return data;
}
function setView(name) {
  state.view = name;
  $$(".view-section").forEach(section => section.classList.toggle("active", section.id === "view-" + name));
  $$(".nav-link[data-view]").forEach(link => link.classList.toggle("active", link.dataset.view === name));
  const labels = { overview:"Overview", queue:"Task queue", reviewers:"Reviewers", audit:"Audit log", rubric:"Quality rubric" };
  $("#breadcrumb-current").textContent = labels[name] || "Overview";
  if (name === "queue") loadTasks();
  if (name === "reviewers") loadReviewers();
  if (name === "audit") loadAudit();
}
function renderOverview(summary, trend, queues) {
  $("#kpi-total").textContent = formatNumber(summary.total);
  $("#kpi-created").textContent = "+" + formatNumber(summary.created_24h || 0);
  $("#kpi-active").textContent = formatNumber(number(summary.in_review) + number(summary.needs_revision));
  $("#kpi-in-review").textContent = formatNumber(summary.in_review) + " in review";
  $("#kpi-revision").textContent = formatNumber(summary.needs_revision);
  $("#kpi-awaiting").textContent = formatNumber(summary.awaiting_approval);
  $("#kpi-quality").textContent = summary.avg_quality == null ? "—" : Number(summary.avg_quality).toFixed(1);
  $("#kpi-approval-rate").textContent = summary.approval_rate == null ? "—" : Number(summary.approval_rate).toFixed(1);
  $("#kpi-completed").textContent = formatNumber(number(summary.approved) + number(summary.rejected)) + " completed";
  $("#nav-open-count").textContent = formatNumber(number(summary.queued) + number(summary.in_review) + number(summary.needs_revision));
  const labels = ["queued","in_review","awaiting_approval","needs_revision","approved","rejected"];
  const colors = ["#bfd39a","#83c9b3","#c4cdb5","#dfba7b","#8fbe91","#d98f7d"];
  const names = ["Queued","In review","Awaiting approval","Needs revision","Approved","Rejected"];
  const values = labels.map(key => number(summary[key]));
  const total = values.reduce((a,b) => a+b, 0);
  let cursor = 0;
  const parts = values.map((v,i) => {
    const start = cursor;
    cursor += total ? v / total * 100 : 0;
    return colors[i] + " " + start + "% " + cursor + "%";
  });
  $("#quality-donut").style.background = total
    ? "conic-gradient(" + parts.join(",") + ")"
    : "conic-gradient(#344258 0 100%)";
  $("#donut-total").textContent = formatNumber(total);
  $("#quality-legend").innerHTML = names.map((name,i) =>
    '<div><i style="background:' + colors[i] + '"></i><span>' + name + '</span><b>' + values[i] + '</b></div>'
  ).join("");
  $("#quality-footer-value").textContent = (summary.approval_rate == null ? "—" : Number(summary.approval_rate).toFixed(1)) + "% approved";
  const peak = Math.max(0, ...trend.map(item => number(item.created)), ...trend.map(item => number(item.completed)));
  const scaleMax = Math.max(4, Math.ceil(peak / 4) * 4);
  const ticks = [scaleMax, scaleMax * 0.75, scaleMax * 0.5, scaleMax * 0.25, 0];
  $("#throughput-y-axis").innerHTML = ticks.map(value =>
    '<span>' + (Number.isInteger(value) ? value : Number(value.toFixed(1))) + '</span>'
  ).join("");
  $("#throughput-chart").innerHTML = trend.map(item => {
    const created = number(item.created);
    const completed = number(item.completed);
    const a = created / scaleMax * 100;
    const b = completed / scaleMax * 100;
    const tooltip = escapeHtml(item.label + ': ' + created + ' created, ' + completed + ' decisions');
    return '<div class="chart-day" role="img" aria-label="' + tooltip + '" title="' + tooltip + '"><i class="chart-bar" style="height:' + a + '%"></i><i class="chart-bar complete" style="height:' + b + '%"></i></div>';
  }).join("");
  $("#throughput-labels").innerHTML = trend.map(item => "<span>" + escapeHtml(item.label) + "</span>").join("");
  $("#chart-total").textContent = formatNumber(trend.reduce((sum,item) => sum + number(item.created),0)) + " tasks tracked";
  if (queues && queues.length) {
    const totalProjects = queues.length;
    $("#chart-total").textContent += " · " + totalProjects + " active projects";
  }
}
function taskRow(task, compact = false) {
  const id = escapeHtml(task.id);
  const title = escapeHtml(task.title);
  const external = escapeHtml(task.external_id || "No external ID");
  const reviewer = escapeHtml(task.reviewer_name || "Unassigned");
  return '<tr data-task-id="' + id + '">' +
    (compact ? "" : '<td><input type="checkbox" disabled aria-label="Select task"></td>') +
    '<td><div class="task-primary"><span class="task-id">' + external + '</span><span class="task-name">' + title + '</span></div></td>' +
    '<td><div class="project-cell"><strong>' + escapeHtml(task.project) + '</strong><small>' + escapeHtml(task.queue) + '</small></div></td>' +
    (compact ? "" : '<td>' + reviewer + '</td>') +
    '<td>' + priorityBadge(task.priority) + '</td>' +
    '<td>' + statusBadge(task.status) + '</td>' +
    '<td>' + (task.quality_score == null ? '<span class="quality-na">—</span>' : '<span class="quality-score">' + Number(task.quality_score).toFixed(1) + '</span>') + '</td>' +
    (compact ? "" : '<td>' + relativeTime(task.updated_at) + '</td><td><span class="table-more">···</span></td>') +
    '</tr>';
}
async function loadOverview() {
  try {
    const [overview, taskData] = await Promise.all([
      api("/overview"),
      api("/tasks?limit=6&page=1")
    ]);
    renderOverview(overview.summary || {}, overview.trend || [], overview.queues || []);
    if (overview.workspace && overview.workspace.name) {
      $("#workspace-name").textContent = overview.workspace.name;
      $("#workspace-icon").textContent = String(overview.workspace.name).trim().charAt(0).toUpperCase() || "W";
      const isDemo = overview.workspace.slug === "atlas-demo";
      $("#workspace-subtitle").textContent = isDemo ? "Synthetic sample data" : "Organization workspace";
      $("#environment-label").textContent = isDemo ? "DEMO DATA" : "WORKSPACE";
      const role = String(overview.workspace.role || "member").replaceAll("_", " ");
      $("#workspace-role").textContent = role.charAt(0).toUpperCase() + role.slice(1);
    }
    $("#overview-task-rows").innerHTML = taskData.data.length
      ? taskData.data.slice(0,5).map(task => taskRow(task,true)).join("")
      : '<tr><td colspan="5" class="empty-cell">No tasks yet.</td></tr>';
    renderActivity(overview.recent_activity || [], $("#overview-activity"));
  } catch (error) {
    $("#overview-task-rows").innerHTML = '<tr><td colspan="5" class="empty-cell">Operational data unavailable. Check API health.</td></tr>';
    $("#overview-activity").innerHTML = '<div class="empty-state-small">Activity unavailable.</div>';
    console.error(error);
  }
}
function renderActivity(events, container) {
  if (!events.length) {
    container.innerHTML = '<div class="empty-state-small">No recorded events yet.</div>';
    return;
  }
  const symbols = { task_created:"＋", task_imported:"⇧", reviewer_assigned:"♧", review_submitted:"◎", status_transition:"↗", seeded:"·" };
  container.innerHTML = events.map(event => {
    const action = String(event.action || "event").replaceAll("_"," ");
    const title = event.title || event.external_id || "Task";
    const target = event.to_status ? " → " + statusLabel(event.to_status) : "";
    return '<div class="activity-item"><span class="activity-icon">' + (symbols[event.action] || "·") + '</span><div class="activity-copy"><p><strong>' + escapeHtml(action) + '</strong> · ' + escapeHtml(title) + escapeHtml(target) + '</p><small>' + escapeHtml(event.actor || "system") + ' · ' + relativeTime(event.created_at) + '</small></div></div>';
  }).join("");
}
async function loadTasks() {
  const query = new URLSearchParams({ page:String(state.page), limit:String(state.limit) });
  if (state.search) query.set("q", state.search);
  if (state.status) query.set("status", state.status);
  if (state.project) query.set("project", state.project);
  try {
    const result = await api("/tasks?" + query.toString());
    $("#task-rows").innerHTML = result.data.length
      ? result.data.map(task => taskRow(task,false)).join("")
      : '<tr><td colspan="9" class="empty-cell">No matching tasks. Clear a filter or create a new task.</td></tr>';
    const page = result.pagination;
    $("#pagination-summary").textContent = page.total
      ? "Showing " + ((page.page - 1) * page.limit + 1) + "–" + Math.min(page.page * page.limit,page.total) + " of " + page.total + " tasks"
      : "No tasks found";
    $("#page-current").textContent = page.page + " / " + Math.max(1,page.pages);
    $("#page-prev").disabled = page.page <= 1;
    $("#page-next").disabled = page.page >= page.pages;
    const projects = Array.from(new Set(result.data.map(task => task.project).filter(Boolean)));
    const select = $("#project-filter");
    const selected = select.value;
    const allKnown = Array.from(new Set([...Array.from(select.options).slice(1).map(option=>option.value),...projects])).sort();
    select.innerHTML = '<option value="">All projects</option>' + allKnown.map(project => '<option value="' + escapeHtml(project) + '">' + escapeHtml(project) + '</option>').join("");
    select.value = state.project || selected || "";
  } catch (error) {
    $("#task-rows").innerHTML = '<tr><td colspan="9" class="empty-cell">Unable to load tasks. ' + escapeHtml(error.message) + '</td></tr>';
  }
}
async function loadReviewers() {
  try {
    const result = await api("/reviewers");
    state.reviewers = result.data || [];
    const active = state.reviewers.filter(person => person.active);
    const open = active.reduce((sum,person) => sum + number(person.open_tasks),0);
    const capacity = active.reduce((sum,person) => sum + number(person.capacity),0);
    $("#reviewer-summary").innerHTML =
      '<div class="reviewer-summary-card"><span>Active reviewers</span><strong>' + active.length + '</strong></div>' +
      '<div class="reviewer-summary-card"><span>Open assignments</span><strong>' + open + '</strong></div>' +
      '<div class="reviewer-summary-card"><span>Team capacity used</span><strong>' + (capacity ? Math.round(open/capacity*100) : 0) + '%</strong></div>';
    $("#reviewer-grid").innerHTML = state.reviewers.map(person => {
      const initials = person.name.split(" ").map(part=>part[0]).slice(0,2).join("").toUpperCase();
      const utilization = Math.min(100, Math.round(number(person.open_tasks)/Math.max(1,number(person.capacity))*100));
      return '<article class="reviewer-card"><div class="reviewer-card-head"><div class="reviewer-avatar">' + escapeHtml(initials) + '</div><div class="reviewer-name"><strong>' + escapeHtml(person.name) + '</strong><small>' + escapeHtml(person.role) + '</small></div><i class="online-dot" title="Active"></i></div><div class="reviewer-specialty">' + escapeHtml(person.specialty) + '</div><div class="capacity-head"><span>Current capacity</span><strong>' + number(person.open_tasks) + ' / ' + number(person.capacity) + '</strong></div><div class="capacity-track"><i style="width:' + utilization + '%"></i></div><div class="reviewer-stats"><span>Average review score</span><strong>' + (person.avg_score == null ? "—" : Number(person.avg_score).toFixed(1) + "/100") + '</strong></div></article>';
    }).join("");
  } catch (error) {
    $("#reviewer-grid").innerHTML = '<div class="panel empty-cell">Unable to load reviewer roster.</div>';
  }
}
async function loadAudit() {
  try {
    const result = await api("/audit?limit=100");
    $("#audit-list").innerHTML = result.data.length ? result.data.map(event => {
      const statusText = event.from_status ? statusLabel(event.from_status) + " → " + statusLabel(event.to_status) : statusLabel(event.to_status || "recorded");
      return '<div class="audit-item"><time class="audit-time">' + formatDate(event.created_at,true) + '</time><div class="audit-event"><strong>' + escapeHtml(event.action.replaceAll("_"," ")) + ' · ' + escapeHtml(event.external_id || "Task") + '</strong><small>' + escapeHtml(event.title) + ' · ' + escapeHtml(statusText) + '</small></div><span class="audit-actor">' + escapeHtml(event.actor || "system") + '</span></div>';
    }).join("") : '<div class="empty-cell">No audit events recorded yet.</div>';
  } catch (error) {
    $("#audit-list").innerHTML = '<div class="empty-cell">Unable to load audit history.</div>';
  }
}
async function openTask(id) {
  $("#task-dialog").showModal();
  $("#detail-external-id").textContent = "TASK DETAIL";
  $("#detail-title").textContent = "Loading task…";
  $("#detail-meta").textContent = "";
  $("#task-detail-body").innerHTML = '<div class="empty-cell">Loading task…</div>';
  try {
    const result = await api("/tasks/" + encodeURIComponent(id));
    state.activeTask = result.task;
    renderTaskDetail(result);
  } catch (error) {
    $("#task-detail-body").innerHTML = '<div class="empty-cell">' + escapeHtml(error.message) + '</div>';
  }
}
function scoreFor(values, rubric) {
  const weights = rubric?.dimensions || {correctness:.30,completeness:.20,instruction_adherence:.20,format_validity:.15,evidence_quality:.15};
  return Object.keys(weights).reduce((sum,key)=>sum + number(values[key])*number(weights[key]),0) / 5 * 100;
}
function reviewPanel(task, rubric) {
  if (!rubric) {
    return '<div class="detail-block"><h3>QUALITY REVIEW</h3><p class="review-empty">No active rubric is configured. Publish one in the <a href="/evaluations.html">Quality Workbench</a> before submitting a review.</p></div>';
  }
  const labels = {
    correctness:"Correctness",
    completeness:"Completeness",
    instruction_adherence:"Instruction adherence",
    format_validity:"Format validity",
    evidence_quality:"Evidence quality"
  };
  const dimensions = Object.keys(labels).map(key=>[key,labels[key],Math.round(number(rubric.dimensions?.[key])*100)]);
  const threshold=rubric.pass_threshold==null?85:number(rubric.pass_threshold);
  const floor=rubric.critical_floor==null?2:number(rubric.critical_floor);
  return '<div class="detail-block"><h3>QUALITY REVIEW · ' + escapeHtml(rubric.name) + ' V' + number(rubric.version) + '</h3><div class="review-controls">' +
    dimensions.map(([key,label,weight]) => '<div class="score-row"><label for="score-' + key + '">' + label + ' <small>(' + weight + '%)</small></label><input type="range" min="1" max="5" step=".5" value="4" id="score-' + key + '" data-score-key="' + key + '"><output for="score-' + key + '">4.0</output></div>').join("") +
    '<div class="score-preview"><span>Live weighted score · pass ' + threshold + '+ · critical floor ' + floor + '/5</span><strong id="live-score">80.0</strong></div><textarea id="review-notes" class="review-notes" rows="2" placeholder="Evidence, reasoning and actionable feedback…"></textarea><div class="detail-actions"><button class="button button-primary" id="submit-review">Submit quality review →</button></div></div></div>';
}
function renderTaskDetail(result) {
  const task = result.task;
  state.activeRubric = result.rubric || null;
  const payload = task.payload && typeof task.payload === "object" ? task.payload : {};
  $("#detail-external-id").textContent = task.external_id || "NO EXTERNAL ID";
  $("#detail-title").textContent = task.title;
  $("#detail-meta").innerHTML = statusBadge(task.status) + '<span>' + escapeHtml(task.project) + '</span><span>·</span><span>Revision ' + number(task.revision) + '</span>';
  let html = '<div class="detail-grid">' +
    '<div class="detail-stat"><small>Priority</small><strong>' + escapeHtml("P" + task.priority) + '</strong></div>' +
    '<div class="detail-stat"><small>Quality score</small><strong>' + (task.quality_score == null ? "Not reviewed" : Number(task.quality_score).toFixed(1) + " / 100") + '</strong></div>' +
    '<div class="detail-stat"><small>Reviewer</small><strong>' + escapeHtml(task.reviewer_name || "Unassigned") + '</strong></div>' +
    '<div class="detail-stat"><small>Review attempts</small><strong>' + number(task.review_count) + '</strong></div></div>';
  if (task.description) html += '<div class="detail-block"><h3>REVIEW INSTRUCTIONS</h3><div style="font-size:10px;line-height:1.6;color:#aebbd0">' + escapeHtml(task.description) + '</div></div>';
  html += '<div class="detail-block"><h3>TASK PAYLOAD</h3><pre class="payload-pre">' + escapeHtml(JSON.stringify(payload,null,2)) + '</pre></div>';
  if (["queued","needs_revision"].includes(task.status)) {
    const options = state.reviewers.length ? state.reviewers.filter(person=>person.active).map(person => '<option value="' + escapeHtml(person.id) + '" ' + (task.assigned_to===person.id?'selected':'') + '>' + escapeHtml(person.name) + ' · ' + number(person.open_tasks) + '/' + number(person.capacity) + ' open</option>').join("") : "";
    html += '<div class="detail-block"><h3>REVIEWER ASSIGNMENT</h3><div class="review-controls"><select id="assign-reviewer" class="review-notes"><option value="">Select reviewer…</option>' + options + '</select><div class="detail-actions"><button class="button button-secondary" id="assign-task">Assign & start review →</button>' + (task.status === "needs_revision" ? '<button class="button button-quiet" data-transition="queued">Re-queue without reviewer</button>' : "") + '</div></div></div>';
  }
  if (["in_review","needs_revision"].includes(task.status)) html += reviewPanel(task,result.rubric);
  if (task.status === "awaiting_approval") {
    html += '<div class="detail-block"><h3>FINAL DECISION</h3><p style="font-size:10px;color:#92a2ba;line-height:1.5">The latest review passed the rubric threshold. An authorized workspace user can approve, request revision, or reject the work.</p><div class="detail-actions"><button class="button button-primary" data-transition="approved">✓ Approve task</button><button class="button button-secondary" data-transition="needs_revision">Request revision</button><button class="button button-quiet" data-transition="rejected">Reject</button></div></div>';
  }
  if (["approved","rejected"].includes(task.status)) {
    html += '<div class="detail-block"><h3>TERMINAL DECISION</h3><p style="font-size:10px;color:#92a2ba">This task is ' + escapeHtml(statusLabel(task.status)) + '. The workflow prevents further transitions from a terminal state.</p></div>';
  }
  if (result.reviews && result.reviews.length) {
    html += '<div class="detail-block"><h3>REVIEW HISTORY</h3><div class="review-list">' + result.reviews.map(review =>
      '<div class="review-card"><div><strong>Attempt ' + review.attempt_number + ' · ' + escapeHtml(review.reviewer_name || "Reviewer") + '</strong><small>' + escapeHtml(review.verdict) + ' · ' + escapeHtml(review.rubric_version) + ' · ' + formatDate(review.created_at,true) + '</small></div><b>' + Number(review.overall_score).toFixed(1) + '</b></div>'
    ).join("") + '</div></div>';
  }
  html += '<div class="detail-block"><h3>EVENT TIMELINE</h3><div class="event-list">' + ((result.events || []).length ? result.events.map(event =>
    '<div class="event-line"><span>' + escapeHtml(event.action.replaceAll("_"," ")) + (event.to_status ? ' · ' + escapeHtml(statusLabel(event.to_status)) : '') + '</span><small>' + relativeTime(event.created_at) + '</small></div>'
  ).join("") : '<span style="color:#7d8da5;font-size:10px">No events.</span>') + '</div></div>';
  $("#task-detail-body").innerHTML = html;
  $$("[data-score-key]").forEach(input => input.addEventListener("input", updateLiveScore));
  if ($("#live-score")) updateLiveScore();
  const assignButton = $("#assign-task");
  if (assignButton) assignButton.addEventListener("click", assignTask);
  const submitReview = $("#submit-review");
  if (submitReview) submitReview.addEventListener("click", submitTaskReview);
  $$("[data-transition]").forEach(button => button.addEventListener("click", () => transitionTask(button.dataset.transition)));
}
function updateLiveScore() {
  const values = {};
  $$("[data-score-key]").forEach(input => {
    values[input.dataset.scoreKey] = Number(input.value);
    const output = $('output[for="' + input.id + '"]');
    if (output) output.textContent = Number(input.value).toFixed(1);
  });
  const score = scoreFor(values,state.activeRubric);
  if ($("#live-score")) $("#live-score").textContent = score.toFixed(1);
}
async function assignTask() {
  const reviewerId = $("#assign-reviewer")?.value;
  if (!reviewerId) return toast("Choose a reviewer first.", "error");
  if (!state.activeTask) return;
  try {
    await api("/tasks/" + state.activeTask.id + "/assign", { method:"POST", body:JSON.stringify({reviewer_id:reviewerId}) });
    toast("Reviewer assigned. Task moved into review.");
    await refreshAfterMutation();
  } catch (error) { toast(error.message, "error"); }
}
async function submitTaskReview() {
  if (!state.activeTask) return;
  const dimensions = {};
  $$("[data-score-key]").forEach(input => dimensions[input.dataset.scoreKey] = Number(input.value));
  const notes = $("#review-notes")?.value || "";
  const button = $("#submit-review");
  button.disabled = true;
  button.textContent = "Submitting…";
  try {
    const result = await api("/tasks/" + state.activeTask.id + "/review", { method:"POST", body:JSON.stringify({dimensions,notes}) });
    toast("Review saved · " + Number(result.result.overall_score).toFixed(1) + " / 100 · " + result.result.verdict);
    await refreshAfterMutation();
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = "Submit quality review →";
  }
}
async function transitionTask(status) {
  if (!state.activeTask) return;
  const note = status === "needs_revision" ? window.prompt("What should be improved? (optional)") || "" : "";
  try {
    await api("/tasks/" + state.activeTask.id + "/transition", { method:"POST", body:JSON.stringify({status,note}) });
    toast("Task moved to " + statusLabel(status) + ".");
    await refreshAfterMutation();
  } catch (error) { toast(error.message, "error"); }
}
async function refreshAfterMutation() {
  if (state.activeTask) await openTask(state.activeTask.id);
  await Promise.all([loadOverview(),loadTasks(),loadReviewers()]);
  if (state.view === "audit") await loadAudit();
}
function openDialog(id) {
  const dialog = $("#" + id);
  if (dialog && !dialog.open) dialog.showModal();
}
function closeDialog(id) {
  const dialog = $("#" + id);
  if (dialog && dialog.open) dialog.close();
}
async function createTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  let payload;
  try { payload = JSON.parse(data.payload || "{}"); }
  catch { $("#create-message").textContent = "Payload must be valid JSON."; $("#create-message").classList.add("error"); return; }
  data.priority = Number(data.priority);
  data.payload = payload;
  const button = $("#create-submit");
  button.disabled = true;
  button.textContent = "Creating…";
  $("#create-message").textContent = "";
  try {
    const result = await api("/tasks/create", { method:"POST", body:JSON.stringify(data) });
    form.reset();
    $("#create-message").classList.remove("error");
    closeDialog("create-dialog");
    toast("Task created and added to the queue.");
    await refreshAfterMutation();
    if (result.task?.id) openTask(result.task.id);
  } catch (error) {
    $("#create-message").textContent = error.message;
    $("#create-message").classList.add("error");
    if (error.message.includes("Sign in")) $("#create-message").textContent = "Sign in first, then submit this task.";
  } finally {
    button.disabled = false;
    button.innerHTML = 'Create task <span>→</span>';
  }
}
function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i=0; i<text.length; i++) {
    const char = text[i], next = text[i+1];
    if (char === '"' && quoted && next === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(value=>value.trim() !== "")) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some(value=>value.trim() !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must contain a header row and at least one record.");
  const headers = rows[0].map(value=>value.trim().toLowerCase().replaceAll(" ","_"));
  return rows.slice(1).map(values => Object.fromEntries(headers.map((header,index)=>[header,(values[index] || "").trim()])));
}
async function readImportFile(file) {
  if (!file) return;
  state.importFileName = file.name;
  try {
    const text = await file.text();
    let records;
    if (file.name.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text);
      records = Array.isArray(parsed) ? parsed : parsed.records || parsed.tasks;
      if (!Array.isArray(records)) throw new Error("JSON must be an array or contain a records/tasks array.");
    } else records = parseCSV(text);
    if (!records.length) throw new Error("No task records found.");
    if (records.length > 100) throw new Error("This demo accepts at most 100 records per import.");
    state.importRecords = records.map(row => {
      let payload = row.payload || {};
      if (typeof payload === "string") {
        try { payload = payload ? JSON.parse(payload) : {}; }
        catch { payload = { raw: payload }; }
      }
      return {
        external_id: row.external_id || row.id || "",
        title: row.title || row.task_title || "",
        description: row.description || "",
        project: row.project || "Imported",
        queue: row.queue || "General QA",
        task_type: row.task_type || "classification",
        priority: Number(row.priority || 3),
        payload
      };
    });
    renderImportPreview();
  } catch (error) {
    state.importRecords = [];
    $("#import-preview").hidden = true;
    $("#import-message").textContent = error.message;
    $("#import-message").classList.add("error");
    $("#import-submit").disabled = true;
  }
}
function renderImportPreview() {
  $("#import-message").textContent = "";
  $("#import-message").classList.remove("error");
  $("#preview-name").textContent = state.importFileName;
  $("#preview-count").textContent = state.importRecords.length + " records";
  const preview = state.importRecords.slice(0,5);
  $("#preview-table").innerHTML = '<table><thead><tr><th>EXTERNAL ID</th><th>TITLE</th><th>PROJECT</th><th>PRIORITY</th></tr></thead><tbody>' +
    preview.map(row=>'<tr><td>' + escapeHtml(row.external_id || "Auto-generated") + '</td><td>' + escapeHtml(row.title) + '</td><td>' + escapeHtml(row.project) + '</td><td>' + escapeHtml(row.priority) + '</td></tr>').join("") +
    '</tbody></table>' + (state.importRecords.length > 5 ? '<div style="padding:7px 9px;color:#71829b;font-size:9px">Showing first 5 rows</div>' : "");
  $("#import-preview").hidden = false;
  $("#import-submit").disabled = !state.importRecords.length;
}
async function importTasks(event) {
  event.preventDefault();
  if (!state.importRecords.length) return;
  const button = $("#import-submit");
  button.disabled = true;
  button.textContent = "Validating…";
  try {
    const result = await api("/tasks/import", { method:"POST", body:JSON.stringify({source:state.importFileName,records:state.importRecords}) });
    closeDialog("import-dialog");
    toast("Import complete · " + result.inserted + " inserted · " + result.duplicates + " duplicates · " + result.rejected + " rejected.");
    state.importRecords = [];
    $("#import-file").value = "";
    $("#import-preview").hidden = true;
    await refreshAfterMutation();
    if (result.errors?.length) console.warn("Import row errors",result.errors);
  } catch (error) {
    $("#import-message").textContent = error.message;
    $("#import-message").classList.add("error");
    button.disabled = false;
  } finally {
    button.textContent = "Validate & import";
  }
}
function bindEvents() {
  $$(".nav-link[data-view]").forEach(link => link.addEventListener("click",()=>setView(link.dataset.view)));
  $$("[data-go-view]").forEach(button => button.addEventListener("click",()=>setView(button.dataset.goView)));
  $("#open-create").addEventListener("click",()=>openDialog("create-dialog"));
  $("#queue-create").addEventListener("click",()=>openDialog("create-dialog"));
  $("#open-import").addEventListener("click",()=>openDialog("import-dialog"));
  $("#queue-import").addEventListener("click",()=>openDialog("import-dialog"));
  $$("[data-close]").forEach(button=>button.addEventListener("click",()=>closeDialog(button.dataset.close)));
  $("#create-form").addEventListener("submit",createTask);
  $("#import-form").addEventListener("submit",importTasks);
  $("#import-file").addEventListener("change",event=>readImportFile(event.target.files[0]));
  const drop = $("#drop-zone");
  ["dragenter","dragover"].forEach(name=>drop.addEventListener(name,event=>{event.preventDefault();drop.classList.add("dragging");}));
  ["dragleave","drop"].forEach(name=>drop.addEventListener(name,event=>{event.preventDefault();drop.classList.remove("dragging");}));
  drop.addEventListener("drop",event=>readImportFile(event.dataTransfer.files[0]));
  $("#task-search").addEventListener("input",event=>{
    state.search=event.target.value.trim();
    state.page=1;
    clearTimeout(state.searchTimer);
    state.searchTimer=window.setTimeout(loadTasks,260);
  });
  $("#status-filter").addEventListener("change",event=>{state.status=event.target.value;state.page=1;loadTasks();});
  $("#project-filter").addEventListener("change",event=>{state.project=event.target.value;state.page=1;loadTasks();});
  $("#refresh-tasks").addEventListener("click",loadTasks);
  $("#refresh-audit").addEventListener("click",loadAudit);
  $("#page-prev").addEventListener("click",()=>{state.page=Math.max(1,state.page-1);loadTasks();});
  $("#page-next").addEventListener("click",()=>{state.page++;loadTasks();});
  $("#task-rows").addEventListener("click",event=>{const row=event.target.closest("[data-task-id]");if(row)openTask(row.dataset.taskId);});
  $("#overview-task-rows").addEventListener("click",event=>{const row=event.target.closest("[data-task-id]");if(row)openTask(row.dataset.taskId);});
  $("#help-button").addEventListener("click",()=>{$("#help-popover").hidden=!$("#help-popover").hidden;});
  $("#profile-menu").addEventListener("click", () => $("#sign-in-link")?.click());
  document.addEventListener("click",event=>{
    if (!event.target.closest("#help-button") && !event.target.closest("#help-popover")) $("#help-popover").hidden=true;
  });
  document.addEventListener("keydown",event=>{
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==="k") {
      event.preventDefault();
      setView("queue");
      $("#task-search").focus();
    }
    if (event.key==="Escape") $("#help-popover").hidden=true;
  });
}
async function loadWorkspaceSelector() {
  const select = $("#workspace-select");
  if (!select) return;
  try {
    const result = await api("/workspaces");
    const workspaces = Array.isArray(result.data) ? result.data : [];
    if (!workspaces.length) {
      // First sign-in: overview bootstraps the starter workspace, then we retry the list.
      await api("/overview");
      const retry = await api("/workspaces");
      workspaces.push(...(retry.data || []));
    }
    if (!workspaces.length) {
      select.innerHTML = '<option value="">No workspace</option>';
      return;
    }
    const stored = localStorage.getItem("taskops_workspace_id");
    let active = workspaces.find(item => item.id === stored) || workspaces[0];
    localStorage.setItem("taskops_workspace_id", active.id);
    select.innerHTML = workspaces.map(item =>
      '<option value="' + escapeHtml(item.id) + '">' +
      escapeHtml(item.name) + ' · ' + escapeHtml(item.organization_name) +
      '</option>'
    ).join("");
    select.value = active.id;
    select.addEventListener("change", () => {
      localStorage.setItem("taskops_workspace_id", select.value);
      window.location.reload();
    });
  } catch (error) {
    select.innerHTML = '<option value="">Sign in to load workspaces</option>';
    console.warn("workspace_selector_failed", error);
  }
}
async function refreshAuthControl() {
  const link = $("#sign-in-link");
  const auth = window.hatchable && window.hatchable.auth;
  let sessionUser = null;

  if (auth && typeof auth.getSession === "function") {
    try {
      const session = await auth.getSession();
      sessionUser = session && session.user ? session.user : null;
    } catch (error) {
      console.warn("session_lookup_failed", error);
    }
  }

  // Fall back to the server-verified session when the browser auth helper
  // is unavailable. Never render an empty, misleading operations screen.
  if (!sessionUser) {
    try {
      const response = await fetch("/api/me", { credentials:"same-origin", headers:{ "Accept":"application/json" } });
      const current = response.ok ? await response.json() : null;
      if (current && current.authenticated && current.user) sessionUser = current.user;
    } catch (error) {
      console.warn("session_preflight_failed", error);
    }
  }

  if (!sessionUser) {
    loginRedirect();
    return false;
  }

  const displayName = String(sessionUser.name || sessionUser.email || "Workspace member").split("@")[0].trim();
  const profileName = $("#profile-name");
  const profileAvatar = $("#profile-avatar");
  if (profileName) profileName.textContent = displayName || "Workspace member";
  if (profileAvatar) profileAvatar.textContent = (displayName || "WM").split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join("").toUpperCase() || "WM";

  if (link) {
    const email = sessionUser.email || "Signed in";
    if (auth && typeof auth.signOut === "function") {
      link.textContent = email + " · Sign out";
      link.href = "#sign-out";
      link.addEventListener("click", async event => {
        event.preventDefault();
        try { await auth.signOut(); toast("Signed out."); window.location.reload(); }
        catch (error) { toast("Could not sign out.", "error"); }
      }, { once:true });
    } else {
      link.textContent = email;
      link.href = "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
    }
  }
  return true;
}
async function loadRubricSummary() {
  try {
    const result=await api("/rubrics");
    const active=(result.data||[]).filter(item=>item.is_active)
      .sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0];
    if(!active) return;
    const chip=$("#rubric-version-chip");
    if(chip) chip.textContent="VERSION " + active.version;
    const kpiChip=$("#kpi-rubric-version");
    if(kpiChip) kpiChip.textContent="Rubric v" + active.version;
    $$("[data-rubric-key]").forEach(row=>{
      const weight=number(active.dimensions?.[row.dataset.rubricKey])*100;
      const value=row.querySelector("b");
      const bar=row.querySelector(".weight-track i");
      if(value) value.textContent=Math.round(weight)+"%";
      if(bar) bar.style.width=weight+"%";
    });
    const threshold=active.pass_threshold==null?85:number(active.pass_threshold);
    const floor=active.critical_floor==null?2:number(active.critical_floor);
    const pass=$("#rubric-pass-rule");
    const passNote=$("#rubric-pass-note");
    const failNote=$("#rubric-fail-note");
    if(pass) pass.textContent="Pass ≥ " + threshold;
    if(passNote) passNote.textContent="Every dimension must also be at least 3/5. Moves to approval.";
    if(failNote) failNote.textContent="Any dimension below " + floor + "/5 triggers a fail verdict and returns for revision.";
  } catch(error) {
    console.warn("rubric_summary_failed",error);
  }
}
async function refreshServiceStatus() {
  const root = $("#sidebar-status");
  const label = $("#system-status-label");
  if (!root || !label) return;
  try {
    const response = await fetch("/api/health", { credentials:"same-origin", headers:{ "Accept":"application/json" } });
    const data = response.ok ? await response.json() : null;
    const healthy = !!data && data.status === "ok" && data.database === "connected";
    root.dataset.state = healthy ? "ok" : "error";
    label.textContent = healthy ? "Database connected" : "Database unavailable";
  } catch {
    root.dataset.state = "error";
    label.textContent = "Health check unavailable";
  }
}
async function initialize() {
  const today = new Intl.DateTimeFormat("en-IN",{weekday:"long",day:"2-digit",month:"long",year:"numeric"}).format(new Date());
  const todayLabel = $("#today-label");
  if (todayLabel) todayLabel.textContent = today.toUpperCase() + " · LIVE OPERATIONS";
  bindEvents();
  const authenticated = await refreshAuthControl();
  if (!authenticated) return;
  await Promise.all([refreshServiceStatus(),loadWorkspaceSelector()]);
  try { await Promise.all([loadReviewers(),loadRubricSummary()]); } catch {}
  await Promise.all([loadOverview(),loadTasks()]);
}
initialize();