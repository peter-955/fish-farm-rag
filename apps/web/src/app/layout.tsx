import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/lib/providers';
import '@/styles/globals.scss';

export const metadata: Metadata = {
  title: 'Fish Farm RAG',
  description: 'Trusted aquaculture knowledge base',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
