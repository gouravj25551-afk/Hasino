# Hasino on Android

The APK is a Capacitor shell around the **deployed** Hasino web app. It is not a
second implementation and not a copy of the assets: the WebView loads
`HASINO_APP_URL` over HTTPS, so the running app is the same code, on the same
origin, talking to the same API as a desktop browser.

That is the whole reason for this shape. Bundling the web assets into the APK
would put the WebView on `http://localhost`, which breaks every relative
`/api/*` call, needs CORS opened for the app origin, and moves Clerk onto an
origin its OAuth redirect knows nothing about. Loading the real site avoids all
three, and Clerk needs no mobile-specific configuration.

The admin panel cannot appear here. The deployed server has no `/admin` route,
no admin asset and no `/api/admin/*` — the panel is a separate process bound to
loopback on the operator's own machine (`src/http/admin-server.ts`). There is
nothing to exclude because there is nothing to include.

## The toolchain (already installed)

Both are in place on this machine. Android Studio is deliberately **not** used:
the command-line tools do the same job headlessly, with no setup wizard and
about a tenth of the download.

| | |
|---|---|
| JDK 21 | `/opt/homebrew/opt/openjdk@21` — `brew install openjdk@21` |
| Android SDK | `~/Library/Android/sdk` — `brew install --cask android-commandlinetools` |
| Packages | `platform-tools`, `platforms;android-36`, `build-tools;36.0.0` |

JDK 21 came from the **formula**, not the `temurin` cask: the formula installs
into the Homebrew prefix with no `sudo`, and leaves the system Java alone. The
Android Gradle Plugin supports 17 and 21; on the JDK 25 that was already here,
Gradle fails outright with `Unsupported class file major version 69`.

Add these to `~/.zshrc` so a new terminal can build:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

**What is still missing is a deployed Hasino.** There is a `Dockerfile`; any
host that runs it works. The APK needs the public HTTPS URL, and it must be
HTTPS — Android blocks cleartext traffic and Google sign-in will not run on an
insecure origin.

## Building the APK

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME="$HOME/Library/Android/sdk"
export HASINO_APP_URL=https://your-deployment      # your real URL

npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a phone plugged in over USB with debugging enabled:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`capacitor.config.ts` refuses to build without `HASINO_APP_URL`, and refuses a
non-HTTPS one. A localhost default would produce an APK that works on the
laptop that built it and nowhere else — and an emulator would make that look
fine right up until you installed it on a phone.

## Google sign-in, and the trip through the browser

Google refuses OAuth from embedded WebViews, so the Google step happens in the
real browser. That part is not a bug and cannot be avoided — spoofing the
WebView's user agent to hide from it breaks whenever Google changes detection,
and is against their policy.

What *was* a bug is where the browser put the result. Chrome landed on
`https://<host>/sso-callback`, finished the handshake against Chrome's cookie
jar, and left the user signed in **in Chrome** while the app still showed a
sign-in button. A WebView has its own storage; the session cannot cross.

Three pieces catch the return:

| | |
|---|---|
| `AndroidManifest.xml` | an `autoVerify` App Links filter for `https://<host>/sso-callback` — and only that path, so ordinary links still open in the browser |
| `MainActivity.java` | loads the incoming link into the WebView. Capacitor's own `onNewIntent` only notifies plugins; nothing navigates, so without this the app would foreground and silently drop the sign-in |
| `GET /.well-known/assetlinks.json` | the site's half of the agreement — served by the app server from `ANDROID_CERT_FINGERPRINTS` |

The host in the manifest is a placeholder filled from
`android/app/src/main/assets/capacitor.config.json` at build time, so it cannot
drift from the URL the WebView actually loads.

### What you must configure

Set these on the server, then rebuild and reinstall the APK:

```
ANDROID_CERT_FINGERPRINTS=AA:BB:…   # SHA-256 of the signing cert, colon-separated
ANDROID_PACKAGE=com.hasino.app      # optional; this is the default
```

Get the fingerprint from the APK you are actually installing — debug and
release are signed with different certificates, and a release build needs its
own entry added to the list:

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
  android/app/build/outputs/apk/debug/app-debug.apk
```

Verify the site's half is live before installing:

```bash
curl https://<host>/.well-known/assetlinks.json
```

Then, on the device, confirm Android verified the link:

```bash
adb shell pm get-app-links com.hasino.app     # want: verified
```

`Domain verification state: verified` means the OAuth return comes back into
the app. Anything else and it opens in Chrome — the old behaviour, which is a
degraded sign-in rather than a broken app. Verification needs a network at
install time; if it says `unverified`, reinstall once the site is reachable, or
enable it by hand for testing with
`adb shell pm set-app-links --package com.hasino.app 1 all`.

### If sign-in fails with `disallowed_useragent`

That is a different problem: Google refusing the WebView for the *first* leg
rather than the return leg. The supported fix is native Google Sign-In — a
Capacitor Google Auth plugin returns an ID token and Clerk accepts one through
`authenticateWithGoogleOneTap({ token })`. That needs an Android OAuth client
in Google Cloud registered against the app's SHA-1, and a branch in
`views/login.js` for when the app runs natively. Not done pre-emptively.

## The admin panel on Android

Optional, and off unless both halves are set. `ADMIN_PANEL_URL` on the server
sends a signed-in admin to the hosted panel; `HASINO_ADMIN_URL` at sync time
adds that host to `allowNavigation` so the app opens it instead of handing it
to Chrome. They are the same URL. Set neither and an admin stays in the
customer app, which is the previous behaviour exactly.

The panel signs in on its own origin — a Clerk session belongs to one origin,
so this is a fresh sign-in, not a continuation.

## Location

`ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` are declared in the
manifest. Declaring is not granting: Android asks the first time the page calls
`navigator.geolocation`, which happens when the customer taps **Use my current
location** and nowhere else. Nothing requests location at launch.

Both are listed because the app wants a city name, not a doorstep — a customer
who grants only approximate location still gets a working salon search.

## What is in the repo

| Path | |
|---|---|
| `capacitor.config.ts` | app id, name, and the URL guard |
| `mobile/www/index.html` | offline fallback — shown only when the site is unreachable |
| `android/` | generated Android project |
| `android/app/src/main/res/mipmap-*` | launcher icons, generated from `brand.css` |
| `android/app/src/main/res/drawable/splash.png` | splash |

The project has no image assets — the logo is a CSS wordmark — so the icons are
drawn from the brand purple (`--brand: #9b8ae8`), the app background
(`#0b0a0f`) and the wordmark's black tittle. Replace them with real artwork
before shipping to anyone.

## The web version is untouched

`npm run dev` and the deployment are unchanged. The only edits outside
`android/` are `viewport-fit=cover` in `index.html` and two `env(safe-area-inset-*)`
rules in `brand.css`, both of which resolve to `0px` in a desktop browser.
They exist because Android 15 and later draw apps edge to edge whether they ask
to or not, and without them the location chip sits under the status bar.
