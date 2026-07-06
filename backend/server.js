const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Path to the JSON database file
const DATA_FILE = path.join(__dirname, 'data.json');

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
//   ADMIN AUTH (Basic Auth)
// =========================
// Protects the /admin page and every /api route except the public ones
// registered below. Set ADMIN_PASSWORD (and optionally ADMIN_USER) as
// environment variables on Render.
function requireAdminAuth(req, res, next) {
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedPass) {
    console.warn('⚠️  ADMIN_PASSWORD is not set — the admin area is currently UNPROTECTED.');
    return next();
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
    return next();
  }
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
  let subject, headline;
  if (days < 0) {
    subject = `MOT overdue – ${vehicle.regNumber}`;
    headline = `Your MOT for ${vehicle.regNumber} expired on ${expiryUK}. Please book a test as soon as possible — driving without a valid MOT can invalidate your insurance.`;
  } else if (days <= 7) {
    subject = `MOT due in ${days} day${days === 1 ? '' : 's'} – ${vehicle.regNumber}`;
    headline = `Your MOT for ${vehicle.regNumber} is due in ${days} day${days === 1 ? '' : 's'}, on ${expiryUK}.`;
  } else {
    subject = `MOT reminder – ${vehicle.regNumber} due ${expiryUK}`;
    headline = `This is a friendly reminder that your MOT for ${vehicle.regNumber} is due on ${expiryUK} (${days} days from now).`;
  }
  const text =
`Hi ${customer.name},

${headline}

Vehicle: ${vehicle.make} ${vehicle.model}
Registration: ${vehicle.regNumber}

Reply to this email or get in touch to book your test.

Thanks,
The Workshop Team`;
  return { subject, text };
}

async function sendReminderEmail(customer, vehicle, days) {
  if (!transporter) return false;
  if (!customer || !customer.email) return false;
  const { subject, text } = buildReminderEmail(customer, vehicle, days);
  try {
    await transporter.sendMail({
      from: `"MOT Manager" <${process.env.EMAIL_USER}>`,
      to: customer.email,
      subject,
      text
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

// =========================
//   PUBLIC API (no auth) — MUST be registered before the admin auth
//   middleware below, and must never return other customers' data.
// =========================

// Look up a single vehicle's MOT status by registration number.
// Returns only status info — no customer details, no other vehicles.
app.get('/api/public/vehicle/:reg', (req, res) => {
  const data = readData();
  const target = normalizeReg(req.params.reg);
  const vehicle = data.vehicles.find(v => normalizeReg(v.regNumber) === target);
  if (!vehicle) return res.status(404).json({ error: 'No vehicle found with that registration number' });
  res.json({
    regNumber: vehicle.regNumber,
    make: vehicle.make,
    model: vehicle.model,
    motExpiry: vehicle.motExpiry,
    daysUntil: vehicle.motExpiry ? daysUntil(vehicle.motExpiry) : null
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
});
