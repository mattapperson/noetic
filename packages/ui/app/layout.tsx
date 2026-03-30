import type React from 'react';
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
          href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔮</text></svg>"
        />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Required for theme initialization to prevent flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const theme = localStorage.getItem('noetic-ui-theme') || 'system';
                const isDark = theme === 'dark' || 
                  (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
                if (isDark) {
                  document.documentElement.classList.add('dark');
                } else {
                  document.documentElement.classList.add('light');
                }
              })();
            `,
          }}
        />
      </head>
      <body className="bg-[var(--noetic-bg)] text-[var(--noetic-text)]">{children}</body>
    </html>
  );
}
