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
app.use(express.static(path.join(__dirname, '../frontend')));

const DATA_FILE = path.join(__dirname, 'data.json');

// ---- Helpers ----
function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    const defaultData = { customers: [], vehicles: [], bookings: [], notifications: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---- Email setup ----
const emailConfigured = !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
const transporter = emailConfigured
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS, // Must be a Gmail App Password
      }
    })
  : null;

if (!emailConfigured) {
  console.warn('⚠️ EMAIL_USER / EMAIL_PASS not set — MOT reminder emails are disabled.');
}

function daysUntil(dateStr) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00');
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
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
    headline = `Your MOT for ${vehicle.regNumber} expired on ${expiryUK}. Please book a test immediately – driving without a valid MOT can invalidate your insurance.`;
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
    console.log(`✅ Reminder email sent to ${customer.email} for ${vehicle.regNumber}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send reminder email for ${vehicle.regNumber}:`, err.message);
    return false;
  }
}

// ---- The core reminder check (idempotent) ----
async function checkAndSendReminders() {
  if (!transporter) return;
  const data = readData();
  let changed = false;
  const now = new Date().toISOString();

  for (const vehicle of data.vehicles) {
    if (!vehicle.motExpiry) continue;
    const days = daysUntil(vehicle.motExpiry);
    const stage = getStage(days);

    // Only send if the stage changed AND we haven't sent an email for this stage recently (safety net)
    if (stage && stage !== vehicle.emailStage) {
      const customer = data.customers.find(c => c.id === vehicle.customerId);
      if (customer && customer.email) {
        const sent = await sendReminderEmail(customer, vehicle, days);
        if (sent) {
          vehicle.emailStage = stage;
          vehicle.lastEmailSent = now; // Extra safety: track exact time
          changed = true;
        }
      }
    }
  }
  if (changed) writeData(data);
}

// ---- API Routes (same as yours) ----
app.get('/api/data', (req, res) => res.json(readData()));

app.get('/api/customers', (req, res) => res.json(readData().customers));

app.post('/api/customers', (req, res) => {
  const data = readData();
  const customer = { id: generateId(), name: req.body.name.trim(), phone: req.body.phone?.trim() || '', email: req.body.email?.trim() || '', address: req.body.address?.trim() || '', createdAt: new Date().toISOString() };
  data.customers.push(customer);
  writeData(data);
  res.status(201).json(customer);
});

app.put('/api/customers/:id', (req, res) => {
  const data = readData();
  const idx = data.customers.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  data.customers[idx] = { ...data.customers[idx], name: req.body.name.trim(), phone: req.body.phone?.trim() || '', email: req.body.email?.trim() || '', address: req.body.address?.trim() || '' };
  writeData(data);
  res.json(data.customers[idx]);
});

app.delete('/api/customers/:id', (req, res) => {
  const data = readData();
  data.customers = data.customers.filter(c => c.id !== req.params.id);
  data.vehicles.forEach(v => { if (v.customerId === req.params.id) v.customerId = null; });
  writeData(data);
  res.status(204).send();
});

app.post('/api/vehicles', (req, res) => {
  const data = readData();
  const vehicle = { id: generateId(), ...req.body, customerId: req.body.customerId || null, emailStage: null, lastEmailSent: null, createdAt: new Date().toISOString() };
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
    data.vehicles[idx].emailStage = null; // Reset stage for the new date
  }
  writeData(data);
  res.json(data.vehicles[idx]);
});

app.delete('/api/vehicles/:id', (req, res) => {
  const data = readData();
  data.vehicles = data.vehicles.filter(v => v.id !== req.params.id);
  data.bookings = data.bookings.filter(b => b.vehicleId !== req.params.id);
  writeData(data);
  res.status(204).send();
});

app.post('/api/vehicles/:id/send-reminder', async (req, res) => {
  if (!transporter) return res.status(500).json({ error: 'Email not configured' });
  const data = readData();
  const vehicle = data.vehicles.find(v => v.id === req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  if (!vehicle.motExpiry) return res.status(400).json({ error: 'No MOT expiry date' });
  const customer = data.customers.find(c => c.id === vehicle.customerId);
  if (!customer || !customer.email) return res.status(400).json({ error: 'No customer email' });
  const days = daysUntil(vehicle.motExpiry);
  const sent = await sendReminderEmail(customer, vehicle, days);
  if (!sent) return res.status(500).json({ error: 'Email failed' });
  res.json({ success: true });
});

app.post('/api/bookings', (req, res) => {
  const data = readData();
  const booking = { id: generateId(), ...req.body, status: 'pending', createdAt: new Date().toISOString() };
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

app.post('/api/notifications', (req, res) => {
  const data = readData();
  const notif = { id: generateId(), ...req.body, dismissed: false, createdAt: new Date().toISOString() };
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

// ---- Start server & schedule ----
app.listen(PORT, () => {
  console.log(`✅ MOT Manager with Email running on port ${PORT}`);
  checkAndSendReminders(); // Run once immediately on boot
  setInterval(checkAndSendReminders, 12 * 60 * 60 * 1000); // Then every 12 hours
});
