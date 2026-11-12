# proconnect-env

Shows which ProConnect environment is active: `federation.proconnect.gouv.fr` is a
CNAME to `lb.production02…` or `lb.production12…`; the one it points to is active, the
other is the standby (PRA).

Live at https://env.proconnect.gouv.fr, published with GitHub Pages.

## Files

- `index.html`: the whole page, with no server side. It asks the public DNS-over-HTTPS
  resolvers that accept requests from a browser and shows one row per resolver. The
  needle points once 80% of them agree, a little short of the card if some disagree.
  A collapsed section shows the raw answer of one of the zone's authoritative servers,
  through dns.bortzmeyer.org, for reading only.
- `CNAME`: the GitHub Pages custom domain.
- `.nojekyll`: makes GitHub Pages serve the files as they are.

## Using the page

Clicking the dial or the summary re-runs the whole check; clicking a row or the group
title asks just that resolver or all of them again. The check also re-runs every minute
while the tab is visible; `?refresh=30` changes the delay (in seconds, at least 10) and
`?refresh=0` turns it off. `?test` (or `?test=0.4`) swaps a random share of the answers
for the other environment, to see what disagreement looks like; a banner says so.
Parameters combine: `?test&refresh=15`.

## Hosting

Pushing to `main` publishes the page on GitHub Pages.
