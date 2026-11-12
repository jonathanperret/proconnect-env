// Server-side half of the check: asks DNS servers a browser cannot reach.
// - the zone's authoritative name servers (the source of truth, no caching)
// - public resolvers over plain DNS (UDP), which have no browser-readable HTTPS API
//
// The response is streamed as NDJSON, one JSON object per line:
//   { type: 'start', region, sources: [{ group, label, host }] }
//   { type: 'result', index, target, ttl } or { type: 'result', index, error }  (in arrival order)
//   { type: 'end' }
// ttl is in seconds: the configured value from an authoritative server, the time left in
// its cache from a resolver.
// With one or more ?host=<host from the sources list>, only those servers are asked, and
// each answer is a line { type: 'result', host, target, ttl } or { type: 'result', host, error }.
// Unknown hosts are refused, so the endpoint cannot be pointed at arbitrary servers.
const dgram = require('node:dgram');
const { Resolver } = require('node:dns').promises;

const NAME = 'federation.proconnect.gouv.fr';

const PUBLIC_RESOLVERS = [
  ['AdGuard', '94.140.14.140'],
  ['Yandex', '77.88.8.8'],
  ['Level3', '4.2.2.2'],
  ['UltraDNS', '156.154.70.1'],
  ['Comodo', '8.26.56.26'],
  ['Hurricane Electric', '74.82.42.42'],
  ['114DNS', '114.114.114.114'],
  ['DNSPod', '119.29.29.29'],
  ['CIRA', '149.112.121.10'],
  ['SafeDNS', '195.46.39.39'],
  ['NextDNS', '45.90.28.0'],
  ['Gcore', '95.85.95.85'],
  ['Freifunk München', '5.1.66.255'],
  ['Baidu', '180.76.76.76'],
  ['Dyn', '216.146.35.35'],
  ['DNS for Family', '94.130.180.225'],
];

const TIMEOUT_MESSAGE = 'délai dépassé';
const RCODE_MESSAGES = { 2: 'erreur du serveur', 3: 'nom inconnu', 5: 'requête refusée' };

// --- DNS over UDP. Node's resolver does not report TTLs for CNAME records, so queries are
// built and parsed here (same format as in index.html).
const TYPE_CNAME = 5;

function buildQuery(id) {
  const bytes = [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];  // header: RD set, 1 question
  for (const label of NAME.split('.')) bytes.push(label.length, ...Buffer.from(label));
  bytes.push(0, 0, TYPE_CNAME, 0, 1);                                // root, type, class IN
  return Buffer.from(bytes);
}

// Reads a (possibly compressed) domain name; returns [name, offset after it].
function readName(buf, off) {
  const labels = [];
  let end = null;
  for (let hops = 0; ; ) {
    const len = buf[off];
    if (len === undefined) throw new Error('réponse tronquée');
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (end === null) end = off + 2;
      if (++hops > 20) throw new Error('réponse invalide');
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    labels.push(buf.toString('latin1', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return [labels.join('.'), end ?? off];
}

function parseResponse(buf) {
  if (buf.length < 12) throw new Error('réponse tronquée');
  const questions = buf.readUInt16BE(4), count = buf.readUInt16BE(6);
  let off = 12;
  for (let i = 0; i < questions; i++) { [, off] = readName(buf, off); off += 4; }
  const answers = [];
  for (let i = 0; i < count; i++) {
    let name; [name, off] = readName(buf, off);
    const type = buf.readUInt16BE(off), ttl = buf.readUInt32BE(off + 4), rdlength = buf.readUInt16BE(off + 8);
    off += 10;
    answers.push({ name, type, ttl, data: type === TYPE_CNAME ? readName(buf, off)[0] : null });
    off += rdlength;
  }
  return { id: buf.readUInt16BE(0), rcode: buf[3] & 15, answers };
}

// Some resolvers (Comodo, Level3) silently drop a share of queries rather than answering
// slowly: an answer comes back within ~100 ms or never, so waiting longer does not help.
// Instead the query is sent again every RETRY_EVERY_MS and the first answer wins.
const ASK_TIMEOUT_MS = 3500;
const RETRY_EVERY_MS = 700;

function ask(ip) {
  return new Promise(resolve => {
    const id = Math.floor(Math.random() * 65536);
    const query = buildQuery(id);
    const socket = dgram.createSocket('udp4');
    const timers = [];
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      socket.close();
      resolve(result);
    };
    socket.on('error', e => finish({ error: e.code || e.message }));
    socket.on('message', (message, from) => {
      let response;
      try { response = parseResponse(message); } catch { return; }
      if (response.id !== id || from.address !== ip) return;  // not an answer to our query
      if (response.rcode) return finish({ error: RCODE_MESSAGES[response.rcode] || `statut DNS ${response.rcode}` });
      const cname = response.answers.find(a => a.type === TYPE_CNAME && a.name.toLowerCase() === NAME);
      finish(cname ? { target: cname.data.toLowerCase(), ttl: cname.ttl } : { error: 'pas de CNAME' });
    });
    for (let at = 0; at < ASK_TIMEOUT_MS; at += RETRY_EVERY_MS) {
      timers.push(setTimeout(() => !done && socket.send(query, 53, ip), at));
    }
    timers.push(setTimeout(() => finish({ error: TIMEOUT_MESSAGE }), ASK_TIMEOUT_MS));
  });
}

// Finds the zone that holds NAME by walking up until a name has NS records.
async function authoritativeServers() {
  const system = new Resolver({ timeout: 2000, tries: 2 });
  const labels = NAME.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join('.');
    let names;
    try { names = await system.resolveNs(zone); } catch { continue; }
    const servers = await Promise.all(names.sort().map(async name => {
      try { return { name, ip: (await system.resolve4(name))[0] }; } catch { return null; }
    }));
    return servers.filter(Boolean);
  }
  return [];
}

async function serverList() {
  const auth = await authoritativeServers().catch(() => []);
  return [
    ...auth.map(s => ({ group: 'auth', label: s.name, host: s.name, ip: s.ip })),
    ...PUBLIC_RESOLVERS.map(([label, ip]) => ({ group: 'resolver', label, host: ip, ip })),
  ];
}

// Calls send(message) for each line of the protocol described at the top.
async function run(send) {
  const servers = await serverList();
  send({ type: 'start', region: process.env.VERCEL_REGION || null,
         sources: servers.map(({ group, label, host }) => ({ group, label, host })) });
  await Promise.all(servers.map(async (s, index) => send({ type: 'result', index, ...await ask(s.ip) })));
  send({ type: 'end' });
}

async function runSome(hosts, send) {
  const servers = await serverList();
  await Promise.all([...new Set(hosts)].map(async host => {
    const server = servers.find(s => s.host === host);
    send({ type: 'result', host, ...server ? await ask(server.ip) : { error: 'serveur inconnu' } });
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('X-Accel-Buffering', 'no');
  const hosts = new URL(req.url, 'http://localhost').searchParams.getAll('host');
  const send = message => res.write(JSON.stringify(message) + '\n');
  await (hosts.length ? runSome(hosts, send) : run(send));
  res.end();
};
module.exports.run = run;
