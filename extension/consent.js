// Consent page for the browser bridge. background.js opens this as a popup
// window and the answer travels back over the extension-INTERNAL message channel
// (web pages only ever reach onMessageExternal), and the background closes the
// window on settle.
//
// Kinds, chosen by the `kind` query param:
//   - default (tab-group creation): new_tab found no Noah group and asks to make
//     one, showing the URL about to open.
//   - kind=cookies (read_cookies): the avatar wants THIS site's cookies —
//     including login session tokens — handed to it and stored in the chat.
//   - kind=local / kind=session (read_storage): the avatar wants THIS site's
//     localStorage / sessionStorage values — which may hold login/auth tokens —
//     handed to it and stored in the chat.
//   - kind=console (read_console): the avatar wants THIS site's console messages
//     (logs, errors) in this tab — captured from now on, token-shaped strings
//     masked — handed to it and stored in the chat.
//   - kind=network (read_network): the avatar wants THIS site's request list in
//     this tab — method, address without query, status, type, timing; never
//     headers or bodies — captured from now on.
//   - kind=secret (type / fill_form with a stored secret): the avatar wants to
//     TYPE one of the owner's stored secrets into this site. The only kind that
//     writes rather than reads, so it also names the secret and whether it is
//     restricted to a password field — and the only kind whose approval is
//     SESSION-WIDE rather than per site (one yes covers every site the owner
//     allowed for that secret in Noah's settings), which the copy has to say
//     plainly: the host shown is where this write is going, not the limit of
//     what is being approved.
//
// The URL/host shown here is DISPLAY-ONLY (textContent, never markup). Whether
// the action may happen at all was already decided (origin allowlist / the
// server) before this page appeared.

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const kind = params.get("kind") || "group";

// Human-readable name of the store a read_storage consent popup is asking about.
const STORAGE_LABEL = { local: "localStorage", session: "sessionStorage" };

