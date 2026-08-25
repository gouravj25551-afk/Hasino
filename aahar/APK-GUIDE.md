# Aahar — Android APK Guide & Test Report

_Install it on your phone and use it like a real business app._

---

## 1. The APK

| | |
|---|---|
| **File** | `aahar/Aahar-v1.0-debug.apk` |
| **App name / icon** | Aahar |
| **Package id** | `com.aahar.feedfactory` |
| **Version** | 1.0 (versionCode 1) |
| **Size** | ~4.2 MB |
| **Min Android** | 7.0 (API 24) |
| **Target Android** | 14 (API 36 toolchain) |
| **Build type** | Debug (installable directly, no Play Store) |
| **Wrapper** | Capacitor 8 (a WebView shell around the React app) |

### Install on your phone
1. Copy `Aahar-v1.0-debug.apk` to the phone (WhatsApp-to-self, USB, Google Drive, email).
2. Tap the file. Android will warn "install from unknown source" — allow it for your file manager / browser (Settings → Apps → Special access → Install unknown apps).
3. Install, then open **Aahar**.
4. It starts with a full **sample dataset** (a Rajasthan cattle-feed mill) so you can test every flow immediately. To wipe it and start clean: **Settings → Data → Reset to sample data** (this restores the sample set; there is no "empty" mode in V1).

There is **no login and no server** — see §4.

---

## 2. What actually works (this is not a mockup)

Every number is **computed** from the transactions you enter, and **everything is saved on the phone** and survives closing/reopening the app.

- **Customers / suppliers** — add, edit, delete; opening balance, credit limit, credit days, GSTIN, notes.
- **Products (feed & raw material)** — add, edit, delete; bag size, rate, HSN, opening stock, reorder level.
- **New Sale** — pick customer, add items, quantity × rate, payment terms, part-payment, truck/driver. On save it **reduces stock, posts the customer khata, creates a dated receivable, updates the daily rokad and dashboard, and generates the parchi** — one entry, everything updates.
- **Digital Khata** — running ledger per party, outstanding, open invoices, statement, call/print/WhatsApp buttons.
- **Payments** — record received/paid (cash/UPI/bank/cheque/other); edit & delete with an audited reason; buckets for overdue / due today / upcoming; history.
- **Purchases** — raw-material entry, supplier payable.
- **Inventory** — live RM + finished-goods stock, valuation, low-stock alerts, kg/bag handling.
- **Production** — batches with BOM (recipe) expected-vs-actual consumption and wastage.
- **Dispatch** — pending → dispatched → delivered, truck/driver, transport cost.
- **Daily Rokad** — opening → cash in − cash out → closing, split by mode.
- **Expenses** — categorised, with who entered it; edit & delete.
- **Reports** — ageing, sales by product/customer, collections, daily sales, expenses.
- **Reminders** — auto-built WhatsApp reminder queue (see §5).
- **Users & roles, Audit log** — every financial create/edit/delete is logged (old → new value, who, when, reason).
- **Language** — full **English / हिंदी** switch (Settings → Language), remembered across restarts.
- **Parchi** — GST-style tax-invoice / delivery challan, printable, with an e-way-bill notice when a consignment is ≥ ₹50,000.

---

## 3. Test report — what I verified

Verified in a Chromium browser running the exact bundle the APK ships, **and** on a real Android 14 emulator with the installed APK.

