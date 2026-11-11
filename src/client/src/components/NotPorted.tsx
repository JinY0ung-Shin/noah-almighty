// Placeholder for a screen or component that has not been moved from Svelte to
// React yet. Every file that still re-exports this is a port that is still owed;
// the file goes away when none is left.
export default function NotPorted({ name }: { name?: string }) {
  return (
    <div className="svelte-fallback-pad muted" role="status" data-not-ported={name ?? ""}>
      {name ? `${name}: ` : ""}아직 React로 옮기지 않은 화면입니다.
    </div>
  );
}
