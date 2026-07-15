'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { getTemplate, updateTemplate, deleteTemplate, addTemplateStage, addTemplateTransition } from '../../../lib/api';
import Link from 'next/link';

export default function TemplateDetailsPage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params);
  const templateId = unwrappedParams.id;
  
  const router = useRouter();
  
  const [template, setTemplate] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit Meta State
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // New Stage State
  const [isAddingStage, setIsAddingStage] = useState(false);
  const [newStageName, setNewStageName] = useState('');
  const [newStageIsStart, setNewStageIsStart] = useState(false);
  const [newStageIsFinal, setNewStageIsFinal] = useState(false);

  // New Transition State
  const [isAddingTransition, setIsAddingTransition] = useState(false);
  const [newTransName, setNewTransName] = useState('');
  const [newTransFrom, setNewTransFrom] = useState('');
  const [newTransTo, setNewTransTo] = useState('');
  const [newTransRole, setNewTransRole] = useState('');

  const fetchTemplate = async () => {
    try {
      const res = await getTemplate(templateId);
      setTemplate(res.data);
      setEditName(res.data.name);
      setEditDescription(res.data.description || '');
      
      // Defaults for dropdown
      if (res.data.stages && res.data.stages.length > 0) {
        setNewTransFrom(res.data.stages[0].id);
        setNewTransTo(res.data.stages[res.data.stages.length - 1].id);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load template');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTemplate();
  }, [templateId]);

  // --- Handlers ---
  const handleUpdateMeta = async () => {
    setError('');
    try {
      await updateTemplate(templateId, { name: editName, description: editDescription });
      setIsEditing(false);
      await fetchTemplate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Update failed. Are you an Admin?');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to soft-delete this template?')) return;
    setError('');
    try {
      await deleteTemplate(templateId);
      router.push('/templates');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Delete failed. Are you an Admin?');
    }
  };

  const handleAddStage = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await addTemplateStage(templateId, {
        name: newStageName,
        isStart: newStageIsStart,
        isFinal: newStageIsFinal
      });
      setIsAddingStage(false);
      setNewStageName('');
      await fetchTemplate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Add stage failed. Are you an Admin?');
    }
  };

  const handleAddTransition = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await addTemplateTransition(templateId, {
        name: newTransName,
        fromStageId: newTransFrom,
        toStageId: newTransTo,
        permissions: newTransRole ? [{ role: newTransRole }] : []
      });
      setIsAddingTransition(false);
      setNewTransName('');
      await fetchTemplate();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Add transition failed. Are you an Admin?');
    }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading template...</div>;
  if (!template) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Template not found.</div>;

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <Link href="/templates" className="btn btn-outline" style={{ padding: '6px 12px' }}>
          &larr; Templates
        </Link>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>Manage Template</h1>
        <button onClick={handleDelete} className="btn btn-outline" style={{ marginLeft: 'auto', borderColor: 'var(--accent-danger)', color: 'var(--accent-danger)' }}>
          Delete Template
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px', background: 'rgba(255, 51, 102, 0.1)', borderLeft: '4px solid var(--accent-danger)', marginBottom: '20px', borderRadius: '4px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        
        {/* Meta Panel */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Metadata</h3>
            {!isEditing ? (
              <button className="btn btn-outline" onClick={() => setIsEditing(true)} style={{ padding: '4px 8px', fontSize: '0.8rem' }}>Edit</button>
            ) : null}
          </div>

          {isEditing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Name</label>
                <input className="input-field" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Description</label>
                <textarea className="input-field" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={3} />
              </div>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button className="btn btn-outline" onClick={() => { setIsEditing(false); setEditName(template.name); }}>Cancel</button>
                <button className="btn btn-primary" onClick={handleUpdateMeta}>Save Metadata</button>
              </div>
            </div>
          ) : (
            <div>
              <h4 style={{ fontSize: '1.4rem', color: 'var(--text-primary)', marginBottom: '8px' }}>{template.name}</h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>{template.description || 'No description'}</p>
              <div style={{ marginTop: '12px' }}>
                <span className={`badge ${template.isActive ? 'badge-success' : 'badge-danger'}`}>
                  {template.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Stages Panel */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Workflow Stages ({template.stages?.length || 0})</h3>
            <button className="btn btn-outline" onClick={() => setIsAddingStage(!isAddingStage)} style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
              {isAddingStage ? 'Cancel' : '+ Add Stage'}
            </button>
          </div>

          {isAddingStage && (
            <form onSubmit={handleAddStage} style={{ marginBottom: '24px', padding: '16px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <input className="input-field" placeholder="Stage Name" value={newStageName} onChange={e => setNewStageName(e.target.value)} required />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newStageIsStart} onChange={e => setNewStageIsStart(e.target.checked)} /> Is Start
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newStageIsFinal} onChange={e => setNewStageIsFinal(e.target.checked)} /> Is Final
                </label>
                <button type="submit" className="btn btn-primary" style={{ padding: '8px 16px' }}>Add</button>
              </div>
            </form>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '16px' }}>
            {template.stages?.map((stage: any) => (
              <div key={stage.id} style={{ padding: '16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)' }}>{stage.name}</h4>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {stage.isStart && <span className="badge badge-success" style={{ fontSize: '0.7rem' }}>Start</span>}
                  {stage.isFinal && <span className="badge badge-danger" style={{ fontSize: '0.7rem' }}>Final</span>}
                  {!stage.isStart && !stage.isFinal && <span className="badge badge-medium" style={{ fontSize: '0.7rem' }}>Middle</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Transitions Panel */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Transitions ({template.transitions?.length || 0})</h3>
            <button className="btn btn-outline" onClick={() => setIsAddingTransition(!isAddingTransition)} style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
              {isAddingTransition ? 'Cancel' : '+ Add Transition'}
            </button>
          </div>

          {isAddingTransition && (
            <form onSubmit={handleAddTransition} style={{ marginBottom: '24px', padding: '16px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Action Name</label>
                <input className="input-field" placeholder="e.g. Approve" value={newTransName} onChange={e => setNewTransName(e.target.value)} required />
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>From Stage</label>
                <select className="input-field" value={newTransFrom} onChange={e => setNewTransFrom(e.target.value)}>
                  {template.stages?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>To Stage</label>
                <select className="input-field" value={newTransTo} onChange={e => setNewTransTo(e.target.value)}>
                  {template.stages?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Required Role (Optional)</label>
                <select className="input-field" value={newTransRole} onChange={e => setNewTransRole(e.target.value)}>
                  <option value="">None (Any User)</option>
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" style={{ padding: '10px 16px', height: '42px' }}>Add</button>
            </form>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {template.transitions?.map((trans: any) => (
              <div key={trans.id} style={{ display: 'flex', alignItems: 'center', padding: '16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <div style={{ flex: 1 }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{trans.name}</strong>
                </div>
                <div style={{ flex: 2, display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <span className="badge badge-low">{trans.fromStage?.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>&rarr;</span>
                  <span className="badge badge-low">{trans.toStage?.name}</span>
                </div>
                <div style={{ flex: 1, textAlign: 'right' }}>
                  {trans.permissions?.length > 0 ? (
                    <span className="badge badge-urgent">{trans.permissions[0].role || 'Custom'} Role</span>
                  ) : (
                    <span className="badge badge-medium">Any Role</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
