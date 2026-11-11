# Public website (B7a)

The marketing site, pricing, book-a-demo, contact, policy drafts and the help centre (10 articles). Plain HTML and CSS
built by a short Node script: no framework, no npm packages, no third-party scripts, fonts or trackers, no cookies.
It is separate from the app: the site is served by Cloudflare Pages, the app stays at `app.<domain>` on the tunnel.

## Files

| Path | What |
|---|---|
| `site.config.json` | Everything a business must supply: name, domain, app links, contact, legal details, prices |
| `build.mjs` | Renders `src/` into `dist/` |
| `src/layout.html` | Header, nav, footer around every page |
| `src/pages/*.html` | Home, features, pricing, demo, contact, terms, privacy, refund |
| `src/help/*.html` | Help articles (each starts with `<!-- title: …; summary: … -->`) and the help index |
| `src/assets/` | `site.css`, `demo.js`, `mark.svg` |
| `src/_headers` | Cloudflare Pages security headers (strict CSP: nothing from other sites) |

Templates use `{{field}}` (escaped), dotted paths such as `{{plans.store.priceMonthText}}`, and
`{{#if field}}…{{/if}}` / `{{#unless field}}…{{/unless}}`. A misspelt field stops the build.

## Fill in `site.config.json`

- `productName` is "GroPop" (chosen 2026-11-08, replacing TRIDENT; trademark search still to do).
- `appUrl` e.g. `https://app.example.in`; `signupUrl` = appUrl + `/register`; `loginUrl` = appUrl + `/login`. Check both
  paths against your Phase 1 sign-in pages.
- `whatsappNumber`: digits only with country code (`91` + 10 digits). `whatsappDisplay`: how it is shown.
- Legal: `legalName`, `legalForm` (e.g. "sole proprietorship"), `addressLine1`/`2`, `city`, `state`, `pin`,
  `grievanceOfficerName`, `grievanceEmail` (required by the IT Rules), `effectiveDate`, `jurisdictionCity`.
  `gstin` is optional: lines that show it disappear while it is empty.
- **Prices must match the `plans` table** (migration `0600_saas.sql`: Store ₹999/₹9,999, 3 users; Store + Online
  ₹1,999/₹19,999, 5 users). Change both together. `gstNote` says whether prices include GST; set it from your GST
  status (unregistered: "No GST is charged." once your CA agrees).
- `annualRefund` is your refund rule for annual plans; the default is a suggestion.
- `lawyerReviewed`: leave `false` until a lawyer has reviewed Terms, Privacy and Refunds. While false, those pages show
  "Draft for review by a lawyer. Not legal advice." even in a release build.

## Build

```sh
node site/build.mjs             # draft: empty fields show as yellow "[to be filled: …]", every page says "Draft"
node site/build.mjs --release   # refuses and lists the empty required fields; otherwise a clean build
```
Open `site/dist/index.html` in a browser to check. `dist/` is not committed.

## Deploy on Cloudflare Pages

1. Cloudflare → Workers & Pages → Create → Pages → connect the GitHub repository.
2. Production branch `main`. Framework preset: none. Root directory: the repository root. Build command
   `node site/build.mjs --release`. Output directory `site/dist`. Environment variable `NODE_VERSION` = `22`.
3. Custom domains: the apex (`example.in`) and `www`. Do not point `app.` here; it belongs to the tunnel.
4. Pages applies `_headers` automatically. Check the CSP with the browser console open on every page: there should be
   no errors.

## Book a demo

The form sends nothing to any server. `demo.js` turns the answers into a WhatsApp message (or an email) that the visitor
sends themselves, so the site stores no personal data and has no endpoint to spam (D82).
