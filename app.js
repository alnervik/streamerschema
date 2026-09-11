/* NHL-schema — statiskt fantasyverktyg. Ingen build, inga beroenden. */

const API = 'https://api-web.nhle.com/v1';
const $ = (sel) => document.querySelector(sel);

const state = {
  schedule: null,   // { season, updated, teams, games }
  weeks: [],        // [{ label, number, start, end }] — kommer från data/weeks.json
  pick: '0',        // index i weeks, 'season' eller 'custom'
  custom: { start: null, end: null },
  offMax: 6,
  minGp: 0,
  division: 'all',
  sort: { key: 'score', dir: -1 },
  pinned: new Set(),

  /* Fantasylagen. Ett lag per liga, var och en med egna platser och spelare. */
  rosters: [],      // [{ id, name, slots, players }]
  rosterId: null,   // id på det lag som visas
  range: { from: 0, to: 0 },  // index i weeks, inklusive båda ändar
};

/* Poängen väger ihop kolumnerna till ett tal: en match är värd 1, en match på
   en offnight lite mer, en match mot ett tröttkört lag lite mer, och en match
   dagen efter en annan match lite mindre. */
const WEIGHT = { game: 1, off: 0.25, tired: 0.15, b2b: -0.3 };
const scoreOf = (r) =>
  r.gp * WEIGHT.game + r.off * WEIGHT.off + r.tired * WEIGHT.tired + r.b2b * WEIGHT.b2b;

/* ── Datum, allt i UTC ──────────────────────────────────────── */
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toISO = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
};
const dayRange = (a, b) => {
  const out = [];
  for (let c = a; c <= b && out.length < 400; c = addDays(c, 1)) out.push(c);
  return out;
};

const fmtWeekday = new Intl.DateTimeFormat('sv-SE', { weekday: 'short', timeZone: 'UTC' });
const fmtLong = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortDate = (s) => {
  const d = toDate(s);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
};
const seasonLabel = (s) => `${s.slice(0, 4)}-${s.slice(6)}`;

/* ── Inläsning ──────────────────────────────────────────────── */
async function boot() {
  wire();
  let schedule = null;
  try {
    const res = await fetch('data/schedule.json', { cache: 'no-cache' });
    if (res.ok) schedule = await res.json();
  } catch { /* saknas eller file:// */ }

  if (!schedule) {
    show('empty');
    return;
  }

  let file = null;
  try {
    const res = await fetch('data/weeks.json', { cache: 'no-cache' });
    if (res.ok) file = await res.json();
  } catch { /* valfri */ }

  start(schedule, file?.weeks);
}

/* Veckorna kommer från data/weeks.json och är därmed samma för alla som
   öppnar sidan. Saknas filen faller vi tillbaka på mån–sön. */
function start(schedule, weeks) {
  state.schedule = schedule;
  state.weeks = weeks?.length
    ? weeks.map((w) => ({ ...w }))
    : defaultWeeks(schedule.games);

  $('#seasonLabel').textContent = seasonLabel(schedule.season);
  $('#stamp').textContent = schedule.updated
    ? `Uppdaterat ${new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(schedule.updated))}`
    : '';

  fillWeekPicker();
  fillDivisionPicker();
  state.pick = String(pickCurrentWeek());
  $('#weekPick').value = state.pick;

  loadRosters();
  const now = pickCurrentWeek();
  state.range = { from: now, to: now };
  fillRangePickers();
  fillTeamPicker();
  renderRosterPanels();

  show('schedule');
  render();
}

function pickCurrentWeek() {
  const today = toISO(new Date());
  const i = state.weeks.findIndex((w) => today >= w.start && today <= w.end);
  if (i >= 0) return i;
  const next = state.weeks.findIndex((w) => w.start > today);
  return next >= 0 ? next : 0;
}

/* ── Urval ──────────────────────────────────────────────────── */
function activeRange() {
  const regular = state.schedule.games.filter((g) => g.type === 2).map((g) => g.date).sort();
  if (state.pick === 'season') {
    return { start: regular[0], end: regular[regular.length - 1], label: 'Hela grundserien' };
  }
  if (state.pick === 'custom') {
    const start = state.custom.start ?? regular[0];
    const end = state.custom.end ?? start;
    return { start, end: end < start ? start : end, label: 'Eget intervall' };
  }
  const w = state.weeks[Number(state.pick)] ?? state.weeks[0];
  return { start: w.start, end: w.end, label: w.label };
}

function buildTable() {
  const { start, end, label } = activeRange();
  const days = dayRange(start, end);
  const inRange = new Set(days);

  const gamesByDay = new Map(days.map((d) => [d, []]));
  const playsOn = new Map(); // "TOR|2026-10-07" -> match

  for (const g of state.schedule.games) {
    if (g.type !== 2) continue;
    playsOn.set(`${g.home}|${g.date}`, g);
    playsOn.set(`${g.away}|${g.date}`, g);
    if (inRange.has(g.date)) gamesByDay.get(g.date).push(g);
  }

  // En dag utan matcher är ingen offnight — det finns inget att plocka upp.
  const offNight = new Map(days.map((d) => {
    const n = gamesByDay.get(d).length;
    return [d, n > 0 && n <= state.offMax];
  }));

  const rows = state.schedule.teams.map((team) => {
    let gp = 0, off = 0, b2b = 0, tired = 0;
    const cells = days.map((day) => {
      const g = playsOn.get(`${team.abbrev}|${day}`);
      if (!g) return null;
      const home = g.home === team.abbrev;
      const opp = home ? g.away : g.home;
      const isOff = offNight.get(day);
      const back = playsOn.has(`${team.abbrev}|${addDays(day, -1)}`);
      const oppBack = playsOn.has(`${opp}|${addDays(day, -1)}`);
      gp++;
      if (isOff) off++;
      if (back) b2b++;
      if (oppBack) tired++;
      return { home, opp, b2b: back, tired: oppBack, off: isOff };
    });
    const row = { team, cells, gp, off, b2b, tired };
    row.score = scoreOf(row);
    return row;
  });

  return { days, gamesByDay, offNight, rows, label, start, end };
}

