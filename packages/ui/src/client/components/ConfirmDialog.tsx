'use client';

import type React from 'react';
import { createContext, useCallback, useContext, useState } from 'react';

interface ConfirmDialogState {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

interface ConfirmDialogContextValue {
  showConfirm: (options: Omit<ConfirmDialogState, 'isOpen'>) => Promise<boolean>;
}

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null);

export function useConfirmDialog(): ConfirmDialogContextValue {
  const context = useContext(ConfirmDialogContext);
  if (!context) {
    throw new Error('useConfirmDialog must be used within ConfirmDialogProvider');
  }
  return context;
}

interface ConfirmDialogProviderProps {
  children: React.ReactNode;
}

export const ConfirmDialogProvider: React.FC<ConfirmDialogProviderProps> = ({ children }) => {
  const [state, setState] = useState<ConfirmDialogState>({
    isOpen: false,
    title: '',
    description: '',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    onConfirm: () => {},
    onCancel: () => {},
  });

  const showConfirm = useCallback(
    (options: Omit<ConfirmDialogState, 'isOpen'>): Promise<boolean> => {
      return new Promise((resolve) => {
        setState({
          isOpen: true,
          ...options,
          onConfirm: () => {
            setState((prev) => ({
              ...prev,
              isOpen: false,
            }));
            options.onConfirm();
            resolve(true);
          },
          onCancel: () => {
            setState((prev) => ({
              ...prev,
              isOpen: false,
            }));
            options.onCancel();
            resolve(false);
          },
        });
      });
    },
    [],
  );

  return (
    <ConfirmDialogContext.Provider
      value={{
        showConfirm,
      }}
    >
      {children}
      {state.isOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {/* Backdrop */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
            }}
            onClick={state.onCancel}
          />

          {/* Dialog */}
          <div
            style={{
              position: 'relative',
              backgroundColor: 'var(--noetic-sidebar-bg)',
              border: '1px solid var(--noetic-border)',
              borderRadius: '8px',
              padding: '24px',
              minWidth: '400px',
              maxWidth: '90vw',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              zIndex: 1,
            }}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
          >
            <h2
              id="confirm-title"
              style={{
                margin: '0 0 8px 0',
                fontSize: '18px',
                fontWeight: 600,
                color: 'var(--noetic-text)',
              }}
            >
              {state.title}
            </h2>
            <p
              id="confirm-description"
              style={{
                margin: '0 0 24px 0',
                fontSize: '14px',
                color: 'var(--noetic-text-secondary)',
                lineHeight: 1.5,
              }}
            >
              {state.description}
            </p>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '12px',
              }}
            >
              <button
                type="button"
                onClick={state.onCancel}
                style={{
                  padding: '8px 16px',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: 'var(--noetic-text)',
                  backgroundColor: 'transparent',
                  border: '1px solid var(--noetic-border)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--noetic-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {state.cancelLabel}
              </button>
              <button
                type="button"
                onClick={state.onConfirm}
                style={{
                  padding: '8px 16px',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: 'white',
                  backgroundColor: 'var(--noetic-error)',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'opacity 0.15s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '1';
                }}
              >
                {state.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmDialogContext.Provider>
  );
};
