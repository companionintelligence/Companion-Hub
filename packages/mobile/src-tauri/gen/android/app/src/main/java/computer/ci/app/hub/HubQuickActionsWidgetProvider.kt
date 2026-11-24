package computer.ci.app.hub

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

internal fun hubWidgetDeepLink(action: String): String? = when (action) {
    "home", "connect", "switch", "settings" -> "cihub://intent/$action"
    else -> null
}

class HubQuickActionsWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
        widgetIds.forEach { widgetId ->
            val views = RemoteViews(context.packageName, R.layout.widget_hub_quick_actions)
            bindAction(context, views, widgetId, R.id.widget_hub_open, "home", 0)
            bindAction(context, views, widgetId, R.id.widget_hub_connect, "connect", 1)
            bindAction(context, views, widgetId, R.id.widget_hub_switch, "switch", 2)
            bindAction(context, views, widgetId, R.id.widget_hub_settings, "settings", 3)
            manager.updateAppWidget(widgetId, views)
        }
    }

    private fun bindAction(
        context: Context,
        views: RemoteViews,
        widgetId: Int,
        viewId: Int,
        action: String,
        actionIndex: Int,
    ) {
        val deepLink = hubWidgetDeepLink(action) ?: return
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink))
            .setClass(context, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            context,
            widgetId * 10 + actionIndex,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        views.setOnClickPendingIntent(viewId, pendingIntent)
    }
}
