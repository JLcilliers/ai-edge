import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Edge',
  description: 'Trust Alignment for the AI search era.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className="dark">
        <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