/* ── Rendering ──────────────────────────────────────────────── */

/* Kolumnerna till vänster om rutnätet, i ordning. `heat` styr färgskalan:
   warm = mer är bättre (gult), cool = mer är sämre (blått). */
const STATS = [
  { key: 'score', label: 'Poäng', title: 'Matcher viktade med offnights, trötta motståndare och B2B', heat: 'warm', dec: 1 },
  { key: 'gp',    label: 'Matcher', title: 'Matcher i perioden', heat: 'warm' },
  { key: 'off',   label: 'Offnights', title: 'Matcher på offnights — de som är lättast att få in i laguppställningen', heat: 'warm' },
  { key: 'b2b',   label: 'B2B', title: 'Matcher laget spelar dagen efter en annan match', heat: 'cool' },
  { key: 'tired', label: 'Trötta', title: 'Matcher mot ett lag som spelade dagen innan', heat: 'warm' },
];

function render() {
  const t = buildTable();

  const visible = t.rows
    .filter((r) => r.gp >= state.minGp)
    .filter((r) => state.division === 'all' || r.team.division === state.division)
    .sort(compare);

  renderReadout(t, visible);
  renderHead(t);
  renderBody(t, visible);
  layoutFrozen();
  $('#clearPins').hidden = state.pinned.size === 0;
}

function compare(a, b) {
  const { key, dir } = state.sort;
  if (key === 'team') return a.team.abbrev.localeCompare(b.team.abbrev) * dir;
  const diff = (a[key] - b[key]) * dir;
  return diff || b.off - a.off || b.gp - a.gp || a.team.abbrev.localeCompare(b.team.abbrev);
}

/* Färgskalan sätts relativt urvalet, så den fungerar lika bra för en vecka
   som för hela grundserien. Nivå 0 = ingen färg. */
function ramp(values) {
  const used = values.filter((v) => v > 0);
  const max = Math.max(...used, 0);
  const min = Math.min(...used, max);
  return (v) => {
    if (!(v > 0)) return 0;
    if (max === min) return 3;
    return 1 + Math.round(3 * (v - min) / (max - min));
  };
}

function renderReadout(t, visible) {
  const total = t.days.reduce((n, d) => n + t.gamesByDay.get(d).length, 0);
  const offDays = t.days.filter((d) => t.offNight.get(d));
  const offText = offDays.length
    ? offDays.map((d) => `${fmtWeekday.format(toDate(d))} ${shortDate(d)} (${t.gamesByDay.get(d).length})`).join(', ')
    : 'inga';
  $('#readout').innerHTML =
    `<b>${t.label}</b> · ${fmtLong.format(toDate(t.start))} – ${fmtLong.format(toDate(t.end))} · `
    + `${t.days.length} ${t.days.length === 1 ? 'dag' : 'dagar'} · ${total} matcher · ${visible.length} lag i listan<br>`
    + `<b>${offDays.length}</b> offnights (≤ ${state.offMax} matcher): ${offText}`;
}

function renderHead(t) {
  const arrow = (key) => (state.sort.key === key ? ` <span class="arrow">${state.sort.dir < 0 ? '▼' : '▲'}</span>` : '');

  let frz = 0;
  const teamCol = `<th class="col-team frozen sortable" data-frz="${frz++}" data-sort="team">Lag${arrow('team')}</th>`;
  const statCols = STATS.map((s, i) =>
    `<th class="num frozen sortable${i === STATS.length - 1 ? ' frozen-last' : ''}" `
    + `data-frz="${frz++}" data-sort="${s.key}" title="${s.title}">${s.label}${arrow(s.key)}</th>`).join('');

  const dayCols = t.days.map((d) => {
    const n = t.gamesByDay.get(d).length;
    const cls = t.offNight.get(d) ? ' is-off' : '';
    return `<th class="col-day${cls}">`
      + `<span class="day-name">${fmtWeekday.format(toDate(d))}</span>`
      + `<span class="day-date">${shortDate(d)}</span>`
      + `<span class="day-load">${n}</span></th>`;
  }).join('');

  $('#gridHead').innerHTML = `<tr>${teamCol}${statCols}${dayCols}</tr>`;

  for (const th of $('#gridHead').querySelectorAll('.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'team' ? 1 : -1 };
      render();
    });
  }
}

function renderBody(t, visible) {
  const scales = Object.fromEntries(STATS.map((s) => [s.key, ramp(visible.map((r) => r[s.key]))]));

  $('#gridBody').innerHTML = visible.map((r) => {
    let frz = 0;
    const teamCol = `<td class="col-team frozen" data-frz="${frz++}">
        <button class="team-btn" data-team="${r.team.abbrev}">
          <span class="team-abv">${r.team.abbrev}</span>
          <span class="team-name">${r.team.name ?? ''}</span>
        </button>
      </td>`;

    const statCols = STATS.map((s, i) => {
      const v = r[s.key];
      const level = scales[s.key](v);
      const cls = `num frozen${i === STATS.length - 1 ? ' frozen-last' : ''} ${level ? `${s.heat}-${level}` : 'zero'}`;
      return `<td class="${cls}" data-frz="${frz++}">${s.dec ? v.toFixed(s.dec) : v}</td>`;
    }).join('');

    const dayCols = r.cells.map((c, i) => {
      if (!c) return '<td class="cell"></td>';
      const off = c.off ? ' is-off' : '';
      const cls = `chip ${c.home ? 'chip-home' : 'chip-away'}${c.b2b ? ' b2b' : ''}`;
      const text = c.home ? c.opp : `@${c.opp}`;
      const title = c.b2b ? ' title="Andra matchen på två dagar"' : '';
      const tired = c.tired ? '<span class="tired" title="Motståndaren spelade dagen innan">🥱</span>' : '';
      return `<td class="cell${off}"><span class="${cls}"${title}>${text}</span>${tired}</td>`;
    }).join('');

    return `<tr class="${state.pinned.has(r.team.abbrev) ? 'is-pinned' : ''}">${teamCol}${statCols}${dayCols}</tr>`;
  }).join('');

  for (const btn of $('#gridBody').querySelectorAll('.team-btn')) {
    btn.addEventListener('click', () => {
      const abv = btn.dataset.team;
      state.pinned.has(abv) ? state.pinned.delete(abv) : state.pinned.add(abv);
      render();
    });
  }
}

