/**
 * H5P player page.
 *
 * Decision: H5P packages are unpacked server-side with our own dependency-free ZIP
 * reader (zip.ts) and served file-by-file from storage. They are rendered with the
 * open-source h5p-standalone runtime loaded from a pinned jsDelivr URL.
 *
 * Security model: package code is untrusted (H5P libraries are arbitrary JS), so
 * the player page and every package file are served with a CSP `sandbox` directive
 * (no `allow-same-origin`), which gives them an opaque origin even when opened
 * directly: they cannot read the LMS cookies, storage or DOM. Because the sandbox
 * has no cookies, package files are authorised with a short-lived HMAC token in the
 * URL instead of the session. Scores are reported to the parent window with
 * postMessage; the parent (signed-in app) validates the source and calls the API.
 */

export const H5P_STANDALONE_VERSION = "3.6.0";
const CDN = `https://cdn.jsdelivr.net/npm/h5p-standalone@${H5P_STANDALONE_VERSION}/dist`;

export const PLAYER_CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
  "default-src 'self' https://cdn.jsdelivr.net",
  // H5P libraries rely on inline handlers and occasionally eval.
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "connect-src 'self'",
  "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

/** Applied to every extracted package file (e.g. an SVG opened directly cannot run in our origin). */
export const PACKAGE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'";

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function playerHtml(input: { title: string; packageBase: string }) {
  const options = JSON.stringify({
    h5pJsonPath: input.packageBase,
    frameJs: `${CDN}/frame.bundle.js`,
    frameCss: `${CDN}/styles/h5p.css`,
    frame: false,
    copyright: false,
    export: false,
    icon: false,
    fullScreen: true,
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(input.title)}</title>
<style>html,body{margin:0;padding:0;background:#fff;font-family:system-ui,sans-serif}#h5p{min-height:120px}.err{padding:16px;color:#b91c1c}</style>
<script src="${CDN}/main.bundle.js"></script>
</head>
<body>
<div id="h5p" role="region" aria-label="${escapeAttr(input.title)}"></div>
<script>
(function () {
  var options = ${options};
  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (e) {} }
  function resize() { post({ type: "lms-h5p:resize", height: document.documentElement.scrollHeight }); }
  var el = document.getElementById("h5p");
  if (!window.H5PStandalone) { el.innerHTML = '<p class="err">The H5P player could not be loaded.</p>'; return; }
  new window.H5PStandalone.H5P(el, options).then(function () {
    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);
    window.H5P.externalDispatcher.on("xAPI", function (event) {
      var s = event && event.data && event.data.statement;
      if (!s || !s.result) return;
      var ctx = s.context && s.context.contextActivities;
      if (ctx && ctx.parent && ctx.parent.length) return; // sub-content: only the top-level result counts
      var verb = (s.verb && s.verb.id) || "";
      var score = s.result.score || {};
      post({
        type: "lms-h5p:xapi",
        verb: verb,
        rawScore: typeof score.raw === "number" ? score.raw : null,
        maxScore: typeof score.max === "number" ? score.max : null,
        completed: s.result.completion === true || /\\/(completed|passed|failed|answered)$/.test(verb),
        statement: { verb: s.verb, result: s.result, object: s.object && { id: s.object.id } }
      });
    });
  }).catch(function () { el.innerHTML = '<p class="err">This H5P content could not be displayed.</p>'; });
})();
</script>
</body>
</html>`;
}
