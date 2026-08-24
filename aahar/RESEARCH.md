# Aahar — Research & Product Design Report

_A digital operating system for a cattle-feed manufacturing + distribution business._

> This report is the pre-build deliverable. It captures the market research, the
> business analysis, the feature decisions, the architecture, and the phased plan
> that the V1 implementation in this folder is built against.

---

## 0. TL;DR

- **The market splits into three tiers.** (1) _Digital-khata apps_ (OkCredit, Khatabook) — brilliant at credit-ledger + WhatsApp/SMS reminders, but **no inventory, no manufacturing, no dispatch**. (2) _SME billing+inventory_ (Vyapar, myBillBook, Busy) — GST invoicing, stock, basic reminders; **weak on manufacturing/BOM and dispatch, desktop-era UX**. (3) _Full ERP_ (Tally, Zoho, ERPNext, Odoo) — everything including BOM/batch, but **heavy, consultant-driven, and hostile to a non-technical factory owner on a phone.**
- **The gap we fill:** the _khata-app simplicity_ of OkCredit, fused with the _inventory + manufacturing + dispatch_ of an ERP, tuned for **one specific workflow** (cattle feed) and **one primary user** (the owner, on a phone, in Hindi+English).
- **The legally-correct framing of the "parchi":** in India a dispatch note that moves goods is a **Delivery Challan / Tax Invoice**, and any consignment ≥ ₹50,000 needs an **e-way bill**. We model the digital parchi as a proper challan/invoice so it is print-legal from day one, with an e-way-bill hook for later.
- **WhatsApp must be the _official_ Cloud API (or a BSP), never an unofficial automation library** — the latter gets the business number **permanently banned**. Pricing is now **per-message by template category**; **utility templates are free inside the 24-hour customer-service window**, which is exactly where receipts/parchis land.
- **Core design law:** _one entry updates everything._ Saving a sale must, in a single transaction, cut stock, post the customer ledger, create a dated receivable, schedule the reminder, generate the parchi, and move the dashboard — the owner never types the same fact twice.

---

## 1. Competitors researched

| Product | Category | What it is | Strength | Weakness for us |
|---|---|---|---|---|
| **OkCredit** | Digital khata | Credit ledger + automated SMS/WhatsApp reminders | Dead-simple UX, reminder automation, customer gets their own ledger view | No inventory, no invoice/GST, no manufacturing, no dispatch |
| **Khatabook** | Digital khata | Ledger + basic billing, staff, some reports | Huge adoption, vernacular, offline-friendly | No real inventory/manufacturing; billing is thin |
| **Vyapar** | SME billing+inventory | GST invoicing, stock, payment reminders, mobile+desktop | Good invoicing + basic inventory + reminders, works offline | No true manufacturing/BOM, no dispatch/transport, generic UX |
| **myBillBook** | SME billing+inventory | Similar to Vyapar; strong WhatsApp invoicing | Clean, WhatsApp-first billing | Same gaps: no manufacturing, no dispatch |
| **Busy** | Distributor accounting | Desktop GST accounting, multi-godown, WhatsApp invoicing | Strong for distributors, multi-warehouse, statutory reports | Desktop-bound, dated UX, weak mobile, manufacturing is bolt-on |
| **Tally (Prime)** | Accounting ERP | The default Indian accounting system | Trusted, complete accounting, e-invoice/e-way bill | Not workflow software; no operational dispatch/production floor UX; steep |
| **Zoho Books / Inventory** | Cloud ERP suite | Modular cloud accounting + inventory + more | Polished, APIs, integrations, multi-user | Manufacturing is light; priced/shaped for services & retail, not a feed mill |
| **ERPNext (Frappe)** | Open-source ERP | Full manufacturing: **multi-level BOM, work orders, batch (FIFO), job cards, quality** | Genuinely complete manufacturing + open source | Heavy, consultant-driven, generic forms, poor for a phone-first owner |
| **Odoo** | Modular ERP | Manufacturing (MRP), inventory, accounting, apps | Very capable, modular | Complexity + per-app cost; over-built for one mill |
| **Marg / Vyapar-class distributor DMS** | Distribution/pharma DMS | Distributor management, schemes, van sales | Distributor-specific | Vertical-specific, dated, not feed-aware |

