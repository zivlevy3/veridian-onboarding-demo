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
const { getPlan, toggleItemStatus, approvePlan, saveManagerIntake } = require('./lib/persistence');
const { buildEmployeeContext } = require('./lib/context');
const { createEmployee } = require('./lib/employees');
const { runOrchestrator } = require('./lib/orchestrator');

const PORT = process.env.PORT || 3000;

// One shared writable connection for the life of this simple v1 server - fine for a
// single-process, synchronous-SQLite dev server; would need reconsidering for
// concurrent multi-worker deployment.
const db = openDb({ writable: true });

// Real company name, queried once at startup - same source/shape context.js uses
// (SELECT * FROM company_overview LIMIT 1). Used as-is (no .io suffix) for <title> and
// other prose text; the intake page's eyebrow builds its own .io brandLabel from this,
// same split already established on the plan page.
const companyRow = db.prepare('SELECT company_name FROM company_overview LIMIT 1').get();
const companyName = (companyRow && companyRow.company_name) || 'Veridian';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
// Editing (the pencil icon) is scoped to these two tracks only - see the comment above
// its use in renderItem for why. Adding a new item still offers all 5 tracks (a manager
// filling a real gap - e.g. a forgotten system - needs every track available), and the
// checkbox is untouched on every track; only the edit affordance is narrowed.
const EDITABLE_TRACKS = new Set(['team_interfaces', 'role']);

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

// Every real employee's name->email, queried fresh per request - used to resolve a
// mailto target for an item's facilitator. Deliberately a raw, unfiltered company-wide
// lookup rather than just context.people's curated subset (manager/hrbp/buddy/etc.):
// several real facilitators (teammates like Tal Harari, Rachel Cooper) aren't in any of
// those curated lists, but they ARE real employees with a real email - excluding them
// would just be an arbitrary gap, not a "never invent" safeguard. The actual safeguard
// is the match itself: if facilitatorDisplayName's name portion doesn't match a real
// employee, no email is offered - never guessed or constructed from a pattern.
function buildNameEmailMap(db) {
  const rows = db.prepare('SELECT full_name, email FROM employees').all();
  const map = {};
  for (const r of rows) {
    if (r.full_name && r.email) map[r.full_name] = r.email;
  }
  return map;
}

// facilitatorDisplayName is always either "Name (relationship note)" (a real person) or
// a non-person label ("Self-paced (LMS)", "IT Operations", "HR team", "To be assigned",
// "—" for the lighter-week placeholder). Splitting on " (" and checking the result
// against real employee data is what tells these apart - a system/team/placeholder label
// simply won't match any employee's full_name, so it naturally gets no mailto affordance
// without needing a stored facilitatorType (not part of the persisted item shape).
function resolveFacilitatorEmail(facilitatorDisplayName, nameEmailMap) {
  if (!facilitatorDisplayName) return null;
  const name = facilitatorDisplayName.split(' (')[0].trim();
  return nameEmailMap[name] || null;
}

function renderItem(planId, item, trackStyles, activeWeek, nameEmailMap) {
  const style = trackStyles[item.track] || DEFAULT_TRACK_STYLE;
  const facilitatorName = (item.facilitatorDisplayName || '').split(' (')[0].trim();
  const email = resolveFacilitatorEmail(item.facilitatorDisplayName, nameEmailMap);
  // Mail icon requires BOTH a resolved real email AND a hand-written emailContext - the
  // email lookup alone isn't enough (see prompts/content-writer.md's "Use emailContext"
  // rule: the direct-manager relationship resolves to a real email too, but never gets
  // emailContext, since that meeting is already scheduled and needs no employee-
  // initiated outreach). No emailContext means no generic fallback text either - the
  // whole point of this field is real, per-relationship content, not a template.
  const mailBtn = email && item.emailContext
    ? `<button type="button" class="icon-btn mail-btn" data-email="${escapeHtml(email)}" title="Email ${escapeHtml(facilitatorName)}" aria-label="Email ${escapeHtml(facilitatorName)}">&#9993;</button>`
    : '';
  // Editing is scoped to the two "content" tracks a manager would plausibly want to
  // adjust wording on (People & Roles, Your Role) - not Veridian/Tools & Access/
  // Compliance, whose items are either fixed catalog content (systems, mandatory
  // trainings) or company-wide LMS sessions, not something this demo edit affordance is
  // meant to touch. See EDITABLE_TRACKS in the client script for the matching rule
  // applied to freshly-added draft items too.
  const editBtn = EDITABLE_TRACKS.has(item.track)
    ? `<button type="button" class="icon-btn edit-btn" title="Edit (preview only)" aria-label="Edit ${escapeHtml(item.shortLine)}">&#9998;</button>`
    : '';
  return `
    <li class="item${item.completed ? ' completed' : ''}" data-id="${escapeHtml(item.id || '')}" data-track="${escapeHtml(item.track || '')}" data-short-line="${escapeHtml(item.shortLine)}" data-detail-text="${escapeHtml(item.detailText)}" data-facilitator="${escapeHtml(item.facilitatorDisplayName)}" data-day-hint="${escapeHtml(item.dayHint)}" data-email-context="${escapeHtml(item.emailContext || '')}">
      <form class="check-form" method="POST" action="/plan/${planId}/item/${encodeURIComponent(item.id)}/toggle?week=${activeWeek}">
        <input type="checkbox" ${item.completed ? 'checked' : ''} onchange="this.form.submit()" aria-label="Mark ${escapeHtml(item.shortLine)} as done">
      </form>
      <details class="card" style="--track-accent:${style.accent}">
        <summary>
          <span class="tag" style="background:${style.chipBg};color:${style.chipFg}">${escapeHtml(style.label)}</span>
          <span class="short-line">${escapeHtml(item.shortLine)}</span>
          <span class="facilitator">${escapeHtml(item.facilitatorDisplayName)}</span>
          <span class="day-hint">${escapeHtml(item.dayHint)}</span>
          ${mailBtn}
          ${editBtn}
        </summary>
        <p class="detail-text">${escapeHtml(item.detailText)}</p>
      </details>
    </li>
  `;
}

