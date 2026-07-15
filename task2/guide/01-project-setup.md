# Guide 01 — Project Setup

> **What you'll build in this guide:** A fully configured monorepo with a NestJS backend, Next.js frontend, PostgreSQL database, and all tooling (linting, testing, Docker) ready for development.

---

## 1. Prerequisites

Make sure you have these installed:

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥ 18.x | `node -v` |
| npm | ≥ 9.x | `npm -v` |
| Docker & Docker Compose | Latest | `docker --version` |
| Git | Latest | `git --version` |

---

## 2. Initialize the Monorepo

We'll use a simple monorepo structure with two workspaces: `backend` (NestJS) and `frontend` (Next.js).

```bash
# From the WorkflowCore root directory
mkdir -p backend frontend
```

### 2.1 Root `package.json` (workspace root)

Create the root `package.json`:

```json
{
  "name": "workflow-core",
  "version": "1.0.0",
  "private": true,
  "description": "WorkflowCore — A configurable workflow engine",
  "workspaces": [
    "backend",
    "frontend"
  ],
  "scripts": {
    "dev": "concurrently \"npm run dev:backend\" \"npm run dev:frontend\"",
    "dev:backend": "cd backend && npm run start:dev",
    "dev:frontend": "cd frontend && npm run dev",
    "test": "cd backend && npm run test",
    "test:e2e": "cd backend && npm run test:e2e",
    "lint": "cd backend && npm run lint && cd ../frontend && npm run lint",
    "db:migrate": "cd backend && npx prisma migrate dev",
    "db:seed": "cd backend && npx prisma db seed",
    "db:studio": "cd backend && npx prisma studio"
  }
}
```

---

## 3. Backend Setup (NestJS)

### 3.1 Initialize NestJS Project

```bash
# Install the Nest CLI globally (if not already installed)
npm install -g @nestjs/cli

# Create the NestJS project inside the backend folder
cd backend
nest new . --package-manager npm --skip-git
```

> **Note:** Using `--skip-git` because we'll manage Git from the monorepo root.

### 3.2 Install Backend Dependencies

```bash
# Core dependencies
npm install @nestjs/config @nestjs/swagger @prisma/client class-validator class-transformer

# Prisma (dev dependency)
npm install -D prisma

# Authentication
npm install @nestjs/jwt @nestjs/passport passport passport-jwt bcrypt
npm install -D @types/passport-jwt @types/bcrypt

# File upload
npm install @nestjs/platform-express multer
npm install -D @types/multer

# Testing extras
npm install -D @faker-js/faker

# Utility
npm install uuid
npm install -D @types/uuid
```

### 3.3 Initialize Prisma

```bash
npx prisma init
```

This creates:
- `prisma/schema.prisma` — the database schema file
- `.env` — environment variables (with `DATABASE_URL`)

### 3.4 Project Structure

Organize the backend into feature modules with clear domain boundaries:

```
backend/
├── prisma/
│   ├── schema.prisma          # Database schema (Guide 02)
│   ├── migrations/            # Auto-generated migrations
│   └── seed.ts                # Seed data for development
├── src/
│   ├── main.ts                # Application entry point
│   ├── app.module.ts          # Root module
│   ├── common/                # Shared utilities
│   │   ├── decorators/        # Custom decorators (@CurrentUser, @Roles)
│   │   ├── filters/           # Exception filters
│   │   ├── guards/            # Auth guards, role guards
│   │   ├── interceptors/      # Logging, transform interceptors
│   │   ├── pipes/             # Validation pipes
│   │   └── types/             # Shared types & enums
│   ├── config/                # Configuration module
│   │   └── config.module.ts
│   ├── prisma/                # Prisma service module
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── auth/                  # Authentication module
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/        # JWT strategy
│   │   ├── guards/            # JWT auth guard
│   │   └── dto/               # Login, Register DTOs
│   ├── templates/             # Workflow Templates module (Guide 03)
│   │   ├── templates.module.ts
│   │   ├── templates.controller.ts
│   │   ├── templates.service.ts
│   │   └── dto/
│   ├── items/                 # Workflow Items module (Guide 04)
│   │   ├── items.module.ts
│   │   ├── items.controller.ts
│   │   ├── items.service.ts
│   │   └── dto/
│   ├── transitions/           # Transition engine (Guide 05)
│   │   ├── transitions.module.ts
│   │   ├── transitions.service.ts
│   │   └── policies/          # Permission policy functions
│   ├── audit/                 # Audit trail / Event sourcing (Guide 06)
│   │   ├── audit.module.ts
│   │   ├── audit.service.ts
│   │   └── reconcile.service.ts  # Crash recovery (Guide 08)
│   ├── attachments/           # Document attachments (Guide 09)
│   │   ├── attachments.module.ts
│   │   ├── attachments.controller.ts
│   │   └── attachments.service.ts
│   ├── notifications/         # Notification queue (Guide 10)
│   │   ├── notifications.module.ts
│   │   ├── notifications.service.ts
│   │   └── notification.processor.ts
│   └── search/                # Search & pagination (Guide 11)
│       ├── search.module.ts
│       └── search.service.ts
├── test/                      # E2E tests
│   ├── app.e2e-spec.ts
│   ├── concurrency.e2e-spec.ts
│   └── jest-e2e.json
├── .env
├── .env.test
├── docker-compose.yml
├── nest-cli.json
├── tsconfig.json
└── package.json
```

