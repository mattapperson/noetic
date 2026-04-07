import type React from 'react';
import { ConfirmDialogProvider } from '../src/client/components/ConfirmDialog';
import './globals.css';

export const metadata = {
  title: 'Noetic UI - Agent Debugger',
  description: 'Visual debugging interface for Noetic agent workflows',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 rx=%2212%22 fill=%22%2339ff14%22/><text x=%2250%22 y=%2268%22 font-family=%22monospace%22 font-size=%2248%22 font-weight=%22700%22 fill=%22%23050505%22 text-anchor=%22middle%22>N</text></svg>"
        />
      </head>
      <body className="bg-[var(--noetic-bg)] text-[var(--noetic-text)] h-screen w-screen overflow-hidden">
        <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
      </body>
    </html>
  );
}