**Sources:** WhatsApp Business Platform pricing (Meta developer docs); Khatabook/OkCredit/Vyapar/Busy comparisons (Techjockey, SaaSworthy); ERPNext manufacturing (frappe.io, implementation case studies); India e-way-bill rules 2025 (Mondaq, Busy GST guide, IndiaFilings).

### What they do well / where they're weak
- **Do well:** OkCredit's reminder loop + customer-visible ledger; Vyapar/myBillBook's WhatsApp invoice send; ERPNext's BOM+batch model; Tally's statutory correctness.
- **Weak everywhere:** (a) **no product ties khata → dispatch → production → cash into one flow**; (b) **manufacturing + credit-collection are never in the same simple app**; (c) **mobile-first owner UX is missing** in the ERPs and **operational depth is missing** in the khata apps; (d) **dispatch/transport (truck, driver, parchi, delivery proof)** is nobody's first-class citizen.

---

## 2. Important features discovered (that shaped our design)

1. **The customer's own ledger view** (OkCredit) — collection improves when the customer can _see_ what they owe. We keep this, via a shared statement link.
2. **Reminder automation by status** (due today / overdue) with owner-configurable timing — but **anti-spam throttling** so a number is never blacklisted.
3. **WhatsApp official-API discipline** — template categories, the 24h free service window, opt-out handling.
4. **Delivery-challan / e-way-bill correctness** — the parchi is a legal document, not a slip.
5. **BOM + batch (FIFO) for feed** — expected raw-material consumption computed from a recipe; batch numbers for traceability (important for feed safety/recalls).
6. **Multi-godown / location** and **unit conversion (kg ↔ bag ↔ ton)** — feed is sold in bags but made by weight.
7. **Audit trail on every financial edit** — old value, new value, who, when, why (accounting-grade, never silent overwrite).
8. **Daily cash book (rokad)** with carry-forward opening balance and split by mode (cash/UPI/bank/cheque).

---

## 3. Features we SHOULD add

Grouped by priority with the _problem → user → why → connections_ rationale. Full module list in §11 and the app's in-product "Design" notes.

### MUST HAVE (V1 — replace the register and the parchi)
- **Customer/Dealer master + Digital Khata** — _Problem:_ khatas live in notebooks. _User:_ owner/accountant. _Why:_ single source of truth for who owes what. _Connects:_ every sale & payment posts here; feeds receivables, reminders, dashboard.
- **Fast New Sale → auto-parchi** — _Problem:_ handwritten parchis + double entry. _User:_ owner/sales/dispatch. _Why:_ one entry cuts stock, invoices, posts ledger, schedules reminder, prints parchi. _Connects:_ inventory, ledger, receivables, dispatch, rokad, reports.
- **Payment collection (multi-mode)** — _Problem:_ manual payment tracking. _User:_ accountant/owner. _Why:_ closes receivables, updates khata & rokad. _Connects:_ ledger, rokad, reminders (stops them), reports.
- **Finished-goods + raw-material inventory** — _Problem:_ manual stock math. _User:_ store/owner. _Why:_ live stock, low-stock alerts, valuation. _Connects:_ sale reduces FG; purchase/production changes stock.
- **Purchase entry + supplier ledger** — _Problem:_ scattered supplier dues. _User:_ owner/accountant. _Why:_ payables mirror of khata. _Connects:_ inventory inward, rokad, reports.
- **Daily Rokad (cash book)** — _Problem:_ manual daily cash. _User:_ owner/accountant. _Why:_ closing = opening next day; catches leakage. _Connects:_ sales, payments, expenses.
- **Expenses** — _Problem:_ untracked spends. _User:_ owner. _Why:_ real profit needs costs. _Connects:_ rokad, P&L report.
- **Owner Dashboard** — _Problem:_ no single view. _User:_ owner. _Why:_ run the business in 30 seconds. _Connects:_ everything.
- **Printable + digital parchi** — legal challan/invoice, print for driver, digital for customer.
- **Roles + audit log** — even a small mill has a munim; financial edits must be traceable.

### SHOULD HAVE (V2 — automation)
- **WhatsApp automation** (parchi on dispatch, receipt on payment, due/overdue reminders, monthly statement) via official API.
- **Reminder scheduler** with owner-set timing + throttling.
- **Reports**: outstanding, ageing, daily/monthly sales, collection, purchase, stock, rokad, expense, product- & customer-wise.
- **Dispatch/transport**: vehicle, driver, transport cost, delivery status/POD.
- **Customer statement share** (PDF/WhatsApp) and lightweight customer view.
- **Credit limit + over-limit alert**, **ageing buckets**, **partial payments**.

