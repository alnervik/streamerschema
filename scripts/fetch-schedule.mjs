#!/usr/bin/env node
// Hämtar hela NHL-säsongens schema och skriver data/schedule.json.
// Skapar data/weeks.json med Mån–Sön-veckor om filen saknas (skrivs aldrig över).
//
//   node scripts/fetch-schedule.mjs                 # nuvarande säsong
//   node scripts/fetch-schedule.mjs 20262027        # given säsong
//   node scripts/fetch-schedule.mjs --force-weeks   # generera om weeks.json

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://api-web.nhle.com/v1';
const DATA = path.resolve('data');

const FALLBACK_TEAMS = [
  'ANA', 'BOS', 'BUF', 'CAR', 'CBJ', 'CGY', 'CHI', 'COL', 'DAL', 'DET', 'EDM',
  'FLA', 'LAK', 'MIN', 'MTL', 'NJD', 'NSH', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT',
  'SEA', 'SJS', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WPG', 'WSH',
];

const args = process.argv.slice(2);
const forceWeeks = args.includes('--force-weeks');
const seasonArg = args.find((a) => /^\d{8}$/.test(a));

function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  // Ny säsong räknas från augusti.
  return now.getUTCMonth() >= 7 ? `${y}${y + 1}` : `${y - 1}${y}`;
}

async function getJSON(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i === tries) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

async function getTeams() {
  try {
    const st = await getJSON(`${API}/standings/now`);
    const teams = (st.standings ?? [])
      .map((t) => ({
        abbrev: t.teamAbbrev?.default,
        name: t.teamName?.default,
        conference: t.conferenceName,
        division: t.divisionName,
      }))
      .filter((t) => t.abbrev);
    if (teams.length >= 30) return teams;
    throw new Error(`fick bara ${teams.length} lag`);
  } catch (err) {
    console.warn(`standings/now misslyckades (${err.message}) – använder fast laglista`);
    return FALLBACK_TEAMS.map((abbrev) => ({
      abbrev, name: abbrev, conference: '', division: '',
    }));
  }
}

async function getSchedule(teams, season) {
  const seen = new Map();
  for (const team of teams) {
    let payload;
    try {
      payload = await getJSON(`${API}/club-schedule-season/${team.abbrev}/${season}`);
    } catch (err) {
      console.warn(`hoppar över ${team.abbrev}: ${err.message}`);
      continue;
    }
    for (const g of payload.games ?? []) {
      if (g.gameType !== 2 && g.gameType !== 3) continue; // 2 = grundserie, 3 = slutspel
      if (seen.has(g.id)) continue;
      seen.set(g.id, {
        id: g.id,
        date: g.gameDate,
        home: g.homeTeam?.abbrev,
        away: g.awayTeam?.abbrev,
        type: g.gameType,
        start: g.startTimeUTC ?? null,
      });
    }
    process.stdout.write(`\r${team.abbrev} · ${seen.size} matcher   `);
  }
  process.stdout.write('\n');
  return [...seen.values()]
    .filter((g) => g.home && g.away)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}

// --- datumhjälpare, allt i UTC för att slippa tidszonstrul ---
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const toISO = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
};
const weekday = (s) => toDate(s).getUTCDay(); // 0 = söndag

// Vecka 1 går från premiären till första söndagen, sedan mån–sön.
function buildWeeks(games) {
  const dates = games.filter((g) => g.type === 2).map((g) => g.date).sort();
  if (!dates.length) return [];
  const first = dates[0];
  const last = dates[dates.length - 1];

  const weeks = [];
  let start = first;
  let n = 1;
  while (start <= last) {
    const daysToSunday = (7 - weekday(start)) % 7;
    let end = addDays(start, daysToSunday);
    if (addDays(end, 1) > last) end = last; // sista veckan sträcks till säsongsslut
    weeks.push({ label: `Vecka ${n}`, number: n, start, end });
    start = addDays(end, 1);
    n++;
  }
  return weeks;
}

async function main() {
  const season = seasonArg ?? currentSeason();
  console.log(`Säsong ${season.slice(0, 4)}-${season.slice(6)}`);

  const teams = await getTeams();
  const games = await getSchedule(teams, season);
  if (!games.length) {
    console.error('Inga matcher hittades – schemat är antagligen inte släppt än.');
    process.exit(1);
  }

  await mkdir(DATA, { recursive: true });
  const payload = {
    season,
    updated: new Date().toISOString(),
    teams: teams.sort((a, b) => a.abbrev.localeCompare(b.abbrev)),
    games,
  };
  await writeFile(path.join(DATA, 'schedule.json'), `${JSON.stringify(payload)}\n`);
  console.log(`data/schedule.json · ${games.length} matcher · ${teams.length} lag`);

  const weeksPath = path.join(DATA, 'weeks.json');
  let existing = null;
  try {
    existing = JSON.parse(await readFile(weeksPath, 'utf8'));
  } catch { /* filen finns inte */ }

  if (!existing || existing.season !== season || forceWeeks) {
    const weeks = buildWeeks(games);
    await writeFile(weeksPath, `${JSON.stringify({ season, weeks }, null, 2)}\n`);
    console.log(`data/weeks.json · ${weeks.length} veckor (justera efter Yahoos veckor)`);
  } else {
    console.log('data/weeks.json lämnad orörd');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
