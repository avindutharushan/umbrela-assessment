'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTemplate } from '../../../lib/api';
import Link from 'next/link';

export default function NewTemplatePage() {
  const router = useRouter();
  
  // Basic Info
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  
  // Dynamic Stages
  const [stages, setStages] = useState([
    { name: 'Draft', isStart: true, isFinal: false },
    { name: 'Review', isStart: false, isFinal: false },
  ]);

  // Dynamic Transitions
  const [transitions, setTransitions] = useState([
    { name: 'Submit for Review', fromStageName: 'Draft', toStageName: 'Review', role: '' },
  ]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // --- Handlers for Stages ---
  const handleAddStage = () => {
    setStages([...stages, { name: `Stage ${stages.length + 1}`, isStart: false, isFinal: false }]);
  };

  const handleRemoveStage = (index: number) => {
    if (stages.length <= 2) return alert('You must have at least 2 stages.');
    const updatedStages = stages.filter((_, i) => i !== index);
    setStages(updatedStages);
  };

  const updateStage = (index: number, field: string, value: any) => {
    const updated = [...stages];
    updated[index] = { ...updated[index], [field]: value };
    setStages(updated);
  };

  // --- Handlers for Transitions ---
  const handleAddTransition = () => {
    setTransitions([...transitions, { name: 'New Transition', fromStageName: stages[0].name, toStageName: stages[stages.length - 1].name, role: '' }]);
  };

  const handleRemoveTransition = (index: number) => {
    if (transitions.length <= 1) return alert('You must have at least 1 transition.');
    const updated = transitions.filter((_, i) => i !== index);
    setTransitions(updated);
  };

  const updateTransition = (index: number, field: string, value: any) => {
    const updated = [...transitions];
    updated[index] = { ...updated[index], [field]: value };
    setTransitions(updated);
  };

  // --- Submit ---
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      // Format payload according to DTO
      const payload = {
        name,
        description,
        stages: stages.map((s, i) => ({
          name: s.name,
          position: i,
          isStart: s.isStart,
          isFinal: s.isFinal,
        })),
        transitions: transitions.map(t => ({
          name: t.name,
          fromStageName: t.fromStageName,
          toStageName: t.toStageName,
          permissions: t.role ? [{ role: t.role }] : []
        })),
      };

      await createTemplate(payload);
      router.push('/templates');
    } catch (err: any) {
      setError(err.response?.data?.message || (Array.isArray(err.response?.data?.message) ? err.response?.data?.message.join(', ') : 'Failed to create template'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <Link href="/templates" className="btn btn-outline" style={{ padding: '6px 12px' }}>
          &larr; Back
        </Link>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>Advanced Template Builder</h1>
      </div>

      <div className="glass-panel" style={{ padding: '32px' }}>
        {error && (
          <div style={{ padding: '12px', background: 'rgba(255, 51, 102, 0.1)', borderLeft: '4px solid var(--accent-danger)', marginBottom: '20px', borderRadius: '4px' }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          
          {/* Basic Info Section */}
          <section>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)', marginBottom: '16px' }}>Basic Information</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)' }}>Template Name *</label>
                <input 
                  type="text" 
                  className="input-field" 
                  value={name} 
                  onChange={(e) => setName(e.target.value)} 
                  required 
                  placeholder="e.g., Expense Approval"
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)' }}>Description</label>
                <textarea 
                  className="input-field" 
                  value={description} 
                  onChange={(e) => setDescription(e.target.value)} 
                  rows={2}
                  placeholder="Brief description of this workflow"
                />
              </div>
            </div>
          </section>

          {/* Stages Builder */}
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Workflow Stages</h3>
              <button type="button" className="btn btn-outline" onClick={handleAddStage} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
                + Add Stage
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {stages.map((stage, i) => (
                <div key={i} style={{ display: 'flex', gap: '16px', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div style={{ flex: 2 }}>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Stage Name</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      value={stage.name}
                      onChange={(e) => updateStage(i, 'name', e.target.value)}
                      required
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={stage.isStart} 
                        onChange={(e) => updateStage(i, 'isStart', e.target.checked)} 
                      />
                      Is Start Stage?
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', cursor: 'pointer' }}>
                      <input 
                        type="checkbox" 
                        checked={stage.isFinal} 
                        onChange={(e) => updateStage(i, 'isFinal', e.target.checked)} 
                      />
                      Is Final Stage?
                    </label>
                  </div>
                  <button type="button" onClick={() => handleRemoveStage(i)} style={{ background: 'transparent', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', fontSize: '1.2rem', padding: '8px' }}>
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Transitions Builder */}
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Transitions & Permissions</h3>
              <button type="button" className="btn btn-outline" onClick={handleAddTransition} style={{ padding: '4px 12px', fontSize: '0.8rem' }}>
                + Add Transition
              </button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {transitions.map((trans, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: '12px', alignItems: 'end', background: 'rgba(0,0,0,0.2)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  
                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Action Name</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      value={trans.name}
                      onChange={(e) => updateTransition(i, 'name', e.target.value)}
                      placeholder="e.g. Approve"
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>From Stage</label>
                    <select 
                      className="input-field"
                      value={trans.fromStageName}
                      onChange={(e) => updateTransition(i, 'fromStageName', e.target.value)}
                    >
                      {stages.map((s, idx) => <option key={idx} value={s.name}>{s.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>To Stage</label>
                    <select 
                      className="input-field"
                      value={trans.toStageName}
                      onChange={(e) => updateTransition(i, 'toStageName', e.target.value)}
                    >
                      {stages.map((s, idx) => <option key={idx} value={s.name}>{s.name}</option>)}
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Required Role</label>
                    <select 
                      className="input-field"
                      value={trans.role}
                      onChange={(e) => updateTransition(i, 'role', e.target.value)}
                    >
                      <option value="">Any (No restriction)</option>
                      <option value="USER">User Role</option>
                      <option value="ADMIN">Admin Role</option>
                    </select>
                  </div>

                  <button type="button" onClick={() => handleRemoveTransition(i)} style={{ background: 'transparent', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', fontSize: '1.2rem', padding: '8px', paddingBottom: '12px' }}>
                    &times;
                  </button>
                </div>
              ))}
            </div>
          </section>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '24px' }}>
            <button type="submit" className="btn btn-primary" disabled={loading || !name}>
              {loading ? 'Creating Template...' : 'Save Template Configuration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
