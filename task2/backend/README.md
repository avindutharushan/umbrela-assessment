# WorkflowCore Backend (NestJS API)

This is the backend service for **WorkflowCore**, a highly scalable workflow engine. It provides the REST APIs required to manage dynamic templates, workflow items, transitions, file attachments, and audit trails.

> For complete architectural notes, database schemas, and global setup instructions, please see the [Root README](../README.md).

---

## 🚀 Tech Stack

- **Framework**: [NestJS](https://nestjs.com/) (Node.js / TypeScript)
- **Database**: PostgreSQL (via [Prisma ORM](https://www.prisma.io/))
- **Documentation**: Swagger / OpenAPI
- **Validation**: class-validator & class-transformer
- **Authentication**: JWT (JSON Web Tokens)

---

## ⚙️ Setup & Execution

Make sure your PostgreSQL database is running (e.g., via the Docker Compose file in the root directory).

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   Create a `.env` file in this directory with the following (or use the defaults if running locally):
   ```env
   DATABASE_URL="postgresql://postgres:postgres@localhost:5432/workflowcore?schema=public"
   JWT_SECRET="your-super-secret-jwt-key"
   PORT=3000
   ```

3. **Database Migrations**
   Run the Prisma migrations to generate the schema:
   ```bash
   npx prisma migrate dev
   ```

4. **Start the Server**
   ```bash
   # development
   npm run start
   
   # watch mode
   npm run start:dev
   ```

---

## 📖 API Documentation (Swagger)

The backend provides interactive API documentation via Swagger.
When the server is running, navigate your browser to:

**[http://localhost:3000/api-docs](http://localhost:3000/api-docs)**

From there, you can explore the endpoints, view the required DTO schemas, and even execute requests directly (after passing the JWT Bearer token obtained from `/api/auth/login`).

---

## 🧪 Testing

This project includes a rigorous automated test suite designed to prove correctness under concurrent loads and crash scenarios.

```bash
# unit tests
npm run test

# e2e / concurrency tests
npm run test:e2e
```

**Key Test Files (`/test` directory):**
- `concurrency-field-edits.e2e-spec.ts`: Tests optimistic locking during concurrent field edits.
- `concurrency-transitions.e2e-spec.ts`: Tests strict serialization of concurrent stage transitions.
- `audit-event-sourcing.e2e-spec.ts`: Verifies complete event capture.
- `crash-recovery.e2e-spec.ts`: Verifies the `ReconcileService` can rebuild the materialized state from the audit log.
- `notification-queue.e2e-spec.ts`: Verifies the Transactional Outbox pattern.
