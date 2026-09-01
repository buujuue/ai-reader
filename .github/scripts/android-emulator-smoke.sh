#!/usr/bin/env bash

set -euo pipefail

: "${EVIDENCE_DIR:?EVIDENCE_DIR must be set by the workflow}"
: "${ANDROID_HOME:?ANDROID_HOME must be set by the workflow}"

mkdir -p "$EVIDENCE_DIR"

ready_timeout_ms="${ANDROID_SMOKE_READY_TIMEOUT_MS:-30000}"
ready_interval_ms="${ANDROID_SMOKE_READY_INTERVAL_MS:-500}"
cdp_port="${ANDROID_SMOKE_CDP_PORT:-9333}"

case "$ready_timeout_ms" in
  ''|*[!0-9]*) echo '::error::ANDROID_SMOKE_READY_TIMEOUT_MS must be a positive integer' >&2; exit 1 ;;
esac
case "$ready_interval_ms" in
  ''|*[!0-9]*) echo '::error::ANDROID_SMOKE_READY_INTERVAL_MS must be a positive integer' >&2; exit 1 ;;
esac
case "$cdp_port" in
  ''|*[!0-9]*) echo '::error::ANDROID_SMOKE_CDP_PORT must be a numeric TCP port' >&2; exit 1 ;;
esac

current_phase="start"
package_id=""
launchable_activity=""

phase_paths() {
  local phase="$1"
  case "$phase" in
    start)
      phase_screenshot="$EVIDENCE_DIR/android-tablet-start.png"
      phase_ui="$EVIDENCE_DIR/android-tablet-start-ui.xml"
      phase_probe="$EVIDENCE_DIR/start-webview-probe.json"
      ;;
    touch)
      phase_screenshot="$EVIDENCE_DIR/android-tablet-after-touch.png"
      phase_ui="$EVIDENCE_DIR/android-tablet-touch-ui.xml"
      phase_probe="$EVIDENCE_DIR/touch-webview-probe.json"
      ;;
    restart)
      phase_screenshot="$EVIDENCE_DIR/android-tablet-after-restart.png"
      phase_ui="$EVIDENCE_DIR/android-tablet-after-restart-ui.xml"
      phase_probe="$EVIDENCE_DIR/restart-webview-probe.json"
      ;;
    *)
      echo "::error::未知 Android 冒烟阶段：$phase" >&2
      return 1
      ;;
  esac
}

ensure_text_evidence() {
  local path="$1"
  local message="$2"
  if ! test -s "$path"; then
    printf '%s\n' "$message" > "$path"
  fi
}

ensure_probe_evidence() {
  local phase="$1"
  phase_paths "$phase"
  if ! test -s "$phase_probe"; then
    printf '{\n  "schemaVersion": "android-webview-probe.v1",\n  "phase": "%s",\n  "packageId": "%s",\n  "result": "not-run",\n  "diagnostic": "WebView 探测器未能启动；请结合该阶段日志、前台 Activity 和目标进程证据定位失败。"\n}\n' \
      "$phase" "$package_id" > "$phase_probe"
  fi
}

capture_phase_evidence() {
  local phase="$1"
  phase_paths "$phase"

  adb shell dumpsys window windows > "$EVIDENCE_DIR/${phase}-foreground-activity.txt" 2>&1 || true
  ensure_text_evidence \
    "$EVIDENCE_DIR/${phase}-foreground-activity.txt" \
    "阶段 $phase 未能读取前台 Activity。"

  if test -n "$package_id"; then
    adb shell pidof "$package_id" > "$EVIDENCE_DIR/${phase}-target-process.txt" 2>&1 || true
  else
    : > "$EVIDENCE_DIR/${phase}-target-process.txt"
  fi
  ensure_text_evidence \
    "$EVIDENCE_DIR/${phase}-target-process.txt" \
    "阶段 $phase 未能读取目标进程；APK 包名可能尚未解析。"

  adb exec-out screencap -p > "$phase_screenshot" 2> "$EVIDENCE_DIR/${phase}-screenshot.log" || true
  ensure_text_evidence \
    "$EVIDENCE_DIR/${phase}-screenshot.log" \
    "阶段 $phase 截图命令未返回额外诊断。"

  local remote_ui="/sdcard/ai-reader-${phase}-ui.xml"
  adb shell uiautomator dump "$remote_ui" > "$EVIDENCE_DIR/${phase}-uiautomator.log" 2>&1 || true
  adb shell cat "$remote_ui" > "$phase_ui" 2>> "$EVIDENCE_DIR/${phase}-uiautomator.log" || true
  if ! test -s "$phase_ui"; then
    printf '%s\n' "阶段 $phase 未能取得 UIAutomator 语义树；请查看 uiautomator 日志。" \
      > "$EVIDENCE_DIR/${phase}-ui-evidence-error.txt"
  fi
  ensure_probe_evidence "$phase"
}

