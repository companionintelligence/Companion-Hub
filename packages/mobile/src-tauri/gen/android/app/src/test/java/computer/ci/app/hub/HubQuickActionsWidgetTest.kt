package computer.ci.app.hub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HubQuickActionsWidgetTest {
    @Test
    fun `widget actions use only supported app intent destinations`() {
        assertEquals("cihub://intent/home", hubWidgetDeepLink("home"))
        assertEquals("cihub://intent/connect", hubWidgetDeepLink("connect"))
        assertEquals("cihub://intent/switch", hubWidgetDeepLink("switch"))
        assertEquals("cihub://intent/settings", hubWidgetDeepLink("settings"))
    }

    @Test
    fun `widget refuses arbitrary deep link actions`() {
        assertNull(hubWidgetDeepLink("https://example.com"))
        assertNull(hubWidgetDeepLink("app?urn=external:app"))
    }
}
