package com.hasino.app;

import android.os.CancellationSignal;

import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.util.concurrent.Executors;

/**
 * Native Google sign-in, so the account picker appears inside the app and the
 * login never leaves for a browser.
 *
 * The old flow sent Google's OAuth out to Chrome, and Chrome would not hand the
 * result back to the app — the user was stranded on the site in the browser.
 * This asks Android's Credential Manager for a Google ID token directly: the
 * system account sheet is drawn over the app, the user taps an account, and a
 * signed ID token comes straight back. No browser, nothing to return from.
 *
 * The token is a standard Google ID token (a JWT). The web layer hands it to
 * Clerk (`authenticateWithGoogleOneTap`), which verifies it and creates the
 * session in the same WebView that asked for it — see lib/auth.js.
 *
 * `serverClientId` is the Google *Web* OAuth client id that Clerk is configured
 * with; the token is minted for that audience so Clerk will accept it. It is
 * passed in from the web layer, which reads it from Clerk's own environment, so
 * there is one source of truth and nothing to hardcode here.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    @PluginMethod
    public void signIn(PluginCall call) {
        final String serverClientId = call.getString("serverClientId");
        if (serverClientId == null || serverClientId.isEmpty()) {
            call.reject("MISSING_CLIENT_ID: no Google client id configured in Clerk (google_one_tap_client_id)");
            return;
        }

        // filterByAuthorizedAccounts=false so a first-time user still sees every
        // Google account on the device, not an empty sheet. setAutoSelect off so
        // the user always chooses, which is what a sign-in button implies.
        GetGoogleIdOption googleIdOption = new GetGoogleIdOption.Builder()
            .setServerClientId(serverClientId)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(false)
            .build();

        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build();

        CredentialManager credentialManager = CredentialManager.create(getContext());

        credentialManager.getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            Executors.newSingleThreadExecutor(),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    try {
                        if (
                            response.getCredential() instanceof CustomCredential &&
                            GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(response.getCredential().getType())
                        ) {
                            GoogleIdTokenCredential cred = GoogleIdTokenCredential.createFrom(
                                ((CustomCredential) response.getCredential()).getData()
                            );
                            JSObject ret = new JSObject();
                            ret.put("idToken", cred.getIdToken());
                            call.resolve(ret);
                        } else {
                            call.reject("UNEXPECTED_CREDENTIAL: not a Google ID token");
                        }
                    } catch (Exception e) {
                        call.reject("PARSE_FAILED: " + e.getMessage(), e);
                    }
                }

                @Override
                public void onError(GetCredentialException e) {
                    // Includes the user dismissing the sheet (NoCredentialException /
                    // GetCredentialCancellationException). The web layer treats a
                    // reject as "sign-in did not happen" and shows nothing scary.
                    call.reject("SIGN_IN_FAILED: " + e.getClass().getSimpleName() + ": " + e.getMessage(), e);
                }
            }
        );
    }
}
