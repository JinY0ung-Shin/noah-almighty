// Noah's ONE addition to pi-gateway's admin panel, which Noah serves at /admin
// (src/server/routes/piAdminProxy.ts adds this script and pi-admin-names.css to
// pi's page document). pi knows a user only as the id Noah sends it — a UUID —
// so its tables (사용자별 토큰, 진행 중인 턴, 대화 기록, 요청, the mining report)
// name people by UUID, and its sandbox table by the folder name it derives from
// that id (`u-<hash>`). This shows who each one is.
//
// Display only. It never changes a text node or adds an element inside pi's
// (Preact-drawn) tree: an element that SHOWS a known id gets the attribute
// `data-noah-user`, and the stylesheet draws that name before the id. pi's own
// data, requests and markup are untouched, and until Noah has answered who the
// ids are — or if it never does — nothing is marked: the panel is exactly pi's.
(function () {
  "use strict";

  var ATTR = "data-noah-user";
  var NAMES_URL = "/api/admin/pi-user-names";
  var REFRESH_MS = 5 * 60 * 1000;
  // An id nobody was named for (someone approved since the names were read): ask again, at most this often.
  var UNKNOWN_RETRY_MS = 60 * 1000;
  // At most one scan in this long, however often pi's page changes (its chat page streams text).
  var SCAN_DELAY_MS = 120;
  var USER_ID = /^[0-9a-f]{8}-/i;
  // A Noah user id, the principal of a consultation's throwaway sandbox, and a
  // user's sandbox key — on its own, not inside a container name (`pi-sbx-u-…`).
  var ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|consult-[0-9a-f]{24}|(?<![\w-])u-[0-9a-f]{24}(?![\w-])/gi;
  var CONSULTATION = /^consult-/i;
  var CONSULTATION_NAME = "아바타 상담 (임시 샌드박스)";
  // Only an element that shows an id as a VALUE: a table cell, a heading, a
  // short line. A long text that merely contains one (a transcript, a tool
  // result, a file) is left alone, and so is anything typed or preformatted.
  var MAX_TEXT = 120;
  var SKIPPED = "pre, code, textarea, script, style, option, [contenteditable]";

  var names = new Map();
  var loadedAt = 0; // 0 = Noah has not said who anyone is: nothing is marked
  var askedAt = 0;
  var scheduled = false;

  function nameOf(id) {
    return CONSULTATION.test(id) ? CONSULTATION_NAME : names.get(id.toLowerCase());
  }

  function scan() {
    scheduled = false;
    if (!document.body || !loadedAt) return;
    var found = new Map();
    var unknown = false;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var text = node.nodeValue || "";
      if (text.length < 26 || text.trim().length > MAX_TEXT) continue;
      var parent = node.parentElement;
      if (!parent || parent.closest(SKIPPED)) continue;
      ID.lastIndex = 0;
      for (var match = ID.exec(text); match; match = ID.exec(text)) {
        var name = nameOf(match[0]);
        if (!name) {
          if (USER_ID.test(match[0])) unknown = true;
          continue;
        }
        var list = found.get(parent);
        if (!list) found.set(parent, (list = []));
        if (list.indexOf(name) < 0) list.push(name);
      }
    }
    found.forEach(function (list, element) {
      var value = list.join(", ");
      if (element.getAttribute(ATTR) !== value) element.setAttribute(ATTR, value);
    });
    // An element pi reused for something else no longer shows that id.
    var marked = document.querySelectorAll("[" + ATTR + "]");
    for (var i = 0; i < marked.length; i += 1) {
      if (!found.has(marked[i])) marked[i].removeAttribute(ATTR);
    }
    if (unknown && Date.now() - askedAt > UNKNOWN_RETRY_MS) load();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    // Not per frame: pi's chat page changes its text many times a second while an answer streams.
    window.setTimeout(scan, SCAN_DELAY_MS);
  }

  function load() {
    askedAt = Date.now();
    return fetch(NAMES_URL, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (body) {
        if (!body || !Array.isArray(body.users)) return;
        var next = new Map();
        body.users.forEach(function (user) {
          if (user && typeof user.id === "string" && typeof user.name === "string" && user.name) {
            next.set(user.id.toLowerCase(), user.name);
            if (typeof user.key === "string" && user.key) next.set(user.key.toLowerCase(), user.name);
          }
        });
        // Not one usable name (there is always the admin who is looking): not an answer to draw from.
        if (next.size === 0) return;
        names = next;
        if (!loadedAt) watch();
        loadedAt = Date.now();
        schedule();
      })
      .catch(function () {
        // No names: pi's panel as it is.
      });
  }

  /** Follow pi's redraws — only once there are names to draw. */
  function watch() {
    // Attributes are not watched, so marking an element never calls this back.
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function start() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && Date.now() - askedAt > REFRESH_MS) load();
    });
    load();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
