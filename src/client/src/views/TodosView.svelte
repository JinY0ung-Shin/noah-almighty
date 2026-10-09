<script lang="ts">
  // 할 일 tab: the detailed home of the viewer's work to-do list. Left = the add
  // form, status chips, search and the grouped list; right = the selected item's
  // editor. It deliberately reuses the 예약 작업 view's workspace/pane/chip/search/
  // group classes (50-platform-views.css) — the same work-list language and the
  // same ≤980px stacking from ONE stylesheet — and scopes only the to-do rows,
  // forms and chips below. The data is the shared `appState.todos` slice
  // (lib/todos.ts), which the chat overlay and the rail badge read too.
  import { onMount, tick } from "svelte";
  import Icon from "../components/Icon.svelte";
  import { openSeededChat, selectConversation } from "../lib/chat";
  import { confirmAction } from "../lib/confirm";
  import { relativeDayTimeLabel } from "../lib/format";
  import { prefersReducedMotion } from "../lib/motion";
  import { goView, syncHash } from "../lib/nav";
  import { appState, notify, updateState } from "../lib/state";
  import {
    TODO_FILTERS,
    TODO_PRIORITY_LABELS,
    clearCompletedTodos,
    completeTodoWithUndo,
    createTodo,
    deleteTodo,
    dueDateText,
    dueLabel,
    isPendingTodo,
    isTodoFilter,
    loadTodos,
    matchesTodoFilter,
    matchesTodoQuery,
    parseTagInput,
    setTodoDone,
    todoFilterCounts,
    todoSeedText,
    todoSourceTitle,
    updateTodo,
    type TodoChanges,
  } from "../lib/todos";
  import type { TodoFilter, TodoItem, TodoPriority } from "../lib/types";
  import {
    MAX_LISTED_DONE_TODOS,
    MAX_TODO_NOTE_LENGTH,
    MAX_TODO_TITLE_LENGTH,
    TODO_PRIORITIES,
    todoDueBucket,
  } from "../../../shared/todos";

  let loading = false;
  let loadError = "";
  let detailEl: HTMLElement | null = null;
  let listEl: HTMLElement | null = null;

  // Add form.
  let newTitle = "";
  let newDue = "";
  let newPriority: TodoPriority = "normal";
  let newTags = "";
  let newTitleEl: HTMLInputElement | null = null;

  // Editor state, loaded from the selected item. A remote change (poll, avatar)
  // reloads it only while nothing is typed, so a refresh never eats an edit.
  let formForId = "";
  let formTitle = "";
  let formNote = "";
  let formDue = "";
  let formPriority: TodoPriority = "normal";
  let formTags = "";
  // What the form was loaded from. save() sends only the fields the user changed
  // relative to THIS — never relative to the live item, or a field the avatar
  // (or another tab) changed meanwhile would be written back with the stale
  // form value.
  let formBase = { title: "", note: "", due: "", priority: "normal" as TodoPriority, tags: "" };
  let dirty = false;
  let saving = false;
  let delegating = false;
  let openingSource = false;

  onMount(() => {
    void load();
  });

  async function load() {
    if (loading) return;
    loading = true;
    loadError = "";
    try {
      await loadTodos();
    } catch (err) {
      loadError = (err as Error).message || "네트워크 오류";
    } finally {
      loading = false;
    }
  }

  $: todos = $appState.todos;
  $: items = todos.items;
  $: todayKst = todos.todayKst;
  $: counts = todos.counts;
  $: filterId = (isTodoFilter($appState.todoFilter) ? $appState.todoFilter : "all") as TodoFilter;
  $: query = $appState.todoSearch;
  $: filterCounts = todoFilterCounts(items, counts, todayKst);
  $: filtered = items.filter((item) => matchesTodoFilter(item, filterId, todayKst) && matchesTodoQuery(item, query));
  // Open filters group by due bucket (the order the shared sort already gives);
  // 완료 is one newest-first group.
  $: groups =
    filterId === "done"
      ? [{ id: "done", label: "완료", items: filtered }].filter((group) => group.items.length)
      : [
          { id: "overdue", label: "마감 지남", items: filtered.filter((item) => todoDueBucket(item.dueDate, todayKst) === "overdue") },
          { id: "today", label: "오늘", items: filtered.filter((item) => todoDueBucket(item.dueDate, todayKst) === "today") },
          { id: "upcoming", label: "예정", items: filtered.filter((item) => todoDueBucket(item.dueDate, todayKst) === "upcoming") },
          { id: "none", label: "날짜 없음", items: filtered.filter((item) => todoDueBucket(item.dueDate, todayKst) === "none") },
        ].filter((group) => group.items.length);
  $: listedDone = items.filter((item) => item.done).length;
  $: selected = items.find((item) => item.id === $appState.todoSelectedId) ?? null;
  $: syncForm(selected);
  $: headerSummary = !todos.loaded
    ? "업무 할 일을 모아 두고 마감과 우선순위로 관리하세요"
    : `열린 할 일 ${counts.open}개 · 오늘 마감 ${counts.dueToday}개`;
  $: activeFilterLabel = TODO_FILTERS.find((filter) => filter.id === filterId)?.label ?? "전체";
  $: countLabel = query.trim() ? `${filtered.length}개 찾음` : `${filtered.length}개`;
  $: emptyList = counts.open === 0 && counts.done === 0 && !items.length;

  function syncForm(item: TodoItem | null) {
    if (!item) {
      formForId = "";
      dirty = false;
      return;
    }
    if (item.id === formForId && dirty) return;
    formForId = item.id;
    formBase = formFromItem(item);
    formTitle = formBase.title;
    formNote = formBase.note;
    formDue = formBase.due;
    formPriority = formBase.priority;
    formTags = formBase.tags;
    dirty = false;
  }

  function markDirty() {
    dirty = true;
  }

  function setFilter(id: TodoFilter) {
    updateState((state) => {
      state.todoFilter = id;
    });
  }

  // Roving tabindex over the chips, mirroring the 예약 작업 filters.
  function onFilterKeydown(event: KeyboardEvent, currentId: TodoFilter): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = TODO_FILTERS.findIndex((filter) => filter.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TODO_FILTERS.length - 1
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + TODO_FILTERS.length) %
            TODO_FILTERS.length;
    const next = TODO_FILTERS[nextIndex].id;
    setFilter(next);
    requestAnimationFrame(() => document.getElementById(`todo-filter-${next}`)?.focus());
  }

  function clearSearch() {
    updateState((state) => {
      state.todoSearch = "";
    });
  }

  async function add() {
    const title = newTitle.trim();
    if (!title) {
      newTitleEl?.focus();
      return;
    }
    // Clear first so the next item can be typed right away; a failure puts the
    // text back (createTodo already toasts why).
    const draft = { title, priority: newPriority, dueDate: newDue || null, tags: parseTagInput(newTags) };
    newTitle = "";
    newDue = "";
    newPriority = "normal";
    newTags = "";
    const created = await createTodo(draft);
    if (!created && !newTitle) {
      newTitle = draft.title;
      newDue = draft.dueDate ?? "";
      newPriority = draft.priority;
      newTags = draft.tags.join(", ");
    }
    await tick();
    newTitleEl?.focus();
  }

  function toggle(item: TodoItem, checked: boolean) {
    if (checked) void completeTodoWithUndo(item);
    else void setTodoDone(item.id, false);
  }

  // Stacked (narrow) layout puts the editor below the list; reveal it so a
  // selection does not read as "nothing happened".
  function revealDetailWhenStacked(): void {
    if (typeof window === "undefined" || !detailEl) return;
    if (!window.matchMedia?.("(max-width: 980px)").matches) return;
    detailEl.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  async function select(item: TodoItem) {
    if (isPendingTodo(item) || item.id === $appState.todoSelectedId) return;
    if (
      dirty &&
      !(await confirmAction("저장하지 않은 변경 사항이 있습니다. 버리고 다른 할 일을 열까요?", {
        title: "변경 사항을 버릴까요?",
        confirmLabel: "버리기",
        tone: "danger",
      }))
    )
      return;
    dirty = false;
    updateState((state) => {
      state.todoSelectedId = item.id;
    });
    syncHash(true);
    await tick();
    revealDetailWhenStacked();
  }

  async function save() {
    const item = selected;
    if (!item || saving) return;
    const title = formTitle.replace(/\s+/g, " ").trim();
    if (!title) {
      notify("할 일 제목을 입력해 주세요.");
      return;
    }
    const changes: TodoChanges = {};
    if (title !== formBase.title.replace(/\s+/g, " ").trim()) changes.title = title;
    const note = formNote.trim();
    if (note !== formBase.note.trim()) changes.note = note;
    const dueDate = formDue || null;
    if (dueDate !== (formBase.due || null)) changes.dueDate = dueDate;
    if (formPriority !== formBase.priority) changes.priority = formPriority;
    const tags = parseTagInput(formTags);
    if (tags.join("\n") !== parseTagInput(formBase.tags).join("\n")) changes.tags = tags;
    if (!Object.keys(changes).length) {
      dirty = false;
      syncForm(selected);
      return;
    }
    // What was sent: typing that continues while the PATCH is in flight must
    // survive its answer.
    const sent = formSnapshot();
    saving = true;
    const saved = await updateTodo(item.id, changes);
    saving = false;
    if (!saved) return;
    // The editor moved on (버리기 → another item) while this PATCH was in flight:
    // the form now belongs to THAT item, so its base and dirty flag stay its own.
    if (formForId !== item.id) {
      notify("할 일을 저장했습니다.", "ok");
      return;
    }
    if (sameForm(formSnapshot(), sent)) {
      dirty = false;
      syncForm(selected);
    } else {
      // Newer edits are still in the form: keep them (and the dirty flag), and
      // diff the next save against what the server now has.
      formBase = formFromItem(saved);
    }
    notify("할 일을 저장했습니다.", "ok");
  }

  type FormValues = typeof formBase;

  function formSnapshot(): FormValues {
    return { title: formTitle, note: formNote, due: formDue, priority: formPriority, tags: formTags };
  }

  function formFromItem(item: TodoItem): FormValues {
    return { title: item.title, note: item.note, due: item.dueDate ?? "", priority: item.priority, tags: item.tags.join(", ") };
  }

  function sameForm(a: FormValues, b: FormValues): boolean {
    return a.title === b.title && a.note === b.note && a.due === b.due && a.priority === b.priority && a.tags === b.tags;
  }

  function clearDue() {
    formDue = "";
    markDirty();
  }

  async function delegate() {
    const item = selected;
    if (!item || delegating) return;
    delegating = true;
    try {
      await openSeededChat(todoSeedText(item), "할 일 내용을 입력창에 넣었습니다. 검토 후 보내기를 누르세요.");
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      delegating = false;
    }
  }

  async function openSource() {
    const item = selected;
    if (!item?.sourceConversationId || openingSource) return;
    openingSource = true;
    try {
      if (item.source === "routine") goView("routines", item.sourceConversationId);
      else {
        goView("chat");
        await selectConversation(item.sourceConversationId);
      }
    } catch (err) {
      notify(`대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      openingSource = false;
    }
  }

  async function remove(item: TodoItem) {
    const confirmed = await confirmAction(`“${item.title}” 할 일을 삭제할까요? 되돌릴 수 없습니다.`, {
      title: "할 일을 삭제할까요?",
      confirmLabel: "삭제",
      tone: "danger",
    });
    if (!confirmed) return;
    // Where the row sat, so focus can land on its neighbour once it is gone.
    const index = filtered.findIndex((entry) => entry.id === item.id);
    if (await deleteTodo(item.id)) {
      syncHash(true);
      notify("할 일을 삭제했습니다.", "ok");
      await tick();
      const rows = listEl ? Array.from(listEl.querySelectorAll<HTMLButtonElement>(".todo-row-main:not(:disabled)")) : [];
      (rows[Math.min(Math.max(index, 0), rows.length - 1)] ?? newTitleEl)?.focus();
    }
  }

  async function clearDone() {
    const total = counts.done;
    if (!total) return;
    const confirmed = await confirmAction(`완료한 할 일 ${total}개를 모두 삭제할까요? 되돌릴 수 없습니다.`, {
      title: "완료 항목을 비울까요?",
      confirmLabel: "비우기",
      tone: "danger",
    });
    if (!confirmed) return;
    const removed = await clearCompletedTodos();
    if (removed !== null) notify(`완료 항목 ${removed}개를 비웠습니다.`, "ok");
  }
</script>

<header class="view-header">
  <div class="title">
    <h1>할 일</h1>
    <p>{headerSummary}{#if todos.loaded && counts.overdue}<span class="todo-head-alert">{` · 마감 지남 ${counts.overdue}개`}</span>{/if}</p>
  </div>
</header>

<div class="view-body routines-body todos-body">
  {#if !todos.loaded && loadError}
    <div class="warn-box" role="alert">
      할 일을 불러오지 못했습니다: {loadError}
      <button class="linkish" type="button" disabled={loading} on:click={load}>다시 시도</button>
    </div>
  {:else if !todos.loaded}
    <div class="muted pad" role="status">불러오는 중…</div>
  {:else}
    <div class="routine-workspace todo-workspace">
      <!-- ===== Left: add + filter + list ===== -->
      <section class="routine-pane todo-list-pane" aria-label="할 일 목록">
        <form class="todo-add" aria-label="할 일 추가" on:submit|preventDefault={add}>
          <div class="todo-add-main">
            <label class="field todo-add-title">
              <span class="sr-only">새 할 일 제목</span>
              <input
                bind:this={newTitleEl}
                type="text"
                placeholder="할 일을 입력하고 Enter"
                maxlength={MAX_TODO_TITLE_LENGTH}
                bind:value={newTitle}
              />
            </label>
            <button class="primary small todo-add-btn" type="submit" disabled={!newTitle.trim()}>
              <Icon name="plus" size={16} /><span>추가</span>
            </button>
          </div>
          <div class="todo-add-extra">
            <label class="field">
              <span>마감일 (선택)</span>
              <input type="date" bind:value={newDue} />
            </label>
            <label class="field">
              <span>우선순위</span>
              <select bind:value={newPriority}>
                {#each TODO_PRIORITIES as priority (priority)}
                  <option value={priority}>{TODO_PRIORITY_LABELS[priority]}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              <span>태그 (선택)</span>
              <input type="text" placeholder="쉼표로 구분" bind:value={newTags} />
            </label>
          </div>
        </form>

        <div class="routine-side-tools">
          <div class="routine-search-row">
            <span class="routine-search-wrap">
              <input
                class="routine-search"
                type="search"
                placeholder="제목·메모·태그 검색"
                aria-label="할 일 검색"
                value={$appState.todoSearch}
                on:input={(event) =>
                  updateState((state) => {
                    state.todoSearch = event.currentTarget.value;
                  })}
              />
            </span>
            <span class="routine-count muted nowrap">{countLabel}</span>
          </div>
          <!-- Each chip spells its own aria-label: the count is an inline span the
               accname algorithm would glue on as "완료1". -->
          <div class="routine-filter-chips" role="radiogroup" aria-label="할 일 상태">
            {#each TODO_FILTERS as filter (filter.id)}
              {@const active = filterId === filter.id}
              {@const count = filterCounts[filter.id]}
              <button
                id={`todo-filter-${filter.id}`}
                class="routine-chip"
                class:active
                class:danger={filter.id === "overdue" && count > 0}
                type="button"
                role="radio"
                aria-checked={active ? "true" : "false"}
                aria-label={`${filter.label} ${count}`}
                tabindex={active ? 0 : -1}
                on:click={() => setFilter(filter.id)}
                on:keydown={(event) => onFilterKeydown(event, filter.id)}>{filter.label}<span class="routine-chip-n">{count}</span></button
              >
            {/each}
          </div>
        </div>

        <div class="routine-manage-list todo-manage-list scroll-thin" bind:this={listEl}>
          {#if emptyList && !query.trim()}
            <div class="routine-empty tall">
              <span class="routine-empty-icon" aria-hidden="true"><Icon name="check-square" size={20} /></span>
              <h3>아직 할 일이 없습니다</h3>
              <p>위 입력창에 적어 두거나, 대화에서 아바타에게 “할 일에 넣어줘”라고 부탁해 보세요. 내 아바타와의 대화에서는 /todo로도 추가할 수 있어요.</p>
            </div>
          {:else if !filtered.length}
            <div class="routine-empty tall">
              <h3>{query.trim() ? "검색 결과가 없습니다" : `${activeFilterLabel} 할 일이 없습니다`}</h3>
              <p>
                {#if query.trim()}“{query.trim()}”에 맞는 할 일을 찾지 못했습니다.{:else}다른 상태를 골라 보세요.{/if}
              </p>
              <div class="routine-empty-actions">
                {#if query.trim()}<button class="ghost-sm" type="button" on:click={clearSearch}>검색어 지우기</button>{/if}
                {#if filterId !== "all"}<button class="ghost-sm" type="button" on:click={() => setFilter("all")}>전체 보기</button>{/if}
              </div>
            </div>
          {:else}
            {#each groups as group (group.id)}
              <div class="routine-group">
                <div class="routine-group-head static">
                  <span>{group.label}</span>
                  <span class="routine-group-n">{group.items.length}</span>
                </div>
                <ul class="routine-group-items todo-items">
                  {#each group.items as item (item.id)}
                    {@const bucket = todoDueBucket(item.dueDate, todayKst)}
                    {@const active = $appState.todoSelectedId === item.id}
                    {@const pending = isPendingTodo(item)}
                    <li
                      class="todo-row"
                      class:active
                      class:done={item.done}
                      class:overdue={!item.done && bucket === "overdue"}
                      aria-busy={pending ? "true" : undefined}
                    >
                      <!-- The label is only the touch-sized hit area; the name is the checkbox's own. -->
                      <label class="todo-check-hit">
                        <input
                          class="todo-check"
                          type="checkbox"
                          checked={item.done}
                          disabled={pending}
                          aria-label={item.done ? `완료 취소: ${item.title}` : `완료: ${item.title}`}
                          on:change={(event) => toggle(item, event.currentTarget.checked)}
                        />
                      </label>
                      <!-- Named by its visible content (title, then due/priority/tags),
                           so a screen reader hears the same row a sighted user scans. -->
                      <button
                        class="todo-row-main"
                        type="button"
                        disabled={pending}
                        aria-current={active ? "true" : undefined}
                        on:click={() => select(item)}
                      >
                        <span class="todo-row-title">{item.title}</span>
                        {#if item.dueDate || item.priority !== "normal" || item.tags.length || item.source !== "user" || item.note}
                          <span class="todo-row-meta">
                            {#if item.dueDate}
                              <span class="tag todo-due" data-bucket={item.done ? "done" : bucket} title={dueDateText(item.dueDate, todayKst)}
                                >{dueLabel(item.dueDate, todayKst)}</span
                              >
                            {/if}
                            {#if item.priority !== "normal"}
                              <span class="tag todo-priority" data-priority={item.priority}>우선순위 {TODO_PRIORITY_LABELS[item.priority]}</span>
                            {/if}
                            {#each item.tags as tag (tag)}<span class="tag">#{tag}</span>{/each}
                            {#if item.source !== "user"}<span class="tag accent" title={todoSourceTitle(item.source)}>아바타</span>{/if}
                            {#if item.note}<span class="todo-row-note" title="메모 있음"><Icon name="file" size={12} /></span>{/if}
                          </span>
                        {/if}
                      </button>
                    </li>
                  {/each}
                </ul>
              </div>
            {/each}
            {#if filterId === "done" && counts.done > listedDone}
              <p class="muted todo-done-note">최근 완료한 {MAX_LISTED_DONE_TODOS}개만 표시합니다.</p>
            {/if}
          {/if}
        </div>

        {#if filterId === "done" && counts.done > 0}
          <div class="todo-list-foot">
            <button class="ghost-sm danger" type="button" on:click={clearDone}>완료 항목 비우기</button>
          </div>
        {/if}
      </section>

      <!-- ===== Right: editor ===== -->
      <section class="routine-pane todo-detail-pane" class:is-empty={!selected} aria-label="할 일 상세" bind:this={detailEl}>
        {#if selected}
          {@const item = selected}
          <form class="todo-detail" aria-label="할 일 편집" on:submit|preventDefault={save}>
            <div class="todo-detail-head">
              <label class="todo-detail-done">
                <input
                  class="todo-check"
                  type="checkbox"
                  checked={item.done}
                  on:change={(event) => toggle(item, event.currentTarget.checked)}
                />
                <span>{item.done ? "완료됨" : "완료로 표시"}</span>
              </label>
              <span class="muted todo-detail-stamp">
                {item.done && item.completedAt
                  ? `완료 ${relativeDayTimeLabel(item.completedAt)}`
                  : `추가 ${relativeDayTimeLabel(item.createdAt)}`}
              </span>
            </div>
            <label class="field">
              <span>제목</span>
              <input type="text" maxlength={MAX_TODO_TITLE_LENGTH} bind:value={formTitle} on:input={markDirty} />
            </label>
            <label class="field">
              <span>메모</span>
              <textarea
                class="todo-note-input"
                rows="6"
                maxlength={MAX_TODO_NOTE_LENGTH}
                placeholder="자세한 내용, 링크, 진행 상황"
                bind:value={formNote}
                on:input={markDirty}
              ></textarea>
            </label>
            <div class="todo-detail-grid">
              <div class="todo-detail-due">
                <label class="field">
                  <span>마감일</span>
                  <input type="date" bind:value={formDue} on:input={markDirty} on:change={markDirty} />
                </label>
                {#if formDue}<button class="linkish small" type="button" on:click={clearDue}>마감 없음</button>{/if}
              </div>
              <label class="field">
                <span>우선순위</span>
                <select bind:value={formPriority} on:change={markDirty}>
                  {#each TODO_PRIORITIES as priority (priority)}
                    <option value={priority}>{TODO_PRIORITY_LABELS[priority]}</option>
                  {/each}
                </select>
              </label>
            </div>
            <label class="field">
              <span>태그</span>
              <input type="text" placeholder="쉼표로 구분 (최대 5개)" bind:value={formTags} on:input={markDirty} />
            </label>
            <div class="todo-detail-actions">
              <button class="primary small" type="submit" disabled={!dirty || saving}>{saving ? "저장 중…" : "저장"}</button>
              <button class="ghost-sm" type="button" disabled={delegating} on:click={delegate}>아바타에게 맡기기</button>
              {#if item.sourceConversationId}
                <button class="ghost-sm" type="button" disabled={openingSource} on:click={openSource}>출처 대화 열기</button>
              {/if}
              <button class="ghost-sm danger" type="button" on:click={() => remove(item)}>삭제</button>
            </div>
            {#if item.source !== "user"}
              <p class="muted todo-detail-source">{todoSourceTitle(item.source)}</p>
            {/if}
          </form>
        {:else}
          <div class="routine-empty tall">
            <span class="routine-empty-icon" aria-hidden="true"><Icon name="check-square" size={20} /></span>
            <h3>할 일을 골라 보세요</h3>
            <p>목록에서 할 일을 고르면 메모·마감일·우선순위를 고치거나 아바타에게 맡길 수 있어요.</p>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .todo-head-alert {
    color: var(--warn);
  }
  /* The list is the screen's main content, so it takes the flexible width and
     the editor keeps a readable fixed measure — the reverse of 예약 작업, whose
     wide pane is the run transcript. The panes' gap replaces the splitter. */
  .todo-workspace {
    gap: var(--s-4);
  }
  .todo-list-pane {
    flex: 1 1 0;
  }
  .todo-detail-pane {
    flex: 0 0 clamp(300px, 34%, 420px);
    overflow-y: auto;
  }

  .todo-add {
    flex: none;
    display: grid;
    gap: var(--s-2);
  }
  .todo-add-main {
    display: flex;
    align-items: stretch;
    gap: var(--s-2);
  }
  .todo-add-title {
    flex: 1;
    min-width: 0;
  }
  .todo-add-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1-5);
    flex: none;
    white-space: nowrap;
  }
  /* Wrapping tracks, not fixed thirds: Chrome keeps a date input at its
     intrinsic ~176px (wider in some locales) whatever the cell, so a narrow
     pane wraps the fields instead of letting the date run under its neighbour.
     min-width:0 on the cells/controls is the backstop when even one column is
     narrower than that. */
  .todo-add-extra {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 176px), 1fr));
    gap: var(--s-2);
  }
  .todo-add-extra > :global(.field),
  .todo-detail-grid > :global(*) {
    min-width: 0;
  }
  .todo-add-extra :global(input),
  .todo-add-extra :global(select),
  .todo-detail-grid :global(input),
  .todo-detail-grid :global(select) {
    min-width: 0;
    max-width: 100%;
  }
  .todo-add-extra :global(.field span) {
    font-size: var(--t-xs);
  }

  .todo-items {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* The shared scroll-edge mask (80-apple-design.css) fades the list's first and
     last 10px; padding keeps the first group heading out of that fade at rest. */
  .todo-manage-list {
    padding-block: var(--s-2-5);
  }
  /* List items, not cards — same reasoning as .routine-row: the pane is already
     the surface. The checkbox is its own control beside the row's button. */
  .todo-row {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--s-2-5);
    padding: var(--s-2-5) var(--s-3);
    border-radius: var(--r-md);
    background: var(--bg-subtle);
    transition: background-color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
  }
  @media (hover: hover) {
    .todo-row:hover {
      background: var(--panel-strong);
    }
  }
  .todo-row.active {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent) inset;
  }
  .todo-row.overdue::before {
    content: "";
    position: absolute;
    inset: var(--s-2) auto var(--s-2) 0;
    width: 3px;
    border-radius: var(--r-pill);
    background: var(--warn);
  }
  .todo-row[aria-busy="true"] {
    opacity: 0.7;
  }
  .todo-check-hit {
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }
  .todo-check {
    width: 18px;
    height: 18px;
    margin: 1px 0 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  /* Touch: the global 44px target rule exempts checkboxes; the label is the target. */
  @media (pointer: coarse) {
    .todo-check-hit {
      min-width: 44px;
      min-height: 44px;
      margin: calc(var(--s-2-5) * -1) calc(var(--s-2) * -1);
    }
  }
  .todo-check:disabled {
    cursor: progress;
  }
  .todo-row-main {
    min-width: 0;
    display: grid;
    gap: var(--s-1);
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .todo-row-main:disabled {
    cursor: progress;
  }
  .todo-row-main:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 3px;
    border-radius: var(--r-sm);
  }
  .todo-row-title {
    min-width: 0;
    font-size: var(--t-base);
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .todo-row.done .todo-row-title {
    color: var(--muted);
    text-decoration: line-through;
    font-weight: 400;
  }
  .todo-row-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-1);
  }
  .todo-row-note {
    display: inline-flex;
    color: var(--muted);
  }
  /* Due chips: `.tag` base + a colour modifier only (DESIGN.md §4.3). */
  .tag.todo-due[data-bucket="overdue"] {
    color: var(--warn);
    border-color: var(--warn-line);
    background: var(--warn-soft);
    font-weight: 600;
  }
  .tag.todo-due[data-bucket="today"] {
    color: var(--accent-strong);
    border-color: var(--accent-soft-strong);
    background: var(--accent-soft);
    font-weight: 600;
  }
  .tag.todo-priority[data-priority="high"] {
    color: var(--danger);
    border-color: var(--danger-line);
    background: var(--danger-soft);
  }
  .todo-done-note {
    margin: 0;
    padding: 0 var(--s-1-5);
    font-size: var(--t-xs);
  }
  .todo-list-foot {
    flex: none;
    display: flex;
    justify-content: flex-end;
  }

  .todo-detail {
    display: grid;
    gap: var(--s-3);
  }
  .todo-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .todo-detail-done {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    font-weight: 600;
    cursor: pointer;
  }
  .todo-detail-stamp {
    font-size: var(--t-xs);
  }
  .todo-note-input {
    width: 100%;
    min-height: 120px;
    resize: vertical;
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--s-2-5) var(--s-3);
    font: inherit;
    line-height: 1.5;
  }
  .todo-detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 176px), 1fr));
    gap: var(--s-2);
    align-items: start;
  }
  .todo-detail-due {
    display: grid;
    gap: var(--s-1);
    justify-items: start;
  }
  .todo-detail-due .field {
    width: 100%;
  }
  .todo-detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
  }
  .todo-detail-source {
    margin: 0;
    font-size: var(--t-xs);
  }

  /* Stacked (≤980px, the 예약 작업 breakpoint): every pane takes its content
     height in the scrolling page. The list pane's desktop `flex: 1 1 0` would
     otherwise collapse it to nothing inside the auto-height column (its rows
     overflowing under the editor), and the shared scroll mask then hides them. */
  @media (max-width: 980px) {
    .todo-list-pane {
      flex: none;
    }
    .todo-detail-pane {
      flex-basis: auto;
      overflow: visible;
    }
    /* Nothing selected: the editor's placeholder would only push the page
       taller; a selection brings the pane back (and scrolls to it). */
    .todo-detail-pane.is-empty {
      display: none;
    }
  }
</style>
