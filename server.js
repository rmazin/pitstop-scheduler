const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data.json');
const ADMIN_PHONE = process.env.ADMIN_PHONE || '(555) 014-2088';

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { bookings: [], notifications: [] }; }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

function id() { return `ps_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`; }
function isoNow() { return new Date().toISOString(); }
function dateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || ''); }
function isBusinessDay(value) {
  if (!dateOnly(value)) return false;
  const day = new Date(`${value}T12:00:00`).getDay();
  return day >= 1 && day <= 6;
}
function validTime(value) { return /^(0[89]|1[0-7]):00$/.test(value || ''); }
function dateTimeLabel(date, time) {
  return new Date(`${date}T${time}:00`).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
}
function notify(data, booking, channel, kind, message) {
  data.notifications.push({ id: id(), bookingId: booking.id, channel, kind, to: channel === 'admin' ? ADMIN_PHONE : (channel === 'email' ? booking.customer.email : booking.customer.phone), message, createdAt: isoNow() });
}
function publicBooking(booking) {
  return { ...booking, customer: { ...booking.customer }, vehicle: { ...booking.vehicle } };
}

function serveStatic(req, res) {
  const requested = decodeURIComponent(req.url.split('?')[0]);
  const file = requested === '/' ? path.join(PUBLIC, 'index.html') : path.join(PUBLIC, requested.replace(/^\//, ''));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, content) => {
    if (err) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

async function handleApi(req, res, url) {
  const data = readData();
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/api/availability') {
      const date = url.searchParams.get('date');
      const bookings = data.bookings.filter(b => b.date === date && b.status !== 'canceled');
      return json(res, 200, { date, businessDay: isBusinessDay(date), capacity: 4, bookedCount: bookings.length, bookedTimes: bookings.map(b => b.time), bookings: bookings.map(publicBooking) });
    }
    if (req.method === 'POST' && url.pathname === '/api/bookings') {
      const body = await parseBody(req);
      const required = ['date', 'time', 'customer', 'vehicle'];
      if (!required.every(key => body[key])) return json(res, 400, { error: 'Date, time, customer, and vehicle details are required.' });
      if (!isBusinessDay(body.date)) return json(res, 400, { error: 'Bookings are available Monday through Saturday.' });
      if (!validTime(body.time)) return json(res, 400, { error: 'Choose an hourly drop-off between 8:00 AM and 5:00 PM.' });
      const active = data.bookings.filter(b => b.date === body.date && b.status !== 'canceled');
      if (active.length >= 4) return json(res, 409, { error: 'This day is full. Choose another day.' });
      if (active.some(b => b.time === body.time)) return json(res, 409, { error: 'That hour was just booked. Choose another time.' });
      const booking = { id: id(), date: body.date, time: body.time, status: 'scheduled', createdAt: isoNow(), customer: body.customer, vehicle: body.vehicle, jobDescription: '', total: null, paymentStatus: 'unpaid', invoice: null };
      data.bookings.push(booking);
      notify(data, booking, 'sms', 'confirmation', `PitStop appointment confirmed for ${dateTimeLabel(booking.date, booking.time)}. Reply CANCEL the day before to release the slot.`);
      notify(data, booking, 'email', 'confirmation', `Your PitStop drop-off is confirmed for ${dateTimeLabel(booking.date, booking.time)}.`);
      writeData(data);
      return json(res, 201, { booking: publicBooking(booking), notifications: data.notifications.filter(n => n.bookingId === booking.id) });
    }
    const cancelMatch = url.pathname.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const booking = data.bookings.find(b => b.id === cancelMatch[1]);
      if (!booking) return json(res, 404, { error: 'Booking not found.' });
      if (booking.status === 'canceled') return json(res, 200, { booking: publicBooking(booking) });
      booking.status = 'canceled'; booking.canceledAt = isoNow();
      notify(data, booking, 'sms', 'cancellation', `Your PitStop appointment for ${dateTimeLabel(booking.date, booking.time)} was canceled. The hour is available again.`);
      writeData(data);
      return json(res, 200, { booking: publicBooking(booking) });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      const today = new Date().toISOString().slice(0, 10);
      const openCarryovers = data.bookings.filter(b => b.date < today && b.status !== 'canceled' && b.status !== 'completed');
      const completed = data.bookings.filter(b => b.status === 'completed');
      return json(res, 200, { today, openCarryovers: openCarryovers.map(publicBooking), totalRevenue: completed.reduce((sum, b) => sum + Number(b.total || 0), 0), outstanding: data.bookings.filter(b => b.status === 'completed' && b.paymentStatus !== 'paid').length, notifications: data.notifications.slice(-20).reverse() });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/bookings') {
      const date = url.searchParams.get('date');
      return json(res, 200, { date, bookings: data.bookings.filter(b => b.date === date && b.status !== 'canceled').map(publicBooking), openCarryovers: data.bookings.filter(b => b.date < date && b.status !== 'canceled' && b.status !== 'completed').map(publicBooking) });
    }
    const completeMatch = url.pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/complete$/);
    if (req.method === 'POST' && completeMatch) {
      const booking = data.bookings.find(b => b.id === completeMatch[1]);
      if (!booking) return json(res, 404, { error: 'Booking not found.' });
      const body = await parseBody(req);
      const total = Number(body.total);
      if (!body.jobDescription || !Number.isFinite(total) || total < 0) return json(res, 400, { error: 'Add a job description and a valid total.' });
      booking.status = 'completed'; booking.completedAt = isoNow(); booking.jobDescription = body.jobDescription; booking.total = total; booking.paymentStatus = 'unpaid';
      booking.invoice = { number: `PS-${new Date().getFullYear()}-${String(data.bookings.indexOf(booking) + 1).padStart(4, '0')}`, issuedAt: isoNow(), paymentUrl: `${process.env.STRIPE_PAYMENT_LINK_BASE || 'https://checkout.stripe.com/pay/cs_demo_'}${booking.id}` };
      notify(data, booking, 'sms', 'invoice', `Your PitStop work order ${booking.invoice.number} is ready for $${total.toFixed(2)}. Pay online: ${booking.invoice.paymentUrl} or pay cash at pickup.`);
      notify(data, booking, 'email', 'invoice', `Work order ${booking.invoice.number} for ${booking.vehicle.year} ${booking.vehicle.make} ${booking.vehicle.model}. Total: $${total.toFixed(2)}.`);
      writeData(data);
      return json(res, 200, { booking: publicBooking(booking) });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/daily-digest') {
      const date = (await parseBody(req)).date;
      const dayBookings = data.bookings.filter(b => b.date === date && b.status !== 'canceled');
      const carryovers = data.bookings.filter(b => b.date < date && b.status !== 'canceled' && b.status !== 'completed');
      const message = `PitStop ${date}: ${dayBookings.length} scheduled vehicle(s), ${carryovers.length} carryover job(s).`;
      data.notifications.push({ id: id(), channel: 'admin', kind: 'daily-digest', to: ADMIN_PHONE, message, createdAt: isoNow() });
      writeData(data);
      return json(res, 200, { message, scheduled: dayBookings.length, carryovers: carryovers.length, sentTo: ADMIN_PHONE });
    }
    return json(res, 404, { error: 'API route not found.' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'The server could not complete that request.' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res);
});

if (!fs.existsSync(DATA_FILE)) writeData({ bookings: [], notifications: [] });
server.listen(PORT, () => console.log(`PitStop Scheduler running at http://localhost:${PORT}`));