/* De frysta kolumnerna limmas fast till vänster. Bredderna varierar med
   innehåll och skärm, så offseten mäts efter varje rendering. */
function layoutFrozen(sel = '#grid') {
  const table = $(sel);
  if (!table || table.offsetParent === null) return;

  const heads = [...table.querySelectorAll('thead th.frozen')];
  if (!heads.length) return;

  let left = 0;
  const offsets = heads.map((th) => {
    const at = left;
    left += th.getBoundingClientRect().width;
    return at;
  });

  for (const cell of table.querySelectorAll('.frozen')) {
    cell.style.left = `${offsets[Number(cell.dataset.frz)] ?? 0}px`;
  }
}

/* ── Väljare ────────────────────────────────────────────────── */
function fillWeekPicker() {
  const opts = state.weeks.map((w, i) =>
    `<option value="${i}">${w.label} · ${fmtLong.format(toDate(w.start))} – ${fmtLong.format(toDate(w.end))}</option>`);
  $('#weekPick').innerHTML = opts.join('')
    + '<option value="season">Hela grundserien</option>'
    + '<option value="custom">Eget intervall…</option>';
}

function fillDivisionPicker() {
  const divs = [...new Set(state.schedule.teams.map((t) => t.division).filter(Boolean))].sort();
  $('#divPick').innerHTML = '<option value="all">Alla</option>'
    + divs.map((d) => `<option value="${d}">${d}</option>`).join('');
}

/* ── Reservveckor ───────────────────────────────────────────── */
/* Används bara när data/weeks.json saknas, t.ex. vid direkthämtning från
   API:t. Riktiga fantasyveckor redigeras i filen. */
function defaultWeeks(games) {
  const dates = games.filter((g) => g.type === 2).map((g) => g.date).sort();
  if (!dates.length) return [];
  const last = dates[dates.length - 1];
  const weeks = [];
  let start = dates[0];
  let n = 1;
  while (start <= last) {
    const toSunday = (7 - toDate(start).getUTCDay()) % 7;
    let end = addDays(start, toSunday);
    if (addDays(end, 1) > last) end = last;
    weeks.push({ label: `Vecka ${n}`, number: n, start, end });
    start = addDays(end, 1);
    n++;
  }
  return weeks;
}

/* ── Direkthämtning från NHL:s API ──────────────────────────── */
async function fetchLive() {
  const btn = $('#fetchLive');
  const err = $('#emptyErr');
  btn.disabled = true;
  err.textContent = '';
  try {
    const now = new Date();
    const y = now.getUTCFullYear();
    const season = now.getUTCMonth() >= 7 ? `${y}${y + 1}` : `${y - 1}${y}`;

    btn.textContent = 'Hämtar lag…';
    const st = await (await fetch(`${API}/standings/now`)).json();
    const teams = st.standings.map((t) => ({
      abbrev: t.teamAbbrev.default,
      name: t.teamName.default,
      conference: t.conferenceName,
      division: t.divisionName,
    })).sort((a, b) => a.abbrev.localeCompare(b.abbrev));

    const seen = new Map();
    let done = 0;
    await Promise.all(teams.map(async (team) => {
      const res = await fetch(`${API}/club-schedule-season/${team.abbrev}/${season}`);
      const data = await res.json();
      for (const g of data.games ?? []) {
        if (g.gameType !== 2 && g.gameType !== 3) continue;
        seen.set(g.id, {
          id: g.id, date: g.gameDate,
          home: g.homeTeam.abbrev, away: g.awayTeam.abbrev,
          type: g.gameType, start: g.startTimeUTC ?? null,
        });
      }
      btn.textContent = `Hämtar scheman… ${++done}/${teams.length}`;
    }));

    const games = [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!games.length) throw new Error('Inga matcher i svaret — schemat kanske inte är släppt än.');
    start({ season, updated: new Date().toISOString(), teams, games }, null);
  } catch (e) {
    err.textContent = `Hämtningen misslyckades: ${e.message}. Kör skriptet lokalt istället.`;
    btn.disabled = false;
    btn.textContent = 'Hämta från NHL:s API';
  }
}

/* ── Vyer och händelser ─────────────────────────────────────── */
function show(view) {
  for (const name of ['schedule', 'roster', 'empty']) {
    $(`#view-${name}`).hidden = name !== view;
  }
  $('#tabs').hidden = view === 'empty';
  for (const tab of $('#tabs').querySelectorAll('.tab')) {
    tab.classList.toggle('is-on', tab.dataset.view === view);
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  if (view === 'roster') renderLineup();
  if (view === 'schedule') layoutFrozen();
}

function wire() {
  $('#weekPick').addEventListener('change', (e) => {
    state.pick = e.target.value;
    const custom = state.pick === 'custom';
    for (const el of document.querySelectorAll('[data-custom]')) el.hidden = !custom;
    if (custom && !state.custom.start) {
      const r = activeRange();
      state.custom = { start: r.start, end: r.end };
      $('#fromDate').value = r.start;
      $('#toDate').value = r.end;
    }
    render();
  });

  $('#fromDate').addEventListener('change', (e) => { state.custom.start = e.target.value; render(); });
  $('#toDate').addEventListener('change', (e) => { state.custom.end = e.target.value; render(); });
  $('#offMax').addEventListener('change', (e) => { setOffMax(e.target.value); });
  $('#minGp').addEventListener('change', (e) => { state.minGp = Number(e.target.value) || 0; render(); });
  $('#divPick').addEventListener('change', (e) => { state.division = e.target.value; render(); });
  $('#clearPins').addEventListener('click', () => { state.pinned.clear(); render(); });

  $('#fetchLive').addEventListener('click', fetchLive);

  for (const tab of $('#tabs').querySelectorAll('.tab')) {
    tab.addEventListener('click', () => show(tab.dataset.view));
  }

  wireRoster();

  let resizing;
  window.addEventListener('resize', () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => { layoutFrozen(); layoutFrozen('#rgrid'); }, 100);
  });
}

