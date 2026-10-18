// A fixed-device application queue. No forwarding, arbitrary URLs, or shell API.
import {html,css,js} from './console-ui.mjs';
const ACTIONS = new Set(['status', 'screenshot', 'source', 'home', 'launch', 'tap', 'swipe', 'type', 'foreground', 'sequence']);
const encoder = new TextEncoder();
const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const json = (body, status = 200) => Response.json(body, {status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
}});
async function equalSecret(a, b) {
  if (!a || !b) return false;
  const [x, y] = await Promise.all([a, b].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const xx = new Uint8Array(x), yy = new Uint8Array(y);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= xx[i] ^ yy[i];
  return difference === 0;
}
async function roleOf(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ') || h.length > 256) fail(401, 'Authentication required');
  const value = h.slice(7);
  for (const [role, name] of [['controller', 'CONTROLLER_TOKEN'], ['agent', 'AGENT_TOKEN'], ['device', 'DEVICE_TOKEN'], ['bot', 'BOT_TOKEN']]) {
    if (await equalSecret(value, env[name])) return role;
  }
  fail(401, 'Authentication required');
}
function requireRole(role, allowed) { if (!allowed.includes(role)) fail(403, 'Role is not allowed'); }
async function bodyOf(request, limit = 900000) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'JSON required');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Request body required');
  const chunks = []; let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) { await reader.cancel(); fail(413, 'Body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'Invalid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Object required');
  return data;
}
export function validateOperation(input) {
  if (!ACTIONS.has(input.action)) fail(400, 'Unsupported operation');
  if (Object.keys(input).some(k => !['action', 'args'].includes(k))) fail(400, 'Unknown operation field');
  const args = input.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail(400, 'Arguments must be an object');
  const keys = {
    status: [], screenshot: [], source: [], home: [], foreground: [],
    launch: ['bundle_id'], tap: ['x', 'y'],
    swipe: ['from_x', 'from_y', 'to_x', 'to_y', 'duration'], type: ['text'],
    sequence: ['steps', 'capture_delay_ms'],
  }[input.action];
  if (Object.keys(args).some(k => !keys.includes(k))) fail(400, 'Unknown argument');
  if (input.action === 'launch' && (typeof args.bundle_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/.test(args.bundle_id))) fail(400, 'Invalid bundle identifier');
  for (const key of keys.filter(k => /^(x|y|from_|to_)/.test(k))) {
    if (!Number.isFinite(args[key]) || args[key] < 0 || args[key] > 3000) fail(400, 'Invalid coordinate');
  }
  if (input.action === 'swipe' && args.duration !== undefined && (!Number.isFinite(args.duration) || args.duration < 0.05 || args.duration > 5)) fail(400, 'Invalid duration');
  if (input.action === 'type' && (typeof args.text !== 'string' || args.text.length > 4096)) fail(400, 'Invalid text');
  if (input.action === 'sequence') {
    if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 12) fail(400, 'Expected 1 to 12 local steps');
    const captureDelay=args.capture_delay_ms ?? 0;
    if (!Number.isInteger(captureDelay) || captureDelay < 0 || captureDelay > 2000) fail(400, 'Invalid capture delay');
    let duration=captureDelay;
    for (const step of args.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(k=>!['action','args'].includes(k))) fail(400, 'Invalid sequence step');
      if (step.action === 'wait') {
        if (!step.args || Object.keys(step.args).length !== 1 || !Number.isInteger(step.args.duration_ms) || step.args.duration_ms < 0 || step.args.duration_ms > 2000) fail(400, 'Invalid local wait');
        duration+=step.args.duration_ms;
      } else if (['tap','swipe'].includes(step.action)) {
        validateOperation(step);
        duration+=step.action==='tap'?40:50+1000*(step.args.duration ?? 0.25);
      } else fail(400, 'Only tap, swipe and wait are allowed inside a sequence');
    }
    if (duration > 8000) fail(400, 'Sequence exceeds eight seconds');
  }
  return {action: input.action, args};
}
function parseJob(row) {
  if (!row) return null;
  return {...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null};
}
async function insertJob(env, kind, payload, key) {
  if (key && !/^[a-f0-9-]{36}$/.test(key)) fail(400, 'Invalid idempotency key');
  const id = key || crypto.randomUUID(), now = Date.now();
  const previous = await env.DB.prepare('SELECT kind,payload,status,created_at FROM jobs WHERE id=? AND device_id=?').bind(id, env.DEVICE_ID).first();
  if (previous) {
    if (previous.kind !== kind || previous.payload !== JSON.stringify(payload)) fail(409, 'Idempotency key already used');
    return {id, status: previous.status, created_at: previous.created_at};
  }
  // No automatic redelivery: a duplicate tap or text entry could have side effects.
  await env.DB.prepare('INSERT INTO jobs(id,kind,device_id,status,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, kind, env.DEVICE_ID, 'pending', JSON.stringify(payload), now, now + (kind === 'goal' ? 900000 : 180000)).run();
  await env.DB.prepare('DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE expires_at < ? LIMIT 100)').bind(now - 86400000).run();
  return {id, status: 'pending', created_at: now};
}
async function claimJob(env, kind) {
  const now = Date.now();
  const row = await env.DB.prepare(`UPDATE jobs SET status='running',claimed_at=? WHERE id=(SELECT id FROM jobs WHERE kind=? AND device_id=? AND status='pending' AND expires_at>? ORDER BY created_at,id LIMIT 1) AND status='pending' RETURNING *`)
    .bind(now, kind, env.DEVICE_ID, now).first();
  return parseJob(row);
}
async function finishJob(env, kind, body) {
  if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.id)) fail(400, 'Invalid task identifier');
  if (!['done', 'error'].includes(body.status)) fail(400, 'Invalid result status');
  const serialized = JSON.stringify(body.result ?? null);
  if (encoder.encode(serialized).length > 800000) fail(413, 'Result too large');
  const row = await env.DB.prepare('SELECT status,result FROM jobs WHERE id=? AND kind=? AND device_id=?')
    .bind(body.id, kind, env.DEVICE_ID).first();
  if (!row) fail(404, 'Task not found');
  if (['done', 'error'].includes(row.status)) {
    if (row.status !== body.status || row.result !== serialized) fail(409, 'Result already recorded');
    return {recorded: true, duplicate: true};
  }
  if (row.status !== 'running') fail(409, 'Task was not claimed');
  await env.DB.prepare("UPDATE jobs SET status=?,result=?,completed_at=? WHERE id=? AND status='running'")
    .bind(body.status, serialized, Date.now(), body.id).run();
  return {recorded: true};
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (url.protocol !== 'https:') return json({error: 'HTTPS required'}, 400);
      if (request.method === 'GET' && ['/', '/console.css', '/console.mjs'].includes(path)) {
        const content = path === '/' ? html : path === '/console.css' ? css : js;
        return new Response(content, {headers:{'Content-Type':path==='/'?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',
          'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"}});
      }
      if (path === '/health' && request.method === 'GET') return json({ok: true, protocol: 1});
      const role = await roleOf(request, env);
      if (path === '/v1/device/claim' && request.method === 'POST') {
        requireRole(role, ['device']);
        const body = await bodyOf(request, 4000);
        if (body.device_id !== env.DEVICE_ID) fail(403, 'Wrong device');
        const metadata = JSON.stringify({version: String(body.version || '').slice(0, 40), uptime: Number(body.uptime) || 0});
        await env.DB.prepare('INSERT INTO device_state(id,last_seen,metadata) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,metadata=excluded.metadata')
          .bind(env.DEVICE_ID, Date.now(), metadata).run();
        return json({task: await claimJob(env, 'operation')});
      }
      if (path === '/v1/device/result' && request.method === 'POST') {
        requireRole(role, ['device']); return json(await finishJob(env, 'operation', await bodyOf(request)));
      }
      if (path === '/v1/agent/claim' && request.method === 'POST') {
        requireRole(role, ['agent']); return json({task: await claimJob(env, 'goal')});
      }
      if (path === '/v1/agent/result' && request.method === 'POST') {
        requireRole(role, ['agent']); return json(await finishJob(env, 'goal', await bodyOf(request, 40000)));
      }
      if (path === '/v1/device' && request.method === 'GET') {
        requireRole(role, ['controller', 'agent', 'bot']);
        return json(await env.DB.prepare('SELECT * FROM device_state WHERE id=?').bind(env.DEVICE_ID).first());
      }
      const kind = path.startsWith('/v1/operations') ? 'operation' : path.startsWith('/v1/goals') ? 'goal' : null;
      const prefix = kind === 'operation' ? '/v1/operations' : '/v1/goals';
      if (kind && path === prefix && request.method === 'POST') {
        requireRole(role, kind === 'goal' ? ['controller'] : ['controller', 'agent', 'bot']);
        const body = await bodyOf(request, 16000);
        if (kind === 'goal') {
          if (Object.keys(body).some(k => k !== 'prompt') || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000) fail(400, 'Invalid goal');
          return json(await insertJob(env, kind, {prompt: body.prompt}, request.headers.get('Idempotency-Key')), 201);
        }
        return json(await insertJob(env, kind, validateOperation(body), request.headers.get('Idempotency-Key')), 201);
      }
      if (kind && request.method === 'GET' && path.startsWith(prefix + '/')) {
        requireRole(role, kind === 'goal' ? ['controller', 'agent'] : ['controller', 'agent', 'bot']);
        const id = path.slice(prefix.length + 1);
        if (!/^[a-f0-9-]{36}$/.test(id)) fail(404, 'Task not found');
        const row = await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND kind=? AND device_id=?').bind(id, kind, env.DEVICE_ID).first();
        if (!row) fail(404, 'Task not found');
        return json(parseJob(row));
      }
      return json({error: 'Route not found'}, 404);
    } catch (error) {
      return json({error: error.status ? error.message : 'Internal queue error'}, error.status || 500);
    }
  },
};
