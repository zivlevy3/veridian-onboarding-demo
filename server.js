// Onboarding dashboard v1 - server-rendered, reads/writes the real persistence layer
// (lib/persistence.js) on every request. No client-side state, no static JSON: a
// checkbox click is a full POST + redirect round-trip through db/veridian.sqlite, so a
// browser refresh is a genuine test of whether the DB write actually happened.
//
// No auth/roles yet (see README.md) - this single view is what employee, manager, and
// HR would all see. internalGaps are deliberately not rendered anywhere on this page:
// they were designed as HR/manager-only content, and until real role separation exists,
// the safer default is to keep them out of the shared view entirely rather than expose
// them to everyone.
const express = require('express');
const { openDb } = require('./lib/db');
const { getPlan, toggleItemStatus, approvePlan } = require('./lib/persistence');

const PORT = process.env.PORT || 3000;

// One shared writable connection for the life of this simple v1 server - fine for a
// single-process, synchronous-SQLite dev server; would need reconsidering for
// concurrent multi-worker deployment.
const db = openDb({ writable: true });

const app = express();
app.use(express.urlencoded({ extended: false }));

const TRACK_STYLES = {
  role: { bg: '#f3e8fd', fg: '#7e22ce', border: '#c084fc', label: 'Role' },
  team_interfaces: { bg: '#dff7f5', fg: '#0f766e', border: '#2dd4bf', label: 'Team & Interfaces' },
  business: { bg: '#ffe6df', fg: '#c2410c', border: '#fb923c', label: 'Business' },
  systems_access: { bg: '#fdf1cf', fg: '#92620a', border: '#f5b942', label: 'Systems & Access' },
};
const DEFAULT_TRACK_STYLE = { bg: '#eee', fg: '#555', border: '#bbb', label: 'Other' };

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function renderItem(planId, item) {
  const style = TRACK_STYLES[item.track] || DEFAULT_TRACK_STYLE;
  return `
    <li class="item${item.completed ? ' completed' : ''}">
      <form class="check-form" method="POST" action="/plan/${planId}/item/${encodeURIComponent(item.id)}/toggle">
        <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="this.form.submit()" aria-label="Mark ${escapeHtml(item.shortLine)} as done">
      </form>
      <details class="card" style="border-color:${style.border}">
        <summary>
          <span class="tag" style="background:${style.bg};color:${style.fg}">${escapeHtml(style.label)}</span>
          <span class="short-line">${escapeHtml(item.shortLine)}</span>
          <span class="facilitator">${escapeHtml(item.facilitatorDisplayName)}</span>
          <span class="day-hint">${escapeHtml(item.dayHint)}</span>
        </summary>
        <p class="detail-text">${escapeHtml(item.detailText)}</p>
      </details>
    </li>
  `;
}

function renderWeek(planId, week) {
  const items = week.items.length
    ? week.items.map((item) => renderItem(planId, item)).join('')
    : '<li class="empty">Nothing scheduled this week.</li>';
  return `
    <section class="week">
      <h2>Week ${week.weekNumber}</h2>
      <ul class="items">${items}</ul>
    </section>
  `;
}

function renderPlanPage(plan, errorMessage) {
  const allItems = plan.content.weeks.flatMap((w) => w.items);
  const completedCount = allItems.filter((i) => i.completed).length;
  const statusBadge = plan.status === 'approved'
    ? '<span class="status-badge approved">Approved</span>'
    : `<span class="status-badge draft">${escapeHtml(plan.status)}</span>`;
  const approveControl = plan.status === 'draft'
    ? `<form method="POST" action="/plan/${plan.plan_id}/approve"><button type="submit" class="approve-btn">Approve plan</button></form>`
    : '';
  const errorBanner = errorMessage
    ? `<div class="error-banner">${escapeHtml(errorMessage)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Onboarding Plan - ${escapeHtml(plan.employee_id)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f7f7f5; color: #1f2328; margin: 0; padding: 0 0 4rem; }
  header { background: #fff; border-bottom: 1px solid #e5e5e0; padding: 1.5rem 2rem; position: sticky; top: 0; z-index: 5; }
  header h1 { margin: 0 0 0.25rem; font-size: 1.4rem; }
  .header-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .progress { color: #555; font-size: 0.95rem; }
  .status-badge { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; text-transform: capitalize; }
  .status-badge.draft { background: #e5e5e0; color: #444; }
  .status-badge.approved { background: #dcf5e3; color: #15803d; }
  .approve-btn { background: #1f2328; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
  .approve-btn:hover { background: #33383f; }
  .error-banner { background: #fee2e2; color: #991b1b; padding: 0.75rem 1rem; border-radius: 6px; margin-top: 0.75rem; font-size: 0.9rem; }
  main { max-width: 780px; margin: 0 auto; padding: 1.5rem 2rem; }
  .week { margin-bottom: 1.75rem; }
  .week h2 { font-size: 1rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 0.6rem; }
  .items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .item { display: flex; align-items: flex-start; gap: 0.6rem; }
  .item.empty { color: #9ca3af; font-size: 0.9rem; padding: 0.4rem 0; list-style: none; }
  .check-form { padding-top: 0.9rem; }
  .check-form input { width: 18px; height: 18px; cursor: pointer; }
  .card { flex: 1; background: #fff; border: 1px solid #e5e5e0; border-left: 4px solid #ccc; border-radius: 8px; padding: 0.1rem 0; }
  .item.completed .card { opacity: 0.55; }
  .item.completed .short-line { text-decoration: line-through; }
  summary { cursor: pointer; list-style: none; padding: 0.7rem 0.9rem; display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  summary::-webkit-details-marker { display: none; }
  .tag { font-size: 0.72rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.02em; }
  .short-line { font-weight: 600; flex: 1 1 auto; min-width: 160px; }
  .facilitator { color: #6b7280; font-size: 0.85rem; }
  .day-hint { color: #9ca3af; font-size: 0.8rem; margin-left: auto; }
  .detail-text { margin: 0 0.9rem 0.85rem; color: #444; font-size: 0.92rem; line-height: 1.45; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(plan.employee_id)}'s onboarding plan</h1>
  <div class="header-row">
    ${statusBadge}
    <span class="progress">${completedCount} / ${allItems.length} completed</span>
    ${approveControl}
  </div>
  ${errorBanner}
</header>
<main>
  ${plan.content.weeks.map((week) => renderWeek(plan.plan_id, week)).join('')}
</main>
</body>
</html>`;
}

app.get('/', (req, res) => res.redirect('/plan/2'));

app.get('/plan/:planId', (req, res) => {
  const planId = Number(req.params.planId);
  const plan = getPlan(db, planId);
  if (!plan) return res.status(404).send(`No plan found for plan_id ${planId}.`);
  res.send(renderPlanPage(plan, req.query.error));
});

app.post('/plan/:planId/item/:itemId/toggle', (req, res) => {
  const planId = Number(req.params.planId);
  const plan = toggleItemStatus(db, planId, req.params.itemId);
  if (!plan) return res.status(404).send(`No plan found for plan_id ${planId}.`);
  res.redirect(`/plan/${planId}`);
});

app.post('/plan/:planId/approve', (req, res) => {
  const planId = Number(req.params.planId);
  try {
    approvePlan(db, planId);
  } catch (err) {
    return res.redirect(`/plan/${planId}?error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/plan/${planId}`);
});

app.listen(PORT, () => {
  console.log(`Onboarding dashboard running at http://localhost:${PORT}/plan/2`);
});
