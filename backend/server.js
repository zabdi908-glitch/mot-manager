const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

// Base URL of this app, used to build links in emails. Render automatically
// sets RENDER_EXTERNAL_URL for web services — no need to configure it manually.
// You can override it by setting PUBLIC_URL yourself if needed.
const APP_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// Business details shown in emails — set these as env vars so you never have
// to touch code to update them.
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'The Workshop';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';

// Middleware
app.use(cors());
app.use(express.json());

// Path to the JSON database file. On Render, the app's own disk is wiped on
// every redeploy — set DATA_DIR to a Render Persistent Disk mount path (e.g.
// /var/data) so this survives deploys. Falls back to the app folder for local dev.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

if (!process.env.DATA_DIR) {
  console.warn('⚠️  DATA_DIR is not set — data.json is stored on ephemeral disk and will be lost on redeploy.');
} else {
  console.log(`💾 Using persistent data directory: ${DATA_DIR}`);
}

// Helper: Read data from disk
function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    const defaultData = { customers: [], vehicles: [], bookings: [], notifications: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

// Helper: Write data to disk
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Helper: Generate IDs
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Helper: normalize a registration for comparison (ignore case + spacing)
function normalizeReg(reg) {
  return (reg || '').replace(/\s+/g, '').toUpperCase();
}

function daysUntil(dateStr) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

// =========================
//   RATE LIMITING (no external deps — simple in-memory, per-IP)
// =========================
function rateLimit(maxRequests, windowMs) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now > entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests — please try again in a few minutes.' });
    }
    entry.count++;
    next();
  };
}

// =========================
//   ADMIN AUTH (Basic Auth + brute-force lockout)
// =========================
// Protects the /admin page and every /api route except the public ones
// registered below. Set ADMIN_PASSWORD (and optionally ADMIN_USER) as
// environment variables on Render.
const loginFailures = new Map(); // ip -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 6;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  if (!expectedPass) {
    console.warn('⚠️  ADMIN_PASSWORD is not set — the admin area is currently UNPROTECTED.');
    return next();
  }

  const failRecord = loginFailures.get(ip);
  if (failRecord && failRecord.lockedUntil && Date.now() < failRecord.lockedUntil) {
    const minsLeft = Math.ceil((failRecord.lockedUntil - Date.now()) / 60000);
    return res.status(429).send(`Too many failed login attempts. Try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}.`);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="MOT Manager Admin"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
  const separatorIdx = decoded.indexOf(':');
  const user = decoded.slice(0, separatorIdx);
  const pass = decoded.slice(separatorIdx + 1);

  if (user === expectedUser && pass === expectedPass) {
    loginFailures.delete(ip); // reset on success
    return next();
  }

  // Track the failure
  const current = loginFailures.get(ip) || { count: 0, lockedUntil: null };
  current.count += 1;
  if (current.count >= MAX_LOGIN_ATTEMPTS) {
    current.lockedUntil = Date.now() + LOCKOUT_MS;
    console.warn(`⚠️  IP ${ip} locked out of admin login for ${LOCKOUT_MS / 60000} minutes after ${current.count} failed attempts.`);
  }
  loginFailures.set(ip, current);

  res.set('WWW-Authenticate', 'Basic realm="MOT Manager Admin"');
  return res.status(401).send('Invalid credentials');
}

// =========================
//   EMAIL (MOT REMINDERS)
// =========================
const emailConfigured = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
const transporter = emailConfigured
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    })
  : null;

if (!emailConfigured) {
  console.warn('⚠️  EMAIL_USER / EMAIL_PASS not set — MOT reminder emails are disabled.');
}

function getStage(days) {
  if (days === null || days === undefined || Number.isNaN(days)) return null;
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_7';
  if (days <= 30) return 'due_30';
  return null;
}

