# WorkflowCore Frontend (Next.js)

This is the frontend user interface for **WorkflowCore**. It demonstrates how a client application interacts with the highly concurrent, event-sourced backend engine.

> For complete architectural notes, database schemas, and global setup instructions, please see the [Root README](../README.md).

---

## 🚀 Tech Stack

- **Framework**: [Next.js](https://nextjs.org) (App Router)
- **Language**: TypeScript
- **Styling**: Vanilla CSS (`src/app/globals.css`)
- **API Client**: Axios

---

## ⚙️ Setup & Execution

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Variables**
   The frontend expects the backend API to be running on `http://localhost:3000`. This is configured by default.
   If you need to change it, create a `.env.local` file:
   ```env
   NEXT_PUBLIC_API_URL=http://localhost:3000/api
   ```

3. **Start the Development Server**
   ```bash
   npm run dev
   ```

4. **Access the UI**
   Open **[http://localhost:3001](http://localhost:3001)** with your browser (note: the dev server is configured to run on port 3001 to avoid conflicting with the NestJS backend).

---

## 🌟 Key Features Demonstrated

- **Concurrency Handling (Optimistic Locking)**: Navigate to `/items/[id]` and click "Edit" on the Details panel. The UI passes the current `version` token back to the API. If another user edits the item first, the UI gracefully catches the `409 Conflict` error.
- **Dynamic Template Builder**: Navigate to `/templates/new` to see a dynamic React form that constructs complex workflow graphs (stages and transitions) and maps backend role permissions (`ADMIN`, `USER`) dynamically.
- **Event Sourcing (Audit Trail)**: Navigate to `/items/[id]` to see the visual "Timeline / Audit Trail". This is powered by the backend's immutable event stream.
- **Dynamic Action Buttons**: The UI dynamically reads the available transitions for an item's current stage and renders the appropriate action buttons (e.g., "Approve", "Reject", "Close").
