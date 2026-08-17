// Onboarding dashboard v1 - server-rendered, reads/writes the real persistence layer
// (lib/persistence.js) on every request. No client-side state for data: a checkbox
// click is a full POST + redirect round-trip through db/veridian.sqlite, so a browser
// refresh is a genuine test of whether the DB write actually happened. The one
// exception is the week carousel's position (which week is centered) - that's pure
// presentation, not data, so it lives in a small inline script and never touches the
// server except to carry the current position through a toggle/approve redirect.
//
// No auth/roles yet (see README.md) - this single view is what employee, manager, and
// HR would all see. internalGaps are deliberately not rendered anywhere on this page:
// they were designed as HR/manager-only content, and until real role separation exists,
// the safer default is to keep them out of the shared view entirely rather than expose
// them to everyone.
const express = require('express');
const { openDb } = require('./lib/db');
const { getPlan, toggleItemStatus, approvePlan } = require('./lib/persistence');
const { buildEmployeeContext } = require('./lib/context');

const PORT = process.env.PORT || 3000;

// One shared writable connection for the life of this simple v1 server - fine for a
// single-process, synchronous-SQLite dev server; would need reconsidering for
// concurrent multi-worker deployment.
const db = openDb({ writable: true });

const app = express();
app.use(express.urlencoded({ extended: false }));

// The "business" track's label is the real company name, not the literal word
// "Business" - built per-request from context.company rather than hardcoded, since
// (in principle) that's real data, not a fixed label like the other four. `description`
// is the fixed legend copy (framework/product-agnostic, doesn't change per company).
//
// Track hues are deliberately spread around the wheel (approx. 8/48/172/234/292 degrees)
// so every pair differs by hue, not just lightness/saturation of the same color family -
// business (red-coral) and systems_access (yellow-gold) used to sit only ~19 degrees
// apart (both orange-ish), and role (purple) and compliance (indigo) only ~37 degrees
// apart, both hard to tell apart at a glance. Every pair is now >=40 degrees apart.
function buildTrackStyles(companyName) {
  return {
    business: {
      accent: '#f4573f',
      chipBg: 'rgba(244,87,63,0.16)',
      chipFg: '#fca597',
      label: companyName || 'Business',
      description: 'Who we are - the business, the market, our customers',
    },
    compliance: {
      accent: '#818cf8',
      chipBg: 'rgba(129,140,248,0.16)',
      chipFg: '#a5b4fc',
      label: 'Compliance',
      description: 'Required training',
    },
    team_interfaces: {
      accent: '#2dd4bf',
      chipBg: 'rgba(45,212,191,0.16)',
      chipFg: '#5eead4',
      label: 'People & Roles',
      description: 'The people worth meeting',
    },
    role: {
      accent: '#d946ef',
      chipBg: 'rgba(217,70,239,0.16)',
      chipFg: '#f0abfc',
      label: 'Your Role',
      description: 'Learning and hands-on practice',
    },
    systems_access: {
      accent: '#facc15',
      chipBg: 'rgba(250,204,21,0.16)',
      chipFg: '#fde047',
      label: 'Tools & Access',
      description: "The systems you'll work in",
    },
  };
}
const DEFAULT_TRACK_STYLE = { accent: '#6b7690', chipBg: 'rgba(107,118,144,0.16)', chipFg: '#9aa4bd', label: 'Other' };
// Legend order is fixed and doesn't depend on which tracks happen to appear in a given
// plan - an employee with no role-track items this week should still see what "Your
// Role" means, since the legend is a standing reference, not a per-week summary.
const LEGEND_ORDER = ['business', 'team_interfaces', 'role', 'systems_access', 'compliance'];

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Tel Aviv (Asia/Jerusalem) runs a Sun-Thu work week; every other office in this
// dataset (London, Austin) runs the standard Mon-Fri week. Returned as JS
// Date#getUTCDay() values (0 = Sunday).
function officeWorkDays(office) {
  return office && office.time_zone === 'Asia/Jerusalem' ? [0, 1, 2, 3, 4] : [1, 2, 3, 4, 5];
}

// hire_date is stored as "YYYY-MM-DD" - parsed as UTC midnight so day-of-week math
// isn't affected by the server process's own local timezone.
function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(date, n) {
  return new Date(date.getTime() + n * DAY_MS);
}

// Walks forward from `from` (inclusive) and collects the next `count` working days
// per `workDays`, skipping non-working days.
function nextWorkingDays(from, workDays, count) {
  const result = [];
  let d = from;
  while (result.length < count) {
    if (workDays.includes(d.getUTCDay())) result.push(d);
    d = addDays(d, 1);
  }
  return result;
}