### 3.5 Configure `main.ts`

Replace the default `src/main.ts` with:

```typescript
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global prefix for all API routes
  app.setGlobalPrefix('api');

  // Enable CORS for Next.js frontend
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    credentials: true,
  });

  // Global validation pipe — rejects any request with invalid DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,       // Strip properties not in the DTO
      forbidNonWhitelisted: true, // Throw error if extra properties sent
      transform: true,       // Auto-transform payloads to DTO instances
    }),
  );

  // Swagger API documentation
  const config = new DocumentBuilder()
    .setTitle('WorkflowCore API')
    .setDescription('A configurable workflow engine with dynamic templates, event-sourced audit trails, and concurrency safety.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 WorkflowCore API running on http://localhost:${port}`);
  console.log(`📚 Swagger docs at http://localhost:${port}/api/docs`);
}
bootstrap();
```

### 3.6 Create the Prisma Service

```typescript
// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

```typescript
// src/prisma/prisma.module.ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // Makes PrismaService available everywhere without importing the module
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

### 3.7 Configure `app.module.ts`

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    // Feature modules will be added in subsequent guides:
    // AuthModule,        (Guide 01 - below)
    // TemplatesModule,   (Guide 03)
    // ItemsModule,       (Guide 04)
    // TransitionsModule, (Guide 05)
    // AuditModule,       (Guide 06)
    // AttachmentsModule, (Guide 09)
    // NotificationsModule, (Guide 10)
    // SearchModule,      (Guide 11)
  ],
})
export class AppModule {}
```

---

## 4. Frontend Setup (Next.js)

### 4.1 Initialize Next.js Project

```bash
cd ../frontend

# Create Next.js app with TypeScript, ESLint, App Router
npx -y create-next-app@latest . --typescript --eslint --app --src-dir --use-npm --no-tailwind --import-alias "@/*"
```

### 4.2 Install Frontend Dependencies

```bash
npm install axios swr
```

### 4.3 Frontend Structure

```
frontend/
├── src/
│   ├── app/
│   │   ├── layout.tsx           # Root layout
│   │   ├── page.tsx             # Dashboard home
│   │   ├── login/
│   │   │   └── page.tsx         # Login page
│   │   ├── templates/
│   │   │   ├── page.tsx         # Template list
│   │   │   ├── [id]/
│   │   │   │   └── page.tsx     # Template detail / editor
│   │   │   └── new/
│   │   │       └── page.tsx     # Create template
│   │   ├── items/
│   │   │   ├── page.tsx         # Workflow items list (with search/filter)
│   │   │   └── [id]/
│   │   │       └── page.tsx     # Item detail (transitions, comments, attachments)
│   │   └── admin/
│   │       └── page.tsx         # Admin dashboard
│   ├── components/              # Reusable UI components
│   │   ├── WorkflowGraph.tsx    # Visual template graph
│   │   ├── AuditTimeline.tsx    # Event trail display
│   │   ├── TransitionButton.tsx # Stage transition with confirmation
│   │   └── Navbar.tsx
│   ├── lib/
│   │   ├── api.ts               # Axios instance & API helpers
│   │   └── auth.ts              # Auth context & token management
│   └── types/
│       └── index.ts             # Shared TypeScript types
├── public/
├── next.config.js
├── tsconfig.json
└── package.json
```

### 4.4 Configure API Client

```typescript
// src/lib/api.ts
import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api',
  withCredentials: true,
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Handle 401 — redirect to login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('access_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

export default api;
```

---

## 5. Docker Compose

Create `docker-compose.yml` in the **monorepo root**:

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: workflowcore-db
    ports:
      - '5432:5432'
    environment:
      POSTGRES_USER: workflowcore
      POSTGRES_PASSWORD: workflowcore_dev
      POSTGRES_DB: workflowcore
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U workflowcore']
      interval: 5s
      timeout: 5s
      retries: 5

  postgres-test:
    image: postgres:16-alpine
    container_name: workflowcore-db-test
    ports:
      - '5433:5432'
    environment:
      POSTGRES_USER: workflowcore
      POSTGRES_PASSWORD: workflowcore_test
      POSTGRES_DB: workflowcore_test
    tmpfs:
      - /var/lib/postgresql/data  # In-memory for fast tests

