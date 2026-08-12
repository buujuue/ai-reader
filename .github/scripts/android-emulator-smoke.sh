#!/usr/bin/env bash

set -euo pipefail

: "${EVIDENCE_DIR:?EVIDENCE_DIR must be set by the workflow}"
: "${ANDROID_HOME:?ANDROID_HOME must be set by the workflow}"

apk_path="$(find apps/reader/src-tauri/gen/android -type f -name '*.apk' -path '*/build/outputs/apk/*' -print -quit)"
test -n "$apk_path"
test -f "$apk_path"

aapt_path="$(find "$ANDROID_HOME/build-tools" -type f -name aapt -print | sort -V | tail -n 1)"
test -x "$aapt_path"

apk_badging="$("$aapt_path" dump badging "$apk_path")"
package_id="$(printf '%s\n' "$apk_badging" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
launchable_activity="$(printf '%s\n' "$apk_badging" | sed -n "s/^launchable-activity: name='\([^']*\)'.*/\1/p")"
test -n "$package_id"
test -n "$launchable_activity"

record_resources() {
  local label="$1"
  {
    printf '\n=== %s ===\n' "$label"
    date -Is
    free -h
    if test -r /sys/fs/cgroup/memory.current; then
      printf 'cgroup memory.current=' && cat /sys/fs/cgroup/memory.current
      printf 'cgroup memory.max=' && cat /sys/fs/cgroup/memory.max
      cat /sys/fs/cgroup/memory.events
    fi
    ps -eo pid,ppid,rss,%mem,%cpu,comm --sort=-rss | sed -n '1,20p'
  } | tee -a "$EVIDENCE_DIR/resource-usage.log"
}

cleanup() {
  adb logcat -d > "$EVIDENCE_DIR/android-logcat.txt" 2>&1 || true
}

trap cleanup EXIT

record_resources before-install
adb install "$apk_path" | tee "$EVIDENCE_DIR/install.log"
record_resources after-install
adb shell monkey -p "$package_id" 1 | tee "$EVIDENCE_DIR/launch.log"
record_resources after-launch
sleep 8
record_resources before-start-screenshot
adb exec-out screencap -p > "$EVIDENCE_DIR/android-tablet-start.png"
adb shell uiautomator dump /sdcard/ai-reader-start-ui.xml >/dev/null
adb shell cat /sdcard/ai-reader-start-ui.xml > "$EVIDENCE_DIR/android-tablet-start-ui.xml"
adb shell input swipe 1050 900 400 900 350
sleep 2
adb exec-out screencap -p > "$EVIDENCE_DIR/android-tablet-after-touch.png"
adb shell uiautomator dump /sdcard/ai-reader-touch-ui.xml >/dev/null
adb shell cat /sdcard/ai-reader-touch-ui.xml > "$EVIDENCE_DIR/android-tablet-touch-ui.xml"
adb shell input keyevent 4
sleep 1
adb shell am force-stop "$package_id"
adb shell monkey -p "$package_id" 1 | tee "$EVIDENCE_DIR/relaunch.log"
sleep 8
adb exec-out screencap -p > "$EVIDENCE_DIR/android-tablet-after-restart.png"