function buildReminderEmail(customer, vehicle, days) {
  const expiryUK = new Date(vehicle.motExpiry + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  let subject, headline, urgencyColor, urgencyLabel;
  if (days < 0) {
    const daysAgo = Math.abs(days);
    subject = `Action needed: MOT overdue for ${vehicle.regNumber}`;
    headline = `Your MOT expired ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago, on ${expiryUK}. Please book a test as soon as possible — driving without a valid MOT can invalidate your insurance.`;
    urgencyColor = '#b8262c';
    urgencyLabel = 'OVERDUE';
  } else if (days <= 7) {
    subject = `Reminder: MOT due in ${days} day${days === 1 ? '' : 's'} – ${vehicle.regNumber}`;
    headline = `Your MOT is due in ${days} day${days === 1 ? '' : 's'}, on ${expiryUK}. Now's a good time to get it booked in.`;
    urgencyColor = '#8a5a00';
    urgencyLabel = `DUE IN ${days} DAY${days === 1 ? '' : 'S'}`;
  } else {
    subject = `Heads up: MOT due ${expiryUK} – ${vehicle.regNumber}`;
    headline = `Just a friendly early reminder — your MOT is due on ${expiryUK}, which is ${days} days away.`;
    urgencyColor = '#2b5d34';
    urgencyLabel = 'UPCOMING';
  }

  const bookingLink = `${APP_URL}/?reg=${encodeURIComponent(vehicle.regNumber)}`;
  const firstName = (customer.name || '').split(' ')[0] || customer.name;
  const phoneLine = BUSINESS_PHONE ? `\nOr call us on ${BUSINESS_PHONE}.` : '';

  const text =
`Hi ${firstName},

${headline}

Vehicle: ${vehicle.make} ${vehicle.model}
Registration: ${vehicle.regNumber}

Book your test online here:
${bookingLink}${phoneLine}

Thanks,
${BUSINESS_NAME}`;

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #f5f1e6;">
    <div style="background: #1c2321; padding: 20px 24px; text-align: center;">
      <div style="color: #ffd400; font-weight: bold; font-size: 18px; letter-spacing: 0.5px;">${BUSINESS_NAME}</div>
    </div>
    <div style="padding: 28px 24px;">
      <p style="font-size: 16px; color: #1c2321; margin: 0 0 16px;">Hi ${firstName},</p>
      <div style="display: inline-block; background: ${urgencyColor}1a; color: ${urgencyColor}; border: 2px solid ${urgencyColor}; border-radius: 4px; padding: 4px 12px; font-size: 12px; font-weight: bold; letter-spacing: 1px; margin-bottom: 16px;">
        ${urgencyLabel}
      </div>
      <p style="font-size: 15px; color: #333d3a; line-height: 1.5; margin: 0 0 20px;">${headline}</p>

      <table style="width: 100%; background: #fffdf8; border: 1px solid #d9d0ba; border-radius: 4px; border-collapse: collapse; margin-bottom: 24px;">
        <tr>
          <td style="padding: 12px 16px; color: #55605c; font-size: 13px;">Vehicle</td>
          <td style="padding: 12px 16px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${vehicle.make} ${vehicle.model}</td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">Registration</td>
          <td style="padding: 0 16px 12px; text-align: right;">
            <span style="display: inline-block; background: #ffd400; color: #1c2321; border: 2px solid #1c2321; border-radius: 3px; padding: 2px 8px; font-weight: bold; letter-spacing: 1px; font-size: 13px;">${vehicle.regNumber}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">MOT Expiry</td>
          <td style="padding: 0 16px 12px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${expiryUK}</td>
        </tr>
      </table>

      <div style="text-align: center; margin-bottom: 20px;">
        <a href="${bookingLink}" style="display: inline-block; background: #1c2321; color: #ffd400; text-decoration: none; font-weight: bold; padding: 14px 32px; border-radius: 4px; font-size: 15px; letter-spacing: 0.5px;">
          BOOK YOUR TEST
        </a>
      </div>

      <p style="font-size: 13px; color: #8b8f83; text-align: center; margin: 0;">
        ${BUSINESS_PHONE ? `Or call us on ${BUSINESS_PHONE}` : 'Or reply to this email to arrange it directly'}
      </p>
    </div>
    <div style="padding: 16px 24px; text-align: center; border-top: 1px solid #d9d0ba;">
      <p style="font-size: 12px; color: #8b8f83; margin: 0;">${BUSINESS_NAME}</p>
    </div>
  </div>`;

  return { subject, text, html };
}

function buildRescheduleEmail(customer, vehicle, booking) {
  const dateUK = new Date(booking.date + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const timeStr = (booking.time || '09:00').slice(0, 5);
  const firstName = (customer.name || '').split(' ')[0] || customer.name;
  const phoneLine = BUSINESS_PHONE ? `\nIf this new time doesn't suit you, just call us on ${BUSINESS_PHONE}.` : '';

  const subject = `Your MOT booking has been updated – ${vehicle.regNumber}`;

  const text =
`Hi ${firstName},

Your MOT booking has been rescheduled. Here are the updated details:

Vehicle: ${vehicle.make} ${vehicle.model}
Registration: ${vehicle.regNumber}
New date: ${dateUK}
New time: ${timeStr}
${phoneLine}

Thanks,
${BUSINESS_NAME}`;

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #f5f1e6;">
    <div style="background: #1c2321; padding: 20px 24px; text-align: center;">
      <div style="color: #ffd400; font-weight: bold; font-size: 18px; letter-spacing: 0.5px;">${BUSINESS_NAME}</div>
    </div>
    <div style="padding: 28px 24px;">
      <p style="font-size: 16px; color: #1c2321; margin: 0 0 16px;">Hi ${firstName},</p>
      <div style="display: inline-block; background: #2f51701a; color: #2f5170; border: 2px solid #2f5170; border-radius: 4px; padding: 4px 12px; font-size: 12px; font-weight: bold; letter-spacing: 1px; margin-bottom: 16px;">
        BOOKING UPDATED
      </div>
      <p style="font-size: 15px; color: #333d3a; line-height: 1.5; margin: 0 0 20px;">Your MOT booking has been rescheduled. Here are the updated details:</p>

      <table style="width: 100%; background: #fffdf8; border: 1px solid #d9d0ba; border-radius: 4px; border-collapse: collapse; margin-bottom: 24px;">
        <tr>
          <td style="padding: 12px 16px; color: #55605c; font-size: 13px;">Vehicle</td>
          <td style="padding: 12px 16px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${vehicle.make} ${vehicle.model}</td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">Registration</td>
          <td style="padding: 0 16px 12px; text-align: right;">
            <span style="display: inline-block; background: #ffd400; color: #1c2321; border: 2px solid #1c2321; border-radius: 3px; padding: 2px 8px; font-weight: bold; letter-spacing: 1px; font-size: 13px;">${vehicle.regNumber}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">New date</td>
          <td style="padding: 0 16px 12px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${dateUK}</td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">New time</td>
          <td style="padding: 0 16px 12px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${timeStr}</td>
        </tr>
      </table>

      <p style="font-size: 13px; color: #8b8f83; text-align: center; margin: 0;">
        ${BUSINESS_PHONE ? `If this new time doesn't suit you, call us on ${BUSINESS_PHONE}` : 'If this new time doesn\'t suit you, just reply to this email'}
      </p>
    </div>
    <div style="padding: 16px 24px; text-align: center; border-top: 1px solid #d9d0ba;">
      <p style="font-size: 12px; color: #8b8f83; margin: 0;">${BUSINESS_NAME}</p>
    </div>
  </div>`;

  return { subject, text, html };
}

async function sendRescheduleEmail(customer, vehicle, booking) {
  if (!transporter) return false;
  if (!customer || !customer.email) return false;
  const { subject, text, html } = buildRescheduleEmail(customer, vehicle, booking);
  try {
    await transporter.sendMail({
      from: `"${BUSINESS_NAME}" <${process.env.EMAIL_USER}>`,
      to: customer.email,
      subject,
      text,
      html
    });
    console.log(`✅ Reschedule email sent to ${customer.email} for ${vehicle.regNumber}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send reschedule email for ${vehicle.regNumber}:`, err.message);
    return false;
  }
}

// Turns a stored cancellation reason into a warm, customer-facing sentence.
// Preset reasons get a friendly phrasing; free-text ("Other") is quoted as given.
function friendlyCancellationReason(reason) {
  if (!reason) return 'Unfortunately, we are unable to keep your appointment at the booked time.';
  const map = {
    'Customer requested': 'As requested, we have cancelled this appointment for you.',
    'Vehicle not ready': 'Unfortunately, your vehicle was not ready in time for its scheduled test.',
    'Garage maintenance': 'This is due to some unexpected maintenance at our garage, which means we are unable to carry out tests at the booked time.'
  };
  return map[reason] || `This is due to the following: ${reason}.`;
}

function buildCancellationEmail(customer, vehicle, booking) {
  const dateUK = new Date(booking.date + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const timeStr = (booking.time || '09:00').slice(0, 5);
  const firstName = (customer.name || '').split(' ')[0] || customer.name;
  const reason = booking.cancellationReason ? String(booking.cancellationReason).trim() : '';
  const reasonSentence = friendlyCancellationReason(reason);
  const rebookLink = `${APP_URL}/?reg=${encodeURIComponent(vehicle.regNumber)}`;

  const subject = `We're sorry – your MOT booking has been cancelled (${vehicle.regNumber})`;

  // Contact options for the "next steps" section, tailored to what's configured.
  const contactTextLines = [`  • Online: ${rebookLink}`];
  if (BUSINESS_PHONE) contactTextLines.push(`  • By phone: ${BUSINESS_PHONE}`);
  contactTextLines.push('  • By email: simply reply to this message');

  const text =
`Dear ${firstName},

We're very sorry, but we've had to cancel your upcoming MOT booking with ${BUSINESS_NAME}. ${reasonSentence} We sincerely apologise for any inconvenience this may cause.

For your reference, here are the details of the cancelled booking:

Vehicle: ${vehicle.make} ${vehicle.model}
Registration: ${vehicle.regNumber}
Date: ${dateUK}
Time: ${timeStr}

We'd be glad to get you booked back in at a time that suits you. Please arrange a new appointment at your earliest convenience:

${contactTextLines.join('\n')}

Thank you for your understanding — we look forward to seeing you soon.

Kind regards,
${BUSINESS_NAME}`;

  const contactHtml = BUSINESS_PHONE
    ? `call us on <strong style="color:#1c2321;">${BUSINESS_PHONE}</strong>, or simply reply to this email`
    : `simply reply to this email`;

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #f5f1e6;">
    <div style="background: #1c2321; padding: 20px 24px; text-align: center;">
      <div style="color: #ffd400; font-weight: bold; font-size: 18px; letter-spacing: 0.5px;">${BUSINESS_NAME}</div>
    </div>
    <div style="padding: 28px 24px;">
      <p style="font-size: 16px; color: #1c2321; margin: 0 0 16px;">Dear ${firstName},</p>
      <div style="display: inline-block; background: #b8262c1a; color: #b8262c; border: 2px solid #b8262c; border-radius: 4px; padding: 4px 12px; font-size: 12px; font-weight: bold; letter-spacing: 1px; margin-bottom: 16px;">
        BOOKING CANCELLED
      </div>
      <p style="font-size: 15px; color: #333d3a; line-height: 1.6; margin: 0 0 14px;">
        We're very sorry, but we've had to cancel your upcoming MOT booking with ${BUSINESS_NAME}. ${reasonSentence}
      </p>
      <p style="font-size: 15px; color: #333d3a; line-height: 1.6; margin: 0 0 20px;">
        We sincerely apologise for any inconvenience this may cause.
      </p>

      <p style="font-size: 13px; color: #55605c; margin: 0 0 8px; font-weight: 600;">For your reference, here are the details of the cancelled booking:</p>
      <table style="width: 100%; background: #fffdf8; border: 1px solid #d9d0ba; border-radius: 4px; border-collapse: collapse; margin-bottom: 24px;">
        <tr>
          <td style="padding: 12px 16px; color: #55605c; font-size: 13px;">Vehicle</td>
          <td style="padding: 12px 16px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${vehicle.make} ${vehicle.model}</td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">Registration</td>
          <td style="padding: 0 16px 12px; text-align: right;">
            <span style="display: inline-block; background: #ffd400; color: #1c2321; border: 2px solid #1c2321; border-radius: 3px; padding: 2px 8px; font-weight: bold; letter-spacing: 1px; font-size: 13px;">${vehicle.regNumber}</span>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">Date</td>
          <td style="padding: 0 16px 12px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${dateUK}</td>
        </tr>
        <tr>
          <td style="padding: 0 16px 12px; color: #55605c; font-size: 13px;">Time</td>
          <td style="padding: 0 16px 12px; color: #1c2321; font-size: 13px; font-weight: bold; text-align: right;">${timeStr}</td>
        </tr>
      </table>

      <p style="font-size: 15px; color: #333d3a; line-height: 1.6; margin: 0 0 18px;">
        We'd be glad to get you booked back in at a time that suits you. Please arrange a new appointment at your earliest convenience:
      </p>

      <div style="text-align: center; margin-bottom: 18px;">
        <a href="${rebookLink}" style="display: inline-block; background: #1c2321; color: #ffd400; text-decoration: none; font-weight: bold; padding: 14px 32px; border-radius: 4px; font-size: 15px; letter-spacing: 0.5px;">
          BOOK A NEW APPOINTMENT
        </a>
      </div>

      <p style="font-size: 13px; color: #55605c; text-align: center; line-height: 1.6; margin: 0 0 20px;">
        Prefer to speak to us? You can ${contactHtml}.
      </p>

      <p style="font-size: 14px; color: #333d3a; line-height: 1.6; margin: 0;">
        Thank you for your understanding — we look forward to seeing you soon.<br/>
        <span style="color:#8b8f83;">Kind regards,</span><br/>
        <strong style="color:#1c2321;">${BUSINESS_NAME}</strong>
      </p>
    </div>
    <div style="padding: 16px 24px; text-align: center; border-top: 1px solid #d9d0ba;">
      <p style="font-size: 12px; color: #8b8f83; margin: 0;">${BUSINESS_NAME}</p>
    </div>
  </div>`;

  return { subject, text, html };
}

async function sendCancellationEmail(customer, vehicle, booking) {
  if (!transporter) return false;
  if (!customer || !customer.email) return false;
  const { subject, text, html } = buildCancellationEmail(customer, vehicle, booking);
  try {
    await transporter.sendMail({
      from: `"${BUSINESS_NAME}" <${process.env.EMAIL_USER}>`,
      to: customer.email,
      subject,
      text,
      html
    });
    console.log(`✅ Cancellation email sent to ${customer.email} for ${vehicle.regNumber}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send cancellation email for ${vehicle.regNumber}:`, err.message);
    return false;
  }
}

async function sendReminderEmail(customer, vehicle, days) {
  if (!transporter) return false;
  if (!customer || !customer.email) return false;
  const { subject, text, html } = buildReminderEmail(customer, vehicle, days);
  try {
    await transporter.sendMail({
      from: `"${BUSINESS_NAME}" <${process.env.EMAIL_USER}>`,
      to: customer.email,
      subject,
      text,
      html
    });
    console.log(`✅ Reminder email sent to ${customer.email} for ${vehicle.regNumber} (${subject})`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send reminder email for ${vehicle.regNumber}:`, err.message);
    return false;
  }
}