/* Offnight-tröskeln är gemensam för båda vyerna — annars visar de olika dagar
   som offnights och man får två sanningar om samma vecka. */
function setOffMax(value) {
  state.offMax = Number(value) || 6;
  $('#offMax').value = state.offMax;
  $('#rOffMax').value = state.offMax;
  render();
  if (!$('#view-roster').hidden) renderLineup();
}

/* ══════════════════════════════════════════════════════════════
   Lediga platser — fyller uppställningen dag för dag och visar var
   det blir hål. Ett lag per fantasyliga, var och en med egna platser.
   ══════════════════════════════════════════════════════════════ */

const POS = ['C', 'LW', 'RW', 'D', 'G'];
const SKATERS = ['C', 'LW', 'RW', 'D'];
/* Startplatserna — de som ger poäng och som rutnätet fyller dag för dag. */
const SLOTS = ['C', 'LW', 'RW', 'D', 'UTIL', 'G'];
/* Bänken ger inga poäng, men spelarna finns kvar i laget hela veckan och kan
   ställas in vilken dag som helst. Den avgör hur stort laget får vara. */
const BENCH = 'BN';
const ALL_SLOTS = [...SLOTS, BENCH];
const DEFAULT_SLOTS = { C: 2, LW: 2, RW: 2, D: 4, UTIL: 1, G: 2, BN: 4 };
const STORE = 'nhl-schema.rosters.v1';
const MAX_ROSTERS = 40;
const MAX_PLAYERS = 60;

const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const blankRoster = (name) => ({ id: uid(), name, slots: { ...DEFAULT_SLOTS }, players: [] });
const activeRoster = () => state.rosters.find((r) => r.id === state.rosterId) ?? state.rosters[0];

/* Utan namn visas spelaren som positionen och laget — D-COL. */
const autoName = (p) => `${p.pos.join('/') || '?'}-${p.team || '?'}`;
const nameOf = (p) => p.name.trim() || autoName(p);

/* ── Lagring ────────────────────────────────────────────────── */
/* Allt ligger i webbläsaren. Går det inte att spara — privat läge, full
   kvot — fungerar appen ändå, den minns bara inte till nästa gång. */
function loadRosters() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) ?? 'null'); } catch { /* strunt samma */ }

  state.rosters = cleanRosters(saved?.rosters);
  if (!state.rosters.length) state.rosters = [blankRoster('Lag 1')];
  state.rosterId = state.rosters.some((r) => r.id === saved?.active)
    ? saved.active
    : state.rosters[0].id;
}

function saveRosters() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ active: state.rosterId, rosters: state.rosters }));
  } catch { /* se ovan */ }
}

/* Allt som läses in utifrån — lagring eller inklistrad text — tvättas mot
   det appen faktiskt kan rita: kända lagförkortningar och kända positioner. */
function cleanRosters(list) {
  if (!Array.isArray(list)) return [];
  const known = new Set(state.schedule.teams.map((t) => t.abbrev));
  const used = new Set();

  return list.slice(0, MAX_ROSTERS).filter(Boolean).map((r, i) => {
    const slots = { ...DEFAULT_SLOTS };
    for (const type of ALL_SLOTS) {
      const n = Number(r?.slots?.[type]);
      if (Number.isFinite(n)) slots[type] = Math.max(0, Math.min(12, Math.round(n)));
    }

    const players = (Array.isArray(r?.players) ? r.players : []).slice(0, MAX_PLAYERS).map((p) => ({
      id: uid(),
      name: String(p?.name ?? '').slice(0, 40),
      team: known.has(p?.team) ? p.team : '',
      pos: POS.filter((x) => (Array.isArray(p?.pos) ? p.pos : []).includes(x)),
    }));

    let id = typeof r?.id === 'string' && r.id && !used.has(r.id) ? r.id.slice(0, 24) : uid();
    used.add(id);

    return { id, name: String(r?.name ?? '').slice(0, 40).trim() || `Lag ${i + 1}`, slots, players };
  });
}

/* ── Väljare och paneler ────────────────────────────────────── */
function fillTeamPicker() {
  $('#teamPick').innerHTML = state.rosters
    .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  $('#teamPick').value = state.rosterId;
  $('#deleteRoster').disabled = state.rosters.length < 2;
}

function fillRangePickers() {
  const opts = state.weeks.map((w, i) =>
    `<option value="${i}">${esc(w.label)} · ${fmtLong.format(toDate(w.start))} – ${fmtLong.format(toDate(w.end))}</option>`).join('');
  for (const sel of ['#rFrom', '#rTo']) $(sel).innerHTML = opts;
  $('#rFrom').value = String(state.range.from);
  $('#rTo').value = String(state.range.to);
  $('#rOffMax').value = state.offMax;
}

function renderRosterPanels() {
  $('#rosterName').textContent = activeRoster().name;
  renderSlotFields();
  renderRosterTable();
}

function renderSlotFields() {
  const r = activeRoster();
  $('#slotFields').innerHTML = ALL_SLOTS.map((type) => `
    <label class="slot${type === BENCH ? ' slot-bench' : ''}"${type === BENCH ? ' title="Bänkplatser — spelarna ger inga poäng där, men de finns kvar i laget hela veckan"' : ''}>
      <span class="slot-tag pos-${type}">${type}</span>
      <input type="number" min="0" max="12" step="1" data-slot="${type}" value="${r.slots[type]}">
    </label>`).join('');

  for (const input of $('#slotFields').querySelectorAll('input')) {
    /* Skriv till det lag fältet ritades för, inte till det som råkar vara valt
       när händelsen kommer: byter man lag med ett ändrat sifferfält i fokus
       landar dess change först efteråt. */
    input.addEventListener('change', () => {
      const n = Math.max(0, Math.min(12, Math.round(Number(input.value) || 0)));
      input.value = n;
      r.slots[input.dataset.slot] = n;
      saveRosters();
      if (r !== activeRoster()) return;
      renderSlotSum();
      renderRosterCount();  // platserna avgör hur stort laget får vara
      renderLineup();
    });
  }
  renderSlotSum();
}

