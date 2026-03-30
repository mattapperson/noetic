import { RootProvider } from 'fumadocs-ui/provider/next';
import { jetbrainsMono } from '@/lib/fonts';
import './global.css';

export const metadata = {
  title: 'Noetic — Agent Framework',
  description: 'Primitives to build agents from scratch. Patterns to start fast.',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <body
        style={{
          fontFamily: 'var(--font-mono), monospace',
          background: 'var(--color-tui-bg)',
          color: 'var(--color-tui-fg)',
        }}
      >
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
