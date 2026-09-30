/* Together: finds the times when both people are free.
   Pure functions, no network. Times are milliseconds since 1970 (UTC).
   A person is "free" inside their own daily hours (day_start..day_end, in their own time zone)
   whenever none of their events overlap. Both-free = my free time ∩ partner's free time. */
(function (root) {
"use strict";
const MIN = 60000, DAY = 86400000;

// How far a time zone is ahead of UTC at a given moment, in ms.
function tzOffset(t, tz) {
  try {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  } catch (e) { return 0; }
}
// The calendar date (y, m 0-based, d) a moment falls on in a time zone.
function ymdIn(t, tz) { const d = new Date(t + tzOffset(t, tz)); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; }
// Wall-clock time in a time zone -> UTC ms. `minutes` may be 1440 (midnight at the end of the day).
function zoned(y, m, d, minutes, tz) {
  const guess = Date.UTC(y, m, d, 0, minutes);
  let t = guess - tzOffset(guess, tz);
  const o2 = tzOffset(t, tz);
  t = guess - o2;
  return t;
}

// Sort, drop empties and merge overlapping or touching intervals.
function normalize(list) {
  const s = list.filter(i => i && i[1] > i[0]).map(i => [i[0], i[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const i of s) { const l = out[out.length - 1]; if (l && i[0] <= l[1]) l[1] = Math.max(l[1], i[1]); else out.push(i); }
  return out;
}
function subtract(base, cut) {
  base = normalize(base); cut = normalize(cut);
  const out = []; let j = 0;
  for (const b of base) {
    let s = b[0]; const e = b[1];
    while (j < cut.length && cut[j][1] <= s) j++;
    let k = j;
    while (k < cut.length && cut[k][0] < e) { if (cut[k][0] > s) out.push([s, cut[k][0]]); s = Math.max(s, cut[k][1]); if (s >= e) break; k++; }
    if (s < e) out.push([s, e]);
  }
  return out;
}
function intersect(a, b) {
  a = normalize(a); b = normalize(b);
  const out = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

// The hours someone counts as available, day by day, between `from` and `to`.
function wakingWindows(profile, from, to) {
  const tz = profile.timezone || "UTC", ds = profile.day_start ?? 480, de = profile.day_end ?? 1320;
  const out = [];
  let [y, m, d] = ymdIn(from - DAY, tz);
  for (let n = 0; n < 400; n++) {
    const s = zoned(y, m, d, ds, tz), e = zoned(y, m, d, de, tz);
    if (s >= to) break;
    if (e > from) out.push([Math.max(s, from), Math.min(e, to)]);
    const nx = new Date(Date.UTC(y, m, d + 1)); y = nx.getUTCFullYear(); m = nx.getUTCMonth(); d = nx.getUTCDate();
  }
  return normalize(out);
}
const busyOf = (events, userId) => events.filter(e => e.user_id === userId).map(e => [+new Date(e.starts_at), +new Date(e.ends_at)]);

function freeFor(profile, events, from, to) { return subtract(wakingWindows(profile, from, to), busyOf(events, profile.user_id)); }

// Every stretch between `from` and `to` when both people are free, at least `minMinutes` long.
function bothFree(me, partner, events, from, to, minMinutes) {
  const min = (minMinutes || Math.max(me.min_free || 60, partner.min_free || 60)) * MIN;
  return intersect(freeFor(me, events, from, to), freeFor(partner, events, from, to))
    .filter(i => i[1] - i[0] >= min).map(i => ({ start: i[0], end: i[1] }));
}
// The next stretch when both are free, starting from `now` (may already be under way).
function nextBothFree(me, partner, events, now, days) {
  return bothFree(me, partner, events, now, now + (days || 14) * DAY)[0] || null;
}

root.FREE = { tzOffset, ymdIn, zoned, normalize, subtract, intersect, wakingWindows, freeFor, bothFree, nextBothFree, MIN, DAY };
if (typeof module !== "undefined" && module.exports) module.exports = root.FREE;
})(typeof window !== "undefined" ? window : globalThis);
