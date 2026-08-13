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

    /**
     * Load an incoming VIEW intent, but only when it points at the origin this
     * app is configured to be.
     *
     * The check is not ceremony. Without it any app on the device could send
     * this activity a VIEW intent for a URL of its choosing and have it render
     * inside the Hasino WebView, on Hasino's task, wearing Hasino's identity —
     * a convincing place to ask for a password. The intent-filter narrows what
     * Android routes here; this narrows what is honoured once it arrives.
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
        boolean sameOrigin =
            link.getScheme() != null &&
            link.getScheme().equalsIgnoreCase(configured.getScheme()) &&
            link.getHost() != null &&
            link.getHost().equalsIgnoreCase(configured.getHost()) &&
            link.getPort() == configured.getPort();
        if (!sameOrigin) {
            return;
        }

        final String url = link.toString();
        // post() rather than a direct call: on a cold start this runs inside
        // onCreate, while the WebView is still being handed its first URL.
        // Queueing behind that is what makes the callback the last navigation
        // instead of a race with the initial load.
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(url));
    }
}
