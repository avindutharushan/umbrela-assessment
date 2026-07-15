'use client';

import { useState, useEffect } from 'react';
import { getTemplates } from '../../lib/api';
import Link from 'next/link';

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const res = await getTemplates();
        setTemplates(res.data);
      } catch (err) {
        console.error('Failed to fetch templates', err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchTemplates();
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>Workflow Templates</h1>
        <Link href="/templates/new" className="btn btn-primary">
          + New Template
        </Link>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading templates...</div>
      ) : templates.length === 0 ? (
        <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No templates found. Create one to get started!
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {templates.map((template) => (
            <Link href={`/templates/${template.id}`} key={template.id} style={{ textDecoration: 'none' }}>
              <div 
                className="glass-panel" 
                style={{ padding: '24px', height: '100%', transition: 'transform 0.2s, box-shadow 0.2s', cursor: 'pointer' }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 8px 32px rgba(138, 43, 226, 0.2)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', margin: 0 }}>{template.name}</h3>
                  <span className={`badge ${template.isActive ? 'badge-success' : 'badge-danger'}`}>
                    {template.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '24px', minHeight: '40px' }}>
                  {template.description || 'No description provided.'}
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  <span>Stages: {template.stages?.length || 0}</span>
                  <span>Transitions: {template.transitions?.length || 0}</span>
                </div>
              </div>
            </Link>))}
        </div>
      )}
    </div>
  );
}
