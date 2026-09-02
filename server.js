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
const { getPlan, toggleItemStatus, approvePlan, saveManagerIntake, deleteOrphanedEmployee } = require('./lib/persistence');
const { buildEmployeeContext } = require('./lib/context');
const { createEmployee } = require('./lib/employees');
const { runOrchestrator } = require('./lib/orchestrator');
const { runMilo } = require('./lib/milo-agent');

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
  // Placed last, after day-hint/mail/edit - combined with .facilitator's flex-basis:
  // 100% (see CSS), this guarantees the "who" text always lands on its own line below
  // the title/day-hint/icons row, whether or not it's even present. Omitted entirely
  // (not an empty span) when there's genuinely no "who" to show - systems_access items
  // have an intentionally empty facilitatorDisplayName (see prompts/content-writer.md),
  // and an empty span here would still claim a blank line via flex-basis: 100%.
  const facilitatorSpan = item.facilitatorDisplayName
    ? `<span class="facilitator">${escapeHtml(item.facilitatorDisplayName)}</span>`
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
          <span class="day-hint">${escapeHtml(item.dayHint)}</span>
          ${mailBtn}
          ${editBtn}
          ${facilitatorSpan}
        </summary>
        <p class="detail-text">${escapeHtml(item.detailText)}</p>
      </details>
    </li>
  `;
}

// systems_access items are a stateless checklist ("confirm your access works"), not
// scheduled content - always rendered after everything else in a week's card,
// regardless of what order Process Expert happened to emit them in. Enforced here at
// render time (a stable sort, not a prompt instruction) since ordering is a
// structural/positional guarantee - the same reasoning this project already applies to
// hasExecutiveMember/resolveOfficeTourGuide (see MEMORY.md) - not something left for
// the model to reliably reproduce on every generation. Array.prototype.sort is stable
// in Node, so every other track keeps its original relative order.
function sortSystemsAccessLast(items) {
  return [...items].sort((a, b) => (a.track === 'systems_access' ? 1 : 0) - (b.track === 'systems_access' ? 1 : 0));
}

function renderWeekCard(planId, week, trackStyles, dateRangeLabel, activeWeek, nameEmailMap) {
  const sortedItems = sortSystemsAccessLast(week.items);
  const items = sortedItems.length
    ? sortedItems.map((item) => renderItem(planId, item, trackStyles, activeWeek, nameEmailMap)).join('')
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
      <div class="carousel-nav">
        <button type="button" class="arrow arrow-prev" id="prevBtn" aria-label="Previous week">&#8249;</button>
        <button type="button" class="arrow arrow-next" id="nextBtn" aria-label="Next week">&#8250;</button>
      </div>
      <div class="carousel-track" id="track">${cards}</div>
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
      var trackEl = document.getElementById('track');

      // Below 767px, the 3D perspective/partial-opacity neighbor effect is dropped
      // entirely (it does not work well under touch) - only the active card is shown,
      // full width, everything else fully hidden. matchMedia is re-checked on every
      // position() call (not cached once) so rotating a device or resizing the window
      // re-evaluates it live, same as the resize listener below does.
      function position() {
        var isMobile = window.matchMedia('(max-width: 767px)').matches;
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
          } else if (isMobile) {
            card.classList.add('is-far');
            card.style.transform = 'translateX(-50%)';
            card.style.opacity = '0';
            card.style.zIndex = '1';
            card.style.pointerEvents = 'none';
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

      // Swipe (touch) on the card itself - swipe left = next week, swipe right =
      // previous week, the same feed gesture Instagram/TikTok already trained everyone
      // on. Additive, not a replacement for the arrows above (still there for anyone who
      // doesn't try swiping). SWIPE_MIN_DISTANCE is a horizontal-distance threshold, not
      // a velocity/timing one - deliberately simple for a demo. Requiring
      // dx to exceed dy (not just dx > SWIPE_MIN_DISTANCE alone) is what keeps an
      // ordinary vertical scroll of the items list from ever getting misread as a swipe.
      var touchStartX = 0;
      var touchStartY = 0;
      var touchDeltaX = 0;
      var touchTracking = false;
      var SWIPE_MIN_DISTANCE = 50;

      trackEl.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchDeltaX = 0;
        touchTracking = true;
      }, { passive: true });

      trackEl.addEventListener('touchmove', function (e) {
        if (!touchTracking || e.touches.length !== 1) return;
        var dx = e.touches[0].clientX - touchStartX;
        var dy = e.touches[0].clientY - touchStartY;
        touchDeltaX = dx;
        // Once the gesture is clearly horizontal, stop the page from also trying to
        // scroll vertically underneath the swipe - a passive listener can't call
        // preventDefault (it would just be silently ignored), which is why this one
        // listener is explicitly { passive: false } while the other two stay passive.
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
          e.preventDefault();
        }
      }, { passive: false });

      function endSwipe() {
        if (!touchTracking) return;
        touchTracking = false;
        if (Math.abs(touchDeltaX) < SWIPE_MIN_DISTANCE) return;
        if (touchDeltaX < 0) {
          setActive(active + 1);
        } else {
          setActive(active - 1);
        }
      }
      trackEl.addEventListener('touchend', endSwipe, { passive: true });
      trackEl.addEventListener('touchcancel', function () { touchTracking = false; }, { passive: true });

      window.addEventListener('resize', position);

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

  /* Milo chat - the dashboard's own design language (dark, Inter, accent gradient),
     deliberately NOT the compose window's light Gmail pastiche above - Milo is this
     product's own assistant, not a mock of a different app. Bottom-LEFT specifically so
     it never has to fight the compose window (bottom-right) for the same corner. */
  .milo-bubble {
    position: fixed; left: 24px; bottom: 24px; width: 56px; height: 56px;
    border-radius: 16px; border: none; cursor: pointer; z-index: 250; padding: 0;
    background: transparent;
    display: flex; align-items: center; justify-content: center;
    animation: milo-glow 2.6s ease-in-out infinite;
    transition: transform .15s ease;
    /* Real touch devices (not synthetic TouchEvents, which never trigger this) show a
       default gray tap-highlight overlay on tap, sized to the button's full rectangular
       hit-box - not the narrower/irregular speech-bubble SVG inside it. Invisible on a
       plain circle where the visible content filled the whole box, but on the current
       shape it reads as a dark square container flashing behind the bubble. */
    -webkit-tap-highlight-color: transparent;
  }
  /* The gradient + shape both live in the SVG now (a speech bubble, not a plain circle
     with a letter in it - an immediate "this is a chat" signal a circular avatar-style
     button doesn't give) - this just makes sure the SVG fills its button exactly. */
  .milo-bubble svg { display: block; width: 100%; height: 100%; }
  .milo-bubble:hover { transform: translateY(-2px) scale(1.05); }
  .milo-bubble[hidden] { display: none; }
  /* drop-shadow (not box-shadow) deliberately - box-shadow follows the button's own
     border-radius (a rounded square), not the actual bubble+tail SVG silhouette inside
     it. That was invisible on the old circular icon (border-radius:50% made the glow a
     circle matching the circle exactly) but became a visible mismatch once the icon
     became an irregular shape narrower than its own box - the square glow extended past
     the bubble's real edges and read as a static square frame around it, always
     present since the animation runs continuously. drop-shadow shapes itself from the
     rendered alpha (the real bubble silhouette), so it now hugs the actual shape. */
  @keyframes milo-glow {
    0%, 100% { filter: drop-shadow(0 4px 10px rgba(99,102,241,0.5)); }
    50% { filter: drop-shadow(0 4px 14px rgba(99,102,241,0.7)); }
  }

  .milo-window {
    position: fixed; left: 24px; bottom: 24px; width: 380px; max-width: calc(100vw - 32px);
    height: 520px; max-height: calc(100vh - 48px);
    background: var(--bg-card); border-radius: 16px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0,0,0,0.55), 0 2px 0 rgba(255,255,255,0.04) inset;
    border: 1px solid var(--hairline);
    z-index: 300; display: flex; flex-direction: column;
    transform: translateY(16px) scale(0.97); opacity: 0; pointer-events: none;
    transition: transform .2s cubic-bezier(.2,.8,.2,1), opacity .18s ease;
  }
  .milo-window[hidden] { display: none; }
  .milo-window.visible { transform: translateY(0) scale(1); opacity: 1; pointer-events: auto; }

  .milo-header {
    flex: none; padding: 0.9rem 1rem; display: flex; align-items: center; gap: 0.65rem;
    background: var(--bg-elevated); border-bottom: 1px solid var(--hairline);
  }
  .milo-avatar {
    width: 32px; height: 32px; border-radius: 50%; flex: none;
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; color: #fff; font-size: 0.9rem;
  }
  .milo-header-text { flex: 1; min-width: 0; }
  .milo-header-name { font-weight: 700; font-size: 0.95rem; }
  .milo-header-status { font-size: 0.74rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.35rem; }
  .milo-status-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px #4ade80; flex: none; }
  .milo-close {
    background: transparent; border: none; color: var(--text-muted); cursor: pointer;
    font-size: 1.1rem; line-height: 1; padding: 0.2rem 0.5rem; border-radius: 6px; font-family: inherit;
  }
  .milo-close:hover { color: var(--text-primary); background: rgba(255,255,255,0.08); }

  .milo-messages { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .milo-msg { max-width: 84%; padding: 0.55rem 0.75rem; border-radius: 12px; font-size: 0.87rem; line-height: 1.45; white-space: pre-wrap; }
  .milo-msg.milo { align-self: flex-start; background: var(--bg-card-hover); color: var(--text-primary); border-bottom-left-radius: 3px; }
  .milo-msg.user { align-self: flex-end; background: linear-gradient(135deg, var(--accent-1), var(--accent-2)); color: #fff; border-bottom-right-radius: 3px; }
  .milo-msg.typing { color: var(--text-muted); font-style: italic; }

  .milo-input-row { flex: none; padding: 0.75rem; border-top: 1px solid var(--hairline); display: flex; gap: 0.5rem; }
  .milo-input {
    flex: 1; background: var(--bg-card-hover); border: 1px solid var(--hairline); border-radius: 20px;
    padding: 0.5rem 0.9rem; color: var(--text-primary); font-family: inherit; font-size: 0.87rem; outline: none;
  }
  .milo-input:focus { border-color: var(--accent-1); }
  .milo-send {
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2)); color: #fff; border: none;
    border-radius: 50%; width: 38px; height: 38px; flex: none; cursor: pointer; font-size: 1rem;
    display: flex; align-items: center; justify-content: center; font-family: inherit;
    transition: transform .15s ease;
  }
  .milo-send:hover { transform: translateY(-1px); }
  .milo-send:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

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
  /* flex-basis: 100% forces this onto its own line inside the wrapping flex row
     unconditionally - not just when its text is too long to fit alongside the title, a
     short person's name used to sit inline with short-line while a long department name
     wrapped, an inconsistency that had nothing to do with what the text actually was. */
  .facilitator { color: var(--text-secondary); font-size: 0.83rem; flex-basis: 100%; }
  .day-hint { color: var(--text-muted); font-size: 0.78rem; margin-left: auto; }
  .detail-text { margin: 0 0.85rem 0.8rem; color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; }

  /* .carousel-nav wraps both arrow buttons purely so the mobile media query below can
     reflow them into one row above the card without touching the HTML - on desktop it's
     display:contents, meaning it has no box of its own at all, so .arrow-prev/.arrow-next
     position exactly as before (absolute, relative to .carousel-viewport, at the sides). */
  .carousel-nav { display: contents; }
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

  /* Mobile (2026-08-20): single breakpoint for every below-768px override on this page -
     see MEMORY.md for the full rationale per section. Sections below are independent of
     each other; each is scoped to its own class(es). */
  @media (max-width: 767px) {
    header { padding: 1.4rem 1.25rem 1.2rem; }
    main { padding: 1.5rem 1rem 0; }

    /* 1. Legend: a 2-column grid instead of a horizontal row that would otherwise wrap
       mid-line unpredictably depending on label length. */
    .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem 0.8rem; }

    /* 2. Carousel: one full-width card, no 3D/perspective/partial-opacity neighbors (see
       the isMobile branch in renderCarousel's inline script - this alone can't remove
       the effect, since the script sets transform/opacity as inline styles, which beat
       any stylesheet rule). Nav arrows move out of the absolutely-positioned sides
       (unusable as touch targets there, and they'd overlap card content) into a row
       above the card - .carousel-nav going from display:contents to a real flex row is
       what makes this reflow possible without touching the HTML. */
    .carousel-viewport { display: flex; flex-direction: column; align-items: center; height: auto; min-height: 0; max-height: none; perspective: none; }
    .carousel-nav { display: flex; justify-content: center; gap: 1rem; order: -1; margin-bottom: 0.9rem; }
    .arrow { position: static; top: auto; transform: none; }
    .carousel-track { position: relative; width: 100%; height: 60vh; min-height: 420px; max-height: 640px; flex: none; }
    .week-card { width: 100%; }
    .dots { margin-top: 1.1rem; }

    /* 4. Milo bubble: smaller, tucked closer to the corner. */
    .milo-bubble { width: 48px; height: 48px; left: 14px; bottom: 14px; }

    /* 5. Milo chat window: full screen. The animation drops the transform property
       entirely here (not just re-tuned) - a non-none transform on an ancestor becomes the containing
       block for any position:fixed descendant per the CSS spec, which would silently
       break .milo-input-row's fixed positioning below. Opacity alone still animates the
       open/close smoothly without that side effect. */
    .milo-window, .milo-window.visible { left: 0; right: 0; top: 0; bottom: 0; width: 100%; height: 100%; max-width: 100%; max-height: 100%; border-radius: 0; transform: none; }
    .milo-close { width: 44px; height: 44px; font-size: 1.6rem; }
    .milo-messages { padding-bottom: 84px; }
    /* Fixed (not absolute/in-flow) so the input stays pinned to the real viewport bottom
       rather than being pushed around by the on-screen keyboard resizing the layout. */
    .milo-input-row { position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg-card); padding-bottom: calc(0.75rem + env(safe-area-inset-bottom)); }

    /* 6. Compose (email) window: full screen, same reasoning as the Milo window above. */
    .compose-window { top: 0; bottom: 0; height: 100%; max-height: 100%; max-width: 100%; left: 0; right: 0; width: 100%; border-radius: 0; }
    .compose-header-icons button { width: 44px; height: 44px; font-size: 20px; }
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

<button type="button" class="milo-bubble" id="miloBubble" title="Chat with Milo" aria-label="Open Milo chat">
  <svg viewBox="0 0 56 56" aria-hidden="true">
    <defs>
      <linearGradient id="miloBubbleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color: var(--accent-1)"></stop>
        <stop offset="100%" style="stop-color: var(--accent-2)"></stop>
      </linearGradient>
    </defs>
    <path d="M4,22 A14,14 0 0 1 18,8 L38,8 A14,14 0 0 1 52,22 L52,34 L56,44 L44,40 L14,40 A14,14 0 0 1 4,26 Z" fill="url(#miloBubbleGrad)"></path>
    <text x="28" y="24" text-anchor="middle" dominant-baseline="central" font-size="21" font-weight="800" fill="#fff" font-family="inherit">M</text>
  </svg>
</button>
<div class="milo-window" id="miloWindow" hidden>
  <div class="milo-header">
    <div class="milo-avatar">M</div>
    <div class="milo-header-text">
      <div class="milo-header-name">Milo</div>
      <div class="milo-header-status"><span class="milo-status-dot"></span>Here to help</div>
    </div>
    <button type="button" class="milo-close" id="miloClose" aria-label="Close Milo chat">&times;</button>
  </div>
  <div class="milo-messages" id="miloMessages"></div>
  <div class="milo-input-row">
    <input type="text" class="milo-input" id="miloInput" placeholder="Ask Milo anything..." autocomplete="off">
    <button type="button" class="milo-send" id="miloSend" aria-label="Send message">&#10148;</button>
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

  // ---- Milo chat (real API calls, via POST /plan/:planId/milo -> lib/milo-agent.js) ----
  // Conversation history lives only in this array - client-side, in-memory, for the life
  // of this page view. No DB persistence, no localStorage: a refresh starts a fresh
  // conversation, same session-only convention as the item add/edit forms below. The
  // Messages API itself is stateless, so this whole array is re-sent to the server on
  // every single message - that's what makes Milo's "memory" real, not a server session.
  var PLAN_ID = ${plan.plan_id};
  var miloBubble = document.getElementById('miloBubble');
  var miloWindow = document.getElementById('miloWindow');
  var miloMessages = document.getElementById('miloMessages');
  var miloInput = document.getElementById('miloInput');
  var miloSend = document.getElementById('miloSend');
  var miloHistory = [];
  var miloOpened = false;
  var miloBusy = false;

  function appendMiloMessage(role, text) {
    var div = document.createElement('div');
    div.className = 'milo-msg ' + (role === 'user' ? 'user' : 'milo');
    div.textContent = text;
    miloMessages.appendChild(div);
    miloMessages.scrollTop = miloMessages.scrollHeight;
    return div;
  }

  function openMiloWindow() {
    miloWindow.hidden = false;
    // Force a reflow before adding the class, same trick as the compose window, so the
    // slide/fade transition actually plays instead of jumping straight to its end state.
    void miloWindow.offsetWidth;
    miloWindow.classList.add('visible');
    if (!miloOpened) {
      miloOpened = true;
      appendMiloMessage('milo', "Hi, I'm Milo - happy to help with anything about getting started. What's up?");
    }
    miloInput.focus();
  }

  function closeMiloWindow() {
    miloWindow.classList.remove('visible');
    setTimeout(function () { miloWindow.hidden = true; }, 200);
  }

  miloBubble.addEventListener('click', openMiloWindow);
  document.getElementById('miloClose').addEventListener('click', closeMiloWindow);

  function sendMiloMessage() {
    var text = miloInput.value.trim();
    if (!text || miloBusy) return;

    appendMiloMessage('user', text);
    miloHistory.push({ role: 'user', content: text });
    miloInput.value = '';
    miloBusy = true;
    miloSend.disabled = true;
    var typingEl = appendMiloMessage('milo', 'Milo is typing...');
    typingEl.classList.add('typing');

    fetch('/plan/' + PLAN_ID + '/milo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: miloHistory }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (result) {
        typingEl.remove();
        if (!result.ok) {
          appendMiloMessage('milo', "Sorry, something went wrong on my end" + (result.data && result.data.error ? ': ' + result.data.error : '.'));
          return;
        }
        appendMiloMessage('milo', result.data.reply);
        miloHistory.push({ role: 'assistant', content: result.data.reply });
      })
      .catch(function () {
        typingEl.remove();
        appendMiloMessage('milo', "Sorry, I couldn't reach the server just now - please try again.");
      })
      .finally(function () {
        miloBusy = false;
        miloSend.disabled = false;
        miloInput.focus();
      });
  }

  miloSend.addEventListener('click', sendMiloMessage);
  miloInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMiloMessage();
    }
  });

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
            '<span class="day-hint">' + escapeAttr(data.dayHint) + '</span>' +
            '<button type="button" class="icon-btn edit-btn" title="Edit (preview only)">&#9998;</button>' +
            '<span class="facilitator">' + escapeAttr(data.facilitator) + '</span>' +
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
// Teams the picker never offers, even though they're real: all 7 department-level
// "X Leadership" teams are track=Manager-only by construction - not a plausible team
// for a new IC hire to land on. This is independent of manager selection: Design's
// Sivan Kaplan and Product's Yuval Dayan both manage real ordinary teams (Product
// Design/UX Research; Product Ops & Research) while personally sitting in the very
// Leadership team hidden here - they still resolve correctly as those teams' managers
// because managerCandidates() below reads teams.manager_email (a fact about the real
// team), never this list or an employee's own team field.
const EXCLUDED_INTAKE_TEAMS = [
  'CS Leadership',
  'Design Leadership',
  'Engineering Leadership',
  'Marketing Leadership',
  'People Leadership',
  'Product Leadership',
  'Sales Leadership',
];

function buildIntakeReferenceData(db) {
  // realHeadcount is computed live from employees (excluding not-yet-started test
  // hires, same population EMPLOYEES below is filtered to) rather than trusted from
  // teams.headcount - self-correcting if the two ever drift, and is how a genuinely
  // empty team like "Finance & Operations Leadership" (0 real employees) gets hidden
  // from the picker automatically rather than needing its own special case.
  const allTeams = db
    .prepare(
      `SELECT t.team_id, t.department, t.team, t.primary_office, t.manager_email,
              (SELECT COUNT(*) FROM employees e
               WHERE e.department = t.department AND e.team = t.team AND e.employment_status != 'Pending Start') AS realHeadcount
       FROM teams t
       WHERE t.status = 'Active'
       ORDER BY t.department, t.team`
    )
    .all();
  const teams = allTeams
    .filter((t) => t.realHeadcount > 0 && !EXCLUDED_INTAKE_TEAMS.includes(t.team))
    .map((t) => ({ team_id: t.team_id, department: t.department, team: t.team, primary_office: t.primary_office, manager_email: t.manager_email }));
  const employees = db
    .prepare(
      "SELECT employee_id, full_name, job_title, department, team, track, email, location FROM employees WHERE employment_status != 'Pending Start' ORDER BY full_name"
    )
    .all();
  return { teams, employees };
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
  .intake-heading { margin: 0 0 0.7rem; font-weight: 800; letter-spacing: -0.01em; line-height: 1.28; }
  /* Deliberate two-line break, not responsive wrapping - line 1 sets up, line 2 (the
     actual ask) reads larger and more prominent. Both are block-level so the break
     happens at any viewport width, not just when the text runs out of room. */
  .intake-heading-line1 { display: block; font-size: 1.2rem; }
  .intake-heading-line2 { display: block; font-size: 1.9rem; }
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
  .field-input:disabled, select:disabled { opacity: 0.5; cursor: not-allowed; }
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
    align-items: center; justify-content: center; z-index: 200; gap: 0.6rem; padding: 2rem;
  }
  .loading-overlay[hidden] { display: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-heading { margin: 0; color: var(--text-muted); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
  /* "This usually takes a minute or two" - sets a real time expectation up front, right
     under the eyebrow, so the (real, measured) 30s-300s wait never reads as stuck. */
  .loading-eta { margin: 0 0 1.4rem; color: var(--text-secondary); font-size: 0.85rem; font-weight: 500; }

  /* Real-time progress steps, replacing a single generic spinner - one row per pipeline
     stage (see server.js's POST /start streaming + lib/orchestrator.js's onProgress).
     Same visual language as the rest of this page: muted-until-relevant text, the two
     brand accents for anything currently happening, no new colors introduced.
     Deliberately vertical only (top-to-bottom), never a horizontal variant - most real
     traffic to this form arrives from a phone (a LinkedIn link, not a desktop browser),
     and a vertical list already reads well at any width without needing a separate
     layout. Sized deliberately large (not a small incidental detail): ~45% bigger text
     and icons than an initial pass, since this is the only thing on screen for the
     entire wait and should read as the page's main content, not a footnote. */
  .progress-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1.8rem; width: 100%; max-width: 380px; }
  .progress-step { display: flex; align-items: center; gap: 1.1rem; font-size: 1.35rem; font-weight: 600; line-height: 1.3; color: var(--text-muted); }
  .progress-step-icon {
    flex: none; width: 32px; height: 32px; border-radius: 50%; border: 3px solid var(--hairline);
    display: flex; align-items: center; justify-content: center; position: relative;
  }
  /* min-width:0 overrides the flex item default (min-width:auto), which would otherwise
     refuse to let this long label wrap below its own unwrapped content width - on a
     narrow screen that's exactly what causes a flex row to quietly force the whole page
     wider than the viewport instead of just wrapping to a second line. */
  .progress-step-label { min-width: 0; }
  /* Pending (default): empty ring, nothing else. */
  /* Active: same ring, spun as a lightweight loading indicator - no separate spinner
     element needed, the step's own icon doubles as one. */
  .progress-step--active .progress-step-icon { border-color: var(--accent-1); border-top-color: transparent; animation: spin 0.8s linear infinite; }
  .progress-step--active .progress-step-label { color: var(--text-primary); }
  /* Done: filled accent circle + checkmark, replacing the ring entirely. */
  .progress-step--done .progress-step-icon { border-color: var(--accent-1); background: var(--accent-1); animation: none; }
  .progress-step--done .progress-step-icon::after { content: '\\2713'; color: #fff; font-size: 1.05rem; font-weight: 700; line-height: 1; }
  .progress-step--done .progress-step-label { color: var(--text-secondary); }
  /* Retrying: the active step's label swaps to a generic "just a moment" line - never
     the word "error", never which stage glitched (see the onRetry/emitRetry comment in
     lib/orchestrator.js) - the ring keeps spinning underneath exactly as before. */
  .progress-step--retrying .progress-step-label { color: var(--accent-2); }
  @media (max-width: 767px) {
    /* 16px is the iOS Safari threshold - anything smaller on a focused input triggers
       an automatic zoom-in on focus that most users then have to manually zoom back out
       of. .field-input already covers every text/email/date input and every <select>
       (see the selector list above); textarea is included in that same rule already. */
    .field-input, select, textarea { font-size: 16px; }
    .progress-steps { max-width: 100%; }
  }
</style>
</head>
<body>
<div class="intake-wrap">
  <p class="eyebrow">New Hire Intake · ${escapeHtml(brandLabel)}</p>
  <h1 class="intake-heading"><span class="intake-heading-line1">Your new teammate is starting soon.</span><span class="intake-heading-line2">Let's build their first two months.</span></h1>
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
      </div>
      <div class="field-group">
        <label class="field-label" for="fldMentor">Mentor<span class="required-dot" title="Required"></span></label>
        <p class="field-hint">Who'll walk them through the professional side of the role</p>
        <select class="field-input" id="fldMentor" required></select>
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
  <p class="loading-heading">Building the plan</p>
  <p class="loading-eta">This usually takes a minute or two</p>
  <ol class="progress-steps" id="progressSteps">
    <li class="progress-step" data-stage="content-expert"><span class="progress-step-icon"></span><span class="progress-step-label"></span></li>
    <li class="progress-step" data-stage="process-expert"><span class="progress-step-icon"></span><span class="progress-step-label"></span></li>
    <li class="progress-step" data-stage="content-writer"><span class="progress-step-icon"></span><span class="progress-step-label"></span></li>
    <li class="progress-step" data-stage="gatekeeper"><span class="progress-step-icon"></span><span class="progress-step-label"></span></li>
  </ol>
</div>

<script>
(function () {
  var TEAMS = ${JSON.stringify(referenceData.teams)};
  var EMPLOYEES = ${JSON.stringify(referenceData.employees)};
  var OTHER = '__other__';

  // Display-only mapping for the Department dropdown - real employees.department/
  // teams.department values are never changed by this; it only controls what shows in
  // this <select> and which real department(s) its Team options are pulled from.
  // "Executive" is deliberately absent (not offered at all, real data untouched).
  // "Engineering" shows as "R&D" - a straight relabel, still exactly one real
  // department. "Product" is a genuine composite - selecting it pulls teams from BOTH
  // the real "Product" and "Design" departments (grouped by optgroup below), and
  // "Design" never appears as its own top-level option. Whichever real department a
  // selected TEAM actually belongs to (see realDeptOfSelectedTeam below) is what
  // ultimately gets submitted - this list only ever drives what's shown, never what's
  // saved.
  var DEPARTMENT_DISPLAY = [
    { display: 'Customer Success & Support', match: ['Customer Success & Support'] },
    { display: 'R&D', match: ['Engineering'] },
    { display: 'Product', match: ['Product', 'Design'] },
    { display: 'Finance & Operations', match: ['Finance & Operations'] },
    { display: 'Marketing', match: ['Marketing'] },
    { display: 'People', match: ['People'] },
    { display: 'Sales', match: ['Sales'] },
  ];

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
  var fldMentor = document.getElementById('fldMentor');
  var fldJd = document.getElementById('fldJd');
  var errorBanner = document.getElementById('errorBanner');
  var loadingOverlay = document.getElementById('loadingOverlay');
  var progressStepsEl = document.getElementById('progressSteps');
  var submitBtn = document.getElementById('submitBtn');

  // Mirrors lib/orchestrator.js's real pipeline stages, in order, each with the
  // approximate cumulative number of seconds it takes to reach that stage's
  // completion (from real, measured baseline timings - Content Expert ~15s, +Process
  // Expert ~38s, +Content Writer ~38s, +Gatekeeper ~5s). Time-based, not event-based
  // (2026-08-31, see MEMORY.md): this used to advance from real server-sent progress
  // events over a long-lived streamed response, but that connection was found to die
  // silently around the ~100s mark on the live deployment - now the server responds to
  // POST /start immediately and this is a client-side ESTIMATE of progress while the
  // client polls GET /employee/:employeeId/plan-status for the real outcome (see the
  // submit handler below). An estimate can be wrong in either direction - a retry on
  // any stage means real progress is slower than this - but a moving, proportional
  // indicator beats a blind wait, and once elapsed time passes the last threshold the
  // active step switches to RETRY_LABEL rather than looking stuck (see
  // renderProgressSteps).
  var PROGRESS_STAGES = [
    { stage: 'content-expert', label: 'Understanding the role...', cumulativeSeconds: 15 },
    { stage: 'process-expert', label: 'Structuring the timeline...', cumulativeSeconds: 53 },
    { stage: 'content-writer', label: 'Drafting the plan...', cumulativeSeconds: 91 },
    { stage: 'gatekeeper', label: 'Reviewing for quality...', cumulativeSeconds: 96 },
  ];
  var RETRY_LABEL = 'Just a moment, refining a few details...';

  // Small explicit state machine instead of incremental class-toggling - doneStages is
  // recomputed from elapsed time on every tick (see startProgressSimulation below),
  // retrying flips on once elapsed time passes the last threshold, and every row is
  // fully re-rendered from this state each time, so there's exactly one source of
  // truth for what the UI should look like at any point.
  var progressState = { doneStages: [], retrying: false };

  function renderProgressSteps() {
    var activeIndex = progressState.doneStages.length;
    PROGRESS_STAGES.forEach(function (step, index) {
      var li = progressStepsEl.querySelector('[data-stage="' + step.stage + '"]');
      var label = li.querySelector('.progress-step-label');
      var isDone = progressState.doneStages.indexOf(step.stage) !== -1;
      var isActive = !isDone && index === activeIndex;
      li.classList.toggle('progress-step--done', isDone);
      li.classList.toggle('progress-step--active', isActive);
      li.classList.toggle('progress-step--retrying', isActive && progressState.retrying);
      label.textContent = isActive && progressState.retrying ? RETRY_LABEL : step.label;
    });
  }

  function resetProgressSteps() {
    progressState = { doneStages: [], retrying: false };
    renderProgressSteps();
  }

  function markAllStepsDone() {
    progressState = { doneStages: PROGRESS_STAGES.map(function (s) { return s.stage; }), retrying: false };
    renderProgressSteps();
  }

  // Drives progressState from elapsed time instead of real server events (see
  // PROGRESS_STAGES above for why) - ticks once a second, marks a stage "done" once
  // elapsed time passes its cumulativeSeconds threshold, and switches the active step
  // to RETRY_LABEL once elapsed time passes the last threshold with nothing found yet,
  // so a longer-than-usual run (a real retry on some stage) reads as "still working",
  // not stuck. Returns a stop function - call it the moment polling finds a real
  // outcome (success or failure), there's no reason to keep estimating past that.
  function startProgressSimulation() {
    var startTime = Date.now();
    var timer = setInterval(function () {
      var elapsedSeconds = (Date.now() - startTime) / 1000;
      var doneStages = [];
      PROGRESS_STAGES.forEach(function (step) {
        if (elapsedSeconds >= step.cumulativeSeconds) doneStages.push(step.stage);
      });
      var lastThreshold = PROGRESS_STAGES[PROGRESS_STAGES.length - 1].cumulativeSeconds;
      progressState = { doneStages: doneStages, retrying: elapsedSeconds >= lastThreshold };
      renderProgressSteps();
    }, 1000);
    return function stopProgressSimulation() {
      clearInterval(timer);
    };
  }

  function opt(value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  // A disabled option can still be the initially selected one - the browser shows
  // its label but won't let the user re-select it from the open dropdown once a real
  // option has been chosen. That's the whole mechanism: no extra JS needed to "lock out"
  // going back to the empty placeholder after a real value is picked.
  function placeholderOpt(label) {
    var o = document.createElement('option');
    o.value = '';
    o.textContent = label;
    o.disabled = true;
    o.selected = true;
    return o;
  }

  function currentDisplayDept() {
    return fldDepartment.value;
  }
  // The real department(s) the current display selection can pull teams/roles from -
  // ['Product', 'Design'] for the composite display option, exactly one real name for
  // every other (including "R&D" -> ['Engineering']).
  function currentMatchDepts() {
    var mapping = DEPARTMENT_DISPLAY.filter(function (d) { return d.display === currentDisplayDept(); })[0];
    return mapping ? mapping.match : [currentDisplayDept()];
  }
  // The one real department the SELECTED TEAM actually belongs to - this, not the
  // display value, is what's submitted to the server and what filters the Manager/
  // Buddy/Mentor pools, since those are real employee records with a single real
  // department each (an employee is never "Product or Design", only ever exactly one).
  function currentRealDept() {
    var teamRow = TEAMS.filter(function (t) { return t.team === fldTeam.value; })[0];
    return teamRow ? teamRow.department : null;
  }
  function currentTeam() {
    return fldTeam.value;
  }

  // Department and Team are real organizational fact, not something a demo visitor can
  // invent - createEmployee requires an exact match against teams/departments and throws
  // otherwise, so there's no "Other" option here (an offered-but-always-broken option
  // would be misleading). Role is different: an unmatched title degrades gracefully to
  // a documented GAP, not a failure, so "Other" stays there (see refreshRoles below).
  function refreshDepartments() {
    fldDepartment.innerHTML = '';
    fldDepartment.appendChild(placeholderOpt('Select department...'));
    DEPARTMENT_DISPLAY.forEach(function (d) { fldDepartment.appendChild(opt(d.display, d.display)); });
  }

  // Team and Role both key off Department, so both stay on their own empty placeholder
  // and disabled until a real department is picked - no department yet means no real
  // team/role list to filter down to.
  function refreshTeams() {
    fldTeam.innerHTML = '';
    if (!currentDisplayDept()) {
      fldTeam.appendChild(placeholderOpt('Select team...'));
      fldTeam.disabled = true;
      return;
    }
    fldTeam.disabled = false;
    var matchDepts = currentMatchDepts();
    var previous = fldTeam.value;
    fldTeam.appendChild(placeholderOpt('Select team...'));
    if (matchDepts.length > 1) {
      // Composite display department ("Product") - group by each real department so
      // it's visually clear a Design team is still Design, not secretly Product.
      matchDepts.forEach(function (realDept) {
        var items = TEAMS.filter(function (t) { return t.department === realDept; });
        if (!items.length) return;
        var group = document.createElement('optgroup');
        group.label = realDept;
        items.forEach(function (t) { group.appendChild(opt(t.team, t.team)); });
        fldTeam.appendChild(group);
      });
    } else {
      var flatItems = TEAMS.filter(function (t) { return t.department === matchDepts[0]; });
      flatItems.forEach(function (t) { fldTeam.appendChild(opt(t.team, t.team)); });
    }
    var allNames = TEAMS.filter(function (t) { return matchDepts.indexOf(t.department) !== -1; }).map(function (t) { return t.team; });
    if (allNames.indexOf(previous) !== -1) fldTeam.value = previous;
  }

  // Role options are the real, DISTINCT job titles actually held by employees on the
  // selected TEAM - not the department-level Roles catalog. The catalog has no team
  // field, only job_family at department granularity, so filtering by it let every
  // team in a department show the same full department-wide title list regardless of
  // which titles that specific team actually has. A short or empty list for a small/new
  // team is correct, not a bug - "Other (new role)" exists precisely for that case.
  function refreshRoles() {
    fldRole.innerHTML = '';
    var team = currentTeam();
    if (!team) {
      fldRole.appendChild(placeholderOpt('Select role...'));
      fldRole.disabled = true;
      return;
    }
    fldRole.disabled = false;
    var previous = fldRole.value;
    var titles = EMPLOYEES
      .filter(function (e) { return e.team === team && e.job_title; })
      .map(function (e) { return e.job_title; })
      .filter(function (title, idx, arr) { return arr.indexOf(title) === idx; })
      .sort();
    fldRole.appendChild(placeholderOpt('Select role...'));
    titles.forEach(function (title) { fldRole.appendChild(opt(title, title)); });
    fldRole.appendChild(opt(OTHER, 'Other (new role)'));
    if (titles.indexOf(previous) !== -1 || previous === OTHER) fldRole.value = previous;
  }

  // The team's manager is teams.manager_email - real "who manages this team" fact -
  // not "who is personally tagged with this team name" (an employee's own team
  // field, used below by teamCandidates for buddy/mentor pools, which is a different
  // question). A manager who oversees a team without personally sitting in it (e.g.
  // Sivan Kaplan manages Product Design and UX Research from Design Leadership; Yuval
  // Dayan manages Product Ops & Research from Product Leadership) would otherwise
  // never surface as that team's manager option - a real bug, not a hypothetical one,
  // since both cases exist in this dataset today.
  function managerCandidates() {
    var teamRow = TEAMS.filter(function (t) { return t.team === fldTeam.value; })[0];
    if (teamRow && teamRow.manager_email) {
      var mgr = EMPLOYEES.filter(function (e) { return e.email === teamRow.manager_email; });
      if (mgr.length) return mgr;
    }
    // Fallback only if the team's own manager_email is missing or doesn't resolve to
    // a real (non-"Pending Start") employee - any Manager-track person in the same
    // real department, rather than an empty dropdown.
    var dept = currentRealDept();
    return EMPLOYEES.filter(function (e) { return e.track === 'Manager' && e.department === dept; });
  }

  function teamCandidates() {
    var dept = currentRealDept();
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
    setEmployeeOptions(fldBuddy, teamCandidates(), { placeholder: 'None' });
  }
  function refreshMentor() {
    setEmployeeOptions(fldMentor, mentorCandidates(), { placeholder: 'Select a mentor' });
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
    refreshRoles();
    toggleOther(fldRole, fldRoleOtherWrap);
    refreshManager();
    refreshBuddy();
    refreshMentor();
  });
  fldRole.addEventListener('change', function () { toggleOther(fldRole, fldRoleOtherWrap); });
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
      department: currentRealDept(),
      team: fldTeam.value,
      role: fldRole.value,
      roleOther: fldRoleOther.value.trim(),
      managerEmail: fldManager.value,
      startDate: fldStartDate.value,
      buddy: fldBuddy.value,
      mentorEmail: fldMentor.value,
      jobPostingText: fldJd.value.trim(),
    };

    if (!payload.managerEmail) { showError('Please select a direct manager.'); return; }
    if (!payload.mentorEmail) { showError('Please select a mentor.'); return; }

    resetProgressSteps();
    loadingOverlay.hidden = false;
    submitBtn.disabled = true;

    var stopProgressSimulation = null;

    function fail(message) {
      if (stopProgressSimulation) stopProgressSimulation();
      loadingOverlay.hidden = true;
      submitBtn.disabled = false;
      showError(message || 'Something went wrong.');
    }

    // Polling is the only mechanism now (2026-08-31, see MEMORY.md) - POST /start
    // responds immediately with just { employeeId }, and the real pipeline runs fully
    // detached from that request server-side (see server.js's runBackgroundPipeline).
    // A long-lived streamed response was the original design here, with this same
    // polling endpoint only as a fallback for a dropped connection - promoted to the
    // only path after the streamed response was found to die silently around the
    // ~100s mark on the live deployment (confirmed with two independent HTTP clients,
    // unaffected by adding a periodic heartbeat write), well short of this pipeline's
    // real ~95-190s+ range once any stage's own retry logic kicks in.
    var POLL_INTERVAL_MS = 4000;
    var MAX_POLL_ATTEMPTS = 75; // ~5 minutes of checking before giving up

    function checkPlanStatus(employeeId, attempt) {
      fetch('/employee/' + encodeURIComponent(employeeId) + '/plan-status')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.hasPlan) {
            if (stopProgressSimulation) stopProgressSimulation();
            markAllStepsDone();
            window.location.href = '/plan/' + data.planId;
            return;
          }
          if (data.failed) {
            fail(data.error);
            return;
          }
          if (attempt >= MAX_POLL_ATTEMPTS) {
            fail('This is taking longer than expected. Safe to try again with the same details, or check back in a few minutes.');
            return;
          }
          setTimeout(function () { checkPlanStatus(employeeId, attempt + 1); }, POLL_INTERVAL_MS);
        })
        .catch(function () {
          // A failed status check is itself just a transient hiccup, not the answer -
          // keep polling on the same schedule rather than treating one failed check as
          // the final word.
          if (attempt >= MAX_POLL_ATTEMPTS) {
            fail('This is taking longer than expected. Safe to try again with the same details, or check back in a few minutes.');
            return;
          }
          setTimeout(function () { checkPlanStatus(employeeId, attempt + 1); }, POLL_INTERVAL_MS);
        });
    }

    fetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          if (!r.ok) throw new Error((data && data.error) || 'Something went wrong.');
          return data;
        });
      })
      .then(function (data) {
        stopProgressSimulation = startProgressSimulation();
        checkPlanStatus(data.employeeId, 1);
      })
      .catch(function (err) {
        fail(err.message);
      });
  });
})();
</script>
</body>
</html>`;
}