/* Startplatserna fylls varje speldag, bänken bara en gång: den avgör hur många
   spelare laget får hålla — och därmed hur mycket utrymme det finns att stänga
   hål med. */
function renderSlotSum() {
  const r = activeRoster();
  const start = SLOTS.reduce((n, type) => n + r.slots[type], 0);
  const bench = r.slots[BENCH];
  $('#slotSum').textContent =
    `${start} ${start === 1 ? 'plats' : 'platser'} att fylla per speldag`
    + ` · ${bench} på bänken · ${start + bench} spelare i laget`;
}

const rosterCap = (roster) => ALL_SLOTS.reduce((n, type) => n + roster.slots[type], 0);

function renderRosterTable() {
  const r = activeRoster();
  const teams = state.schedule.teams;

  $('#rosterBody').innerHTML = r.players.length
    ? r.players.map((p) => `
      <tr data-id="${esc(p.id)}">
        <td><input class="r-name" type="text" value="${esc(p.name)}" placeholder="${esc(autoName(p))}" spellcheck="false" autocomplete="off"></td>
        <td>
          <select class="r-team">
            <option value="">– lag –</option>
            ${teams.map((t) => `<option value="${t.abbrev}"${t.abbrev === p.team ? ' selected' : ''}>${t.abbrev} · ${esc(t.name)}</option>`).join('')}
          </select>
        </td>
        <td class="r-pos">${POS.map((x) => `<button type="button" class="pos-btn pos-${x}${p.pos.includes(x) ? ' is-on' : ''}" data-pos="${x}" aria-pressed="${p.pos.includes(x)}">${x}</button>`).join('')}</td>
        <td><button type="button" class="icon-btn r-del" title="Ta bort raden" aria-label="Ta bort raden">×</button></td>
      </tr>`).join('')
    : '<tr class="r-none"><td colspan="4">Inga spelare än — skriv t.ex. <code>D-COL</code> i rutan ovanför.</td></tr>';

  for (const tr of $('#rosterBody').querySelectorAll('tr[data-id]')) {
    const p = r.players.find((x) => x.id === tr.dataset.id);
    const nameInput = tr.querySelector('.r-name');

    nameInput.addEventListener('input', () => { p.name = nameInput.value; touchRoster(); });

    tr.querySelector('.r-team').addEventListener('change', (e) => {
      p.team = e.target.value;
      nameInput.placeholder = autoName(p);
      touchRoster();
    });

    for (const btn of tr.querySelectorAll('.pos-btn')) {
      btn.addEventListener('click', () => {
        const x = btn.dataset.pos;
        const on = !p.pos.includes(x);
        p.pos = POS.filter((q) => (q === x ? on : p.pos.includes(q)));
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', String(on));
        nameInput.placeholder = autoName(p);
        touchRoster();
      });
    }

    tr.querySelector('.r-del').addEventListener('click', () => {
      r.players = r.players.filter((x) => x.id !== p.id);
      renderRosterTable();
      touchRoster();
    });
  }

  renderRosterCount();
}

/* Spelarraderna ritas inte om vid varje tangenttryck — då tappar fältet
   fokus mitt i ett namn. Bara siffrorna och rutnätet uppdateras. */
function touchRoster() {
  saveRosters();
  renderRosterCount();
  renderLineup();
}

function renderRosterCount() {
  const r = activeRoster();
  const ready = r.players.filter((p) => p.team && p.pos.length).length;
  const rest = r.players.length - ready;
  const cap = rosterCap(r);
  const over = r.players.length - cap;

  const el = $('#rosterCount');
  el.textContent =
    `${ready} spelare`
    + (rest ? ` · ${rest} ofullständig${rest === 1 ? '' : 'a'}` : '')
    + (over > 0
      ? ` · ${over} över ligans ${cap} platser`
      : ` · ${-over} ${-over === 1 ? 'ledig plats' : 'lediga platser'} i laget`);
  el.classList.toggle('is-over', over > 0);
}

