/** 当前 WebView 是否是 Android 原生壳。浏览器和桌面 Tauri 都返回 false。 */
export function isAndroidWebView(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}