// Computes the displayed calendar range for each of the 8 weekNumbers, from the
// employee's real hire_date and their office's work week. This governs ONLY the date
// range shown next to a week's heading - it never changes which weekNumber the Process
// Expert scheduled an item into; weekNumber 1's items are still exactly what the plan
// says, regardless of how much (or little) real time that label ends up covering.
//
// If hire_date lands with 4-5 working days left in the employee's first work week,
// week 1 displays that partial range on its own. If 3 or fewer working days are left
// (e.g. starting on the office's last or second-to-last working day), a standalone
// week 1 would be a near-empty stub - so it absorbs the next full work week too (up to
// 8 working days combined), and week 2 onward each continue as a normal 5-working-day
// span, picked up right where the merged range left off.
function computeWeekDateRanges(hireDateStr, office) {
  const workDays = officeWorkDays(office);
  let effectiveStart = parseDateOnly(hireDateStr);
  while (!workDays.includes(effectiveStart.getUTCDay())) {
    effectiveStart = addDays(effectiveStart, 1);
  }

  const startIndexInWeek = workDays.indexOf(effectiveStart.getUTCDay());
  const remainingDays = workDays.length - startIndexInWeek;
  const week1Size = remainingDays >= 4 ? remainingDays : remainingDays + workDays.length;

  const chunkSizes = [week1Size, ...Array(7).fill(workDays.length)];
  const ranges = [];
  let cursor = effectiveStart;
  for (const size of chunkSizes) {
    const days = nextWorkingDays(cursor, workDays, size);
    ranges.push({ start: days[0], end: days[days.length - 1] });
    cursor = addDays(days[days.length - 1], 1);
  }
  return ranges;
}

