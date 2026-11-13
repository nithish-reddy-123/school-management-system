'use strict';
const crypto = require('node:crypto');

// All dates and times use the school's time zone, not the server's. Hosting servers (e.g. Render) usually run on
// UTC, which would make "today", check-in times and timestamps 5h30m behind India time.
// Set APP_TIMEZONE to override (IANA name, e.g. Asia/Kolkata). This file is loaded before any date is created.
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

const pad = (n) => String(n).padStart(2, '0');

/** Local (server time zone) date as YYYY-MM-DD. Avoids the UTC shift of toISOString(). */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local timestamp as 'YYYY-MM-DD HH:MM:SS' (the format stored for created_at, last_login, etc.). */
function nowLocal(d = new Date()) {
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localTime(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

function isValidDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00`);
  return !Number.isNaN(d.getTime()) && localDate(d) === str;
}

/** Indian academic year runs April to March, e.g. "2026-27". */
function academicYear(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${pad((start + 1) % 100)}`;
}

/** Display date as DD-MM-YYYY (common format in Indian schools). */
function formatDate(str) {
  if (!str) return '';
  const [datePart] = String(str).split(' ');
  const [y, m, d] = datePart.split('-');
  return d && m && y ? `${d}-${m}-${y}` : str;
}

/** CBSE-style 8-point grading scale. */
function grade(percent) {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return '-';
  if (percent > 90) return 'A1';
  if (percent > 80) return 'A2';
  if (percent > 70) return 'B1';
  if (percent > 60) return 'B2';
  if (percent > 50) return 'C1';
  if (percent > 40) return 'C2';
  if (percent >= 33) return 'D';
  return 'E';
}

function generatePassword() {
  // Avoid ambiguous characters (0/O, 1/l/I) so it can be read out or written on paper.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Returns an error message if the password is too weak, otherwise null. */
function passwordProblem(pw, username) {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain your username.';
  return null;
}

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Up to two initials for an avatar, e.g. "Sunita Sharma" -> "SS". */
function initials(name) {
  const parts = String(name || '').replace(/^(dr|mr|mrs|ms|mohd)\.?\s+/i, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Stable hue (0-359) per name so each person keeps the same avatar colour. */
function hue(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function toInt(v, fallback = null) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max = 500) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // Prefix formula-leading characters to prevent CSV injection in spreadsheet apps.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function percent(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIODS = [1, 2, 3, 4, 5, 6, 7, 8];
const CATEGORIES = { GEN: 'General', OBC: 'OBC', SC: 'SC', ST: 'ST', EWS: 'EWS' };
const GENDERS = { M: 'Male', F: 'Female', O: 'Other' };

/** CSS level for an attendance/marks percentage: 75% is the usual minimum attendance requirement. */
function level(p) {
  if (p === null || p === undefined) return 'none';
  if (p >= 90) return 'good';
  if (p >= 75) return 'ok';
  return 'bad';
}

/** Returns a valid YYYY-MM month string from user input, or the current month. */
function monthParam(v) {
  return typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : localDate().slice(0, 7);
}

/** 1 = Monday ... 6 = Saturday, 0 = Sunday */
function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

module.exports = {
  localDate, localTime, nowLocal, addDays, isValidDate, academicYear, formatDate, grade,
  generatePassword, toInt, str, csvEscape, percent, dayOfWeek, monthParam, level,
  passwordProblem, USERNAME_RE, PHONE_RE, EMAIL_RE, initials, hue,
  DAYS, PERIODS, CATEGORIES, GENDERS,
};
