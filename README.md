# procoenv

Shows which ProConnect environment is active: `federation.proconnect.gouv.fr` is a
CNAME to `lb.production02…` or `lb.production12…`; the one it points to is active, the
other is the standby (PRA).

Live at https://procoenv.vercel.app

- `index.html`: the whole page. It queries public DNS-over-HTTPS resolvers that allow
  browser requests, plus the backend below, and moves the needle to the answer.
- `api/dns.js`: Vercel function that asks the zone's authoritative name servers and
  public resolvers over plain DNS.
- `vercel.json`: runs functions in Paris (`cdg1`).

Deploy with `vercel deploy --prod`. `procoenv.vercel.app` is a domain of the Vercel
project, so it follows the latest production deployment.
