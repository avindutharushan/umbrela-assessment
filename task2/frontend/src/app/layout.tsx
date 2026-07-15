'use client';

import './globals.css';
import { AuthProvider, useAuth } from '../providers/AuthProvider';
import Link from 'next/link';

function Navigation() {
  const { user, logout } = useAuth();

  if (!user) return null;

  return (
    <nav className="glass-panel" style={{ padding: '16px', marginBottom: '32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ display: 'flex', gap: '24px', alignItems: 'center' }}>
        <h2 style={{ margin: 0, background: 'linear-gradient(to right, var(--accent-primary), var(--accent-secondary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          WorkflowCore
        </h2>
        <Link href="/" style={{ opacity: 0.8 }} className="hover-opacity">Dashboard</Link>
        <Link href="/templates" style={{ opacity: 0.8 }} className="hover-opacity">Templates</Link>
      </div>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
        <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{user.email}</span>
        <button onClick={logout} className="btn btn-outline" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
          Logout
        </button>
      </div>
    </nav>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <title>WorkflowCore</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <AuthProvider>
          <div className="container animate-in">
            <Navigation />
            {children}
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
