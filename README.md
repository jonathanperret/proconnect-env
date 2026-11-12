# procoenv

Shows which ProConnect environment is active: `federation.proconnect.gouv.fr` is a
CNAME to `lb.production02…` or `lb.production12…`; the one it points to is active, the
other is the standby (PRA).

Live at https://procoenv.vercel.app

- `index.html`: the whole page. It asks public DNS-over-HTTPS resolvers that allow
  browser requests, plus the backend below, and shows one row per server. The needle
  points once 80% of the servers agree, a little short of the card if some disagree.
- `api/dns.js`: Vercel function that asks the zone's authoritative name servers and
  public resolvers over plain DNS, streaming each answer as NDJSON as it arrives.
  `?host=…` (repeatable) asks only those servers.
- `vercel.json`: runs functions in Paris (`cdg1`).

On the page, clicking the dial or the summary re-runs the whole check; clicking a row
or a group title asks just that server or group again. The check also re-runs every
minute while the tab is visible; `?refresh=30` changes the delay (in seconds, at least
10) and `?refresh=0` turns it off. `?test` (or `?test=0.4`) swaps a random share of the
answers for the other environment, to see what disagreement looks like; a banner says
so. Parameters combine: `?test&refresh=15`.

Pushing to `main` deploys to production, and `procoenv.vercel.app` follows the latest
production deployment.
