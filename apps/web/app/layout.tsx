import type { Metadata } from 'next';
import { Inter, Plus_Jakarta_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  weight: ['600', '700', '800'],
});

// Use JetBrains Mono as monospace — reliable on Google Fonts, similar aesthetic to Geist Mono
const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: 'Clixsy Intercept',
  description: 'AI search visibility & brand alignment monitoring',
  icons: { icon: '/clixsy-logo.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-[var(--bg-primary)] font-[family-name:var(--font-inter)] text-white antialiased">
        {children}
      </body>
    </html>
  );
}