volumes:
  pgdata:
```

> **Why two Postgres instances?** The test database uses `tmpfs` (in-memory storage) for speed — tests run significantly faster and we get a clean database for every test run without worrying about leftover data.

---

## 6. Environment Variables

### Backend `.env`

```env
# backend/.env
DATABASE_URL="postgresql://workflowcore:workflowcore_dev@localhost:5432/workflowcore"
JWT_SECRET="your-super-secret-key-change-in-production"
JWT_EXPIRATION="15m"
REFRESH_TOKEN_EXPIRATION="7d"
PORT=3000
FRONTEND_URL="http://localhost:3001"
UPLOAD_DIR="./uploads"
```

### Backend `.env.test`

```env
# backend/.env.test
DATABASE_URL="postgresql://workflowcore:workflowcore_test@localhost:5433/workflowcore_test"
JWT_SECRET="test-secret"
JWT_EXPIRATION="15m"
REFRESH_TOKEN_EXPIRATION="7d"
PORT=3000
UPLOAD_DIR="./test-uploads"
```

### Frontend `.env.local`

```env
# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:3000/api
```

---

## 7. Authentication Module

Since every subsequent guide requires authenticated API calls, let's set up auth now.

### 7.1 Auth DTOs

```typescript
// src/auth/dto/register.dto.ts
import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

export class RegisterDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiProperty({ example: 'securePassword123' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ enum: UserRole, default: UserRole.USER, required: false })
  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;
}
```

```typescript
// src/auth/dto/login.dto.ts
import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'john@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'securePassword123' })
  @IsString()
  password: string;
}
```

### 7.2 JWT Strategy

```typescript
// src/auth/strategies/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: string;   // user ID
  email: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
```

### 7.3 Auth Guard & Decorators

```typescript
// src/common/guards/jwt-auth.guard.ts
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

```typescript
// src/common/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
```

```typescript
// src/common/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

```typescript
// src/common/guards/roles.guard.ts
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles) {
      return true; // No roles required — allow access
    }

    const { user } = context.switchToHttp().getRequest();
    return requiredRoles.includes(user.role);
  }
}
```

### 7.4 Auth Service

```typescript
// src/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    // Check if user already exists
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Hash password with bcrypt (cost factor 12, as per Task 1 design)
    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        passwordHash,
        role: dto.role || 'USER',
      },
    });

    return this.generateTokens(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.generateTokens(user);
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
  }

  private generateTokens(user: { id: string; email: string; role: string }) {
    const payload = { sub: user.id, email: user.email, role: user.role };

    return {
      accessToken: this.jwtService.sign(payload),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
```

### 7.5 Auth Controller

```typescript
// src/auth/auth.controller.ts
import { Controller, Post, Body, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(@CurrentUser('id') userId: string) {
    return this.authService.getProfile(userId);
  }
}
```

### 7.6 Auth Module

```typescript
// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get<string>('JWT_EXPIRATION', '15m') },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
```

---

## 8. Git Initialization

```bash
# From the monorepo root
cd /path/to/WorkflowCore
git init

# Create .gitignore
cat > .gitignore << 'EOF'
node_modules/
dist/
.env
.env.local
.env.test
*.log
uploads/
test-uploads/
.next/
coverage/
EOF

# Initial commit
git add .
git commit -m "chore: initial project setup — NestJS + Next.js + Prisma + Docker"
```

---

## 9. Running the Project

### Start infrastructure:

```bash
docker compose up -d
```

### Run database migrations (after creating the schema in Guide 02):

```bash
cd backend
npx prisma migrate dev --name init
```

### Start backend:

```bash
cd backend
npm run start:dev
```

### Start frontend:

```bash
cd frontend
npm run dev -- -p 3001
```

### Verify:

- Backend API: http://localhost:3000/api
- Swagger docs: http://localhost:3000/api/docs
- Frontend: http://localhost:3001

---

## 10. Assessment Mapping

| Assessment Criteria | How This Guide Addresses It |
|--------------------|-----------------------------|
| Clean project structure | Modular monorepo with clear domain boundaries |
| Setup instructions | Docker Compose for one-command infrastructure |
| Code quality | TypeScript strict mode, ESLint, Prettier |
| API documentation | Swagger auto-generated from decorators |
| Clear commit history | Git initialized with meaningful initial commit |

---

**Next: [Guide 02 — Database Schema →](./02-database-schema.md)**
