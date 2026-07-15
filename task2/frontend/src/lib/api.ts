import axios from 'axios';

// Create an Axios instance
const api = axios.create({
  baseURL: 'http://localhost:3000/api', // Backend URL
});

// Request interceptor for API calls
api.interceptors.request.use(
  (config) => {
    // In a browser environment, get token from local storage
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for API calls
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('token');
        if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
          window.location.href = '/login';
        }
      }
    }
    return Promise.reject(error);
  }
);

// --- Auth ---
export const registerUser = (data: any) => api.post('/auth/register', data);
export const loginUser = (data: any) => api.post('/auth/login', data);
export const getCurrentUser = () => api.get('/auth/me');

// --- Templates ---
export const getTemplates = () => api.get('/templates');
export const getTemplate = (id: string) => api.get(`/templates/${id}`);
export const createTemplate = (data: any) => api.post('/templates', data);
export const updateTemplate = (id: string, data: any) => api.patch(`/templates/${id}`, data);
export const deleteTemplate = (id: string) => api.delete(`/templates/${id}`);
export const addTemplateStage = (id: string, data: any) => api.post(`/templates/${id}/stages`, data);
export const addTemplateTransition = (id: string, data: any) => api.post(`/templates/${id}/transitions`, data);

// --- Items ---
export const getItems = (params?: Record<string, string | number>) =>
  api.get('/search/items', { params });
export const getItem = (id: string) => api.get(`/items/${id}`);
export const createItem = (data: any) => api.post('/items', data);
export const updateItem = (id: string, data: any) => api.patch(`/items/${id}`, data);
export const transitionItem = (id: string, data: any) =>
  api.post(`/items/${id}/transitions`, data);

// --- Assignments ---
export const assignUser = (itemId: string, data: any) => 
  api.post(`/items/${itemId}/assignments`, data);
export const removeAssignment = (itemId: string, userId: string) => 
  api.delete(`/items/${itemId}/assignments/${userId}`);

// --- Attachments ---
export const uploadAttachment = (itemId: string, file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post(`/items/${itemId}/attachments`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
};
export const downloadAttachment = (itemId: string, attachmentId: string) => 
  api.get(`/items/${itemId}/attachments/${attachmentId}/download`, { responseType: 'blob' });
export const deleteAttachment = (itemId: string, attachmentId: string) => 
  api.delete(`/items/${itemId}/attachments/${attachmentId}`);

// --- Comments ---
export const addComment = (itemId: string, data: { body: string }) =>
  api.post(`/items/${itemId}/comments`, data);

// --- Audit ---
export const getAuditTrail = (itemId: string) => api.get(`/audit/items/${itemId}`);
export const verifyIntegrity = (itemId: string) => api.get(`/audit/items/${itemId}/verify`);

export default api;
