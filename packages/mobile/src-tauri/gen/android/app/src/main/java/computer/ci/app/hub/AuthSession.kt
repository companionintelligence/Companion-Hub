package computer.ci.app.hub

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResultLauncher
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * In-app sign-in. Chrome Auth Tab is the Android counterpart of iOS
 * ASWebAuthenticationSession: the redirect comes back through a callback
 * instead of an activity intent, and the user never leaves Companion Hub.
 *
 * Browsers without Auth Tab (Chrome before 137, and http URLs, which Auth Tab
 * refuses) open a Custom Tab instead. That path finishes through the existing
 * `cihub://` intent filter. We report OPENED immediately. Waiting for the tab
 * to close comes back as RESULT_CANCELED and would abort a login that already
 * succeeded.
 */
class AuthSession private constructor() {
    companion object {
        private var launcher: ActivityResultLauncher<Intent>? = null

        fun attach(launcher: ActivityResultLauncher<Intent>) {
            this.launcher = launcher
        }

        @JvmStatic
        fun start(activity: Activity, url: String, scheme: String) {
            val parsed = Uri.parse(url)
            val urlScheme = parsed.scheme?.lowercase()
            if (urlScheme != "https" && urlScheme != "http") {
                nativeOnResult(null, "FAILED", "A valid http(s) url is required")
                return
            }

            val redirect = scheme.trim().ifEmpty { "cihub" }
            if (urlScheme == "https" && authTabSupported(activity)) {
                val authLauncher = launcher
                if (authLauncher == null) {
                    nativeOnResult(null, "FAILED", "Could not present the sign-in sheet")
                    return
                }
                try {
                    AuthTabIntent.Builder().build().launch(authLauncher, parsed, redirect)
                } catch (_: ActivityNotFoundException) {
                    nativeOnResult(null, "FAILED", "Could not open the sign-in sheet.")
                }
                return
            }

            try {
                CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, parsed)
                nativeOnResult(null, "OPENED", null)
            } catch (_: ActivityNotFoundException) {
                nativeOnResult(null, "FAILED", "Could not open the sign-in sheet.")
            }
        }

        @JvmStatic
        fun deliver(result: AuthTabIntent.AuthResult) {
            when (result.resultCode) {
                AuthTabIntent.RESULT_OK -> {
                    val callback = result.resultUri?.toString()
                    if (callback.isNullOrBlank()) {
                        nativeOnResult(null, "FAILED", "Sign-in finished without a callback")
                    } else {
                        nativeOnResult(callback, null, null)
                    }
                }
                AuthTabIntent.RESULT_CANCELED ->
                    nativeOnResult(null, "CANCELLED", "Sign-in cancelled")
                else ->
                    nativeOnResult(null, "FAILED", "Could not open the sign-in sheet.")
            }
        }

        private fun authTabSupported(activity: Activity): Boolean {
            val provider = CustomTabsClient.getPackageName(activity, null) ?: return false
            return CustomTabsClient.isAuthTabSupported(activity, provider)
        }

        @JvmStatic
        private external fun nativeOnResult(url: String?, code: String?, message: String?)
    }
}
