// Barrel for the Store facade, split (2026-06) behind UNCHANGED exports into
// per-domain mixins under `store/`. All callers keep importing from
// `./store.js` / `../store.js` and using `new Store(config)` + `store.foo()` —
// the public surface is identical. See store/index.ts for the composition and
// store/internal.ts for the shared base + schema/migrations.
export {
  Store,
  normalizeHashtags,
  MAX_HASHTAGS,
  CLAUDE_OAUTH_TOKEN_KEY,
  SIGNUP_MODE_KEY,
  MODEL_OVERRIDE_KEY,
  AVATAR_TASK_RESTART_ERROR,
} from "./store/index.js";
