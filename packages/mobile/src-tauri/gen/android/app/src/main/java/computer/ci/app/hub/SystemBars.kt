package computer.ci.app.hub

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.View
import android.view.Window
import android.webkit.JavascriptInterface
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps the app out from under the status bar, the navigation bar and the keyboard.
 *
 * `enableEdgeToEdge()` draws the window behind the system bars, and from targetSdk 36
 * Android 15+ does that whether the app asks or not. The WebView's
 * `env(safe-area-inset-*)` only reports the display cutout, never the navigation bar, so
 * the page cannot pad itself: with three-button navigation the bottom 48 dp of every
 * screen sat behind Back / Home / Recents.
 *
 * So the content view is padded by the bars instead and the page ends where they begin.
 * The insets are consumed here, which means nothing else resizes for the keyboard; the
 * bottom padding is therefore the taller of the navigation bar and the keyboard.
 *
 * The strips this exposes show the window background. [paint] colours it to match the
 * page, and the page calls it through [Bridge] whenever its theme changes.
 */
object SystemBars {
  /** Name the page sees: `window.CiHubSystemBars`. */
  const val BRIDGE_NAME = "CiHubSystemBars"

  fun fitContent(activity: Activity) {
    val content = activity.findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val bars =
          windowInsets.getInsets(
              WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      val padding = padding(bars, ime)
      view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }

  /** The padding on each side: the bars, except at the bottom where the keyboard may be taller. */
  fun padding(bars: Insets, ime: Insets): Insets =
      Insets.of(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))

  /** Colour the strips behind the bars, and pick bar icons that show up against it. */
  fun paint(window: Window, color: Int) {
    window.setBackgroundDrawable(ColorDrawable(color))
    val lightBackground = ColorUtils.calculateLuminance(color) > 0.5
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = lightBackground
    controller.isAppearanceLightNavigationBars = lightBackground
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // Otherwise the system lays its own translucent scrim over the three-button bar,
      // and the strip no longer matches the page.
      window.isNavigationBarContrastEnforced = false
    }
  }

  /** Lets the page hand over its background colour as `#rrggbb`. */
  class Bridge(private val activity: Activity) {
    @JavascriptInterface
    fun setBackgroundColor(hex: String?) {
      val color =
          try {
            Color.parseColor(hex)
          } catch (e: RuntimeException) {
            return
          }
      activity.runOnUiThread { paint(activity.window, color) }
    }
  }
}
