// Server-side half of the check: asks DNS servers a browser cannot reach.
// - the zone's authoritative name servers (the source of truth, no caching)
// - public resolvers over plain DNS (UDP), which have no browser-readable HTTPS API
//
// The response is streamed as NDJSON, one JSON object per line:
//   { type: 'start', region, sources: [{ group, label, host }] }
//   { type: 'result', index, target } or { type: 'result', index, error }  (in arrival order)
//   { type: 'end' }
// With one or more ?host=<host from the sources list>, only those servers are asked, and
// each answer is a line { type: 'result', host, target } or { type: 'result', host, error }.
// Unknown hosts are refused, so the endpoint cannot be pointed at arbitrary servers.
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

const MESSAGES = { ETIMEOUT: 'délai dépassé', ENODATA: 'pas de CNAME', ENOTFOUND: 'nom inconnu',
  ECONNREFUSED: 'connexion refusée', ESERVFAIL: 'erreur du serveur', EREFUSED: 'requête refusée' };

// Some resolvers (Comodo, Level3) silently drop a share of queries rather than answering
// slowly: an answer comes back within ~100 ms or never, so waiting longer does not help.
// Instead a fresh query is sent every RETRY_EVERY_MS and the first answer wins.
const ASK_TIMEOUT_MS = 3500;
const RETRY_EVERY_MS = 700;

function ask(ip) {
  return new Promise(resolve => {
    const timers = [], resolvers = [];
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      resolvers.forEach(r => r.cancel());
      resolve(result);
    };
    const attempt = remaining => {
      const resolver = new Resolver({ timeout: remaining, tries: 1 });
      resolver.setServers([ip]);
      resolvers.push(resolver);
      resolver.resolveCname(NAME).then(
        ([target]) => finish({ target: target.toLowerCase() }),
        // A timeout leaves the other attempts running; any other error is an answer.
        e => e.code !== 'ETIMEOUT' && finish({ error: MESSAGES[e.code] || e.code || e.message }));
    };
    for (let at = 0; at < ASK_TIMEOUT_MS; at += RETRY_EVERY_MS) {
      timers.push(setTimeout(() => attempt(ASK_TIMEOUT_MS - at), at));
    }
    timers.push(setTimeout(() => finish({ error: MESSAGES.ETIMEOUT }), ASK_TIMEOUT_MS));
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
