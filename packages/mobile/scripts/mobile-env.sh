#!/usr/bin/env bash
# Source this before running `pnpm --filter mobile android:*` / `ios:*`:
#   source packages/mobile/scripts/mobile-env.sh
#
# It points the Tauri/Gradle/NDK toolchain at the SDKs installed on this machine.
# Adjust the NDK version if you installed a different one.

# --- Java (Gradle needs JDK 17) ---
if [ -d /opt/homebrew/opt/openjdk@17 ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17
elif [ -x /usr/libexec/java_home ]; then
  export JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
fi

# --- Android SDK + NDK ---
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
# Pick the highest installed NDK automatically.
if [ -d "$ANDROID_HOME/ndk" ]; then
  _ndk="$(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | sort -V | tail -1)"
  if [ -n "$_ndk" ]; then
    export NDK_HOME="$ANDROID_HOME/ndk/$_ndk"
    export ANDROID_NDK_HOME="$NDK_HOME"
  fi
fi

export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:${JAVA_HOME:+$JAVA_HOME/bin:}$PATH"

echo "JAVA_HOME=$JAVA_HOME"
echo "ANDROID_HOME=$ANDROID_HOME"
echo "NDK_HOME=${NDK_HOME:-<none installed>}"
