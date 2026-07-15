'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getTemplates, createItem } from '../../../lib/api';
import Link from 'next/link';

export default function NewItemPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const res = await getTemplates();
        setTemplates(res.data);
        if (res.data.length > 0) {
          setTemplateId(res.data[0].id);
        }
      } catch (err) {
        console.error('Failed to fetch templates', err);
      } finally {
        setLoadingTemplates(false);
      }
    };
    
    fetchTemplates();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await createItem({
        templateId,
        title,
        description,
        priority,
      });
      router.push(`/items/${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create item');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <Link href="/" className="btn btn-outline" style={{ padding: '6px 12px' }}>
          &larr; Back
        </Link>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>Create New Item</h1>
      </div>

      <div className="glass-panel" style={{ padding: '32px' }}>
        {error && (
          <div style={{ padding: '12px', background: 'rgba(255, 51, 102, 0.1)', borderLeft: '4px solid var(--accent-danger)', marginBottom: '20px', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        {loadingTemplates ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>Loading templates...</div>
        ) : templates.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            No templates available. Please create a template first.
            <div style={{ marginTop: '16px' }}>
              <Link href="/templates/new" className="btn btn-primary">Create Template</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)' }}>Workflow Template</label>
              <select 
                className="input-field"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                required
              >
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)' }}>Title</label>
              <input 
                type="text" 
                className="input-field" 
                value={title} 
                onChange={(e) => setTitle(e.target.value)} 
                required 
                placeholder="e.g., Vacation Request - John Doe"
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)' }}>Description</label>
              <textarea 
                className="input-field" 
                value={description} 
                onChange={(e) => setDescription(e.target.value)} 
                rows={4}
                placeholder="Details about this request..."
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)' }}>Priority</label>
              <select 
                className="input-field"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button type="submit" className="btn btn-primary" disabled={loading || !title || !templateId}>
                {loading ? 'Creating...' : 'Create Item'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
