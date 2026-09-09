import { withDirectMessages } from "./directMessages.js";
import type { AppConfig } from "../types.js";
import { StoreBase } from "./internal.js";
import { withUsers } from "./users.js";
import { withSecrets } from "./secrets.js";
import { withKnowledgeRepo } from "./knowledgeRepo.js";
import { withRoutines } from "./routines.js";
import { withAvatars } from "./avatars.js";
import { withConversations } from "./conversations.js";
import { withAdmin } from "./admin.js";
import { withGroups } from "./groups.js";
import { withGroupAgents } from "./groupAgents.js";
import { withPersonalAgents } from "./personalAgents.js";
import { withAvatarTasks } from "./avatarTasks.js";
import { withBotTasks } from "./botTasks.js";

// Re-export the non-Store public symbols identically to the pre-split module so
// `../store` / `./store` imports keep resolving. Behavior-preserving: the only
// physical change is that the one god-class is now composed from per-domain
// mixins sharing the single StoreBase db handle.
export {
  normalizeHashtags,
  MAX_HASHTAGS,
  CLAUDE_OAUTH_TOKEN_KEY,
  SIGNUP_MODE_KEY,
  MODEL_OVERRIDE_KEY,
} from "./internal.js";
export { MAX_PERSONAL_AGENTS } from "./personalAgents.js";
export { AVATAR_TASK_RESTART_ERROR } from "./avatarTasks.js";

/**
 * The single Store facade. Each per-domain module is a `(Base) => class extends
 * Base { ... }` mixin; they all share `this.db`/`this.secret` and the
 * cross-cutting helpers via StoreBase. Composed here into ONE class so every
 * caller keeps doing `new Store(config)` and `store.foo()` exactly as before —
 * the public method surface is identical to the original god-class.
 *
 * Compose order is irrelevant to runtime behavior (the domain method names are
 * disjoint, so nothing shadows anything); it only feeds TS `this`-typing, which
 * the `declare`d cross-domain method signatures on StoreBase already cover.
 */
const ComposedStore = withDirectMessages(withAvatarTasks(withBotTasks(
  withPersonalAgents(
    withGroupAgents(
      withGroups(
        withAdmin(
          withConversations(
            withAvatars(
              withRoutines(withKnowledgeRepo(withSecrets(withUsers(StoreBase)))),
            ),
          ),
        ),
      ),
    ),
  ),
)));

export class Store extends ComposedStore {
  constructor(config: AppConfig) {
    super(config);
  }
}
