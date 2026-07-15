'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { getItem, transitionItem, getAuditTrail, uploadAttachment, assignUser, updateItem, addComment, removeAssignment, downloadAttachment, deleteAttachment } from '../../../lib/api';
import Link from 'next/link';
import { useAuth } from '../../../providers/AuthProvider';

export default function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params);
  const itemId = unwrappedParams.id;
  
  const { user } = useAuth();
  const router = useRouter();
  
  const [item, setItem] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  // Edit Mode State
  const [isEditing, setIsEditing] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState('');
  
  // Comment State
  const [commentBody, setCommentBody] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);

  const fetchData = async () => {
    try {
      const [itemRes, auditRes] = await Promise.all([
        getItem(itemId),
        getAuditTrail(itemId),
      ]);
      setItem(itemRes.data);
      setAudit(auditRes.data);
      setEditDescription(itemRes.data.description || '');
      setEditPriority(itemRes.data.priority || 'MEDIUM');
    } catch (err: any) {
      console.error('Failed to load item data', err);
      setError(err.response?.data?.message || 'Failed to load item details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [itemId]);

  const handleTransition = async (toStageId: string, version: number) => {
    setActionLoading(true);
    setError('');
    try {
      await transitionItem(itemId, { toStageId, version });
      await fetchData(); // Refresh data
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to transition item');
    } finally {
      setActionLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    
    setActionLoading(true);
    try {
      await uploadAttachment(itemId, file);
      await fetchData(); // Refresh to show new attachment
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to upload file');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSelfAssign = async () => {
    if (!user) return;
    setActionLoading(true);
    try {
      await assignUser(itemId, { userId: user.id });
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to assign');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveEdits = async () => {
    setActionLoading(true);
    setError('');
    try {
      // Pass the current version to trigger optimistic locking check in the backend
      await updateItem(itemId, {
        description: editDescription,
        priority: editPriority,
        version: item.version,
      });
      setIsEditing(false);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update item. Someone else might have edited it (Version Conflict).');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentBody.trim()) return;
    
    setCommentLoading(true);
    setError('');
    try {
      await addComment(itemId, { body: commentBody });
      setCommentBody('');
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to add comment');
    } finally {
      setCommentLoading(false);
    }
  };

  const handleRemoveAssignment = async (userId: string) => {
    setActionLoading(true);
    try {
      await removeAssignment(itemId, userId);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove assignment');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDownloadAttachment = async (attachmentId: string, fileName: string) => {
    try {
      const res = await downloadAttachment(itemId, attachmentId);
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
    } catch (err: any) {
      setError('Failed to download attachment');
    }
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    if (!window.confirm('Are you sure you want to delete this attachment?')) return;
    setActionLoading(true);
    try {
      await deleteAttachment(itemId, attachmentId);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete attachment');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading item...</div>;
  }

  if (!item) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Item not found.</div>;
  }

  const isAssigned = item.assignments?.some((a: any) => a.user.id === user?.id);

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <Link href="/" className="btn btn-outline" style={{ padding: '6px 12px' }}>
          &larr; Dashboard
        </Link>
        <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>{item.title}</h1>
        {!isEditing ? (
          <span className={`badge badge-${item.priority.toLowerCase()}`} style={{ marginLeft: 'auto' }}>
            {item.priority}
          </span>
        ) : null}
      </div>

      {error && (
        <div style={{ padding: '12px', background: 'rgba(255, 51, 102, 0.1)', borderLeft: '4px solid var(--accent-danger)', marginBottom: '20px', borderRadius: '4px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
        {/* Main Content Area */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Details Panel (with Edit capability) */}
          <div className="glass-panel" style={{ padding: '24px', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Details</h3>
              {!isEditing ? (
                <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: '0.8rem' }} onClick={() => setIsEditing(true)}>
                  Edit
                </button>
              ) : null}
            </div>

            {isEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Priority</label>
                  <select 
                    className="input-field"
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                  >
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                    <option value="URGENT">Urgent</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '8px', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Description</label>
                  <textarea 
                    className="input-field" 
                    value={editDescription} 
                    onChange={(e) => setEditDescription(e.target.value)} 
                    rows={4}
                  />
                </div>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                  <button className="btn btn-outline" onClick={() => { setIsEditing(false); setEditDescription(item.description); setEditPriority(item.priority); }}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleSaveEdits} disabled={actionLoading}>
                    {actionLoading ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>* Uses optimistic locking (Current version: {item.version})</p>
              </div>
            ) : (
              <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {item.description || 'No description provided.'}
              </p>
            )}
          </div>

          {/* Comments Panel */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)', marginBottom: '16px' }}>Comments</h3>
            
            <form onSubmit={handleAddComment} style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <textarea 
                className="input-field" 
                placeholder="Write a comment..." 
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                rows={2}
                required
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="submit" className="btn btn-primary" style={{ padding: '6px 16px', fontSize: '0.9rem' }} disabled={commentLoading || !commentBody.trim()}>
                  {commentLoading ? 'Posting...' : 'Post Comment'}
                </button>
              </div>
            </form>

            {item.comments && item.comments.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {item.comments.map((comment: any) => (
                  <div key={comment.id} style={{ padding: '16px', background: 'var(--bg-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{comment.author?.name || 'Unknown User'}</span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    <p style={{ color: 'var(--text-secondary)', margin: 0, whiteSpace: 'pre-wrap' }}>{comment.body}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', textAlign: 'center' }}>No comments yet.</p>
            )}
          </div>

          {/* Attachments Panel */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '1.2rem', color: 'var(--accent-secondary)' }}>Attachments</h3>
              <label className="btn btn-outline" style={{ cursor: 'pointer', padding: '6px 12px', fontSize: '0.8rem' }}>
                {actionLoading ? 'Uploading...' : '+ Upload File'}
                <input type="file" style={{ display: 'none' }} onChange={handleFileUpload} disabled={actionLoading} />
              </label>
            </div>
            
            {item.attachments && item.attachments.length > 0 ? (
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {item.attachments.map((att: any) => (
                  <li key={att.id} style={{ padding: '12px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{att.fileName} (v{att.versionNum})</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                        {new Date(att.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: '0.8rem' }} onClick={() => handleDownloadAttachment(att.id, att.fileName)}>
                        Download
                      </button>
                      <button className="btn btn-outline" style={{ padding: '4px 8px', fontSize: '0.8rem', color: 'var(--accent-danger)', borderColor: 'var(--accent-danger)' }} onClick={() => handleDeleteAttachment(att.id)}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No attachments yet.</p>
            )}
          </div>

        </div>

        {/* Sidebar Area */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* Status & Transitions */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h3 style={{ fontSize: '1.2rem', marginBottom: '16px', color: 'var(--text-primary)' }}>Current Stage</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' }}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: item.currentStage.isFinal ? 'var(--accent-success)' : 'var(--accent-primary)' }}></div>
              <span style={{ fontSize: '1.2rem', fontWeight: 600 }}>{item.currentStage.name}</span>
            </div>

            <h4 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>Available Actions</h4>
            {item.template?.transitions && item.template.transitions.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {item.template.transitions
                  .filter((t: any) => t.fromStageId === item.currentStageId)
                  .map((transition: any) => (
                    <button 
                      key={transition.id}
                      className="btn btn-outline"
                      onClick={() => handleTransition(transition.toStageId, item.version)}
                      disabled={actionLoading}
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                    >
                      {transition.name} &rarr;
                    </button>
                  ))}
                  {item.template.transitions.filter((t: any) => t.fromStageId === item.currentStageId).length === 0 && (
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No transitions available from this stage.</p>
                  )}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No transitions configured.</p>
            )}
          </div>

          {/* Assignments */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h3 style={{ fontSize: '1.2rem', marginBottom: '16px', color: 'var(--text-primary)' }}>Assigned To</h3>
            
            {item.assignments && item.assignments.length > 0 ? (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {item.assignments.map((a: any) => (
                  <li key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.9rem', background: 'var(--bg-secondary)', padding: '8px 12px', borderRadius: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        👤
                      </div>
                      {a.user.name}
                    </div>
                    <button 
                      onClick={() => handleRemoveAssignment(a.user.id)}
                      disabled={actionLoading}
                      style={{ background: 'transparent', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}
                      title="Remove User"
                    >
                      &times;
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '16px' }}>Unassigned</p>
            )}

            {!isAssigned && (
              <button 
                className="btn btn-outline" 
                onClick={handleSelfAssign} 
                disabled={actionLoading}
                style={{ width: '100%', padding: '6px 12px', fontSize: '0.8rem' }}
              >
                Assign to me
              </button>
            )}
          </div>

          {/* Audit Trail Panel */}
          <div className="glass-panel" style={{ padding: '24px' }}>
            <h3 style={{ fontSize: '1.2rem', marginBottom: '16px', color: 'var(--accent-secondary)' }}>Audit Trail</h3>
            {audit.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', borderLeft: '2px solid var(--border-color)', marginLeft: '8px', paddingLeft: '16px' }}>
                {audit.map((event: any) => (
                  <div key={event.id} style={{ position: 'relative' }}>
                    <div style={{ position: 'absolute', width: '10px', height: '10px', background: 'var(--accent-primary)', borderRadius: '50%', left: '-22px', top: '4px' }}></div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                      {event.eventType.replace(/_/g, ' ')}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {new Date(event.createdAt).toLocaleString()} • {event.user?.name || 'System'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No history available.</p>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