### FUTURE / ADVANCED (V3 — ERP depth)
- **BOM / recipe + production batches** with expected vs actual consumption, wastage, batch traceability, QC.
- **Batch expiry & recall**, **production costing**, **reprocessing/rejection**.
- **e-Way bill / e-invoice** integration; **GST returns** export.
- **Multi-godown**, **price lists / dealer schemes**, **online payment collection**, **customer portal & app**, **analytics/forecasting**, **offline-first sync**.

---

## 4. Features we should NOT add (at least not early)

- **Full double-entry general ledger / balance sheet** — Tally already owns this; we export to it. Owner needs receivables/payables/cash/P&L, not journal vouchers.
- **GPS live truck tracking** — expensive, low ROIfor short-haul feed delivery. A delivery-status + POD photo is enough.
- **Heavy MRP / production planning / demand forecasting** — premature for a single mill; adds friction.
- **Generic CRM, HR/payroll, e-commerce storefront** — scope creep; not the pain.
- **Unofficial WhatsApp automation** — _actively harmful_ (number ban). Explicitly excluded.
- **Over-charted dashboards** — the brief is right: 30-second usefulness beats vanity charts.
- **Multi-currency / multi-company** — not the reality of this business.

---

## 5. Recommended MVP (phasing rationale)

- **V1 — Essential (replace registers & parchis):** Dashboard, New Sale + parchi, Customers + Khata, Payments, Purchases + supplier ledger, Inventory (RM+FG), Daily Rokad, Expenses, Roles, Audit log, PDF/print parchi & statement. _Why:_ this alone kills the notebook, the handwritten parchi, and the manual khata — the stated goal.
- **V2 — Automation:** WhatsApp (official API) for parchi/receipt/reminders/statements, reminder scheduler, dispatch/transport, full reports, credit limits, ageing, customer statement share. _Why:_ removes the manual WhatsApp + manual due-date chasing.
- **V3 — Advanced ERP:** BOM/recipe, production batches + traceability + QC, batch costing, e-way/e-invoice, multi-godown, online payments, customer portal, analytics. _Why:_ depth that matters only once the daily loop is digital and trusted.

---

## 6. Recommended architecture (target)

- **Frontend:** React 19 + Vite + Tailwind 4 (matches the modern stack already in this repo). Mobile-first, PWA-ready. **This V1 implements the frontend with a typed in-memory domain store** so the "one entry updates everything" behaviour is _real_, not mocked.
- **Backend (V1.5+):** Node + Postgres (the stack the sibling salon app uses), REST/JSON API. An **append-only ledger** table is the source of truth for balances; snapshots/materialised views for speed.
- **Auth:** phone-OTP for staff (owner adds users); role claims in the session.
- **Jobs:** a scheduler (cron/queue) for reminders and statements → WhatsApp send worker (outbox pattern, idempotent, throttled).
- **Notifications:** WhatsApp Cloud API / BSP, SMS fallback, in-app alerts.
- **Accounting/ledger:** double-sided (customer = receivable, supplier = payable); every posting is immutable; corrections are new entries + audit record.
- **Inventory:** stock-ledger per item×location; movements (purchase in, production in, sale out, adjustment, return) sum to on-hand; valuation moving-average.
- **Manufacturing:** BOM per product; a production entry consumes RM (expected from BOM, actual editable) and yields FG batch.
- **Reporting:** read models over the ledgers; date-range + export (PDF/CSV).

### How one sale propagates (the spine)
```
SALE CREATED
 → Invoice/Parchi generated (challan-legal, printable + digital)
 → Stock ledger: finished-good OUT (bags→kg)         [inventory]
 → Customer ledger: DEBIT (goods)                    [khata]
 → Receivable created with due date = date+terms     [payments]
 → Reminder scheduled for due/overdue                [scheduler → WhatsApp]
 → Dispatch record (vehicle/driver) if dispatched    [dispatch]
 → Rokad: cash/UPI portion recorded if paid now      [cash book]
 → Dashboard + reports recompute                      [read models]
 → Audit log entry (who created it)                   [audit]
PAYMENT RECEIVED (later)
 → Customer ledger: CREDIT; receivable reduced/closed; reminder cancelled
 → Rokad in; receipt sent (WhatsApp); reports update; audit entry
```

---

## 7. Database model overview (entities & relationships)

