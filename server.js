#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = __dirname;
const HOST = process.env.SEESTAR_HOST || '192.168.8.24';
const KEY_PATH = process.env.SEESTAR_KEY_PATH || path.join(ROOT, '..', 'seestar-cli', 'seestar.pem');
const PORT = Number(process.env.PORT || 8787);
const ALPACA_PORT = Number(process.env.SEESTAR_ALPACA_PORT || 32323);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function contentType(file) {
  return file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
}

class Scope {
  constructor() { this.key = fs.readFileSync(KEY_PATH); this.id = 1; this.buffer = ''; this.waiters = new Map(); }
  fail(error) {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
  async open() {
    this.socket = net.createConnection({ host: HOST, port: 4700 });
    this.socket.setKeepAlive(true, 10000);
    this.socket.setTimeout(15000);
    this.socket.on('data', data => this.receive(data));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Scope connection closed.')));
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => { if (!settled) { settled = true; callback(value); } };
      this.socket.once('connect', () => finish(resolve));
      this.socket.once('error', error => finish(reject, error));
      this.socket.once('timeout', () => finish(reject, new Error('Scope connection timed out.')));
    });
    await this.auth();
  }
  receive(data) {
    this.buffer += data.toString();
    let n;
    while ((n = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, n).trim(); this.buffer = this.buffer.slice(n + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line); const waiter = this.waiters.get(message.id);
        if (waiter) { this.waiters.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
      } catch { /* ignore telemetry fragments */ }
    }
  }
  request(method, params, verify = true) {
    const id = this.id++; const payload = { id, method }; if (verify) payload.verify = true; if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`No reply for ${method}.`)); }, 15000);
      this.waiters.set(id, { resolve, reject, timer });
      if (!this.socket?.writable) { clearTimeout(timer); this.waiters.delete(id); reject(new Error('Scope connection is not writable.')); return; }
      this.socket.write(JSON.stringify(payload) + '\r\n');
    });
  }
  async auth() {
    const challenge = await this.request('get_verify_str', undefined, false);
    if (challenge.code !== 0) throw new Error('Scope did not provide a login challenge.');
    const signer = crypto.createSign('RSA-SHA1'); signer.update(challenge.result.str); signer.end();
    const verified = await this.request('verify_client', { sign: signer.sign(this.key, 'base64'), data: challenge.result.str }, false);
    if (verified.code !== 0) throw new Error('Scope rejected local authentication.');
    const confirmation = await this.request('pi_is_verified', undefined, false);
    if (confirmation.code !== 0) throw new Error('Scope did not confirm authentication.');
  }
  close() { this.socket?.end(); }
}

async function call(method, params) {
  const scope = new Scope();
  try { await scope.open(); const reply = await scope.request(method, params); if (reply.code !== 0) throw new Error(reply.error || `Scope error ${reply.code}`); return reply.result; }
  finally { scope.close(); }
}

function alpacaHealth() {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: HOST,
      port: ALPACA_PORT,
      path: '/management/v1/description?ClientID=1&ClientTransactionID=1',
      timeout: 3_000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (response.statusCode !== 200 || payload.ErrorNumber) throw new Error(payload.ErrorMessage || `Alpaca returned HTTP ${response.statusCode}.`);
          resolve({ online: true, server: payload.Value?.ServerName, version: payload.Value?.ManufacturerVersion });
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Alpaca health check timed out.')));
    request.on('error', reject);
  });
}

async function readStatus() {
  const alpaca = alpacaHealth().catch(error => ({ online: false, error: error.message }));
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const scope = new Scope();
    try {
      await scope.open();
      // Keep a status refresh to one authenticated connection. The older version
      // opened two parallel sessions every time the dashboard refreshed.
      const device = await scope.request('get_device_state');
      const app = await scope.request('iscope_get_app_state');
      if (device.code !== 0 || app.code !== 0) throw new Error(device.error || app.error || 'Scope rejected a status request.');
      return { device: device.result, app: app.result, alpaca: await alpaca, rpcError: null };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await pause(750);
    } finally {
      scope.close();
    }
  }
  const alpacaStatus = await alpaca;
  if (alpacaStatus.online) return { device: null, app: null, alpaca: alpacaStatus, rpcError: lastError?.message || 'Native control connection failed.' };
  throw lastError;
}

function safeStatus(device, app, alpaca, rpcError) {
  const d = device || {}; const p = d.pi_status || {}; const view = app?.View || {};
  return {
    connection: {
      native: { online: !rpcError, error: rpcError || undefined },
      alpaca: alpaca || { online: false, error: 'Alpaca was not checked.' },
    },
    device: { model: d.device?.product_model, firmware: d.device?.firmware_ver_string },
    power: { battery: p.battery_capacity, charging: p.charge_online, temperature: p.temp, overtemp: p.is_overtemp },
    storage: d.storage?.storage_volume?.[0],
    mount: d.mount,
    view: { state: view.state, stage: view.stage, target: view.target_name, coords: view.target_ra_dec, stack: view.Stack ? { state: view.Stack.state, stacked: view.Stack.stacked_frame, dropped: view.Stack.dropped_frame, exposureMs: view.Stack.Exposure?.exp_ms } : null }
  };
}

async function handler(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/api/status') {
      const { device, app, alpaca, rpcError } = await readStatus();
      return json(res, 200, safeStatus(device, app, alpaca, rpcError));
    }
    if (req.method === 'POST' && req.url === '/api/action') {
      let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw || '{}');
      let result;
      if (body.action === 'goto') {
        const ra = Number(body.ra), dec = Number(body.dec);
        if (!body.name || !Number.isFinite(ra) || ra < 0 || ra >= 24 || !Number.isFinite(dec) || dec < -90 || dec > 90) throw new Error('Enter a target name, RA (0–24 hours), and Dec (−90–90°).');
        const params = { mode: 'star', target_name: body.name.trim(), target_ra_dec: [ra, dec], lp_filter: Boolean(body.lpFilter) };
        if (body.mosaic) params.mosaic = body.mosaic;
        result = await call('iscope_start_view', params);
      } else if (body.action === 'setExposure') {
        const milliseconds = Number(body.milliseconds);
        if (!Number.isInteger(milliseconds) || milliseconds < 1000 || milliseconds > 60000) throw new Error('Choose an exposure between 1 and 60 seconds.');
        const current = await call('get_setting');
        result = await call('set_setting', { expert_mode: true, exp_ms: { ...(current.exp_ms || {}), stack_l: milliseconds } });
      } else if (body.action === 'stack') result = await call('iscope_start_stack', { restart: false });
      else if (body.action === 'stop') result = await call('iscope_stop_view', { stage: 'Stack' });
      else if (body.action === 'park') result = await call('scope_park');
      else throw new Error('Unknown action.');
      return json(res, 200, { ok: true, result });
    }
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    const requested = path.resolve(ROOT, 'public', file);
    if (!requested.startsWith(path.join(ROOT, 'public'))) throw new Error('Not found.');
    return fs.createReadStream(requested).on('error', () => { res.writeHead(404); res.end('Not found'); }).pipe(res.writeHead(200, { 'Content-Type': contentType(requested), 'Cache-Control': 'no-store' }));
  } catch (error) { json(res, 500, { ok: false, error: error.message }); }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }

if (!fs.existsSync(KEY_PATH)) throw new Error(`Missing SeeStar key: ${KEY_PATH}`);
http.createServer(handler).listen(PORT, '127.0.0.1', () => console.log(`SeeStar Dashboard ready at http://127.0.0.1:${PORT}`));
