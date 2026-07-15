'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '../providers/AuthProvider';
import { getItems } from '../lib/api';
import Link from 'next/link';

export default function Dashboard() {
  const { user } = useAuth();
  const [items, setItems] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  
  // Filters
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset page on search change
    }, 500);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!user) return;
    
    const fetchItems = async () => {
      setLoading(true);
      try {
        const params: any = { page, limit: 12 };
        if (debouncedSearch) params.search = debouncedSearch;
        if (priority) params.priority = priority;
        
        const res = await getItems(params);
        setItems(res.data.data);
        setMeta(res.data.meta);
      } catch (err) {
        console.error('Failed to fetch items', err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchItems();
  }, [user, page, debouncedSearch, priority]);

  if (!user) return null; // Let layout handle redirect or hide

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>Workflow Items</h1>
        <Link href="/items/new" className="btn btn-primary">
          + New Item
        </Link>
      </div>

      <div className="glass-panel" style={{ padding: '20px', marginBottom: '24px', display: 'flex', gap: '16px', alignItems: 'center' }}>
        <input 
          type="text" 
          className="input-field" 
          placeholder="Search by title..." 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <select 
          className="input-field" 
          style={{ width: '200px' }}
          value={priority}
          onChange={(e) => {
            setPriority(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All Priorities</option>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading...</div>
      ) : items.length === 0 ? (
        <div className="glass-panel" style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          No workflow items found.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {items.map((item) => (
            <Link href={`/items/${item.id}`} key={item.id}>
              <div className="glass-panel" style={{ padding: '20px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span className={`badge badge-${item.priority.toLowerCase()}`}>{item.priority}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>v{item.version}</span>
                </div>
                
                <h3 style={{ fontSize: '1.2rem', marginBottom: '8px', color: 'var(--text-primary)' }}>{item.title}</h3>
                
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '16px', flex: 1 }}>
                  Template: {item.template.name}
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: item.currentStage.isFinal ? 'var(--accent-success)' : 'var(--accent-primary)' }}></div>
                    <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{item.currentStage.name}</span>
                  </div>
                  
                  <div style={{ display: 'flex', gap: '8px', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    <span title="Comments">💬 {item._count.comments}</span>
                    <span title="Attachments">📎 {item._count.attachments}</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '32px' }}>
          <button 
            className="btn btn-outline" 
            disabled={!meta.hasPreviousPage}
            onClick={() => setPage(p => p - 1)}
          >
            Previous
          </button>
          <div style={{ display: 'flex', alignItems: 'center', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Page {meta.page} of {meta.totalPages}
          </div>
          <button 
            className="btn btn-outline" 
            disabled={!meta.hasNextPage}
            onClick={() => setPage(p => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