Core entities (V1 shape; the app's `lib/types.ts` mirrors this):
- **Party** (customer | supplier): name, phone, city, opening balance, credit limit, credit days, GSTIN, notes.
- **Product**: name, type (raw | finished), unit, pack size (kg/bag), rate, HSN, opening stock, reorder level.
- **Sale** (header) → **SaleLine** (product, qty, unit, rate, amount); payment terms, vehicle, driver, status.
- **Purchase** (header) → **PurchaseLine**; supplier, terms.
- **LedgerEntry** (append-only): partyId, date, type (sale | purchase | payment | opening | adjustment), debit, credit, ref (invoiceId/paymentId), note.
- **Payment**: partyId, direction (in | out), amount, mode (cash | upi | bank | cheque | other), date, ref, note.
- **StockMovement** (append-only): productId, date, kind (purchase | production | sale | adjustment | return), qtyKg, ref, reason.
- **ProductionBatch** (V3): productId, batchNo, date, outputQty, BOM snapshot, consumption lines, wastage.
- **Bom / BomLine** (V3): finished productId → raw productId ratios per unit output.
- **Expense**: category, amount, date, mode, note, enteredBy, attachment.
- **CashDay (Rokad)**: date, openingCash, computed closing; derived from payments/sales/expenses.
- **Reminder**: receivable ref, scheduledFor, channel, status, template.
- **AuditEntry**: entity, entityId, field, oldValue, newValue, userId, at, reason.
- **User**: name, phone, role.

**Relationships:** Party 1—* Sale/Purchase/Payment/LedgerEntry; Product 1—* SaleLine/PurchaseLine/StockMovement; Sale 1—1 LedgerEntry(debit) + 0..1 Dispatch; Payment 1—1 LedgerEntry(credit); Bom 1—* BomLine; ProductionBatch *—1 Product.

**Derived, never stored raw:** party outstanding (Σledger), stock on-hand (Σmovements), rokad closing, ageing, dashboard KPIs. Storing them invites drift; we compute.

---

## 8. User roles

| Role | Can do | Cannot |
|---|---|---|
| **Owner** | Everything, incl. settings, users, audit, edits with reason | — |
| **Admin/Manager** | Most operations + reports; user mgmt if granted | Change owner-only settings |
| **Accountant** | Payments, ledgers, rokad, expenses, statements, reports | Change stock/production; delete masters |
| **Sales** | Create sales, view customers & stock, take orders | See supplier costs, edit payments, see full P&L |
| **Store/Inventory** | Inward, stock adjustments (with reason), low-stock | Ledgers, payments |
| **Production** | Record batches, consumption, wastage | Sales, payments |
| **Dispatch** | Assign vehicle/driver, mark dispatched/delivered, POD | Edit prices/ledgers |
| **View-only** | Read dashboards & reports | Any mutation |

Every **financial mutation and every master edit writes an audit entry**. Sensitive fields (amount, rate, date) require a **reason** on edit.

---

## 9. Automation opportunities (ranked by ROI)

1. **Auto-parchi + auto-ledger + auto-stock on save** (V1) — kills the biggest manual duplication.
2. **Due/overdue reminders** (V2) — recovers cash without human chasing.
3. **Payment receipt on collection** (V2) — trust + fewer "did you get it?" calls.
4. **Daily rokad auto-compute + carry-forward** (V1) — ends nightly cash math.
5. **Monthly statement auto-send** (V2) — reconciliation without effort.
6. **Low-stock & credit-limit alerts** (V2) — prevent stockouts / over-exposure.
7. **Expected RM consumption from BOM** (V3) — production accuracy.

---

## 10. WhatsApp strategy (safe architecture)

- **Use the official WhatsApp Business Platform** — Meta **Cloud API** directly, or a **Business Solution Provider (BSP)** (Gupshup/Wati/Interakt/AiSensy/360dialog). **Never** an unofficial `whatsapp-web.js`-style automation — it violates ToS and **gets the number permanently banned**, which is catastrophic for a business number.
- **Pricing (current):** billing is **per delivered template message, by category** — Marketing (always billed), **Utility & Authentication (free inside an open 24-hour customer-service window, billed outside it)**, **Service messages free**. Country + volume affect rate; a BSP adds a small markup.
- **Design consequence:** parchis, receipts, and reminders are **Utility templates**. When a customer has messaged us in the last 24h they're **free**; otherwise we pay a few paise each — negligible and far cheaper than manual follow-up.
- **Rules we bake in:** pre-approved templates only; **opt-out honoured**; **throttle** (never >1 reminder/day/invoice, quiet hours respected); **outbox pattern** (idempotent, retried, logged) so a message is never double-sent; SMS fallback if WhatsApp fails.
- **Reminder cadence (anti-spam default, owner-configurable):** on dispatch (parchi) → on due date (gentle) → +3 days overdue → +7 days overdue → then weekly, stopping on payment. All timings in Settings.

---

## 11. Manufacturing-specific features (feed mill)

- **BOM / recipe per product** (e.g. 1 ton Product A = maize X + bran Y + soybean Z + minerals). Recording production computes **expected RM consumption**; actual is editable to capture reality.
- **Production batches + batch numbers** — traceability matters for feed (contamination/recall, customer complaints). Batch → which RM lots → which customers received it.
- **Wastage / yield**, **production cost** (RM cost + overhead ÷ output), **reprocessing/rejection**, **QC checks** (moisture, etc.).
- **Unit conversion (kg ↔ bag ↔ ton)** everywhere; feed is _made_ by weight, _sold_ by bag.
- **Verdict:** BOM + batch tracking are **genuinely important** for this vertical (unlike, say, a hardware distributor) — but they belong in **V3**, after the daily sales/cash/khata loop is trusted. V1 tracks finished-goods stock and simple production-in without forcing a recipe.

---

## 12. Biggest risks / complexities

- **Ledger correctness** — the whole product's credibility. Mitigation: append-only ledger, derive balances, audit every edit, reconciliation reports.
- **WhatsApp number ban** — existential. Mitigation: official API only, templates, throttling, opt-out.
- **Unit/rounding errors** (kg/bag/ton, paise) — silent money bugs. Mitigation: integer paise, one conversion layer, tests.
- **Adoption by non-technical staff** — if it's slower than a pen, it fails. Mitigation: mobile-first, search-first, minimal typing, Hindi labels, one-entry design.
- **Offline reality** at a rural mill — Mitigation: PWA + offline queue in V2/V3; V1 tolerant of flaky networks.
- **Scope creep into full ERP** — Mitigation: strict V1/V2/V3 gates (this report).
- **Data trust / migration** from notebooks — Mitigation: opening-balance import, parallel-run period.

---

## 13. Proposed UI / navigation

**Primary nav (owner mental model, not accounting jargon):**
`Dashboard · Sales · Khata (Customers) · Payments · Purchases · Inventory · Production · Dispatch · Rokad · Expenses · Reports · Settings`
(+ Settings → Users, Audit log, Reminders, WhatsApp, Business profile.)

- **Desktop:** left sidebar + top bar (search + quick "New Sale").
- **Mobile:** bottom tab bar (Home / Sales / Khata / Rokad / More) + a big **＋ New** action; everything else under "More".
- **Design language:** light, high-contrast, large touch targets, big numbers, bilingual (Devanagari + English), search-first, minimal typing, quick actions. **Not** a 2010 grey ERP.

**Key screens built in V1:** Dashboard, New Sale, Customers, Customer Khata, Payments, Sales history, Purchases, Inventory, Production, Dispatch, Rokad, Expenses, Reports, Reminders, Settings, Users, Audit log.

---

## 14. Implementation plan

1. **Scaffold** React 19 + Vite + Tailwind 4 app (`aahar/`), design tokens, layout shell (sidebar + mobile bottom-nav), bilingual helper. ✅
2. **Typed domain layer** (`lib/types.ts`) + **realistic seed data** + a **derived store** (`lib/data/store.ts`) that computes ledgers, outstanding, ageing, stock, rokad, dashboard from transactions. ✅
3. **One-entry-updates-everything**: New Sale mutates the store → stock down, khata up, receivable + due date, parchi, dashboard move. Payments & expenses likewise. ✅
4. **Screens** listed in §13, all reading the derived store (nothing faked). ✅
5. **Parchi**: printable challan-style document + shareable digital version.
6. **Quality gate:** typecheck, lint, build; responsive desktop + mobile check.
7. **V2 next:** wire Postgres + Node API, official WhatsApp worker, reminder scheduler, reports export.

_This V1 delivers the essential experience and the architecture the rest hangs off — the register, the parchi, and the khata become digital, and the "enter once" promise is real in the running app._
