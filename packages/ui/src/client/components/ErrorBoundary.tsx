'use client';

import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            padding: '24px',
            textAlign: 'center',
            color: 'var(--noetic-text)',
            backgroundColor: 'var(--noetic-bg)',
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              fontSize: '48px',
              marginBottom: '16px',
            }}
          >
            ⚠️
          </div>
          <h2
            style={{
              margin: '0 0 8px 0',
              fontSize: '18px',
            }}
          >
            Something went wrong
          </h2>
          <p
            style={{
              margin: '0 0 16px 0',
              fontSize: '14px',
              color: 'var(--noetic-text-secondary)',
            }}
          >
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() =>
              this.setState({
                hasError: false,
                error: null,
              })
            }
            style={{
              padding: '8px 16px',
              backgroundColor: 'var(--noetic-button-bg)',
              border: '1px solid var(--noetic-border)',
              borderRadius: '4px',
              color: 'var(--noetic-text)',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
