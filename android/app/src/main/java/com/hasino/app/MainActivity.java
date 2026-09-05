package com.hasino.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * The Hasino shell.
 *
 * Sign-in is native: onCreate registers GoogleAuthPlugin, which draws Android's
 * Google account sheet over the WebView and returns a signed ID token to the
 * web layer. The token is exchanged with Clerk in the same WebView, so the
 * login never leaves for a browser and there is nothing to come back from — the
 * old Chrome/Custom-Tab/App-Link round trip is gone.
 *
 * A /sso-callback deep link can still arrive from outside the app (a web sign-in
 * on a device that has the app installed, an email link). AndroidManifest.xml
 * claims it, and loadAppLink() loads it into the WebView rather than letting the
 * browser keep it — Capacitor only notifies plugins on such an intent and would
 * otherwise drop it. The app's own sign-in no longer uses this path.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native Google sign-in. Registered before the bridge starts so the web
        // layer can call it the moment the page loads. This is how sign-in stays
        // inside the app — the account sheet is drawn over the WebView and a
        // token comes straight back, with no browser in the loop. See
        // GoogleAuthPlugin.java and signInWithGoogle() in lib/auth.js.
        registerPlugin(GoogleAuthPlugin.class);

        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, backCallback);
        // A /sso-callback deep link can still arrive (an email confirmation, a
        // web sign-in on a device that has the app). Kept so it lands in the app
        // rather than the browser; the app's own sign-in no longer uses it.
        loadAppLink(getIntent());
    }

    /**
     * The system back button.
     *
     * Capacitor's BridgeActivity registers nothing for back, so the press fell
     * through to the Activity's default handler and finished it: every press
     * quit the app, from a salon page, from checkout, from an open dialog.
     *
     * Where "back" goes is a question only the page can answer — the app is a
     * hash-routed web app, and a native canGoBack() cannot see an open modal,
     * cannot tell the home route from a nested one, and would happily replay a
     * consumed OAuth callback URL sitting in WebView history. So the page is
     * asked first (window.hasinoBack, see lib/backbutton.js) and this acts on
     * its answer:
     *
     *   "handled" — the page closed a dialog or navigated; nothing to do here
     *   "exit"    — the page is at its root with nothing behind it; quit
     *   anything else — the page did not answer (not loaded yet, the offline
     *                   fallback page, an older deploy): fall back to the
     *                   WebView's own history, and quit only when it is empty
     *
     * The last branch is what makes this safe to ship ahead of the web change:
     * the worst case is the platform default, never a trapped user.
     */
    private static final String ASK_PAGE =
        "(function(){try{return (window.hasinoBack && window.hasinoBack()) || 'default';}" +
        "catch(e){return 'default';}})()";

    private final OnBackPressedCallback backCallback = new OnBackPressedCallback(true) {
        @Override
        public void handleOnBackPressed() {
            final WebView webView = getBridge() == null ? null : getBridge().getWebView();
            if (webView == null) {
                exitApp();
                return;
            }
            // evaluateJavascript is asynchronous and its result comes back on
            // the UI thread, so the decision is made there, one press later at
            // the earliest — never on a background thread.
            webView.evaluateJavascript(ASK_PAGE, value -> {
                String answer = value == null ? "" : value.replace("\"", "");
                if ("handled".equals(answer)) {
                    return;
                }
                if ("exit".equals(answer)) {
                    exitApp();
                } else if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    exitApp();
                }
            });
        }
    };

    /**
     * Hand the press back to the system, which finishes the Activity.
     *
     * Disabling this callback first is what makes that happen: the dispatcher
     * walks past a disabled callback to the default one. Calling finish()
     * directly would work too, but would skip the platform's own back
     * behaviour — including the predictive-back animation on Android 13+.
     */
    private void exitApp() {
        backCallback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // launchMode is singleTask, so a running app is reused and the link
        // arrives here. setIntent keeps getIntent() honest for anything else
        // that reads it later.
        setIntent(intent);
        loadAppLink(intent);
    }

    /** The scheme the callback page falls back to; see AndroidManifest.xml. */
    private static final String NATIVE_SCHEME = "hasino";
    private static final String CALLBACK_PATH = "/sso-callback";

    /**
     * Load an incoming VIEW intent, but only ever as a URL on this app's own
     * origin.
     *
     * Two ways in, one outcome. An App Link arrives already on that origin and
     * is loaded as it stands. A `hasino://sso-callback?…` fallback arrives on
     * a scheme any app on the device may claim, so nothing about it is
     * trusted: its query string is copied onto the configured origin and its
     * host, path and scheme are discarded. The worst a hostile sender can do
     * is make Hasino reload its own callback URL.
     *
     * Without this check the activity would render a URL of the sender's
     * choosing inside the Hasino WebView, on Hasino's task, wearing Hasino's
     * identity — a convincing place to ask someone for a password.
     */
    private void loadAppLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri link = intent.getData();
        if (link == null || getBridge() == null) {
            return;
        }

        Uri configured = Uri.parse(getBridge().getConfig().getServerUrl());
        final String url;

        if (NATIVE_SCHEME.equalsIgnoreCase(link.getScheme())) {
            // Rebuilt, not forwarded. Only the query survives.
            String query = link.getEncodedQuery();
            url = configured
                .buildUpon()
                .path(CALLBACK_PATH)
                .encodedQuery(query)
                .build()
                .toString();
        } else {
            boolean sameOrigin =
                link.getScheme() != null &&
                link.getScheme().equalsIgnoreCase(configured.getScheme()) &&
                link.getHost() != null &&
                link.getHost().equalsIgnoreCase(configured.getHost()) &&
                link.getPort() == configured.getPort();
            if (!sameOrigin) {
                return;
            }
            url = link.toString();
        }
        // post() rather than a direct call: on a cold start this runs inside
        // onCreate, while the WebView is still being handed its first URL.
        // Queueing behind that is what makes the callback the last navigation
        // instead of a race with the initial load.
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
}
