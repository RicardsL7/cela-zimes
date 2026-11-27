// B17 (audits 2): lokāls „Supabase” E2E testiem — ĪSTI Supabase servisi, bez Docker:
//   PostgreSQL (lokālais vai CI konteiners) + Supabase Auth (GoTrue, tā pati programma, ko lieto Supabase) +
//   PostgREST (REST API) + visas supabase/*.sql migrācijas pēc supabase/ORDER.txt.
// Lietotne pārlūkā runā ar tiem tieši tāpat kā ar growlab.cc Supabase (/auth/v1, /rest/v1) — tests/e2e/rides-flow.js.
// Datubāze cz_e2e tiek izveidota no jauna un beigās izdzēsta. Tikai localhost — NEKAD Supabase / produkcija.
//
// Vajag: psql; PostgreSQL superlietotājs (PGHOST/PGPORT/PGUSER/PGPASSWORD); programmas auth un postgrest mapē
// CZ_E2E_BIN (CI tās lejupielādē ar fiksētu versiju un SHA-256 — .github/workflows/tests.yml, darbs „e2e”).
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'), path = require('path'), http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const DB = 'cz_e2e';
// Tikai šai pagaidu lokālajai datubāzei / testam (tādas pašas kā tests/e2e/bootstrap.sql). Nav nevienas īstas atslēgas.
const LOCAL_PW = 'cz-e2e-local';
const JWT_SECRET = 'cz-e2e-local-jwt-secret-only-for-tests-0000';

function b64u(b) { return Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function czE2eJwt(payload, secret = JWT_SECRET) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  return h + '.' + p + '.' + b64u(crypto.createHmac('sha256', secret).update(h + '.' + p).digest());
}
// Tikai lokālā adrese — drošības pārbaude (lai tests nekad neaiztiktu attālu datubāzi)
function czE2eLocalHost(h) { return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('/'); }
// Migrāciju faili pēc ORDER.txt
function czE2eOrder(txt) {
  return txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.split(/\s+/)[1]);
}

const wait = ms => new Promise(r => setTimeout(r, ms));
function get(url) {
  return new Promise(res => {
    const rq = http.get(url, r => { r.resume(); res(r.statusCode); });
    rq.on('error', () => res(0)); rq.setTimeout(2000, () => { rq.destroy(); res(0); });
  });
}

async function czE2eStart({ bin = process.env.CZ_E2E_BIN, authPort = 9999, restPort = 3000, log = () => {} } = {}) {
  const pg = { host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || '5432', user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '' };
  if (!czE2eLocalHost(pg.host)) throw new Error('E2E: PGHOST jābūt lokālam (' + pg.host + ')');
  if (!bin || !fs.existsSync(path.join(bin, 'auth')) || !fs.existsSync(path.join(bin, 'postgrest'))) throw new Error('E2E: CZ_E2E_BIN — nav auth / postgrest');
  // Porti brīvi? (cits — piem. iepriekšējā testa — Auth / PostgREST atbildētu ar citu atslēgu un tests maldinātu)
  for (const port of [authPort, restPort]) if (await get(`http://127.0.0.1:${port}/`)) throw new Error('E2E: ports ' + port + ' jau aizņemts');
  const tcpHost = pg.host.startsWith('/') || pg.host === 'localhost' ? '127.0.0.1' : pg.host;
  const env = { ...process.env, PGHOST: pg.host, PGPORT: pg.port, PGUSER: pg.user, PGPASSWORD: pg.password };
  const psql = (args, db = DB) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  psql(['-c', `drop database if exists ${DB} with (force)`, '-c', `create database ${DB}`], 'postgres');
  psql(['-f', path.join(__dirname, 'bootstrap.sql')]);
  log('datubāze ' + DB + ' + lomas');

  const dbUrl = (user) => `postgres://${user}:${LOCAL_PW}@${tcpHost}:${pg.port}/${DB}`;
  const authEnv = {
    ...process.env, GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: dbUrl('supabase_auth_admin'),
    GOTRUE_JWT_SECRET: JWT_SECRET, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_JWT_ADMIN_ROLES: 'service_role', API_EXTERNAL_URL: 'https://app.test/auth/v1', GOTRUE_SITE_URL: 'https://app.test',
    GOTRUE_API_HOST: '127.0.0.1', PORT: String(authPort), GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'true',
    GOTRUE_MAILER_AUTOCONFIRM: 'true', GOTRUE_RATE_LIMIT_ANONYMOUS_USERS: '1000', GOTRUE_LOG_LEVEL: 'warn',
  };
  execFileSync(path.join(bin, 'auth'), ['migrate'], { env: authEnv, cwd: bin, stdio: ['ignore', 'pipe', 'pipe'] });
  log('Auth migrācijas (auth shēma)');
  const files = czE2eOrder(fs.readFileSync(path.join(ROOT, 'supabase', 'ORDER.txt'), 'utf8'));
  for (const f of files) psql(['-f', path.join(ROOT, 'supabase', f)]);
  log(files.length + ' migrācijas no ORDER.txt');

  const procs = [], out = { auth: '', rest: '' };
  const start = (name, cmd, args, penv) => {
    const p = spawn(cmd, args, { env: penv, cwd: bin, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = d => { out[name] = (out[name] + d).slice(-20000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    procs.push(p);
    return p;
  };
  start('auth', path.join(bin, 'auth'), ['serve'], authEnv);
  start('rest', path.join(bin, 'postgrest'), [], {
    ...process.env, PGRST_DB_URI: dbUrl('authenticator'), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: JWT_SECRET, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(restPort), PGRST_DB_POOL: '10',
  });
  const authUrl = `http://127.0.0.1:${authPort}`, restUrl = `http://127.0.0.1:${restPort}`;
  const stop = async () => {
    for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* */ } }
    await wait(300);
    try { psql(['-c', `drop database if exists ${DB} with (force)`], 'postgres'); } catch { /* */ }
  };
  for (let i = 0; i < 60; i++) {
    if (await get(authUrl + '/health') === 200 && await get(restUrl + '/') === 200) break;
    if (i === 59) { await stop(); throw new Error('E2E: Auth / PostgREST nesāka darboties\n' + out.auth.slice(-2000) + '\n' + out.rest.slice(-2000)); }
    await wait(500);
  }
  log('Auth ' + authUrl + ', PostgREST ' + restUrl);
  const now = Math.floor(Date.now() / 1000);
  return {
    authUrl, restUrl, out, stop,
    sql: q => psql(['-At', '-c', q]),
    anonKey: czE2eJwt({ role: 'anon', iss: 'cz-e2e', iat: now, exp: now + 86400 }),
    serviceKey: czE2eJwt({ role: 'service_role', iss: 'cz-e2e', iat: now, exp: now + 86400 }),
  };
}

module.exports = { czE2eStart, czE2eJwt, czE2eLocalHost, czE2eOrder, JWT_SECRET };