function renderWeekCard(planId, week, trackStyles, dateRangeLabel, activeWeek, nameEmailMap) {
  const items = week.items.length
    ? week.items.map((item) => renderItem(planId, item, trackStyles, activeWeek, nameEmailMap)).join('')
    : '<li class="empty">Nothing scheduled this week.</li>';
  return `
    <div class="week-card" data-week="${week.weekNumber}">
      <div class="week-card-inner">
        <div class="week-card-header">
          <span class="week-label">Week ${week.weekNumber}</span>
          <span class="week-dates">${escapeHtml(dateRangeLabel)}</span>
        </div>
        <ul class="items">${items}</ul>
        <div class="week-card-footer">
          <button type="button" class="add-item-btn" data-week="${week.weekNumber}">+ Add item</button>
          <span class="demo-badge">Demo mode - changes won't be saved</span>
        </div>
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
function renderCarousel(plan, context, activeWeek, trackStyles, nameEmailMap) {
  const weeks = plan.content.weeks;
  const dateRanges = computeWeekDateRanges(context.employee.hire_date, context.office);

  const cards = weeks
    .map((week) => renderWeekCard(plan.plan_id, week, trackStyles, formatDateRange(dateRanges[week.weekNumber - 1]), activeWeek, nameEmailMap))
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

function renderPlanPage(plan, context, activeWeek, errorMessage, nameEmailMap) {
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
  const companyName = (context.company && context.company.company_name) || 'Veridian';
  // Display-only stylized brand form ("Veridian.io") for the eyebrow and the business
  // track's label/tag - a deliberate branding choice, not a claim about the real email
  // domain (which is @veridian.ai - see companyName/COMPANY_NAME below, still used
  // as-is in the page <title> and in the compose window's "at Veridian" body text).
  const brandLabel = `${companyName}.io`;
  const trackStyles = buildTrackStyles(brandLabel);
  const subtitle = `${context.employee.job_title}, ${context.employee.department}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(context.employee.full_name)} · Onboarding Plan · ${escapeHtml(companyName)}</title>
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
  .eyebrow { margin: 0 0 0.35rem; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-muted); }
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
  .draft-checkbox-wrap { padding-top: 0.85rem; flex: none; }

  .week-card-footer {
    padding: 0.65rem 1.1rem 0.95rem; flex: none; border-top: 1px solid var(--hairline);
    display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; flex-wrap: wrap;
  }
  .add-item-btn {
    background: transparent; border: 1px dashed var(--text-muted); color: var(--text-secondary);
    border-radius: 8px; padding: 0.35rem 0.7rem; font-size: 0.78rem; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: border-color .15s ease, color .15s ease;
  }
  .add-item-btn:hover { border-color: var(--text-secondary); color: var(--text-primary); }
  .demo-badge { font-size: 0.68rem; color: var(--text-muted); font-style: italic; }
  .demo-item-tag {
    font-size: 0.58rem; font-weight: 700; color: var(--text-muted); border: 1px solid var(--hairline);
    border-radius: 4px; padding: 0.05rem 0.35rem; letter-spacing: 0.05em; text-transform: uppercase;
  }

  .icon-btn {
    background: transparent; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 0.9rem; padding: 0.1rem 0.3rem; border-radius: 5px; line-height: 1;
    margin-left: -0.15rem;
  }
  .icon-btn:hover { color: var(--text-primary); background: rgba(255,255,255,0.08); }

  .item-form-overlay {
    position: fixed; inset: 0; background: rgba(5,8,14,0.68); display: flex;
    align-items: center; justify-content: center; z-index: 100; padding: 1rem;
  }
  .item-form-overlay[hidden] { display: none; }
  .item-form-modal {
    background: var(--bg-card); border-radius: 14px; padding: 1.4rem; width: 100%;
    max-width: 420px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid var(--hairline);
  }
  .item-form-modal h3 { margin: 0 0 1rem; font-size: 1.05rem; }
  .form-field { display: block; font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.85rem; }
  .form-field input, .form-field textarea, .form-field select {
    display: block; width: 100%; margin-top: 0.35rem; padding: 0.5rem 0.6rem; border-radius: 8px;
    border: 1px solid var(--hairline); background: var(--bg-card-hover); color: var(--text-primary);
    font-family: inherit; font-size: 0.88rem; resize: vertical;
  }
  .form-field input:focus, .form-field textarea:focus, .form-field select:focus { outline: 2px solid var(--accent-1); outline-offset: 1px; }
  .item-form-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 0.4rem; }
  .item-form-actions button {
    padding: 0.5rem 1.1rem; border-radius: 8px; border: none; font-weight: 700;
    cursor: pointer; font-family: inherit; font-size: 0.85rem;
  }
  #itemFormCancel { background: transparent; color: var(--text-secondary); border: 1px solid var(--hairline); }
  #itemFormSave { background: linear-gradient(135deg, var(--accent-1), var(--accent-2)); color: #fff; }
  .item-form-note { margin: 0.85rem 0 0; font-size: 0.72rem; color: var(--text-muted); text-align: center; }

  /* Gmail-style compose window mockup - deliberately NOT 'Inter' (the rest of the
     dashboard's font) so it reads as a different app that opened, not another dashboard
     panel. Colors/sizing are a close visual match to real Gmail compose, not a design
     system token set - this window is a one-off pastiche, not part of the dashboard's
     own visual language. */
  .compose-window {
    /* The dashboard sets color-scheme:dark on :root, which changes native form-control
       UA styling (input/textarea backgrounds go dark-by-default) even when every color
       here is spelled out explicitly - this scopes the subtree back to light so it
       actually renders as the white Gmail-style window it's styled to be, not a dark
       one with light-on-dark text fighting the explicit colors below. */
    color-scheme: light;
    position: fixed; right: 24px; bottom: 0; width: 450px; max-width: calc(100vw - 32px);
    background: #fff; border-radius: 8px 8px 0 0; overflow: hidden;
    box-shadow: 0 8px 28px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.18);
    font-family: 'Google Sans', Roboto, Arial, system-ui, -apple-system, sans-serif;
    z-index: 300; display: flex; flex-direction: column;
    transform: translateY(100%); opacity: 0; pointer-events: none;
    transition: transform .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease;
  }
  .compose-window[hidden] { display: none; }
  .compose-window.visible { transform: translateY(0); opacity: 1; pointer-events: auto; }

  .compose-header {
    background: #3c4043; color: #fff; padding: 10px 8px 10px 16px; flex: none;
    display: flex; align-items: center; justify-content: space-between;
    font-size: 14px; font-weight: 500; cursor: default; user-select: none;
  }
  .compose-header-icons { display: flex; align-items: center; gap: 2px; }
  .compose-header-icons button {
    background: transparent; border: none; color: #fff; opacity: 0.85; cursor: pointer;
    width: 28px; height: 28px; border-radius: 4px; font-size: 15px; line-height: 1;
    display: flex; align-items: center; justify-content: center; font-family: inherit;
  }
  .compose-header-icons button:hover { background: rgba(255,255,255,0.14); opacity: 1; }

  .compose-field {
    display: flex; align-items: center; padding: 9px 16px; border-bottom: 1px solid #e0e0e0;
    font-size: 14px; color: #202124; flex: none;
  }
  .compose-field-label { color: #5f6368; margin-right: 12px; flex: none; }
  .compose-to { flex-wrap: wrap; row-gap: 4px; }
  .compose-chip {
    display: inline-flex; align-items: center; gap: 5px; background: #f1f3f4; border-radius: 16px;
    padding: 3px 10px; font-size: 13px; color: #202124;
  }
  .compose-chip-email { color: #5f6368; }
  .compose-field input {
    border: none; outline: none; flex: 1; font-size: 14px; font-family: inherit; color: #202124;
    background: #fff; min-width: 0;
  }

  .compose-body {
    flex: 1; border: none; outline: none; resize: none; padding: 16px; font-size: 14px;
    line-height: 1.5; color: #202124; font-family: inherit; background: #fff; min-height: 180px;
  }

  .compose-footer {
    display: flex; align-items: center; justify-content: space-between; flex: none;
    padding: 8px 14px 14px 16px;
  }
  .compose-footer-left { display: flex; align-items: center; gap: 2px; }
  .compose-send {
    background: #0b57d0; color: #fff; border: none; border-radius: 18px; padding: 10px 24px;
    font-size: 14px; font-weight: 500; font-family: inherit; cursor: pointer; margin-right: 14px;
  }
  .compose-send:hover { background: #0842a0; }
  .compose-icon {
    color: #5f6368; font-size: 16px; width: 28px; height: 28px; border-radius: 4px;
    display: flex; align-items: center; justify-content: center; cursor: default;
  }
  .compose-icon:hover { background: #f1f3f4; }
  .compose-icon.compose-format { font-weight: 700; text-decoration: underline; font-size: 14px; }

  @media (max-width: 520px) {
    .compose-window { right: 0; left: 0; width: 100%; max-width: 100%; }
  }

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
  <p class="eyebrow">Onboarding Plan · ${escapeHtml(brandLabel)}</p>
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
  ${renderCarousel(plan, context, activeWeek, trackStyles, nameEmailMap)}
</main>

<div class="compose-window" id="composeWindow" hidden>
  <div class="compose-header">
    <span>New Message</span>
    <div class="compose-header-icons">
      <button type="button" title="Minimize" tabindex="-1">&#8722;</button>
      <button type="button" title="Full screen" tabindex="-1">&#9744;</button>
      <button type="button" id="composeClose" title="Close" aria-label="Close compose window">&times;</button>
    </div>
  </div>
  <div class="compose-field compose-to">
    <span class="compose-field-label">To</span>
    <span id="composeTo"></span>
  </div>
  <div class="compose-field">
    <input type="text" id="composeSubject" placeholder="Subject">
  </div>
  <textarea class="compose-body" id="composeBody"></textarea>
  <div class="compose-footer">
    <div class="compose-footer-left">
      <button type="button" class="compose-send" id="composeSend">Send</button>
      <span class="compose-icon compose-format" title="Formatting options">A</span>
      <span class="compose-icon" title="Attach files">&#128206;</span>
      <span class="compose-icon" title="Insert emoji">&#128512;</span>
      <span class="compose-icon" title="Insert photo">&#128247;</span>
    </div>
    <span class="compose-icon" title="Discard draft">&#128465;</span>
  </div>
</div>

<div class="item-form-overlay" id="itemFormOverlay" hidden>
  <div class="item-form-modal">
    <h3 id="itemFormHeading">Add item</h3>
    <label class="form-field">Title
      <input type="text" id="itemFormShortLine" maxlength="90" placeholder="e.g. Sync with the design team">
    </label>
    <label class="form-field">Description
      <textarea id="itemFormDetailText" rows="3" placeholder="A sentence or two of detail"></textarea>
    </label>
    <label class="form-field">Track
      <select id="itemFormTrack"></select>
    </label>
    <div class="item-form-actions">
      <button type="button" id="itemFormCancel">Cancel</button>
      <button type="button" id="itemFormSave">Save</button>
    </div>
    <p class="item-form-note">Demo mode - changes won't be saved.</p>
  </div>
</div>

<script>
(function () {
  var TRACK_STYLES = ${JSON.stringify(trackStyles)};
  var DEFAULT_TRACK_STYLE = ${JSON.stringify(DEFAULT_TRACK_STYLE)};
  var EMPLOYEE_NAME = ${JSON.stringify(context.employee.full_name)};
  var EMPLOYEE_TITLE = ${JSON.stringify(context.employee.job_title)};
  var COMPANY_NAME = ${JSON.stringify(companyName)};

  function styleFor(track) {
    return TRACK_STYLES[track] || DEFAULT_TRACK_STYLE;
  }

  function escapeAttr(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  // ---- In-app compose window (Gmail-style mockup, not a real mailto: link) ----
  // mailto: turned out unreliable to verify - it gives zero visible feedback whether it
  // silently opened a mail client, silently no-opped (no default handler, common on
  // dev/corporate machines), or never fired at all, so a working click and a broken one
  // were indistinguishable from the page. This replaces it with a real in-DOM compose
  // window - 100% reliable for every viewer regardless of local mail client config, since
  // nothing ever leaves the page. Send is intentionally decorative (closes the window,
  // doesn't transmit anything) - this is a preview surface, not a real mail client.
  //
  // The body's one variable part is emailContext - a real, hand-written sentence per
  // item (see prompts/content-writer.md's "Use emailContext"), not a phrase mechanically
  // derived from the item's title. There's no generic fallback: an item with a resolved
  // email but no emailContext simply gets no mail icon at all (see renderItem in this
  // file) rather than falling back to templated filler.
  var composeEl = document.getElementById('composeWindow');
  var composeTo = document.getElementById('composeTo');
  var composeSubject = document.getElementById('composeSubject');
  var composeBody = document.getElementById('composeBody');

  function openComposeWindow(li) {
    var mailBtn = li.querySelector('.mail-btn');
    if (!mailBtn) return;
    var email = mailBtn.getAttribute('data-email');
    var facilitatorName = (li.getAttribute('data-facilitator') || '').split(' (')[0].trim();
    var recipientFirstName = facilitatorName.split(' ')[0];
    var emailContext = li.getAttribute('data-email-context') || '';
    var subject = 'Introduction - ' + EMPLOYEE_NAME;
    var body = 'Hi ' + recipientFirstName + ',\\n\\n' +
      "I'm " + EMPLOYEE_NAME + ', ' + EMPLOYEE_TITLE + ' at ' + COMPANY_NAME + '. ' + emailContext + '\\n\\n' +
      "Would love to find some time to connect in the next couple of weeks - let me know what works for you.\\n\\n" +
      'Best,\\n' + EMPLOYEE_NAME;

    composeTo.innerHTML = '<span class="compose-chip">' + escapeAttr(facilitatorName) +
      ' <span class="compose-chip-email">&lt;' + escapeAttr(email) + '&gt;</span></span>';
    composeSubject.value = subject;
    composeBody.value = body;

    // Re-triggering the slide-up when a second meeting is opened while the window is
    // already visible (not stacked - one instance, content swapped and animation redone
    // so it still reads as "a new message just opened", per spec).
    composeEl.classList.remove('visible');
    // Force a reflow so removing+re-adding the class actually restarts the transition.
    void composeEl.offsetWidth;
    composeEl.hidden = false;
    composeEl.classList.add('visible');
  }

  function closeComposeWindow() {
    composeEl.classList.remove('visible');
    setTimeout(function () {
      composeEl.hidden = true;
    }, 200);
  }

  document.getElementById('composeClose').addEventListener('click', closeComposeWindow);
  document.getElementById('composeSend').addEventListener('click', closeComposeWindow);

  // ---- Add/Edit item (session-only - never sent to the server) ----
  var overlay = document.getElementById('itemFormOverlay');
  var headingEl = document.getElementById('itemFormHeading');
  var shortLineInput = document.getElementById('itemFormShortLine');
  var detailTextInput = document.getElementById('itemFormDetailText');
  var trackSelect = document.getElementById('itemFormTrack');
  var formState = { mode: null, weekNumber: null, targetLi: null };
  var draftCounter = 0;

  function populateTrackSelect(selected) {
    trackSelect.innerHTML = '';
    Object.keys(TRACK_STYLES).forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = TRACK_STYLES[key].label;
      trackSelect.appendChild(opt);
    });
    trackSelect.value = selected && TRACK_STYLES[selected] ? selected : 'role';
  }

  function openAddForm(weekNumber) {
    formState = { mode: 'add', weekNumber: weekNumber, targetLi: null };
    headingEl.textContent = 'Add item - Week ' + weekNumber;
    shortLineInput.value = '';
    detailTextInput.value = '';
    populateTrackSelect('role');
    overlay.hidden = false;
    shortLineInput.focus();
  }

  function openEditForm(li) {
    formState = { mode: 'edit', weekNumber: null, targetLi: li };
    headingEl.textContent = 'Edit item';
    shortLineInput.value = li.getAttribute('data-short-line') || '';
    detailTextInput.value = li.getAttribute('data-detail-text') || '';
    populateTrackSelect(li.getAttribute('data-track'));
    overlay.hidden = false;
    shortLineInput.focus();
  }

  function closeForm() {
    overlay.hidden = true;
    formState = { mode: null, weekNumber: null, targetLi: null };
  }

  function buildDraftItemHtml(data) {
    var style = styleFor(data.track);
    return '' +
      '<li class="item" data-id="' + data.id + '" data-track="' + data.track +
      '" data-short-line="' + escapeAttr(data.shortLine) + '" data-detail-text="' + escapeAttr(data.detailText) +
      '" data-facilitator="' + escapeAttr(data.facilitator) + '" data-day-hint="' + escapeAttr(data.dayHint) + '">' +
        '<span class="draft-checkbox-wrap"><input type="checkbox" class="draft-checkbox" aria-label="Mark ' + escapeAttr(data.shortLine) + ' as done"></span>' +
        '<details class="card" style="--track-accent:' + style.accent + '">' +
          '<summary>' +
            '<span class="tag" style="background:' + style.chipBg + ';color:' + style.chipFg + '">' + escapeAttr(style.label) + '</span>' +
            '<span class="demo-item-tag">Draft</span>' +
            '<span class="short-line">' + escapeAttr(data.shortLine) + '</span>' +
            '<span class="facilitator">' + escapeAttr(data.facilitator) + '</span>' +
            '<span class="day-hint">' + escapeAttr(data.dayHint) + '</span>' +
            '<button type="button" class="icon-btn edit-btn" title="Edit (preview only)">&#9998;</button>' +
          '</summary>' +
          '<p class="detail-text">' + escapeAttr(data.detailText) + '</p>' +
        '</details>' +
      '</li>';
  }

  function saveForm() {
    var shortLine = shortLineInput.value.trim();
    var detailText = detailTextInput.value.trim() || 'No additional details yet.';
    var track = trackSelect.value;
    if (!shortLine) { shortLineInput.focus(); return; }

    if (formState.mode === 'add') {
      draftCounter += 1;
      var weekCard = document.querySelector('.week-card[data-week="' + formState.weekNumber + '"]');
      var list = weekCard.querySelector('.items');
      var emptyLi = list.querySelector('.item.empty');
      if (emptyLi) emptyLi.remove();
      list.insertAdjacentHTML('beforeend', buildDraftItemHtml({
        id: 'draft-' + draftCounter,
        track: track,
        shortLine: shortLine,
        detailText: detailText,
        facilitator: 'Added by you (draft)',
        dayHint: 'Week ' + formState.weekNumber,
      }));
    } else if (formState.mode === 'edit') {
      var li = formState.targetLi;
      var style = styleFor(track);
      li.setAttribute('data-track', track);
      li.setAttribute('data-short-line', shortLine);
      li.setAttribute('data-detail-text', detailText);
      var tagEl = li.querySelector('.tag');
      tagEl.textContent = style.label;
      tagEl.style.background = style.chipBg;
      tagEl.style.color = style.chipFg;
      li.querySelector('.card').style.setProperty('--track-accent', style.accent);
      li.querySelector('.short-line').textContent = shortLine;
      li.querySelector('.detail-text').textContent = detailText;
    }
    closeForm();
  }

  document.getElementById('itemFormCancel').addEventListener('click', closeForm);
  document.getElementById('itemFormSave').addEventListener('click', saveForm);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeForm();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) closeForm();
    if (e.key === 'Escape' && !composeEl.hidden) closeComposeWindow();
  });

  // A click inside <summary> normally toggles the parent <details> open/closed - the
  // buttons nested in there need preventDefault (not just stopPropagation) to suppress
  // that default action when they're doing something else instead.
  document.addEventListener('click', function (e) {
    var mailBtn = e.target.closest('.mail-btn');
    if (mailBtn) {
      e.preventDefault();
      openComposeWindow(mailBtn.closest('.item'));
      return;
    }
    var editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      e.preventDefault();
      openEditForm(editBtn.closest('.item'));
      return;
    }
    var addBtn = e.target.closest('.add-item-btn');
    if (addBtn) {
      openAddForm(addBtn.getAttribute('data-week'));
    }
  });

  // Draft items have no real DB row to toggle against, so their checkbox just flips a
  // local class instead of submitting the real .check-form/toggle endpoint.
  document.addEventListener('change', function (e) {
    if (e.target.classList.contains('draft-checkbox')) {
      e.target.closest('.item').classList.toggle('completed', e.target.checked);
    }
  });
})();
</script>
</body>
</html>`;
}

// Reference data for the /start intake form's cascading Department -> Team -> Role
// dropdowns and the Manager/Buddy/Mentor people-pickers - embedded into the page as
// JSON so the cascade filtering runs client-side with no AJAX round-trips (same
// approach renderPlanPage already uses for TRACK_STYLES). Only Active teams and
// employees who have actually started are offered as real org context (a "Pending
// Start" employee - like a previous test hire - can't sensibly be someone's manager,
// buddy, or mentor before they've started themselves).
function buildIntakeReferenceData(db) {
  const departments = db.prepare('SELECT department FROM departments ORDER BY department').all().map((r) => r.department);
  const teams = db
    .prepare("SELECT team_id, department, team, primary_office FROM teams WHERE status = 'Active' ORDER BY department, team")
    .all();
  const roles = db.prepare('SELECT role_id, job_family, title, track FROM roles ORDER BY title').all();
  const employees = db
    .prepare(
      "SELECT employee_id, full_name, job_title, department, team, track, email, location FROM employees WHERE employment_status != 'Pending Start' ORDER BY full_name"
    )
    .all();
  return { departments, teams, roles, employees };
}

function renderStartPage(referenceData, companyName, errorMessage) {
  const brandLabel = `${companyName}.io`;
  const errorBanner = errorMessage
    ? `<div class="error-banner" id="errorBanner">${escapeHtml(errorMessage)}</div>`
    : '<div class="error-banner" id="errorBanner" hidden></div>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>New Hire Intake · ${escapeHtml(companyName)}</title>
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
    padding: 3.5rem 1rem 6rem;
  }
  .intake-wrap { max-width: min(640px, 92vw); margin: 0 auto; }
  .eyebrow { margin: 0 0 0.5rem; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-muted); }
  .intake-heading { margin: 0 0 0.7rem; font-size: 1.9rem; font-weight: 800; letter-spacing: -0.01em; line-height: 1.28; }
  .intake-subtitle { margin: 0 0 2.2rem; color: var(--text-secondary); font-size: 1rem; line-height: 1.55; max-width: 46ch; }
  .error-banner { background: rgba(248,113,113,0.15); color: #fca5a5; border: 1px solid rgba(248,113,113,0.3); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.3rem; font-size: 0.88rem; }
  .error-banner[hidden] { display: none; }

  /* Field cards - same visual language as the plan page's week cards: a shade lighter
     than the page background, a soft shadow instead of a border, grouped under a small
     muted uppercase title (matching .eyebrow's treatment). */
  .field-card { background: var(--bg-card); border-radius: 16px; padding: 1.6rem 1.7rem; box-shadow: 0 12px 34px rgba(0,0,0,0.35); margin-bottom: 1.3rem; }
  /* Per-card left accent stripe - same 3px border-left-as-identity pattern as an item
     card's --track-accent, but decorative here (which card you're in), not meaningful
     (unlike a track color, which tells you what KIND of onboarding item this is). The
     5 track hues (coral 8°, gold 48°, turquoise 172°, indigo 234°, magenta 292°)
     already tile most of the wheel at their own >=40 deg spacing, leaving only one
     ~44 deg gap (88-132, greens) with full 40 deg clearance from every track color -
     not enough room for 4 mutually distinct new hues. These 4 stay >=40 deg apart from
     EACH OTHER (87+ deg apart, so no two cards read as the same color) and >=28 deg from
     the nearest track color - not the full 40, but still a clearly different hue, and
     never adjacent to a track's own position on the wheel. */
  .field-card--joining { border-left: 3px solid #f04c83; --card-accent: #f04c83; }
  .field-card--team-role { border-left: 3px solid #51abec; --card-accent: #51abec; }
  .field-card--involved { border-left: 3px solid #53c65c; --card-accent: #53c65c; }
  .field-card--else { border-left: 3px solid #ef8539; --card-accent: #ef8539; }
  /* Every card is now its own <details> (independent accordion - opening one never
     closes another, unlike a native radio-style details[name] group). margin-bottom
     on the title/summary only applies when open, so a closed card doesn't carry dead
     space below a summary that has no visible content following it. */
  .field-card-title { margin: 0; font-size: 0.76rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); }
  .field-card-collapsible summary { cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; }
  .field-card-collapsible summary::-webkit-details-marker { display: none; }
  .field-card-collapsible summary::after { content: '+'; color: var(--text-muted); font-size: 1.1rem; font-weight: 400; }
  .field-card-collapsible[open] summary::after { content: '\\2212'; }
  .field-card-collapsible[open] summary { margin-bottom: 1.25rem; }
  .field-card-optional { text-transform: none; font-weight: 400; letter-spacing: 0; font-size: 0.74rem; margin-left: 0.4rem; }

  .field-group { margin-bottom: 1.45rem; }
  .field-group:last-of-type { margin-bottom: 0; }
  .field-label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.4rem; }
  /* A small accent-colored dot instead of a red asterisk - "required" isn't an error
     state, so it shouldn't borrow the same red used for real problems (.error-banner). */
  /* Matches the color of whichever card the field lives in (--card-accent, set per
     .field-card--* above), not a fixed global color - "required" here is a per-card
     visual cue, not a separate meaning-carrying system of its own. */
  .required-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--card-accent, var(--accent-1)); box-shadow: 0 0 6px var(--card-accent, var(--accent-1)); margin-left: 0.4rem; vertical-align: middle; }
  .field-hint { font-size: 0.76rem; color: var(--text-muted); margin: -0.15rem 0 0.5rem; }
  .field-input, select, textarea {
    width: 100%; padding: 0.65rem 0.8rem; border-radius: 9px; border: 1px solid var(--hairline);
    background: var(--bg-card-hover); color: var(--text-primary); font-family: inherit; font-size: 0.92rem;
    transition: box-shadow .15s ease, border-color .15s ease;
  }
  select { appearance: auto; }
  textarea { resize: vertical; min-height: 90px; }
  .field-input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--accent-1);
    box-shadow: 0 0 0 3px rgba(99,102,241,0.28), 0 0 16px rgba(99,102,241,0.22);
  }
  .other-input { margin-top: 0.55rem; display: none; }
  .other-input.visible { display: block; }

  .submit-btn {
    width: 100%; background: linear-gradient(135deg, var(--accent-1), var(--accent-2)); color: #fff;
    border: none; padding: 0.75rem 1.3rem; border-radius: 8px; font-family: inherit;
    font-size: 0.95rem; font-weight: 700; cursor: pointer; margin-top: 0.2rem;
    transition: transform .15s ease, box-shadow .15s ease;
    box-shadow: 0 4px 18px rgba(99,102,241,0.4);
  }
  .submit-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 22px rgba(99,102,241,0.55); }
  .submit-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
  .footnote { font-size: 0.78rem; color: var(--text-muted); text-align: center; margin: 1rem 0 0; line-height: 1.55; }

  .loading-overlay {
    position: fixed; inset: 0; background: rgba(5,8,14,0.86); display: flex; flex-direction: column;
    align-items: center; justify-content: center; z-index: 200; gap: 1.1rem;
  }
  .loading-overlay[hidden] { display: none; }
  .spinner { width: 42px; height: 42px; border-radius: 50%; border: 3px solid var(--hairline); border-top-color: var(--accent-1); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-text { color: var(--text-secondary); font-size: 0.95rem; font-weight: 600; }
</style>
</head>
<body>
<div class="intake-wrap">
  <p class="eyebrow">New Hire Intake · ${escapeHtml(brandLabel)}</p>
  <h1 class="intake-heading">Your new teammate is starting soon. Let's build their first two months.</h1>
  <p class="intake-subtitle">Give us a few details, and we'll put together a personalized onboarding plan - who to meet, what to learn, and when.</p>
  ${errorBanner}
  <form id="intakeForm">
    <details class="field-card field-card-collapsible field-card--joining" open>
      <summary class="field-card-title">Who's joining</summary>
      <div class="field-group">
        <label class="field-label" for="fldName">Full name<span class="required-dot" title="Required"></span></label>
        <input class="field-input" type="text" id="fldName" autocomplete="off" required>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldEmail">Company email<span class="required-dot" title="Required"></span></label>
        <input class="field-input" type="email" id="fldEmail" autocomplete="off" required>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldStartDate">Start date<span class="required-dot" title="Required"></span></label>
        <input class="field-input" type="date" id="fldStartDate" required>
      </div>
    </details>

    <details class="field-card field-card-collapsible field-card--team-role">
      <summary class="field-card-title">Team &amp; role</summary>
      <div class="field-group">
        <label class="field-label" for="fldDepartment">Department<span class="required-dot" title="Required"></span></label>
        <select class="field-input" id="fldDepartment" required></select>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldTeam">Team<span class="required-dot" title="Required"></span></label>
        <select class="field-input" id="fldTeam" required></select>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldRole">Role / Title<span class="required-dot" title="Required"></span></label>
        <select class="field-input" id="fldRole" required></select>
        <div class="other-input" id="fldRoleOtherWrap">
          <input class="field-input" type="text" id="fldRoleOther" placeholder="Job title">
        </div>
      </div>
    </details>

    <details class="field-card field-card-collapsible field-card--involved">
      <summary class="field-card-title">Who's involved</summary>
      <div class="field-group">
        <label class="field-label" for="fldManager">Direct manager<span class="required-dot" title="Required"></span></label>
        <select class="field-input" id="fldManager" required></select>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldBuddy">Buddy</label>
        <p class="field-hint">Who's there for the everyday, informal stuff</p>
        <select class="field-input" id="fldBuddy"></select>
        <div class="other-input" id="fldBuddyOtherWrap">
          <input class="field-input" type="text" id="fldBuddyOther" placeholder="Name or email">
        </div>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldMentor">Mentor<span class="required-dot" title="Required"></span></label>
        <p class="field-hint">Who'll walk them through the professional side of the role</p>
        <select class="field-input" id="fldMentor" required></select>
      </div>
      <div class="field-group">
        <label class="field-label" for="fldMentor2">Additional mentor</label>
        <p class="field-hint">A second person to loop in, if relevant</p>
        <select class="field-input" id="fldMentor2"></select>
      </div>
    </details>

    <details class="field-card field-card-collapsible field-card--else">
      <summary class="field-card-title">Anything else<span class="field-card-optional">(optional)</span></summary>
      <div class="field-group">
        <label class="field-label" for="fldJd">Job description</label>
        <textarea id="fldJd" placeholder="Paste the job posting text, if you have one"></textarea>
      </div>
    </details>

    <button type="submit" class="submit-btn" id="submitBtn">Build onboarding plan</button>
    <p class="footnote">From there, it's yours to make changes if you'd like - add a meeting, adjust a detail - then approve whenever it's ready.</p>
  </form>
</div>

<div class="loading-overlay" id="loadingOverlay" hidden>
  <div class="spinner"></div>
  <p class="loading-text">Building your plan...</p>
</div>

<script>
(function () {
  var DEPARTMENTS = ${JSON.stringify(referenceData.departments)};
  var TEAMS = ${JSON.stringify(referenceData.teams)};
  var ROLES = ${JSON.stringify(referenceData.roles)};
  var EMPLOYEES = ${JSON.stringify(referenceData.employees)};
  var OTHER = '__other__';

  var fldName = document.getElementById('fldName');
  var fldEmail = document.getElementById('fldEmail');
  var fldDepartment = document.getElementById('fldDepartment');
  var fldTeam = document.getElementById('fldTeam');
  var fldRole = document.getElementById('fldRole');
  var fldRoleOtherWrap = document.getElementById('fldRoleOtherWrap');
  var fldRoleOther = document.getElementById('fldRoleOther');
  var fldManager = document.getElementById('fldManager');
  var fldStartDate = document.getElementById('fldStartDate');
  var fldBuddy = document.getElementById('fldBuddy');
  var fldBuddyOtherWrap = document.getElementById('fldBuddyOtherWrap');
  var fldBuddyOther = document.getElementById('fldBuddyOther');
  var fldMentor = document.getElementById('fldMentor');
  var fldMentor2 = document.getElementById('fldMentor2');
  var fldJd = document.getElementById('fldJd');
  var errorBanner = document.getElementById('errorBanner');
  var loadingOverlay = document.getElementById('loadingOverlay');
  var submitBtn = document.getElementById('submitBtn');

  function opt(value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  function jobFamilyMatchesDept(jobFamily, department) {
    if (!department) return true;
    if (jobFamily === department) return true;
    // Known naming mismatch between roles.job_family and departments.department (e.g.
    // "Customer Success" vs "Customer Success & Support") - a prefix match on either
    // side covers it without inventing a mapping table for a handful of cases.
    if (department.indexOf(jobFamily) === 0) return true;
    if (jobFamily.indexOf(department) === 0) return true;
    return false;
  }

  // Department and Team are real organizational fact, not something a demo visitor can
  // invent - createEmployee requires an exact match against teams/departments and throws
  // otherwise, so there's no "Other" option here (an offered-but-always-broken option
  // would be misleading). Role is different: an unmatched title degrades gracefully to
  // a documented GAP, not a failure, so "Other" stays there (see refreshRoles below).
  function currentDept() {
    return fldDepartment.value;
  }
  function currentTeam() {
    return fldTeam.value;
  }

  function refreshDepartments() {
    fldDepartment.innerHTML = '';
    DEPARTMENTS.forEach(function (d) { fldDepartment.appendChild(opt(d, d)); });
  }

  function refreshTeams() {
    var dept = currentDept();
    var previous = fldTeam.value;
    var items = TEAMS.filter(function (t) { return t.department === dept; });
    fldTeam.innerHTML = '';
    items.forEach(function (t) { fldTeam.appendChild(opt(t.team, t.team)); });
    if (items.some(function (t) { return t.team === previous; })) fldTeam.value = previous;
  }

  function refreshRoles() {
    var dept = currentDept();
    var previous = fldRole.value;
    var filtered = ROLES.filter(function (r) { return jobFamilyMatchesDept(r.job_family, dept); });
    // "Filtered by department if possible" - job_family/department naming doesn't line
    // up for every role, so an empty filtered list falls back to the full catalog
    // rather than leaving the dropdown with nothing but "Other".
    var items = filtered.length ? filtered : ROLES;
    fldRole.innerHTML = '';
    items.forEach(function (r) { fldRole.appendChild(opt(r.title, r.title)); });
    fldRole.appendChild(opt(OTHER, 'Other'));
    if (items.some(function (r) { return r.title === previous; })) fldRole.value = previous;
  }

  function managerCandidates() {
    var dept = currentDept();
    var team = currentTeam();
    var pool = EMPLOYEES.filter(function (e) { return e.track === 'Manager'; });
    if (dept) {
      var byDept = pool.filter(function (e) { return e.department === dept; });
      if (team) {
        var byTeam = byDept.filter(function (e) { return e.team === team; });
        if (byTeam.length) return byTeam;
      }
      if (byDept.length) return byDept;
    }
    return pool;
  }

  function teamCandidates() {
    var dept = currentDept();
    var team = currentTeam();
    if (dept && team) {
      var byTeam = EMPLOYEES.filter(function (e) { return e.department === dept && e.team === team; });
      if (byTeam.length) return byTeam;
    }
    if (dept) {
      var byDept = EMPLOYEES.filter(function (e) { return e.department === dept; });
      if (byDept.length) return byDept;
    }
    return EMPLOYEES;
  }

  function mentorCandidates() {
    var pool = teamCandidates().slice();
    var managerEmail = fldManager.value;
    if (managerEmail) {
      var already = pool.some(function (p) { return p.email === managerEmail; });
      if (!already) {
        var mgr = EMPLOYEES.filter(function (e) { return e.email === managerEmail; });
        pool = pool.concat(mgr);
      }
    }
    return pool;
  }

  function setEmployeeOptions(select, list, opts) {
    opts = opts || {};
    var previous = select.value;
    select.innerHTML = '';
    if (opts.placeholder) select.appendChild(opt('', opts.placeholder));
    list.forEach(function (e) { select.appendChild(opt(e.email, e.full_name + ' - ' + e.job_title)); });
    if (opts.other) select.appendChild(opt(OTHER, 'Other'));
    if (list.some(function (e) { return e.email === previous; }) || (opts.other && previous === OTHER)) {
      select.value = previous;
    }
  }

  function refreshManager() {
    setEmployeeOptions(fldManager, managerCandidates(), { placeholder: 'Select a manager' });
  }
  function refreshBuddy() {
    setEmployeeOptions(fldBuddy, teamCandidates(), { placeholder: 'None', other: true });
  }
  function refreshMentor() {
    setEmployeeOptions(fldMentor, mentorCandidates(), { placeholder: 'Select a mentor' });
  }
  function refreshMentor2() {
    setEmployeeOptions(fldMentor2, EMPLOYEES, { placeholder: 'None' });
  }

  function toggleOther(select, wrap) {
    wrap.classList.toggle('visible', select.value === OTHER);
  }

  fldDepartment.addEventListener('change', function () {
    refreshTeams();
    refreshRoles();
    toggleOther(fldRole, fldRoleOtherWrap);
    refreshManager();
    refreshBuddy();
    refreshMentor();
  });
  fldTeam.addEventListener('change', function () {
    refreshManager();
    refreshBuddy();
    refreshMentor();
  });
  fldRole.addEventListener('change', function () { toggleOther(fldRole, fldRoleOtherWrap); });
  fldBuddy.addEventListener('change', function () { toggleOther(fldBuddy, fldBuddyOtherWrap); });
  fldManager.addEventListener('change', refreshMentor);

  // Auto-fills the company email from the name as "firstname.lastname@veridian.ai"
  // (lowercase, non-letters stripped) - stops the moment the visitor types into the
  // email field themselves, so a manual edit is never silently overwritten.
  var emailTouched = false;
  fldEmail.addEventListener('input', function () { emailTouched = true; });
  function normalizeToken(s) { return s.toLowerCase().replace(/[^a-z]/g, ''); }
  fldName.addEventListener('input', function () {
    if (emailTouched) return;
    var parts = fldName.value.trim().split(/\\s+/).filter(Boolean);
    if (parts.length < 2) return;
    var first = normalizeToken(parts[0]);
    var last = normalizeToken(parts[parts.length - 1]);
    if (first && last) fldEmail.value = first + '.' + last + '@veridian.ai';
  });

  refreshDepartments();
  refreshTeams();
  refreshRoles();
  refreshManager();
  refreshBuddy();
  refreshMentor();
  refreshMentor2();

  function showError(message) {
    errorBanner.textContent = message;
    errorBanner.hidden = false;
  }

  document.getElementById('intakeForm').addEventListener('submit', function (e) {
    e.preventDefault();
    errorBanner.hidden = true;

    var payload = {
      name: fldName.value.trim(),
      email: fldEmail.value.trim(),
      department: fldDepartment.value,
      team: fldTeam.value,
      role: fldRole.value,
      roleOther: fldRoleOther.value.trim(),
      managerEmail: fldManager.value,
      startDate: fldStartDate.value,
      buddy: fldBuddy.value,
      buddyOther: fldBuddyOther.value.trim(),
      mentorEmail: fldMentor.value,
      secondaryMentorEmail: fldMentor2.value,
      jobPostingText: fldJd.value.trim(),
    };

    if (!payload.managerEmail) { showError('Please select a direct manager.'); return; }
    if (!payload.mentorEmail) { showError('Please select a mentor.'); return; }

    loadingOverlay.hidden = false;
    submitBtn.disabled = true;

    fetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (result) {
        if (result.ok && result.data.planId) {
          window.location.href = '/plan/' + result.data.planId;
          return;
        }
        loadingOverlay.hidden = true;
        submitBtn.disabled = false;
        showError((result.data && result.data.error) || 'Something went wrong.');
      })
      .catch(function (err) {
        loadingOverlay.hidden = true;
        submitBtn.disabled = false;
        showError(err.message);
      });
  });
})();
</script>
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
  const nameEmailMap = buildNameEmailMap(db);
  res.send(renderPlanPage(plan, context, activeWeek, req.query.error, nameEmailMap));
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

app.get('/start', (req, res) => {
  const referenceData = buildIntakeReferenceData(db);
  res.send(renderStartPage(referenceData, companyName));
});

// Creates the employee, saves the manager's intake answers, then runs the full
// pipeline (Context Layer -> Content Expert -> Process Expert -> validate -> Content
// Writer -> Gatekeeper -> save) and returns the new plan_id. No support for creating a
// new manager - managerEmail must already match a real employee (createEmployee
// enforces this and throws a clear error otherwise, same as it always has for the CLI/
// script callers). Department and Team are real organizational fact for the same
// reason - the form only offers real teams/departments (no "Other"), so these always
// match an existing teams row here. Role/title is the one field that tolerates a
// no-catalog-match "Other" (createEmployee already degrades that to a GAP, not a
// failure), and buddy tolerates its own free-text "Other" (stored as-is, resolved
// loosely by the orchestrator).
app.post('/start', async (req, res) => {
  const body = req.body || {};
  try {
    const department = body.department;
    const team = body.team;
    const title = body.role === '__other__' ? String(body.roleOther || '').trim() : body.role;
    const buddyEmail = body.buddy === '__other__' ? String(body.buddyOther || '').trim() || null : body.buddy || null;

    if (!department || !team || !title) {
      return res.status(400).json({ error: 'Department, team, and role/title are all required.' });
    }
    if (!body.managerEmail) {
      return res.status(400).json({ error: 'Please select a direct manager.' });
    }
    if (!body.mentorEmail) {
      return res.status(400).json({ error: 'Please select a mentor.' });
    }

    // office isn't a form field - derived from the selected team's real primary_office
    // (falling back to the manager's own location, defensively, if that lookup ever
    // came up empty). Both are real, already-known facts about where this hire will
    // actually sit; there was no need to ask the visitor something the org data already
    // answers.
    const teamRow = db.prepare('SELECT * FROM teams WHERE team = ? AND department = ?').get(team, department);
    const managerRow = db.prepare('SELECT * FROM employees WHERE email = ?').get(body.managerEmail);
    const office = (teamRow && teamRow.primary_office) || (managerRow && managerRow.location) || null;
    if (!office) {
      return res.status(400).json({
        error: 'Could not determine an office for this hire - no matching team on record and no manager location to fall back on.',
      });
    }

    const { employee } = createEmployee(db, {
      name: body.name,
      email: body.email,
      title,
      department,
      team,
      managerEmail: body.managerEmail,
      office,
      startDate: body.startDate,
    });

    saveManagerIntake(db, employee.employee_id, {
      primaryMentorEmail: body.mentorEmail,
      secondaryMentorEmail: body.secondaryMentorEmail || null,
      buddyEmail,
      jobPostingText: body.jobPostingText || null,
    });

    const result = await runOrchestrator(db, employee.employee_id, {
      buddyEmail,
      mentorEmail: body.mentorEmail,
      jobPostingText: body.jobPostingText || null,
    });

    if (result.status === 'blocked') {
      return res.status(422).json({
        error: `${employee.full_name}'s employee record and manager intake were saved, but the Gatekeeper blocked this plan from being saved - see server logs for the blocking issue(s).`,
      });
    }

    res.json({ planId: result.planId });
  } catch (err) {
    console.error('POST /start failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Onboarding dashboard running at http://localhost:${PORT}/plan/2`);
});