/* ── Snabbinmatning: D-COL, C/LW-TOR, G-VGK ─────────────────── */
function quickAdd(text) {
  const r = activeRoster();
  const known = new Set(state.schedule.teams.map((t) => t.abbrev));
  const bad = [];
  let added = 0;

  for (const raw of text.split(/[,;\n]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (r.players.length >= MAX_PLAYERS) { bad.push(token); continue; }

    const parts = token.toUpperCase().split(/\s*[-–—]\s*|\s+/).filter(Boolean);
    if (parts.length !== 2) { bad.push(token); continue; }

    // Både D-COL och COL-D ska funka.
    let [first, second] = parts;
    if (known.has(first) && !known.has(second)) [first, second] = [second, first];
    if (!known.has(second)) { bad.push(token); continue; }

    const pos = POS.filter((x) => first.split('/').includes(x));
    if (!pos.length || pos.length !== new Set(first.split('/').filter(Boolean)).size) { bad.push(token); continue; }

    r.players.push({ id: uid(), name: '', team: second, pos });
    added++;
  }

  $('#quickErr').textContent = bad.length
    ? `Förstod inte: ${bad.slice(0, 4).join(', ')}${bad.length > 4 ? ' …' : ''}`
    : '';

  if (added) {
    $('#quickAdd').value = '';
    renderRosterTable();
    touchRoster();
  }
  return added;
}

/* ── Uppställningen ─────────────────────────────────────────── */
/* Varje plats i ligan blir en egen rad: C1, C2, LW1 … */
function slotRows(roster, types) {
  const out = [];
  for (const type of types) {
    const n = roster.slots[type];
    for (let i = 1; i <= n; i++) out.push({ type, label: n > 1 ? `${type}${i}` : type });
  }
  return out;
}

/* UTIL tar vilken utespelare som helst, målvakter bara G. */
const fits = (type, pos) =>
  type === 'UTIL' ? pos.some((p) => SKATERS.includes(p)) : pos.includes(type);

/* Maximal matchning mellan spelare och platser (Kuhns algoritm). Att fylla
   girigt uppifrån räcker inte: en C/LW som lagt beslag på UTIL kan behöva
   flyttas till en C-plats för att en ren wing ska få plats. Den som inte får
   någon plats alls blir bänkad. */
function fillLineup(slots, players) {
  const bySlot = new Array(slots.length).fill(-1);   // plats → spelarindex
  const bySeat = new Array(players.length).fill(-1); // spelare → platsindex

  const seat = (p, seen) => {
    for (let s = 0; s < slots.length; s++) {
      if (seen[s] || !fits(slots[s].type, players[p].pos)) continue;
      seen[s] = true;
      if (bySlot[s] === -1 || seat(bySlot[s], seen)) {
        bySlot[s] = p;
        bySeat[p] = s;
        return true;
      }
    }
    return false;
  };

  for (let p = 0; p < players.length; p++) seat(p, new Array(slots.length).fill(false));
  return { bySlot, bySeat };
}

function buildLineup() {
  const roster = activeRoster();
  const lo = Math.min(state.range.from, state.range.to);
  const hi = Math.max(state.range.from, state.range.to);
  const from = state.weeks[lo];
  const to = state.weeks[hi];
  const days = from && to ? dayRange(from.start, to.end) : [];
  const inRange = new Set(days);

  const load = new Map(days.map((d) => [d, 0]));
  const playsOn = new Map(); // "COL|2026-10-07" -> { opp, home }

  for (const g of state.schedule.games) {
    if (g.type !== 2 || !inRange.has(g.date)) continue;
    load.set(g.date, load.get(g.date) + 1);
    playsOn.set(`${g.home}|${g.date}`, { opp: g.away, home: true });
    playsOn.set(`${g.away}|${g.date}`, { opp: g.home, home: false });
  }

  const slots = slotRows(roster, SLOTS);
  const benchSlots = slotRows(roster, [BENCH]);
  const players = roster.players.filter((p) => p.team && p.pos.length);

  const cols = days.map((day) => {
    const games = load.get(day);
    const live = games > 0;

    const playing = [];
    for (const p of players) {
      const g = playsOn.get(`${p.team}|${day}`);
      if (g) playing.push({ p, g });
    }

    const { bySlot, bySeat } = live
      ? fillLineup(slots, playing.map((x) => x.p))
      : { bySlot: new Array(slots.length).fill(-1), bySeat: [] };

    const seats = bySlot.map((i) => (i === -1 ? null : playing[i]));
    const bench = playing.filter((_, i) => bySeat[i] === -1);

    /* Bänkraderna visar vilka av dagens spelare som blir över. Får de inte plats
       ens där är laget större än ligan tillåter — det räknas som `over`. */
    const benchSeats = benchSlots.map((_, i) => bench[i] ?? null);

    return {
      day, games, live,
      off: live && games <= state.offMax,
      seats,
      bench,
      benchSeats,
      over: Math.max(0, bench.length - benchSlots.length),
      free: live ? seats.filter((s) => !s).length : 0,
      playing: playing.length,
    };
  });

  const weeks = state.weeks.slice(lo, hi + 1);
  const label = weeks.length > 1
    ? `${weeks[0].label} – ${weeks[weeks.length - 1].label}`
    : (weeks[0]?.label ?? '–');

  return { days, cols, slots, benchSlots, players, roster, from, to, label };
}

/* ── Rendering av uppställningen ────────────────────────────── */
function renderLineup() {
  if (!state.schedule || !state.rosters.length) return;
  const t = buildLineup();
  renderLineupReadout(t);
  renderLineupHead(t);
  renderLineupBody(t);
  renderLineupFoot(t);
  layoutFrozen('#rgrid');
}

function dayHead(c) {
  return `<th class="col-day${c.off ? ' is-off' : ''}${c.live ? '' : ' is-dark'}">`
    + `<span class="day-name">${fmtWeekday.format(toDate(c.day))}</span>`
    + `<span class="day-date">${shortDate(c.day)}</span>`
    + `<span class="day-load">${c.games}</span></th>`;
}

function renderLineupHead(t) {
  let frz = 0;
  const head = `<th class="col-slot frozen" data-frz="${frz++}">Plats</th>`
    + `<th class="num frozen" data-frz="${frz++}" title="Speldagar då platsen fylls av någon av dina spelare">Fylld</th>`
    + `<th class="num frozen frozen-last" data-frz="${frz++}" title="Speldagar då platsen står tom">Ledig</th>`;
  $('#rHead').innerHTML = `<tr>${head}${t.cols.map(dayHead).join('')}</tr>`;
}

function renderLineupBody(t) {
  const cols = t.days.length + 3;

  if (!t.slots.length && !t.benchSlots.length) {
    $('#rBody').innerHTML = `<tr><td class="r-none" colspan="${cols}">Ligan har inga platser inställda — fyll i antalet under <b>Ligans platser</b>.</td></tr>`;
    $('#rFoot').innerHTML = '';
    return;
  }

  const freeBySlot = t.slots.map((_, s) => t.cols.filter((c) => c.live && !c.seats[s]).length);
  const scale = ramp(freeBySlot);

  $('#rBody').innerHTML = t.slots.map((slot, s) => {
    const free = freeBySlot[s];
    const filled = t.cols.filter((c) => c.live && c.seats[s]).length;

    let frz = 0;
    const head = `<td class="col-slot frozen" data-frz="${frz++}"><span class="slot-tag pos-${slot.type}">${slot.label}</span></td>`
      + `<td class="num frozen" data-frz="${frz++}">${filled}</td>`
      + `<td class="num frozen frozen-last ${free ? `warm-${scale(free)}` : 'zero'}" data-frz="${frz++}">${free}</td>`;

    const cells = t.cols.map((c) => {
      if (!c.live) return '<td class="cell is-dark"></td>';
      const off = c.off ? ' is-off' : '';
      const seat = c.seats[s];
      if (!seat) {
        const star = c.off ? ' <span class="star" title="Ledig plats på en offnight">★</span>' : '';
        return `<td class="cell is-free${off}"><span class="ln-free">LEDIG</span>${star}</td>`;
      }
      return `<td class="cell${off}">`
        + `<span class="ln-name">${esc(nameOf(seat.p))}</span>`
        + `<span class="ln-opp">${seat.g.home ? '' : '@'}${seat.g.opp}</span></td>`;
    }).join('');

    return `<tr>${head}${cells}</tr>`;
  }).join('') + benchBody(t);
}

/* Bänkraderna ligger under startplatserna och räknas inte som hål: en tom
   bänkplats är tvärtom utrymme att plocka upp en extra spelare på. */
function benchBody(t) {
  return t.benchSlots.map((slot, s) => {
    const used = t.cols.filter((c) => c.live && c.benchSeats[s]).length;
    const open = t.cols.filter((c) => c.live && !c.benchSeats[s]).length;
    const last = s === t.benchSlots.length - 1;

    let frz = 0;
    const head = `<td class="col-slot frozen" data-frz="${frz++}"><span class="slot-tag pos-${BENCH}">${slot.label}</span></td>`
      + `<td class="num frozen" data-frz="${frz++}">${used}</td>`
      + `<td class="num frozen frozen-last zero" data-frz="${frz++}">${open}</td>`;

    const cells = t.cols.map((c) => {
      if (!c.live) return '<td class="cell is-dark"></td>';
      const off = c.off ? ' is-off' : '';
      const seat = c.benchSeats[s];
      if (!seat) return `<td class="cell is-open${off}"><span class="ln-open" title="Bänkplatsen är ledig den dagen">–</span></td>`;

      const over = last && c.over
        ? ` <span class="ln-over" title="${c.over} spelare till med match får inte plats ens på bänken">+${c.over}</span>`
        : '';
      return `<td class="cell${off}">`
        + `<span class="ln-name">${esc(nameOf(seat.p))}</span>`
        + `<span class="ln-opp">${seat.g.home ? '' : '@'}${seat.g.opp}${over}</span></td>`;
    }).join('');

    return `<tr class="is-bench${s === 0 ? ' bench-top' : ''}">${head}${cells}</tr>`;
  }).join('');
}

function renderLineupFoot(t) {
  if (!t.slots.length && !t.benchSlots.length) return;

  const rows = [
    {
      label: 'Lediga platser', heat: 'warm',
      title: 'Platser som ingen av dina spelare kan fylla den dagen',
      get: (c) => c.free,
      tip: (c) => t.slots.filter((_, s) => !c.seats[s]).map((s) => s.label).join(', '),
    },
    {
      label: 'Bänkade', heat: 'cool',
      title: 'Dina spelare som har match men inte får en startplats — de tar en bänkplats (BN) den dagen',
      get: (c) => c.bench.length,
      tip: (c) => c.bench.map((b) => nameOf(b.p)).join(', '),
    },
    {
      label: 'Egna i spel', heat: null,
      title: 'Dina spelare som har match den dagen',
      get: (c) => c.playing,
      tip: () => '',
    },
  ];

  $('#rFoot').innerHTML = rows.map((row) => {
    const values = t.cols.map((c) => (c.live ? row.get(c) : 0));
    const scale = row.heat ? ramp(values) : () => 0;
    const total = values.reduce((a, b) => a + b, 0);

    let frz = 0;
    const head = `<td class="col-slot frozen" data-frz="${frz++}" title="${row.title}">${row.label}</td>`
      + `<td class="num frozen" data-frz="${frz++}">${total}</td>`
      + `<td class="num frozen frozen-last" data-frz="${frz++}"></td>`;

    const cells = t.cols.map((c, i) => {
      if (!c.live) return '<td class="num is-dark"></td>';
      const v = values[i];
      const level = scale(v);
      const tip = v ? row.tip(c) : '';
      return `<td class="num ${level ? `${row.heat}-${level}` : 'zero'}"${tip ? ` title="${esc(tip)}"` : ''}>${v}</td>`;
    }).join('');

    return `<tr>${head}${cells}</tr>`;
  }).join('');
}

function renderLineupReadout(t) {
  const el = $('#rReadout');

  if (!t.players.length) {
    el.innerHTML = `<b>${esc(t.roster.name)}</b> · Lägg till spelare i <b>Mitt lag</b> så fylls veckan i — `
      + 'tills dess står alla platser lediga.';
    return;
  }

  const playDays = t.cols.filter((c) => c.live);
  const seatDays = playDays.length * t.slots.length;
  const free = playDays.reduce((n, c) => n + c.free, 0);
  const bench = playDays.reduce((n, c) => n + c.bench.length, 0);
  const over = playDays.filter((c) => c.over).length;

  const perType = SLOTS.map((type) => {
    const idx = t.slots.map((s, i) => (s.type === type ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return null;
    const n = playDays.reduce((sum, c) => sum + idx.filter((i) => !c.seats[i]).length, 0);
    return n ? `${type} ${n}` : null;
  }).filter(Boolean);

  el.innerHTML =
    `<b>${esc(t.roster.name)}</b> · ${esc(t.label)} · ${fmtLong.format(toDate(t.from.start))} – ${fmtLong.format(toDate(t.to.end))} · `
    + `${t.days.length} dagar varav <b>${playDays.length}</b> med NHL-matcher · `
    + `${t.players.length} spelare på ${t.slots.length} startplatser + ${t.benchSlots.length} på bänken<br>`
    + `<b>${free}</b> lediga platser av ${seatDays} · `
    + (perType.length ? `lediga per position: ${perType.join(' · ')}` : 'inga hål alls i perioden')
    + (bench ? ` · <b>${bench}</b> bänkade starter` : '')
    + (over ? ` · <b>${over}</b> ${over === 1 ? 'dag' : 'dagar'} med fler spelare i spel än laget har platser` : '');
}

/* ── Händelser för lagvyn ───────────────────────────────────── */
function wireRoster() {
  $('#rFrom').addEventListener('change', (e) => {
    state.range.from = Number(e.target.value);
    if (state.range.to < state.range.from) {
      state.range.to = state.range.from;
      $('#rTo').value = String(state.range.to);
    }
    renderLineup();
  });

  $('#rTo').addEventListener('change', (e) => {
    state.range.to = Number(e.target.value);
    if (state.range.to < state.range.from) {
      state.range.from = state.range.to;
      $('#rFrom').value = String(state.range.from);
    }
    renderLineup();
  });

  $('#rOffMax').addEventListener('change', (e) => setOffMax(e.target.value));

  /* ── Lagen ── */
  $('#teamPick').addEventListener('change', (e) => {
    state.rosterId = e.target.value;
    saveRosters();
    renderRosterPanels();
    renderLineup();
  });

  $('#newRoster').addEventListener('click', () => {
    if (state.rosters.length >= MAX_ROSTERS) return;
    const name = (prompt('Vad heter laget?', `Lag ${state.rosters.length + 1}`) ?? '').trim();
    if (!name) return;
    const roster = blankRoster(name.slice(0, 40));
    state.rosters.push(roster);
    state.rosterId = roster.id;
    saveRosters();
    fillTeamPicker();
    renderRosterPanels();
    renderLineup();
  });

  $('#renameRoster').addEventListener('click', () => {
    const r = activeRoster();
    const name = (prompt('Nytt namn på laget:', r.name) ?? '').trim();
    if (!name) return;
    r.name = name.slice(0, 40);
    saveRosters();
    fillTeamPicker();
    renderRosterPanels();
    renderLineup();
  });

  /* Två ligor med nästan samma lag: kopiera och justera skillnaderna. */
  $('#copyRosterTeam').addEventListener('click', () => {
    if (state.rosters.length >= MAX_ROSTERS) return;
    const r = activeRoster();
    const copy = {
      id: uid(),
      name: `${r.name} (kopia)`.slice(0, 40),
      slots: { ...r.slots },
      players: r.players.map((p) => ({ ...p, id: uid(), pos: [...p.pos] })),
    };
    state.rosters.push(copy);
    state.rosterId = copy.id;
    saveRosters();
    fillTeamPicker();
    renderRosterPanels();
    renderLineup();
  });

  $('#deleteRoster').addEventListener('click', () => {
    if (state.rosters.length < 2) return;
    const r = activeRoster();
    if (!confirm(`Ta bort ${r.name} med dess ${r.players.length} spelare?`)) return;
    state.rosters = state.rosters.filter((x) => x.id !== r.id);
    state.rosterId = state.rosters[0].id;
    saveRosters();
    fillTeamPicker();
    renderRosterPanels();
    renderLineup();
  });

  $('#resetSlots').addEventListener('click', () => {
    activeRoster().slots = { ...DEFAULT_SLOTS };
    saveRosters();
    renderSlotFields();
    renderRosterCount();
    renderLineup();
  });

  /* ── Spelarna ── */
  $('#quickAddBtn').addEventListener('click', () => quickAdd($('#quickAdd').value));
  $('#quickAdd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); quickAdd($('#quickAdd').value); }
  });

  $('#addPlayer').addEventListener('click', () => {
    const r = activeRoster();
    if (r.players.length >= MAX_PLAYERS) return;
    r.players.push({ id: uid(), name: '', team: '', pos: [] });
    renderRosterTable();
    touchRoster();
    $('#rosterBody').querySelector('tr:last-child .r-team')?.focus();
  });

  $('#clearRoster').addEventListener('click', () => {
    const r = activeRoster();
    if (!r.players.length) return;
    if (!confirm(`Ta bort alla ${r.players.length} spelare i ${r.name}?`)) return;
    r.players = [];
    renderRosterTable();
    touchRoster();
  });

  /* ── Export och import ── */
  document.querySelector('.share').addEventListener('toggle', (e) => {
    if (!e.target.open) return;
    $('#shareMsg').textContent = '';
    $('#shareBox').value = JSON.stringify({
      rosters: state.rosters.map((r) => ({
        name: r.name,
        slots: r.slots,
        players: r.players.map(({ name, team, pos }) => ({ name, team, pos })),
      })),
    }, null, 2);
  });

  $('#copyRoster').addEventListener('click', async () => {
    const box = $('#shareBox');
    box.select();
    try {
      await navigator.clipboard.writeText(box.value);
      $('#shareMsg').textContent = 'Kopierat.';
    } catch {
      $('#shareMsg').textContent = 'Kopiera med Ctrl/Cmd+C — texten är markerad.';
    }
  });

  $('#importRoster').addEventListener('click', () => {
    $('#shareMsg').textContent = importRosters($('#shareBox').value);
  });
}

/* Ersätter allt: den inklistrade texten är hela uppsättningen lag. */
function importRosters(text) {
  let data;
  try { data = JSON.parse(text); } catch { return 'Texten är inte giltig JSON.'; }

  const list = Array.isArray(data) ? data : Array.isArray(data?.rosters) ? data.rosters : [data];
  const clean = cleanRosters(list);
  if (!clean.length) return 'Hittade inga lag i texten.';
  if (!confirm(`Ersätt dina ${state.rosters.length} lag med ${clean.length} inlästa?`)) return 'Avbrutet.';

  state.rosters = clean;
  state.rosterId = clean[0].id;
  saveRosters();
  fillTeamPicker();
  renderRosterPanels();
  renderLineup();
  return `Importerade ${clean.length} lag.`;
}

boot();