// Real visitors (a LinkedIn link, not a developer poking at the app) land here first -
// redirecting to someone else's existing plan as the entry screen never made sense for
// them; it was a leftover from early local testing, when /plan/2 was the fastest way to
// eyeball the dashboard. /start (the actual intake form) is the only sensible front door
// for a real visitor.
app.get('/', (req, res) => res.redirect('/start'));

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

// Milo's own conversation history lives client-side (see the milo-* script section in
// renderPlanPage) - this route is stateless per call, same as the Messages API itself:
// the client re-sends the full messages array every time, this just forwards it to
// lib/milo-agent.js's runMilo() (which rebuilds this one plan_id's safe context fresh on
// every call) and returns the real reply. No conversation state kept on the server.
app.post('/plan/:planId/milo', async (req, res) => {
  const planId = Number(req.params.planId);
  const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : null;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }
  try {
    const reply = await runMilo(planId, messages);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// In-memory only, by design (2026-08-31) - a demo-scale simplification, not meant to
// survive a process restart/redeploy (which wipes the whole DB anyway - see MEMORY.md,
// there's no persistent volume). Tracks ONLY pipeline failures the poll endpoint below
// needs to distinguish from "still working" - a successful run needs no entry here at
// all, since the endpoint already finds it directly via the `plans` table. Consumed
// (deleted) the first time a poll reads an entry, so this never grows unbounded in a
// long-running process.
const pipelineFailures = new Map();

// Runs the full pipeline detached from any HTTP request/response - see POST /start's
// own comment for why a long-lived streamed response was tried first and abandoned.
// Never throws outward; every outcome either leaves a real saved plan behind (found
// naturally by the poll endpoint below via the `plans` table) or records a failure in
// `pipelineFailures` for that same endpoint to report. Not awaited by its caller -
// deliberately fire-and-forget, so POST /start can respond immediately; this function
// has no reference to req/res anywhere in it, so it keeps running on the event loop
// exactly like any other in-flight async work in this process even if the connection
// that triggered it closes the instant POST /start responds.
async function runBackgroundPipeline(db, employeeId, employeeFullName, intakeInput) {
  let result;
  try {
    result = await runOrchestrator(db, employeeId, intakeInput);
  } catch (err) {
    console.error(`POST /start: pipeline failed for ${employeeId} after internal retries:`, err);
    const cleaned = deleteOrphanedEmployee(db, employeeId);
    console.warn(
      `POST /start: cleaned up ${employeeId} after a genuine pipeline failure - ` +
        (cleaned ? 'removed the orphaned employee/manager_intake rows.' : 'nothing to clean up (a plan must already exist).')
    );
    pipelineFailures.set(employeeId, {
      error: 'Something went wrong while building the onboarding plan. Please try again.',
    });
    return;
  }

  if (result.status === 'blocked') {
    // Deliberately NOT cleaned up (unlike the exception case above) - the employee
    // record and manager intake are left in place for HR/manager review, matching the
    // message below. Only a genuine pipeline exception (nothing useful produced at
    // all) triggers automatic cleanup.
    console.warn(`POST /start: Gatekeeper blocked the plan for ${employeeId} - employee/intake rows left in place for review.`);
    pipelineFailures.set(employeeId, {
      error: `${employeeFullName}'s employee record and manager intake were saved, but the Gatekeeper blocked this plan from being saved - see server logs for the blocking issue(s).`,
    });
    return;
  }

  console.log(`POST /start: pipeline succeeded for ${employeeId} - plan_id=${result.planId} saved.`);
}

// The client polls this from the moment POST /start responds (2026-08-31) - not a
// fallback for a dropped connection anymore, the only mechanism now that the pipeline
// runs fully detached from the request that triggered it (see runBackgroundPipeline
// above and POST /start's own comment for why). `failed` entries are consumed
// (deleted) on read - one report to the polling client is enough. Read-only, no auth
// (matches every other route on this single-view demo dashboard - see the file header
// comment).
app.get('/employee/:employeeId/plan-status', (req, res) => {
  const plan = db.prepare('SELECT plan_id FROM plans WHERE employee_id = ? ORDER BY plan_id DESC LIMIT 1').get(req.params.employeeId);
  if (plan) return res.json({ hasPlan: true, planId: plan.plan_id, failed: false });

  const failure = pipelineFailures.get(req.params.employeeId);
  if (failure) {
    pipelineFailures.delete(req.params.employeeId);
    return res.json({ hasPlan: false, failed: true, error: failure.error });
  }

  res.json({ hasPlan: false, failed: false });
});

// Creates the employee, saves the manager's intake answers, then runs the full
// pipeline (Context Layer -> Content Expert -> Process Expert -> validate -> Content
// Writer -> Gatekeeper -> save) and returns the new plan_id. No support for creating a
// new manager - managerEmail must already match a real employee (createEmployee
// enforces this and throws a clear error otherwise, same as it always has for the CLI/
// script callers). Department and Team are real organizational fact for the same
// reason - the form only offers real teams/departments (no "Other"), so these always
// match an existing teams row here. The Department dropdown's display labels ("R&D"
// for Engineering; a combined "Product" option covering both real Product and Design
// teams; "Executive" hidden entirely) are a client-side-only relabeling - see
// DEPARTMENT_DISPLAY in renderStartPage's script - the client always resolves and
// submits the real department the selected team actually belongs to, never the
// display label itself, so nothing here needs to know that mapping exists. Role/title
// is the one field that tolerates a
// no-catalog-match "Other" (createEmployee already degrades that to a GAP, not a
// failure) - Buddy no longer has an "Other" option (see MEMORY.md, 2026-08-30): it used
// to accept free text and pass it straight through as if it were an email, which
// silently failed to resolve against any real employee and vanished into an
// unrendered gap with zero feedback to whoever typed it. Same "always a real person,
// never invented" rule Department/Team already follow.
app.post('/start', async (req, res) => {
  const body = req.body || {};
  let employee;
  let buddyEmail;
  try {
    const department = body.department;
    const team = body.team;
    const title = body.role === '__other__' ? String(body.roleOther || '').trim() : body.role;
    buddyEmail = body.buddy || null;

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

    // A prior attempt for this same email that got interrupted (screen off, network
    // drop) before a plan was ever saved leaves a real employees/manager_intake row
    // behind with nothing to show for it - createEmployee's own duplicate-email check
    // would otherwise permanently block every future retry under that email. Checked
    // BEFORE calling createEmployee (rather than parsing its thrown error string) so
    // this is a plain, direct query, not string-matching. deleteOrphanedEmployee only
    // ever removes an employee who has no saved plan - a real duplicate person (a
    // second submission for someone genuinely already onboarded) still hits
    // createEmployee's normal blocking error below, unchanged.
    const existingByEmail = db.prepare('SELECT employee_id FROM employees WHERE email = ?').get(body.email);
    if (existingByEmail && deleteOrphanedEmployee(db, existingByEmail.employee_id)) {
      console.log(
        `POST /start: "${body.email}" matched a previous orphaned attempt (${existingByEmail.employee_id}, no plan ever saved) - removed it and retrying under the same email.`
      );
    }

    const created = createEmployee(db, {
      name: body.name,
      email: body.email,
      title,
      department,
      team,
      managerEmail: body.managerEmail,
      office,
      startDate: body.startDate,
    });
    employee = created.employee;

    saveManagerIntake(db, employee.employee_id, {
      primaryMentorEmail: body.mentorEmail,
      buddyEmail,
      jobPostingText: body.jobPostingText || null,
    });
  } catch (err) {
    console.error('POST /start failed:', err);
    return res.status(500).json({ error: err.message });
  }

  // The employee record and intake answers are saved - everything past this point is
  // the real pipeline run (30s-300s+ of real API latency, longer with retries). Responds
  // immediately instead of holding this connection open for the whole run.
  //
  // A long-lived streamed response (newline-delimited JSON progress events over
  // fetch()+ReadableStream) was the original design (2026-08-20) and survived several
  // rounds of fixes, including a periodic heartbeat write meant to keep the connection
  // alive during a long gap between real progress events. None of it held up against a
  // real, confirmed production issue (2026-08-31, see MEMORY.md): the connection to the
  // live Railway deployment died silently around the ~100s mark - confirmed with two
  // independent HTTP clients (Node fetch, curl), and unaffected by the heartbeat, which
  // means bytes genuinely weren't reaching the client even though they were being
  // written server-side. ~100s is well short of this pipeline's real range once any
  // stage's own retry logic kicks in (a documented ~13-20% per-attempt failure rate
  // across two real, sequential agent calls). The pipeline itself was never affected by
  // any of this - see runBackgroundPipeline below, it already doesn't depend on this
  // request/response for anything - only the client's real-time visibility into it was.
  //
  // Now: respond with just `{ employeeId }` and let the client poll GET
  // /employee/:employeeId/plan-status from the very start (see renderStartPage's client
  // script) - polling is the only mechanism now, not a fallback for a dropped stream.
  res.json({ employeeId: employee.employee_id });

  runBackgroundPipeline(db, employee.employee_id, employee.full_name, {
    buddyEmail,
    mentorEmail: body.mentorEmail,
    jobPostingText: body.jobPostingText || null,
  });
});

// Explicit 0.0.0.0 (not just relying on Node's own default-all-interfaces behavior when
// host is omitted) so this is a deliberate, visible choice - lets other devices on the
// same LAN (e.g. a real phone, for testing the mobile-responsive work against an actual
// touch screen and a real on-screen keyboard, not just Chrome DevTools' emulation) reach
// this dev server via the host machine's LAN IP, not just localhost/127.0.0.1.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Onboarding dashboard running at http://localhost:${PORT}/plan/2`);
  console.log(`Also reachable on the LAN at http://<this machine's IP>:${PORT}/plan/2`);
});
