// Costa Rica clock arithmetic, written once. Costa Rica is UTC-6 all
// year with no daylight saving (A8), so every CR-local calendar date,
// "HH:MM" wall time and UTC instant in the booking engine converts
// through these functions and the -6 h offset is applied in exactly one
// place. Moved out of booking.js unchanged so day-hours.js can share it.

const CR_OFFSET_HOURS = 6;

export function crDateStringFromUtc(utcDate) {
  const shifted = new Date(utcDate.getTime() - CR_OFFSET_HOURS * 3600000);
  return shifted.toISOString().slice(0, 10);
}

export function crTimeStringFromUtcIso(utcIso) {
  const shifted = new Date(new Date(utcIso).getTime() - CR_OFFSET_HOURS * 3600000);
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const m = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function crDateTimeToUtcIso(crDateStr, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const utcMs = Date.parse(`${crDateStr}T00:00:00.000Z`) + (h * 60 + m) * 60000 + CR_OFFSET_HOURS * 3600000;
  return new Date(utcMs).toISOString();
}

export function addDaysToDateString(dateStr, days) {
  const ms = Date.parse(`${dateStr}T00:00:00.000Z`) + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isValidDateString(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}
