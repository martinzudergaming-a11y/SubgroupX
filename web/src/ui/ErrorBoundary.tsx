import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: ReactNode;
  resetKey?: unknown;
}
interface State {
  hasError: boolean;
  lastKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, lastKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.lastKey) return { hasError: false, lastKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown) {
    console.error('[ErrorBoundary] contained a render error (showing fallback):', error);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
