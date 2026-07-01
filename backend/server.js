const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve the frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

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

// =========================
//   API ROUTES
// =========================

// GET full state (includes customers, vehicles, bookings, notifications)
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
  // Remove the customer
  data.customers = data.customers.filter(c => c.id !== id);
  // Unlink this customer from all their vehicles (optional, but keeps vehicles safe)
  data.vehicles.forEach(v => {
    if (v.customerId === id) {
      v.customerId = null;
    }
  });
  writeData(data);
  res.status(204).send();
});

// ----- VEHICLES (with customer linking) -----
app.post('/api/vehicles', (req, res) => {
  const data = readData();
  const vehicle = {
    id: generateId(),
    ...req.body,
    customerId: req.body.customerId || null,
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
  data.vehicles[idx] = { ...data.vehicles[idx], ...req.body, customerId: req.body.customerId || null };
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

// Catch-all for SPA (serves index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ MOT Manager (CRM) API running on port ${PORT}`);
});