async function checkAndSendReminders() {
  if (!transporter) return;
  const data = readData();
  let changed = false;
  for (const vehicle of data.vehicles) {
    if (!vehicle.motExpiry) continue;
    const days = daysUntil(vehicle.motExpiry);
    const stage = getStage(days);
    if (stage && stage !== vehicle.emailStage) {
      const customer = data.customers.find(c => c.id === vehicle.customerId);
      if (customer && customer.email) {
        await sendReminderEmail(customer, vehicle, days);
      }
      vehicle.emailStage = stage;
      changed = true;
    }
  }
  if (changed) writeData(data);
}

// Weekly automated backup — emails the full dataset to you as a JSON attachment.
// Set ADMIN_EMAIL to control where it's sent (defaults to EMAIL_USER, your Gmail).
async function sendBackupEmail() {
  if (!transporter) return;
  const recipient = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
  if (!recipient) return;
  try {
    const data = readData();
    const dateStr = new Date().toISOString().slice(0, 10);
    await transporter.sendMail({
      from: `"${BUSINESS_NAME}" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject: `Weekly backup – ${BUSINESS_NAME} (${dateStr})`,
      text: `Attached is your MOT Manager data backup as of ${dateStr}.\n\n${data.customers.length} customers, ${data.vehicles.length} vehicles, ${data.bookings.length} bookings.`,
      attachments: [{
        filename: `mot-manager-backup-${dateStr}.json`,
        content: JSON.stringify(data, null, 2)
      }]
    });
    console.log(`📦 Weekly backup email sent to ${recipient}`);
  } catch (err) {
    console.error('❌ Failed to send backup email:', err.message);
  }
}

// =========================
//   PUBLIC API (no auth) — MUST be registered before the admin auth
//   middleware below, and must never return other customers' data.
// =========================
const publicApiLimiter = rateLimit(30, 15 * 60 * 1000); // 30 requests / 15 min / IP
app.use('/api/public', publicApiLimiter);

// Business name/phone for the public page header — safe to expose, no customer data
app.get('/api/public/config', (req, res) => {
  res.json({ businessName: BUSINESS_NAME, businessPhone: BUSINESS_PHONE });
});

// Look up a single vehicle's MOT status by registration number.
// Returns only status info and that vehicle's own booking history — no customer details, no other vehicles.
app.get('/api/public/vehicle/:reg', (req, res) => {
  const data = readData();
  const target = normalizeReg(req.params.reg);
  const vehicle = data.vehicles.find(v => normalizeReg(v.regNumber) === target);
  if (!vehicle) return res.status(404).json({ error: 'No vehicle found with that registration number' });
  const bookings = data.bookings
    .filter(b => b.vehicleId === vehicle.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5)
    .map(b => ({ date: b.date, time: b.time, status: b.status }));
  res.json({
    regNumber: vehicle.regNumber,
    make: vehicle.make,
    model: vehicle.model,
    motExpiry: vehicle.motExpiry,
    daysUntil: vehicle.motExpiry ? daysUntil(vehicle.motExpiry) : null,
    bookings
  });
});

// Request a booking for a vehicle, identified by registration number.
app.post('/api/public/bookings', (req, res) => {
  const data = readData();
  const target = normalizeReg(req.body.regNumber);
  const vehicle = data.vehicles.find(v => normalizeReg(v.regNumber) === target);
  if (!vehicle) return res.status(404).json({ error: 'No vehicle found with that registration number' });
  if (!req.body.date) return res.status(400).json({ error: 'Please choose a date' });

  const booking = {
    id: generateId(),
    vehicleId: vehicle.id,
    date: req.body.date,
    time: req.body.time || '09:00',
    notes: req.body.notes ? String(req.body.notes).trim() : '',
    status: 'pending',
    source: 'public',
    createdAt: new Date().toISOString()
  };
  data.bookings.push(booking);
  writeData(data);
  res.status(201).json({ success: true });
});

// =========================
//   STATIC FRONTENDS
// =========================
// Admin CRM — protected
app.use('/admin', requireAdminAuth, express.static(path.join(__dirname, '../frontend/admin')));
// Public MOT-check page — open
app.use(express.static(path.join(__dirname, '../frontend/public')));

// =========================
//   ADMIN API (everything below this line requires login)
// =========================
app.use('/api', requireAdminAuth);

app.get('/api/data', (req, res) => {
  res.json(readData());
});

// Download the full dataset as a JSON file (admin only — protected by the middleware above)
app.get('/api/backup', (req, res) => {
  const data = readData();
  const filename = `mot-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(data, null, 2));
});

// ----- CUSTOMERS -----
app.get('/api/customers', (req, res) => {
  const data = readData();
  res.json(data.customers);
});

app.post('/api/customers', (req, res) => {
  const data = readData();
  const customer = {
    id: generateId(),
    name: req.body.name.trim(),
    phone: req.body.phone ? req.body.phone.trim() : '',
    email: req.body.email ? req.body.email.trim() : '',
    address: req.body.address ? req.body.address.trim() : '',
    createdAt: new Date().toISOString()
  };
  data.customers.push(customer);
  writeData(data);
  res.status(201).json(customer);
});

app.put('/api/customers/:id', (req, res) => {
  const data = readData();
  const idx = data.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  data.customers[idx] = {
    ...data.customers[idx],
    name: req.body.name.trim(),
    phone: req.body.phone ? req.body.phone.trim() : '',
    email: req.body.email ? req.body.email.trim() : '',
    address: req.body.address ? req.body.address.trim() : ''
  };
  writeData(data);
  res.json(data.customers[idx]);
});

app.delete('/api/customers/:id', (req, res) => {
  const data = readData();
  const id = req.params.id;
  data.customers = data.customers.filter(c => c.id !== id);
  data.vehicles.forEach(v => { if (v.customerId === id) v.customerId = null; });
  writeData(data);
  res.status(204).send();
});

// ----- VEHICLES -----
app.post('/api/vehicles', (req, res) => {
  const data = readData();
  const vehicle = {
    id: generateId(),
    ...req.body,
    customerId: req.body.customerId || null,
    emailStage: null,
    createdAt: new Date().toISOString()
  };
  data.vehicles.push(vehicle);
  writeData(data);
  res.status(201).json(vehicle);
});

app.put('/api/vehicles/:id', (req, res) => {
  const data = readData();
  const idx = data.vehicles.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Vehicle not found' });
  const oldExpiry = data.vehicles[idx].motExpiry;
  data.vehicles[idx] = { ...data.vehicles[idx], ...req.body, customerId: req.body.customerId || null };
  if (req.body.motExpiry && req.body.motExpiry !== oldExpiry) {
    data.vehicles[idx].emailStage = null;
  }
  writeData(data);
  res.json(data.vehicles[idx]);
});

app.delete('/api/vehicles/:id', (req, res) => {
  const data = readData();
  const id = req.params.id;
  data.vehicles = data.vehicles.filter(v => v.id !== id);
  data.bookings = data.bookings.filter(b => b.vehicleId !== id);
  writeData(data);
  res.status(204).send();
});

app.post('/api/vehicles/:id/send-reminder', async (req, res) => {
  if (!transporter) {
    return res.status(500).json({ error: 'Email is not configured on the server (missing EMAIL_USER / EMAIL_PASS)' });
  }
  const data = readData();
  const vehicle = data.vehicles.find(v => v.id === req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  if (!vehicle.motExpiry) return res.status(400).json({ error: 'This vehicle has no MOT expiry date set' });
  const customer = data.customers.find(c => c.id === vehicle.customerId);
  if (!customer || !customer.email) {
    return res.status(400).json({ error: 'This vehicle has no customer email on file' });
  }
  const days = daysUntil(vehicle.motExpiry);
  const sent = await sendReminderEmail(customer, vehicle, days);
  if (!sent) return res.status(500).json({ error: 'Failed to send email' });
  res.json({ success: true });
});

// ----- BOOKINGS -----
app.post('/api/bookings', (req, res) => {
  const data = readData();
  const booking = {
    id: generateId(),
    ...req.body,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  data.bookings.push(booking);
  writeData(data);
  res.status(201).json(booking);
});

app.put('/api/bookings/:id', (req, res) => {
  const data = readData();
  const idx = data.bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Booking not found' });
  data.bookings[idx] = { ...data.bookings[idx], ...req.body };
  writeData(data);
  res.json(data.bookings[idx]);
});

// Complete a booking with an MOT result (pass or fail), atomically.
// On a PASS, the vehicle's MOT expiry is rolled forward to the new date and its
// reminder stage is reset so future reminders fire again. On a FAIL, the result
// is recorded but the expiry is left untouched (the vehicle still needs a valid MOT).
app.post('/api/bookings/:id/complete', (req, res) => {
  const data = readData();
  const booking = data.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const result = req.body.result === 'fail' ? 'fail' : 'pass';
  const newExpiry = req.body.motExpiry;

  if (result === 'pass') {
    if (!newExpiry || !/^\d{4}-\d{2}-\d{2}$/.test(newExpiry)) {
      return res.status(400).json({ error: 'A valid new MOT expiry date (YYYY-MM-DD) is required for a pass' });
    }
  }

  booking.status = 'completed';
  booking.result = result;
  booking.completedAt = new Date().toISOString();
  // Record the expiry this test produced (pass only) so the vehicle's MOT
  // history can show it even after the vehicle's current expiry moves on.
  booking.resultExpiry = result === 'pass' ? newExpiry : null;

  let vehicle = null;
  if (result === 'pass' && booking.vehicleId) {
    vehicle = data.vehicles.find(v => v.id === booking.vehicleId);
    if (vehicle) {
      vehicle.motExpiry = newExpiry;
      vehicle.emailStage = null; // new expiry — allow reminders to fire again
    }
  }

  writeData(data);
  res.json({ booking, vehicle });
});

// Reschedule a booking's date/time and email the customer the new details.
// Only pending or confirmed bookings can be rescheduled. The email is best-effort:
// if it can't be sent (email not configured, no customer email), the save still succeeds.
app.put('/api/bookings/:id/reschedule', async (req, res) => {
  const data = readData();
  const booking = data.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.status === 'completed' || booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Only pending or confirmed bookings can be rescheduled' });
  }
  if (!req.body.date || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.date)) {
    return res.status(400).json({ error: 'A valid date (YYYY-MM-DD) is required' });
  }

  booking.date = req.body.date;
  if (req.body.time) booking.time = req.body.time;
  booking.updatedAt = new Date().toISOString();
  writeData(data);

  // Notify the customer of the new time (best-effort).
  let emailSent = false;
  const vehicle = data.vehicles.find(v => v.id === booking.vehicleId);
  const customer = vehicle ? data.customers.find(c => c.id === vehicle.customerId) : null;
  if (transporter && vehicle && customer && customer.email) {
    emailSent = await sendRescheduleEmail(customer, vehicle, booking);
  }

  res.json({ booking, emailSent });
});

// Cancel a booking and email the customer to let them know, with an offer to rebook.
// Only pending or confirmed bookings can be cancelled. The email is best-effort:
// if it can't be sent, the cancellation still succeeds.
app.post('/api/bookings/:id/cancel', async (req, res) => {
  const data = readData();
  const booking = data.bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.status === 'completed' || booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Only pending or confirmed bookings can be cancelled' });
  }

  booking.status = 'cancelled';
  booking.cancelledAt = new Date().toISOString();
  const reason = req.body.reason ? String(req.body.reason).trim() : '';
  if (reason) booking.cancellationReason = reason;
  writeData(data);

  // Notify the customer their booking was cancelled (best-effort).
  let emailSent = false;
  const vehicle = data.vehicles.find(v => v.id === booking.vehicleId);
  const customer = vehicle ? data.customers.find(c => c.id === vehicle.customerId) : null;
  if (transporter && vehicle && customer && customer.email) {
    emailSent = await sendCancellationEmail(customer, vehicle, booking);
  }

  res.json({ booking, emailSent });
});

app.delete('/api/bookings/:id', (req, res) => {
  const data = readData();
  data.bookings = data.bookings.filter(b => b.id !== req.params.id);
  writeData(data);
  res.status(204).send();
});

// ----- NOTIFICATIONS -----
app.post('/api/notifications', (req, res) => {
  const data = readData();
  const notif = {
    id: generateId(),
    ...req.body,
    dismissed: false,
    createdAt: new Date().toISOString()
  };
  data.notifications.unshift(notif);
  writeData(data);
  res.status(201).json(notif);
});

app.put('/api/notifications/:id', (req, res) => {
  const data = readData();
  const idx = data.notifications.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Notification not found' });
  data.notifications[idx] = { ...data.notifications[idx], ...req.body };
  writeData(data);
  res.json(data.notifications[idx]);
});

// Admin catch-all (SPA) — must stay password-protected too
app.get('/admin/*', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin/index.html'));
});

// Public catch-all (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ MOT Manager API running on port ${PORT}`);
  checkAndSendReminders();
  setInterval(checkAndSendReminders, 12 * 60 * 60 * 1000);
  setInterval(sendBackupEmail, 7 * 24 * 60 * 60 * 1000);
});
