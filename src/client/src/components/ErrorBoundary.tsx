import { Component, type ErrorInfo, type ReactNode } from "react";

// React removes the WHOLE tree when a component throws while rendering — one
// bad row would leave a blank page. These two boundaries keep the rest of the
// app on screen: `ViewBoundary` around the active view (the rail and the
// dialogs stay usable, and another view can be opened), `AppBoundary` around
// everything as the last resort.

interface BoundaryState {
  error: Error | null;
}

function report(scope: string, error: Error, info: ErrorInfo): void {
  // The console is the only place a user can copy this from for a bug report.
  console.error(`[${scope}] render failed:`, error, info.componentStack);
}

interface ViewBoundaryProps {
  /** Changes when another view is shown: the boundary forgets the error with it. */
  resetKey: string;
  children: ReactNode;
}

export class ViewBoundary extends Component<ViewBoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report("view", error, info);
  }

  componentDidUpdate(previous: ViewBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-fallback-pad">
        <div className="warn-box" role="alert">
          이 화면을 표시하지 못했습니다. 다른 메뉴는 계속 사용할 수 있습니다.{" "}
          <button className="linkish" type="button" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }
}

export class AppBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report("app", error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-status-screen" role="alert">
        <div className="app-status-card warn-box">
          <strong>화면을 표시하지 못했습니다</strong>
          <span>페이지를 새로 고치면 다시 시작합니다. 진행 중이던 작업은 서버에서 계속됩니다.</span>
          <button className="primary" type="button" onClick={() => location.reload()}>
            새로 고침
          </button>
        </div>
      </div>
    );
  }
}
