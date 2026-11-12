// Server-side half of the check: asks DNS servers a browser cannot reach.
// - the zone's authoritative name servers (the source of truth, no caching)
// - public resolvers over plain DNS (UDP), which have no browser-readable HTTPS API
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

async function ask(group, label, host, ip) {
  const resolver = new Resolver({ timeout: 1500, tries: 2 });
  resolver.setServers([ip]);
  try {
    const [target] = await resolver.resolveCname(NAME);
    return { group, label, host, target: target.toLowerCase() };
  } catch (e) {
    return { group, label, host, error: MESSAGES[e.code] || e.code || e.message };
  }
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

async function check() {
  const auth = await authoritativeServers().catch(() => []);
  const sources = await Promise.all([
    ...auth.map(s => ask('auth', s.name, s.name, s.ip)),
    ...PUBLIC_RESOLVERS.map(([label, ip]) => ask('resolver', label, ip, ip)),
  ]);
  return { region: process.env.VERCEL_REGION || null, checkedAt: Date.now(), sources };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // A few seconds of CDN caching so the endpoint cannot be used to hammer DNS servers.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=5');
  res.status(200).json(await check());
};
module.exports.check = check;
