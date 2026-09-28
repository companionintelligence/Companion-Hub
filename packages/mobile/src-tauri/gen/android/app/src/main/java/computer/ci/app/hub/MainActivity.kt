package computer.ci.app.hub

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.browser.auth.AuthTabIntent

class MainActivity : TauriActivity() {
  // Must be created before the activity starts. Auth Tab is the in-app
  // sign-in sheet; dismissing it or finishing it calls AuthSession.deliver.
  private val authLauncher =
      AuthTabIntent.registerActivityResultLauncher(this) { result ->
        AuthSession.deliver(result)
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    AuthSession.attach(authLauncher)
    // Enable remote WebView inspection (chrome://inspect / CDP) in debug builds only.
    if (BuildConfig.DEBUG) {
      WebView.setWebContentsDebuggingEnabled(true)
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