validate_phase_evidence() {
  local phase="$1"
  phase_paths "$phase"

  if ! test -s "$phase_screenshot" || ! file "$phase_screenshot" | grep -q 'PNG image data'; then
    echo "::error::Android $phase 阶段截图无效或为空：$phase_screenshot" >&2
    return 1
  fi
  if ! node scripts/android-webview-probe.mjs --validate-png "$phase_screenshot"; then
    echo "::error::Android $phase 阶段截图像素为空或无法解码：$phase_screenshot" >&2
    return 1
  fi
  if ! test -s "$phase_ui"; then
    echo "::error::Android $phase 阶段语义证据为空：$phase_ui" >&2
    return 1
  fi
  if ! test -s "$phase_probe"; then
    echo "::error::Android $phase 阶段 WebView 探测证据为空：$phase_probe" >&2
    return 1
  fi
  if ! node --input-type=module -e 'import { readFileSync } from "node:fs"; const report = JSON.parse(readFileSync(process.argv[1], "utf8")); if (report.result !== "ready") process.exit(1);' "$phase_probe"; then
    echo "::error::Android $phase 阶段 WebView 探测未报告 ready：$phase_probe" >&2
    return 1
  fi
  if ! grep -q '<hierarchy' "$phase_ui"; then
    echo "::error::Android $phase 阶段 UIAutomator 语义树格式无效：$phase_ui" >&2
    return 1
  fi
}

finish() {
  local status=$?
  set +e
  if test "$status" -ne 0; then
    phase_paths "$current_phase" || true
    printf 'Android %s 阶段失败（退出码 %s）。\n' "$current_phase" "$status" > "$EVIDENCE_DIR/failure-${current_phase}.txt"
    printf '失败阶段：%s\n请优先查看该阶段的 WebView 探测、前台 Activity、目标进程、截图和 UIAutomator 证据。\n' \
      "$current_phase" >> "$EVIDENCE_DIR/failure-${current_phase}.txt"
    capture_phase_evidence "$current_phase" || true
  fi
  adb logcat -d > "$EVIDENCE_DIR/android-logcat.txt" 2>&1 || true
  printf 'Android 冒烟退出码：%s\n最后阶段：%s\n' "$status" "$current_phase" > "$EVIDENCE_DIR/run-summary.txt"
  exit "$status"
}

trap finish EXIT

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

adb install "$apk_path" | tee "$EVIDENCE_DIR/install.log"

run_phase_probe() {
  local phase="$1"
  current_phase="$phase"
  phase_paths "$phase"
  node scripts/android-webview-probe.mjs \
    --phase "$phase" \
    --package-id "$package_id" \
    --port "$cdp_port" \
    --timeout-ms "$ready_timeout_ms" \
    --interval-ms "$ready_interval_ms" \
    --output "$phase_probe" \
    2>&1 | tee "$EVIDENCE_DIR/${phase}-webview-probe.log"
  capture_phase_evidence "$phase"
  validate_phase_evidence "$phase"
}

adb shell am start -n "${package_id}/${launchable_activity}" | tee "$EVIDENCE_DIR/launch.log"
run_phase_probe start

current_phase="touch"
adb shell input swipe 1050 900 400 900 350 | tee "$EVIDENCE_DIR/touch.log"
run_phase_probe touch

current_phase="restart"
adb shell input keyevent 4 | tee "$EVIDENCE_DIR/back.log"
adb shell am force-stop "$package_id" | tee "$EVIDENCE_DIR/force-stop.log"
adb shell am start -n "${package_id}/${launchable_activity}" | tee "$EVIDENCE_DIR/relaunch.log"
run_phase_probe restart

printf 'Android 三阶段 WebView 冒烟通过：start、touch、restart。\n' > "$EVIDENCE_DIR/smoke-passed.txt"
