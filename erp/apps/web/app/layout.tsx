import type { Metadata } from 'next';
import './globals.css';
import '../src/styles/tokens.css';
import '../src/styles/components.css';
import { BRAND } from '@/lib/brand';

export const metadata: Metadata = { title: BRAND.name, robots: { index: false }, icons: { icon: '/icon.svg' } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