**On the Android emulator (the actual APK):**
- Installs and launches; Capacitor bridge loads the app; **no crashes**.
- Dashboard renders with correct figures (today's sales ₹27,600, receivables ₹10,71,900, overdue ₹4,91,500, due today ₹50,000).
- Touch navigation works (tap ＋ → New Sale opens).
- **App restart** (force-stop → relaunch): data persists from on-device storage.

**Functional (browser, identical code):**
- **Add customer** → opening balance flows into total receivables → **survives a full page reload** (persistence).
- **Delete customer** → removed, totals readjust.
- **New sale** → the propagation summary and all downstream updates fire; parchi generates; e-way-bill notice appears ≥ ₹50,000.
- **Language switch EN↔HI** → entire UI (dashboard, forms, buttons, labels, empty states, reminder messages, parchi) switches and is remembered.
- **Calculations** — quantity × rate, balances, ageing, rokad closing, stock on-hand all reconcile.
- **Due-date logic** — fixed a timezone bug so due dates are correct in IST (e.g. 24 Aug + 4-day terms = **due 28 Aug**, "due today").
- **Empty states, invalid inputs** (blank name / zero amount are blocked with a message), **large numbers** (Indian lakh/crore grouping), **responsive** desktop + mobile.

**Quality gate:** `typecheck` ✅ · `lint` ✅ (clean) · web `build` ✅ · Android `assembleDebug` ✅.

---

## 4. Backend / API / database setup

**None required.** V1 is a fully **on-device** app:

- Data is stored in the WebView's local storage on the phone (key `aahar.state.v1`), so it persists across app restarts with no server, no account, and works **fully offline**.
- There is **no login, no API keys, no database to configure**. Just install and use.

This is deliberate for a single-till factory: it removes all setup friction. When you want multi-device sync (owner's phone + munim's phone seeing the same data), that is the V1.5 step — a small Node + Postgres backend behind the same typed data layer. The app's data layer is already shaped for that drop-in (see `RESEARCH.md` §6–7).

---

## 5. Known limitations (honest list)

- **WhatsApp reminders open WhatsApp with the message pre-filled; they are not yet auto-sent.** Auto-send needs the official WhatsApp Business Cloud API / a BSP account and a small server (V2) — by design, never an unofficial method that would get your number banned. Today: the app builds the correct message and one tap opens WhatsApp to send it.
- **Single device.** Data lives on the one phone; there is no cloud sync yet (V1.5).
- **Debug build**, not signed for Play Store. Perfect for installing and testing; a signed release build is a later step if you want to distribute it.
- **Reset restores the sample dataset**, not an empty book. A true "start empty for my real shop" onboarding is easy to add next.
- **Users & roles are shown and modelled** (audit log is live), but role-based login/enforcement is V2 (single-user on-device today).
- **Dates** display in English month abbreviations even in Hindi (numerals are language-neutral); relative text ("2 दिन पहले") is translated.

---

## 6. Test data / credentials

No credentials needed. The app ships with a ready sample business:

- **Business:** Balaji Feeds & Minerals, Sikar, Rajasthan.
- **Customers** incl. *ABC Traders* (₹50,000 outstanding, due today), *Shree Krishna Pashu Aahar* (large overdue), *New Gopal Traders* (slow payer), *Verma Dairy Farm* (settled).
- **Products:** Premium / Standard / Buffalo / Calf feed (50 kg bags) + 7 raw materials.
- **Suppliers, purchases, production batches, expenses, payments** — all pre-loaded so every screen has realistic data.

Suggested 2-minute test: open **Khata → ABC Traders** (see the ledger and ₹50,000 due today) → **Payment**, enter ₹50,000, save → watch the khata settle and the dashboard "due today" drop → **New Sale** to ABC → watch stock, khata and the parchi update → **Settings → Language → हिंदी** to see the whole app switch → close and reopen the app to confirm your changes are still there.

---

## 7. Rebuilding the APK yourself

```bash
cd aahar
npm install
npm run build                 # web bundle
npx cap sync android          # copy web into the Android project
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  ANDROID_HOME=$HOME/Library/Android/sdk \
  ./gradlew assembleDebug     # → app/build/outputs/apk/debug/app-debug.apk
```

Needs a JDK (21 recommended — Gradle rejects JDK 25) and the Android SDK (build-tools + platform). The output APK is `android/app/build/outputs/apk/debug/app-debug.apk`.