if (kind === "cookies") {
  const host = params.get("host") || "";
  document.title = "쿠키 접근 허용";
  document.getElementById("title").textContent = "이 사이트의 쿠키를 아바타에게 넘길까요?";
  document.getElementById("lead").textContent =
    "아바타가 현재 탭의 쿠키를 읽으려고 합니다. 허용하면 이 사이트의 쿠키가 — 로그인 세션 " +
    "토큰을 포함해 — 읽혀 아바타에게 전달되고 대화 기록에 저장됩니다. 또한 이 사이트는 이번 " +
    "브라우저 세션 동안 기억되어, 확장 설정에서 취소하거나 브라우저를 닫기 전까지는 같은 사이트에 " +
    "대해 다시 묻지 않습니다.";
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  // No full URL line for cookies — the host is what matters, and a path/query
  // could itself carry a token we should not surface.
  document.getElementById("url").textContent = "";
  document.getElementById("hint").textContent =
    "세션 토큰이 노출되면 이 사이트에 로그인한 것과 같은 접근이 가능해집니다. 신뢰하는 작업에만 " +
    "허용하세요. 허용은 이번 세션 동안 이 사이트에 대해 유지되며, 확장 설정에서 언제든 취소할 수 " +
    "있습니다. 20초 안에 응답하지 않으면 이 요청은 만료됩니다.";
  document.getElementById("allow").textContent = "허용";
} else if (kind === "local" || kind === "session") {
  const host = params.get("host") || "";
  const label = STORAGE_LABEL[kind];
  document.title = "저장소 접근 허용";
  document.getElementById("title").textContent = `이 사이트의 ${label} 값을 아바타에게 넘길까요?`;
  document.getElementById("lead").textContent =
    `아바타가 현재 탭의 ${label} 값을 읽으려고 합니다. 허용하면 이 사이트의 ${label} 값이 — 로그인/인증 ` +
    "토큰이 담겨 있을 수 있습니다 — 읽혀 아바타에게 전달되고 대화 기록에 저장됩니다. 또한 이 사이트는 이번 " +
    "브라우저 세션 동안 기억되어, 확장 설정에서 취소하거나 브라우저를 닫기 전까지는 같은 사이트의 이 " +
    "저장소에 대해 다시 묻지 않습니다.";
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  // No full URL line — the host is what matters, and a storage key/value could
  // itself carry a token we should not surface.
  document.getElementById("url").textContent = "";
  document.getElementById("hint").textContent =
    `${label}에 담긴 토큰이 노출되면 이 사이트에 로그인한 것과 같은 접근이 가능해집니다. 신뢰하는 작업에만 ` +
    "허용하세요. 허용은 이번 세션 동안 이 사이트의 이 저장소에 대해 유지되며, 확장 설정에서 언제든 취소할 수 " +
    "있습니다. 20초 안에 응답하지 않으면 이 요청은 만료됩니다.";
  document.getElementById("allow").textContent = "허용";
} else if (kind === "console" || kind === "network") {
  const host = params.get("host") || "";
  const isConsole = kind === "console";
  const what = isConsole ? "콘솔 메시지(로그·오류)" : "네트워크 요청 목록";
  document.title = isConsole ? "콘솔 접근 허용" : "네트워크 기록 접근 허용";
  document.getElementById("title").textContent = `이 사이트의 ${what}을 아바타에게 넘길까요?`;
  document.getElementById("lead").textContent =
    `아바타가 현재 탭에서 이 사이트의 ${what}을 읽으려고 합니다. 허용하면 지금부터 이 탭의 ${what}을 ` +
    "기록하기 시작하고, 읽은 내용은 아바타에게 전달되어 대화 기록에 저장됩니다. " +
    (isConsole
      ? "토큰처럼 보이는 문자열은 가려서 넘기지만, 페이지가 콘솔에 남긴 내용이 그대로 보일 수 있습니다. "
      : "요청 방식·주소(검색어 부분 제외)·상태 코드·종류·소요 시간만 넘기고, 헤더나 본문은 넘기지 않습니다. ") +
    "이 사이트는 이번 브라우저 세션 동안 기억되어, 확장 설정에서 취소하거나 브라우저를 닫기 전까지는 다시 묻지 않습니다.";
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  document.getElementById("url").textContent = "";
  document.getElementById("hint").textContent =
    "다른 사이트로 이동하거나 허용을 취소하면 기록은 멈추고 지워집니다. 신뢰하는 작업에만 허용하세요. " +
    "20초 안에 응답하지 않으면 이 요청은 만료됩니다.";
  document.getElementById("allow").textContent = "허용";
} else if (kind === "secret") {
  const host = params.get("host") || "";
  const name = params.get("name") || "";
  // The FIELD the value would land in, decided by the owner's own per-secret
  // 비밀번호 필드에만 setting — the user should see which of the two they are
  // approving, because "아무 입력 필드" is the wider of the two by a lot.
  const field = params.get("field") === "any" ? "입력 필드" : "비밀번호 필드";
  document.title = "시크릿 입력 허용";
  document.getElementById("title").textContent = "저장된 시크릿 입력을 허용할까요?";
  document.getElementById("lead").textContent =
    `아바타가 아래 사이트의 ${field}에 저장해 둔 시크릿 값을 입력하려고 합니다. 값은 브라우저가 바로 입력하며 ` +
    "아바타에게는 보이지 않습니다(길이만 확인합니다). 허용하면 이번 브라우저 세션 동안 기억되어, 이 사이트뿐 " +
    "아니라 설정에서 시크릿마다 허용해 둔 모든 사이트에서 다시 묻지 않습니다. 아래 주소는 지금 입력하려는 " +
    "곳을 알려 줄 뿐입니다.";
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  // The secret NAME, not its value — the extension never receives a value it
  // could show here, and this page must never become the place one appears.
  document.getElementById("url").textContent = name ? `시크릿 ${name} · ${field}` : field;
  document.getElementById("hint").textContent =
    "로그인을 직접 시키지 않았다면 거부하세요. 이 허용은 입력할 수 있는 사이트를 넓히지 않습니다 — 시크릿은 " +
    "설정에서 그 시크릿에 지정한 사이트에서만 입력됩니다. 허용은 확장 설정 페이지에서 언제든 취소할 수 있고, " +
    "브라우저를 닫으면 사라집니다. 20초 안에 응답하지 않으면 이 요청은 만료됩니다.";
  document.getElementById("allow").textContent = "허용";
} else {
  const rawUrl = params.get("url") || "";
  let host = "";
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    // Unparseable URL: leave the hostname line to its fallback text.
  }
  document.getElementById("host").textContent = host || "(알 수 없는 주소)";
  document.getElementById("url").textContent = rawUrl;
}

let answered = false;
function answer(allow) {
  if (answered) return;
  answered = true;
  // The background settles the request and removes this window; the callback
  // close is the fallback for when it already lost track of us.
  chrome.runtime.sendMessage({ type: "noah-group-consent", token, allow }, () => {
    void chrome.runtime.lastError;
    window.close();
  });
}

document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
