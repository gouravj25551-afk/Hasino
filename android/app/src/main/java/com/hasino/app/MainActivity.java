package com.hasino.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * The Hasino shell, plus the one thing Capacitor does not do for an App Link.
 *
 * AndroidManifest.xml claims https://<host>/sso-callback, so Android hands the
 * OAuth return to this activity instead of leaving the user in Chrome. What
 * Capacitor then does with that intent is notify plugins — Bridge.onNewIntent
 * calls handleOnNewIntent on each one and stops. Nothing navigates the
 * WebView. With no @capacitor/app plugin installed there is not even a
 * listener, so the app would come to the foreground showing whatever it showed
 * before, having silently dropped the sign-in it was handed. That is a worse
 * failure than staying in Chrome, because it looks like the app is working.
 *
 * So the URL is loaded here. The page at /sso-callback is the app shell, which
 * already knows to finish a redirect callback (isRedirectCallback() in
 * lib/auth.js) — the WebView holds the client state that started the sign-in,
 * which is the whole reason the return has to land here rather than in Chrome.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Cold start: the link launched the app, so the initial load is
        // server.url and the callback would be lost without this.
        loadAppLink(getIntent());
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