function formatDateRange({ start, end }) {
  const startStr = `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCDate()}`;
  const endStr = start.getUTCMonth() === end.getUTCMonth()
    ? `${end.getUTCDate()}`
    : `${MONTH_NAMES[end.getUTCMonth()]} ${end.getUTCDate()}`;
  return `${startStr}\u2013${endStr}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function renderItem(planId, item, trackStyles, activeWeek) {
  const style = trackStyles[item.track] || DEFAULT_TRACK_STYLE;
  return `
    <li class="item${item.completed ? ' completed' : ''}">
      <form class="check-form" method="POST" action="/plan/${planId}/item/${encodeURIComponent(item.id)}/toggle?week=${activeWeek}">
        <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="this.form.submit()" aria-label="Mark ${escapeHtml(item.shortLine)} as done">
      </form>
      <details class="card" style="--track-accent:${style.accent}">
        <summary>
          <span class="tag" style="background:${style.chipBg};color:${style.chipFg}">${escapeHtml(style.label)}</span>
          <span class="short-line">${escapeHtml(item.shortLine)}</span>
          <span class="facilitator">${escapeHtml(item.facilitatorDisplayName)}</span>
          <span class="day-hint">${escapeHtml(item.dayHint)}</span>
        </summary>
        <p class="detail-text">${escapeHtml(item.detailText)}</p>
      </details>
    </li>
  `;
}

function renderWeekCard(planId, week, trackStyles, dateRangeLabel, activeWeek) {
  const items = week.items.length
    ? week.items.map((item) => renderItem(planId, item, trackStyles, activeWeek)).join('')
    : '<li class="empty">Nothing scheduled this week.</li>';
  return `
    <div class="week-card" data-week="${week.weekNumber}">
      <div class="week-card-inner">
        <div class="week-card-header">
          <span class="week-label">Week ${week.weekNumber}</span>
          <span class="week-dates">${escapeHtml(dateRangeLabel)}</span>
        </div>
        <ul class="items">${items}</ul>
      </div>
    </div>
  `;
}

function renderLegend(trackStyles) {
  const items = LEGEND_ORDER.map((track) => {
    const style = trackStyles[track];
    return `
      <div class="legend-item">
        <span class="legend-dot" style="background:${style.accent}"></span>
        <span class="legend-text"><strong style="color:${style.chipFg}">${escapeHtml(style.label)}</strong> - ${escapeHtml(style.description)}</span>
      </div>
    `;
  }).join('');
  return `<div class="legend">${items}</div>`;
}

// All 8 weeks are rendered into the DOM at once (not just the active one) - the
// carousel's positioning (which week is centered, which two are faded to the sides) is
// pure client-side presentation handled by the inline script below. This is the one
// deliberate exception to "no client-side state" in the file header comment: moving
// the carousel doesn't change any data, so there's nothing for a server round-trip to
// verify - a full page reload for something this purely visual would defeat the
// "smooth" requirement outright.
function renderCarousel(plan, context, activeWeek, trackStyles) {
  const weeks = plan.content.weeks;
  const dateRanges = computeWeekDateRanges(context.employee.hire_date, context.office);

  const cards = weeks
    .map((week) => renderWeekCard(plan.plan_id, week, trackStyles, formatDateRange(dateRanges[week.weekNumber - 1]), activeWeek))
    .join('');

  const dots = weeks
    .map((week) => `<button type="button" class="dot" data-week="${week.weekNumber}" aria-label="Go to week ${week.weekNumber}"></button>`)
    .join('');

  return `
    <div class="carousel-viewport">
      <button type="button" class="arrow arrow-prev" id="prevBtn" aria-label="Previous week">&#8249;</button>
      <div class="carousel-track" id="track">${cards}</div>
      <button type="button" class="arrow arrow-next" id="nextBtn" aria-label="Next week">&#8250;</button>
    </div>
    <div class="dots" id="dots">${dots}</div>
    <script>
    (function () {
      var active = ${activeWeek};
      var total = ${weeks.length};
      var cards = Array.prototype.slice.call(document.querySelectorAll('.week-card'));
      var dots = Array.prototype.slice.call(document.querySelectorAll('.dot'));
      var prevBtn = document.getElementById('prevBtn');
      var nextBtn = document.getElementById('nextBtn');

      function position() {
        cards.forEach(function (card) {
          var w = Number(card.getAttribute('data-week'));
          var offset = w - active;
          card.classList.remove('is-active', 'is-near', 'is-far');
          if (offset === 0) {
            card.classList.add('is-active');
            card.style.transform = 'translateX(-50%) scale(1) rotateY(0deg)';
            card.style.opacity = '1';
            card.style.zIndex = '3';
            card.style.pointerEvents = 'auto';
          } else if (Math.abs(offset) === 1) {
            card.classList.add('is-near');
            card.style.transform = 'translateX(calc(-50% + ' + (offset * 68) + '%)) scale(0.58) rotateY(' + (offset * -12) + 'deg)';
            card.style.opacity = '0.45';
            card.style.zIndex = '2';
            card.style.pointerEvents = 'auto';
          } else {
            card.classList.add('is-far');
            card.style.transform = 'translateX(calc(-50% + ' + (offset * 68) + '%)) scale(0.4) rotateY(' + (offset > 0 ? -12 : 12) + 'deg)';
            card.style.opacity = '0';
            card.style.zIndex = '1';
            card.style.pointerEvents = 'none';
          }
        });
        dots.forEach(function (dot) {
          dot.classList.toggle('active', Number(dot.getAttribute('data-week')) === active);
        });
        prevBtn.classList.toggle('disabled', active <= 1);
        nextBtn.classList.toggle('disabled', active >= total);
      }

      function setActive(w) {
        active = Math.min(Math.max(w, 1), total);
        position();
        var forms = document.querySelectorAll('.check-form');
        forms.forEach(function (f) {
          f.action = f.action.replace(/week=\\d+/, 'week=' + active);
        });
        var approveForm = document.getElementById('approveForm');
        if (approveForm) approveForm.action = approveForm.action.replace(/week=\\d+/, 'week=' + active);
      }

      prevBtn.addEventListener('click', function () { setActive(active - 1); });
      nextBtn.addEventListener('click', function () { setActive(active + 1); });
      cards.forEach(function (card) {
        card.addEventListener('click', function (e) {
          var w = Number(card.getAttribute('data-week'));
          if (w !== active) {
            e.preventDefault();
            setActive(w);
          }
        });
      });
      dots.forEach(function (dot) {
        dot.addEventListener('click', function () { setActive(Number(dot.getAttribute('data-week'))); });
      });

      position();
    })();
    </script>
  `;
}

function renderPlanPage(plan, context, activeWeek, errorMessage) {
  const allItems = plan.content.weeks.flatMap((w) => w.items);
  const completedCount = allItems.filter((i) => i.completed).length;
  const statusBadge = plan.status === 'approved'
    ? '<span class="status-badge approved">Approved</span>'
    : `<span class="status-badge draft">${escapeHtml(plan.status)}</span>`;
  const approveControl = plan.status === 'draft'
    ? `<form id="approveForm" method="POST" action="/plan/${plan.plan_id}/approve?week=${activeWeek}"><button type="submit" class="approve-btn">Approve plan</button></form>`
    : '';
  const errorBanner = errorMessage
    ? `<div class="error-banner">${escapeHtml(errorMessage)}</div>`
    : '';
  const trackStyles = buildTrackStyles(context.company && context.company.company_name);
  const subtitle = `${context.employee.job_title}, ${context.employee.department}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Onboarding Plan - ${escapeHtml(context.employee.full_name)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg: #0a0d15;
    --bg-elevated: #131826;
    --bg-card: #171e2f;
    --bg-card-hover: #1c2438;
    --text-primary: #f2f4fa;
    --text-secondary: #9aa4bd;
    --text-muted: #6b7690;
    --hairline: rgba(255,255,255,0.06);
    --accent-1: #6366f1;
    --accent-2: #a855f7;
  }
  * { box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: radial-gradient(ellipse at top, #101526 0%, var(--bg) 55%);
    color: var(--text-primary);
    margin: 0;
    padding: 0 0 4rem;
  }
  header {
    background: var(--bg-elevated);
    padding: 1.75rem 2rem 1.5rem;
    position: sticky;
    top: 0;
    z-index: 20;
    box-shadow: 0 8px 24px rgba(0,0,0,0.45);
  }
  header h1 { margin: 0; font-size: 1.6rem; font-weight: 800; letter-spacing: -0.01em; }
  header .subtitle { margin: 0.2rem 0 0.9rem; color: var(--text-secondary); font-size: 0.95rem; }
  .header-row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .progress { color: var(--text-secondary); font-size: 0.92rem; }
  .status-badge {
    padding: 0.3rem 0.75rem; border-radius: 999px; font-size: 0.78rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .status-badge.draft { background: rgba(251,191,36,0.15); color: #fbbf24; border: 1px solid rgba(251,191,36,0.35); }
  .status-badge.approved { background: rgba(74,222,128,0.15); color: #4ade80; border: 1px solid rgba(74,222,128,0.35); }
  .approve-btn {
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    color: #fff; border: none; padding: 0.6rem 1.3rem; border-radius: 8px;
    font-family: inherit; font-size: 0.9rem; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 18px rgba(99,102,241,0.4);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .approve-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(99,102,241,0.55); }
  .approve-btn:active { transform: translateY(0); }
  .error-banner { background: rgba(248,113,113,0.15); color: #fca5a5; border: 1px solid rgba(248,113,113,0.3); padding: 0.75rem 1rem; border-radius: 8px; margin-top: 0.75rem; font-size: 0.9rem; }

  .legend {
    max-width: 1140px; margin: 1.1rem auto 0; padding: 0.9rem 1.1rem;
    background: var(--bg-card); border-radius: 12px;
    display: flex; flex-wrap: wrap; gap: 0.9rem 1.6rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
  }
  .legend-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; color: var(--text-secondary); }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 8px currentColor; }
  .legend-text strong { font-weight: 700; }

  main { max-width: 1140px; margin: 0 auto; padding: 2.5rem 1rem 0; }

  .carousel-viewport { position: relative; height: 66vh; min-height: 520px; max-height: 720px; perspective: 1600px; }
  .carousel-track { position: relative; width: 100%; height: 100%; transform-style: preserve-3d; }
  .week-card {
    position: absolute; top: 0; left: 50%; width: min(560px, 88vw); height: 100%;
    transition: transform .5s cubic-bezier(.22,.9,.3,1), opacity .5s ease;
    cursor: pointer;
  }
  .week-card.is-active { cursor: default; }
  .week-card-inner {
    background: var(--bg-card);
    border-radius: 18px;
    height: 100%;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 60px rgba(0,0,0,0.55), 0 2px 0 rgba(255,255,255,0.04) inset;
    overflow: hidden;
  }
  .week-card-header {
    padding: 1.2rem 1.4rem 1rem; flex: none;
    display: flex; align-items: baseline; gap: 0.6rem;
    border-bottom: 1px solid var(--hairline);
  }
  .week-label { font-size: 1.05rem; font-weight: 800; letter-spacing: -0.01em; }
  .week-dates { color: var(--text-muted); font-size: 0.85rem; }
  .items { list-style: none; margin: 0; padding: 0.9rem 1.1rem 1.2rem; display: flex; flex-direction: column; gap: 0.55rem; overflow-y: auto; flex: 1; }
  .item { display: flex; align-items: flex-start; gap: 0.6rem; }
  .item.empty { color: var(--text-muted); font-size: 0.9rem; padding: 0.4rem 0.3rem; list-style: none; }
  .check-form { padding-top: 0.85rem; flex: none; }

  input[type=checkbox] {
    -webkit-appearance: none; appearance: none;
    width: 21px; height: 21px; border-radius: 50%;
    border: 2px solid var(--text-muted);
    background: transparent; cursor: pointer; position: relative;
    transition: border-color .15s ease, background .15s ease;
  }
  input[type=checkbox]:hover { border-color: var(--text-secondary); }
  input[type=checkbox]:checked {
    border-color: transparent;
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
  }
  input[type=checkbox]:checked::after {
    content: ''; position: absolute; left: 6px; top: 2px; width: 6px; height: 11px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
  }

  .card {
    flex: 1; min-width: 0; background: var(--bg-card-hover);
    border-radius: 10px; padding: 0.1rem 0;
    border-left: 3px solid var(--track-accent);
  }
  .item.completed .card { opacity: 0.45; }
  .item.completed .short-line { text-decoration: line-through; }
  summary { cursor: pointer; list-style: none; padding: 0.65rem 0.85rem; display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  summary::-webkit-details-marker { display: none; }
  .tag { font-size: 0.68rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.03em; }
  .short-line { font-weight: 600; flex: 1 1 auto; min-width: 140px; color: var(--text-primary); }
  .facilitator { color: var(--text-secondary); font-size: 0.83rem; }
  .day-hint { color: var(--text-muted); font-size: 0.78rem; margin-left: auto; }
  .detail-text { margin: 0 0.85rem 0.8rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }

  .arrow {
    position: absolute; top: 50%; transform: translateY(-50%);
    width: 46px; height: 46px; border-radius: 50%;
    background: var(--bg-card); border: none; color: var(--text-primary);
    font-size: 1.4rem; line-height: 1; cursor: pointer; z-index: 10;
    box-shadow: 0 6px 20px rgba(0,0,0,0.4);
    transition: background .15s ease, transform .15s ease;
    display: flex; align-items: center; justify-content: center;
  }
  .arrow:hover { background: var(--bg-card-hover); }
  .arrow.disabled { opacity: 0.3; pointer-events: none; }
  .arrow-prev { left: 0; }
  .arrow-next { right: 0; }

  .dots { display: flex; justify-content: center; gap: 0.5rem; margin: 1.6rem 0 0; }
  .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--hairline); border: none; padding: 0; cursor: pointer; transition: background .2s ease, transform .2s ease; }
  .dot.active { background: linear-gradient(135deg, var(--accent-1), var(--accent-2)); transform: scale(1.3); }

  @media (max-width: 640px) {
    .legend { gap: 0.7rem 1rem; }
    .carousel-viewport { height: 72vh; }
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(context.employee.full_name)}</h1>
  <p class="subtitle">${escapeHtml(subtitle)}</p>
  <div class="header-row">
    ${statusBadge}
    <span class="progress">${completedCount} / ${allItems.length} completed</span>
    ${approveControl}
  </div>
  ${errorBanner}
</header>
${renderLegend(trackStyles)}
<main>
  ${renderCarousel(plan, context, activeWeek, trackStyles)}
</main>
</body>
</html>`;
}

app.get('/', (req, res) => res.redirect('/plan/2'));

app.get('/plan/:planId', (req, res) => {
  const planId = Number(req.params.planId);
  const plan = getPlan(db, planId);
  if (!plan) return res.status(404).send(`No plan found for plan_id ${planId}.`);
  const context = buildEmployeeContext(db, plan.employee_id);
  const weekCount = plan.content.weeks.length;
  const requestedWeek = Number(req.query.week) || 1;
  const activeWeek = Math.min(Math.max(requestedWeek, 1), weekCount);
  res.send(renderPlanPage(plan, context, activeWeek, req.query.error));
});

app.post('/plan/:planId/item/:itemId/toggle', (req, res) => {
  const planId = Number(req.params.planId);
  const plan = toggleItemStatus(db, planId, req.params.itemId);
  if (!plan) return res.status(404).send(`No plan found for plan_id ${planId}.`);
  res.redirect(`/plan/${planId}?week=${Number(req.query.week) || 1}`);
});

app.post('/plan/:planId/approve', (req, res) => {
  const planId = Number(req.params.planId);
  const activeWeek = Number(req.query.week) || 1;
  try {
    approvePlan(db, planId);
  } catch (err) {
    return res.redirect(`/plan/${planId}?week=${activeWeek}&error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`/plan/${planId}?week=${activeWeek}`);
});

app.listen(PORT, () => {
  console.log(`Onboarding dashboard running at http://localhost:${PORT}/plan/2`);
});
