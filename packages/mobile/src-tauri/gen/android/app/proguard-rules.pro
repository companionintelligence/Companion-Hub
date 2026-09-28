# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Rust calls AuthSession.start by name, and the Auth Tab callback calls the
# native method. R8 cannot see either caller, so a release AAB would strip
# sign-in and then crash or no-op.
-keep class computer.ci.app.hub.AuthSession {
    public static void start(android.app.Activity, java.lang.String, java.lang.String);
    public static void deliver(androidx.browser.auth.AuthTabIntent$AuthResult);
    private static native void nativeOnResult(java.lang.String, java.lang.String, java.lang.String);
}
