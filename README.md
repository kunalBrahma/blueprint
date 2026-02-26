<p align="center">
  <h1 align="center">Blueprint Architect MCP</h1>
  <p align="center">
    <strong>An autonomous backend mutation engine for enterprise-grade API scaffolding.</strong>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-4.1%20(Security_Audit)-blue?style=for-the-badge" alt="Version" />
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white" alt="Prisma" />
  <img src="https://img.shields.io/badge/Express.js-%23404d59.svg?style=for-the-badge&logo=express&logoColor=%2361DAFB" alt="Express.js" />
  <img src="https://img.shields.io/badge/redis-%23DD0031.svg?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" />
  <img src="https://img.shields.io/badge/Socket.io-black?style=for-the-badge&logo=socket.io&badgeColor=010101" alt="Socket.io" />
  <img src="https://img.shields.io/badge/Stripe-626CD9?style=for-the-badge&logo=Stripe&logoColor=white" alt="Stripe" />
</p>

---

**Framework:** FastMCP + TypeScript  
**Transport:** stdio  
**Last Updated:** February 2026

---

## Table of Contents

1.  [What is Blueprint Architect?](#what-is-blueprint-architect)
2.  [Architecture Overview](#architecture-overview)
3.  [Mutation Telemetry System](#mutation-telemetry-system)
4.  [Hardware-Tied Licensing](#hardware-tied-licensing)
5.  [Getting Started](#getting-started)
6.  [Complete Tool Reference](#complete-tool-reference)
    - [Project Scaffolding](#1-scaffold_project)
    - [Database & Schema](#2-inject_prisma_model)
    - [Routing & Controllers](#3-inject_express_route)
    - [Business Logic](#5-inject_transaction)
    - [Authentication & Security](#7-inject_auth_system)
    - [Infrastructure Services](#11-inject_socket_service)
    - [Payments & Subscriptions](#14-inject_payment_webhook)
    - [Testing & Documentation](#18-inject_api_tests)
7.  [Design Principles & Security](#design-principles--security)
8.  [Configuration Reference](#configuration-reference)

---

## What is Blueprint Architect?

Blueprint Architect is a **Model Context Protocol (MCP) server** that gives AI agents the ability to construct, mutate, and harden production-ready backend APIs through code generation and AST manipulation. Instead of producing static templates, it reads your existing codebase, understands the relational structure of your database, and surgically injects new code at exactly the right location — without breaking what already exists.

### What It Does

| Domain | Capability |
|---|---|
| **Database** | Prisma model injection with auto-generated inverse relations, migration-safe schema mutations |
| **Routing** | Express.js route handler injection with automatic `server.ts` wiring |
| **Controllers** | Full CRUD controller generation from Prisma schema introspection |
| **Authentication** | Complete JWT auth stack with refresh token rotation, password reset, and optional Google OAuth |
| **Authorization** | Dynamic role-based access control middleware injection |
| **Transactions** | ACID-compliant `prisma.$transaction` wrapping with auto-detected service imports |
| **Real-time** | Socket.io singleton service with automatic HTTP server wrapping |
| **Storage** | Universal file upload system (local disk + S3/R2/Spaces) with Multer middleware |
| **Caching** | Redis service layer for distributed caching and rate limiting |
| **Email** | Transactional email via Resend SDK with automatic `forgotPassword` integration |
| **Payments** | Unified Stripe + Razorpay webhook handlers with signature verification |
| **Subscriptions** | Strategy-pattern subscription system with provider-agnostic architecture |
| **Testing** | Vitest + Supertest integration test scaffolding |
| **Documentation** | OpenAPI 3.0 spec generation with Swagger UI auto-mounting |
| **Environment** | Zod-powered environment variable validation with `.env` file generation |
| **Error Handling** | Global error handler middleware with `AppError` utility class |

### What Makes It Different

Unlike simple code generators, Blueprint Architect:

- **Reads before it writes.** Every AST mutation parses the existing file first, detecting conflicts, duplicate imports, and already-mounted middleware before making changes.
- **Understands your schema.** When you add a `Booking` model referencing `User`, it automatically finds the `User` model and injects the inverse `bookings Booking[]` relation.
- **Reports what it changed.** Every tool returns a machine-readable JSON mutation report with a correlation ID, list of mutated files, and TypeScript validation results — enabling upstream agents to reconcile and audit changes.
- **Enterprise-Grade Safety.** Every disk write is isolated by a strict `PathJail` to prevent directory traversal (`../../`), and every mutation is snapshotted to guarantee a flawless 100% atomic rollback on intermediate failures.
- **Never overwrites.** Guard clauses prevent overwriting existing files. Combined with `dryRun` mode, you always preview before committing.

---

## Hardware-Tied Licensing

Blueprint Architect integrates a lightweight, zero-dependency licensing system via **Dodo Payments**.

To use the Pro tools (like webhooks, sub systems, or auth generation), you must provide a valid `BLUEPRINT_LICENSE_KEY` in your environment variables. 
The system validates the key against your machine's hardware ID (`os.hostname() + os.platform() + os.arch()`) and caches the result locally for 12 hours. This prevents rampant piracy while allowing you to code offline across network drops.

If you don't have a key, the MCP gracefully downgrades and returns a purchase link directly to the AI agent.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    AI Agent (Claude, etc.)            │
│                         │                            │
│                    MCP Protocol (stdio)               │
│                         │                            │
│    ┌────────────────────▼────────────────────────┐    │
│    │           Blueprint Architect MCP            │    │
│    │                                             │    │
│    │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │    │
│    │  │  Zod     │  │ ts-morph │  │ Mutation  │  │    │
│    │  │ Schemas  │──│   AST    │──│ Telemetry │  │    │
│    │  │          │  │  Engine  │  │  Wrapper  │  │    │
│    │  └──────────┘  └──────────┘  └──────────┘  │    │
│    │         │                           │       │    │
│    │    20 Specialized Tools             │       │    │
│    │    (see reference below)            │       │    │
│    └─────────────────────────────────────┘       │    │
│                         │                            │
│              Target Project Filesystem               │
│    ┌────────────────────▼────────────────────────┐    │
│    │  src/  prisma/  package.json  tsconfig.json │    │
│    └─────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### Core Technologies

| Component | Technology | Role |
|---|---|---|
| **Runtime** | FastMCP | MCP server framework, tool registration, stdio transport |
| **Validation** | Zod | Input schema validation for every tool parameter |
| **AST Engine** | ts-morph | TypeScript Abstract Syntax Tree parsing, analysis, and mutation |
| **Telemetry** | `withMutationReport` | Universal wrapper producing JSON mutation reports |
| **Language** | TypeScript (strict) | End-to-end type safety across the toolchain |

---

## Mutation Telemetry System

Every tool is wrapped in a universal telemetry layer that provides structured, machine-readable output for upstream agent reconciliation.

### How It Works

```
Tool Invoked → Zod Validates Input → withMutationReport() Wraps Execution
     │
     ├── Generates correlationId (UUID v4)
     ├── Executes tool action (tracking mutatedFiles)
     ├── Catches errors → sets status to ERROR
     ├── Runs `tsc --noEmit` on target project → records validation
     └── Returns stringified JSON MutationResult
```

### MutationResult Schema

```typescript
interface MutationResult {
  correlationId: string;                              // UUID v4 for tracing
  operation:     string;                              // Tool name (e.g. "inject_auth_system")
  status:        "SUCCESS" | "ERROR" | "PARTIAL_FAILURE";
  mutatedFiles:  string[];                            // Absolute paths of every file touched
  validation:    { passed: boolean; output: string }; // tsc --noEmit result
  humanMessage:  string;                              // Human-readable summary
}
```

### Status Codes

| Status | Meaning |
|---|---|
| `SUCCESS` | All operations completed. Validation passed. |
| `PARTIAL_FAILURE` | Core logic succeeded but a secondary operation failed (e.g. `npm install`). |
| `ERROR` | The tool threw an error. No files were mutated (or partial mutations are listed). |

### Example Response

```json
{
  "correlationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "operation": "inject_auth_system",
  "status": "SUCCESS",
  "mutatedFiles": [
    "/project/src/utils/auth.ts",
    "/project/src/controllers/auth.controller.ts"
  ],
  "validation": { "passed": true, "output": "tsc --noEmit passed" },
  "humanMessage": "[SUCCESS] Auth System injected successfully!\n\nGenerated Files:\n  - /project/src/utils/auth.ts\n  - /project/src/controllers/auth.controller.ts"
}
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- npm or yarn
- An MCP-compatible client (Claude Desktop, Cursor, etc.)

### Installation

```bash
git clone https://github.com/your-org/blueprint-mcp.git
cd blueprint-mcp
npm install
```

### Running the Server

```bash
# Direct execution
npm start

# With the MCP Inspector (for debugging)
npm run inspector
```

### Connecting to an MCP Client

Add the following to your MCP client configuration:

```json
{
  "mcpServers": {
    "blueprint-architect": {
      "command": "npx",
      "args": ["tsx", "/path/to/blueprint-mcp/src/index.ts"]
    }
  }
}
```

---

## Complete Tool Reference

Blueprint Architect exposes **20 tools**, organized by domain. Each tool accepts Zod-validated parameters, supports `dryRun` mode, and returns a JSON `MutationResult`.

---

### 1. `scaffold_project`

**Purpose:** Bootstrap a new backend project from a production-ready boilerplate.

**What it does:**
- Clones the standard backend boilerplate repository into the specified directory
- Removes `.git` history so the new project starts fresh
- Optionally runs `npm install` to resolve all dependencies

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `projectName` | string | Yes | Name of the project to scaffold |
| `outputDir` | string | Yes | Absolute path to the directory where the project should be created |
| `installDeps` | boolean | No | Whether to install npm dependencies after cloning (default: `true`) |

**Use case:** Starting a new Express + Prisma + TypeScript backend from scratch without manual boilerplate setup.

**Mutation footprint:** Creates the entire project directory tree.

---

### 2. `inject_prisma_model`

**Purpose:** Safely append a new Prisma model to your `schema.prisma` with column-aligned formatting and automatic inverse relation injection.

**What it does:**
- Parses the existing `schema.prisma` to detect duplicate model names
- Appends a perfectly formatted model block with correct spacing and alignment
- If any field has a `relation` property pointing to a parent model, it automaticallsy locates that parent model in the schema and injects the inverse relation field (e.g., `bookings Booking[]`)
- Runs `npx prisma generate` to regenerate the Prisma client
- On `prisma generate` failure, **rolls back** the schema to its original state

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `schemaPath` | string | Yes | Absolute path to the target `schema.prisma` file |
| `modelName` | string | Yes | PascalCase name for the new model (e.g., `Booking`) |
| `fields` | array | Yes | Array of field definitions (name, type, isId, isOptional, isUnique, relation) |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Supported field types:** `String`, `Int`, `Float`, `Boolean`, `DateTime`, `Json`

**Use case:** Adding a `Booking` model that references `User` and `Property`, where the tool auto-injects `bookings Booking[]` into both parent models.

**Mutation footprint:** Modifies `schema.prisma`.

---

### 3. `inject_express_route`

**Purpose:** Surgically inject a new route handler into an existing Express TypeScript router file using AST manipulation.

**What it does:**
- Parses the target router file with ts-morph
- Finds the correct insertion point (after existing routes)
- Injects the new route with the specified HTTP method, path, and handler body
- Sanitizes the handler body to prevent syntax injection
- Optionally auto-wires the router into `server.ts` via `app.use()` with the correct import path

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetFile` | string | Yes | Absolute path to the Express router file |
| `method` | enum | Yes | HTTP method: `get`, `post`, `put`, `delete`, `patch` |
| `routePath` | string | Yes | Express route path (e.g., `/users/:id`) |
| `handlerBody` | string | Yes | Raw TypeScript body of the async handler function |
| `serverFile` | string | No | Path to `server.ts` for automatic route mounting |
| `mountPath` | string | No | Mount prefix (e.g., `/api/bookings`) |
| `routerImportName` | string | No | Custom import name in `server.ts` |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Adding a `GET /api/properties/:id` route to `property.routes.ts` and auto-registering it in `server.ts`.

**Mutation footprint:** Modifies the target router file and optionally `server.ts`.

---

### 4. `inject_crud_controller`

**Purpose:** Generate a complete, production-grade CRUD controller for any Prisma model with advanced query support.

**What it does:**
- Reads `schema.prisma` to introspect the target model's fields
- Generates a full controller with `getAll`, `getById`, `create`, `update`, `delete` handlers
- Includes **pagination** (`?page=1&limit=10`) and **search** (`?search=term`) support
- Storage-aware: if the model has file-related fields, handlers include `req.file` processing for Multer uploads
- Generates Zod validation schemas from the Prisma field types

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `modelName` | string | Yes | PascalCase Prisma model name (e.g., `Property`) |
| `targetDirectory` | string | Yes | Absolute path to the controllers folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Instantly generating a `property.controller.ts` with CRUD operations, pagination, and search from the `Property` model definition.

**Mutation footprint:** Creates a new controller file in the target directory.

---

### 5. `inject_transaction`

**Purpose:** Wrap AI-provided business logic inside a production-grade `prisma.$transaction` block with automatic service import detection.

**What it does:**
- Parses the target controller file using ts-morph
- Creates or updates an exported async function wrapping the logic in `prisma.$transaction((tx) => { ... })`
- **Smart import detection:** Scans the transaction logic for references to `stripe`, `razorpay`, `mailService`, `smsService` and auto-injects the corresponding import statements
- If Stripe/Razorpay is referenced and `payment.service.ts` doesn't exist, it generates one
- Supports an optional `callbackAction` to execute after the transaction succeeds (e.g., Socket.io emit)

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetFile` | string | Yes | Absolute path to the controller file |
| `functionName` | string | Yes | Name of the exported function (e.g., `checkout`) |
| `transactionLogic` | string | Yes | Raw TS/JS logic using the `tx` variable for transaction-safe operations |
| `callbackAction` | string | No | TS statement to run after transaction success |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Wrapping a checkout flow in an ACID transaction that creates an order, charges the payment, sends a confirmation email, and emits a Socket.io event.

**Mutation footprint:** Modifies the target controller. May generate `payment.service.ts`.

---

### 6. `inject_rbac_middleware`

**Purpose:** Secure an Express route with role-based access control by injecting `requireRoles()` middleware into the route handler chain.

**What it does:**
- Parses the target router file with ts-morph
- Locates the exact route matching the given method and path
- Injects `requireRoles([...])` as a middleware argument before the route handler
- If the `requireRoles` function doesn't exist in the file, generates and inserts it
- Accepts **any string roles** — fully universal, not locked to any specific role enum

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetFile` | string | Yes | Absolute path to the Express router file |
| `routePath` | string | Yes | Exact route path (e.g., `/` or `/add`) |
| `method` | enum | Yes | HTTP method: `get`, `post`, `put`, `delete`, `patch` |
| `allowedRoles` | string[] | Yes | Array of permitted roles (e.g., `["SUPERADMIN", "EDITOR"]`) |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Restricting `DELETE /api/properties/:id` to only `SUPERADMIN` and `ADMIN` roles.

**Mutation footprint:** Modifies the target router file.

---

### 7. `inject_auth_system`

**Purpose:** Generate a complete, production-ready authentication system with JWT access/refresh token rotation, password reset, and optional Google OAuth.

**What it does:**
- Generates `src/utils/auth.ts` — JWT utility functions (`generateAccessToken`, `generateRefreshToken`, `verifyToken`)
- Generates `src/controllers/auth.controller.ts` — Full auth stack with:
  - **signUp** — Zod-validated registration with bcrypt hashing
  - **signIn** — Credential verification with JWT pair issuance
  - **logout** — Refresh token revocation
  - **refresh** — Secure refresh token rotation (old token deleted, new pair issued)
  - **forgotPassword** — Reset token generation with expiration
  - **resetPassword** — Token verification and password update
  - **googleLogin** — Passport.js OAuth callback handler (conditional)
- Schema-aware: reads `schema.prisma` to determine if the `name` field on `User` is optional
- Auto-installs `bcrypt`, `jsonwebtoken`, `zod`, and type definitions
- Refuses to overwrite existing auth files

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetDirectory` | string | Yes | Absolute path to the controllers folder |
| `authProviders` | enum[] | Yes | Providers to implement: `["email"]` or `["email", "google"]` |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Setting up a full authentication system for a new API with email/password login and optional Google OAuth.

**Mutation footprint:** Creates `auth.ts` (utils) and `auth.controller.ts`.

---

### 8. `inject_env_validation`

**Purpose:** Inject a Zod-powered environment variable validator that crashes the app immediately with a clear error if required variables are missing.

**What it does:**
- Generates `src/config/env.ts` with a comprehensive Zod schema covering:
  - `PORT`, `NODE_ENV`, `DATABASE_URL`, `JWT_SECRET` (minimum 32 characters)
  - `STORAGE_TYPE`, `REDIS_URL`, `RESEND_API_KEY`, `CORS_ORIGIN`
  - Payment provider variables: `PAYMENT_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- Creates a starter `.env` file with placeholder values if one doesn't exist
- All optional variables have sensible defaults

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Ensuring your app fails fast in development if critical variables like `DATABASE_URL` or `JWT_SECRET` are missing.

**Mutation footprint:** Creates `env.ts` and optionally `.env`.

---

### 9. `inject_global_error_handler`

**Purpose:** Create a centralized error handling system and inject it as the absolute last middleware in the Express pipeline.

**What it does:**
- Generates `src/utils/AppError.ts` — A custom error class with `statusCode` and `isOperational` properties
- Generates `src/middleware/errorHandler.ts` — A strictly-typed Express error handler that:
  - Distinguishes between operational errors (`AppError`) and unexpected system errors
  - Returns structured JSON responses with appropriate status codes
  - Includes stack traces in development mode only
- Uses ts-morph to inject `app.use(globalErrorHandler)` as the **last** middleware in `server.ts`
- Automatically adds the import statement

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `serverFile` | string | Yes | Absolute path to the main application file |
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` directory |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Ensuring all unhandled errors in your Express app are caught and returned as clean JSON responses instead of crashing the process.

**Mutation footprint:** Creates `AppError.ts`, `errorHandler.ts`. Modifies `server.ts`.

---

### 10. `inject_storage_service`

**Purpose:** Inject a universal file upload system that supports both local disk storage and cloud object storage (S3/R2/Spaces) with a single environment variable toggle.

**What it does:**
- Generates `src/services/storage.service.ts` — A `StorageService` class implementing:
  - `uploadFile()` — Routes to S3 (memory buffer) or local disk (saved file) based on `STORAGE_TYPE`
  - `deleteFile()` — Removes objects from S3 or unlinks from the local filesystem
- Generates `src/middleware/upload.ts` — Multer middleware configured with:
  - Memory storage for cloud uploads, disk storage for local
  - MIME type filtering (JPEG, PNG, GIF, WebP, PDF)
  - 5MB file size limit
- Creates the `public/uploads/` directory structure for local storage
- Auto-installs `multer` and `@aws-sdk/client-s3`

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Adding file upload capabilities to your API where you start with local storage in development and switch to S3 in production with a single env var change.

**Mutation footprint:** Creates `storage.service.ts`, `upload.ts`, and `public/uploads/`.

---

### 11. `inject_socket_service`

**Purpose:** Set up a production-ready Socket.io singleton service and automatically rewire the Express application to support WebSocket connections.

**What it does:**
- Generates `src/services/socket.service.ts` — A `SocketService` singleton with:
  - `init(server)` — Attaches Socket.io to the HTTP server
  - `emitEvent(event, data)` — Broadcast to all connected clients
  - `emitToRoom(room, event, data)` — Emit to a specific room
  - `joinRoom(socketId, room)` — Add a socket to a room
  - Built-in action queue for operations requested before `init()` is called
- Uses ts-morph to modify `server.ts`:
  - Wraps `const app = express()` with `const server = http.createServer(app)`
  - Calls `socketService.init(server)`
  - Replaces `app.listen(...)` with `server.listen(...)` to support WebSockets
- Auto-installs `socket.io`

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `serverFile` | string | Yes | Absolute path to `server.ts` |
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` directory |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Adding real-time capabilities (live notifications, chat, presence) to your Express API.

**Mutation footprint:** Creates `socket.service.ts`. Modifies `server.ts`.

---

### 12. `inject_redis_service`

**Purpose:** Generate a Redis client service for distributed caching, session management, and rate limiting.

**What it does:**
- Generates `src/services/redis.service.ts` using the `ioredis` SDK
- Configured with `maxRetriesPerRequest: null` for compatibility with BullMQ and rate-limit stores
- Reads `REDIS_URL` from the validated environment config
- Includes connection event logging for monitoring
- Auto-installs `ioredis`, `express-rate-limit`, and `rate-limit-redis`

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` directory |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Setting up Redis as the backing store for rate limiting, caching frequently-queried data, or managing distributed sessions.

**Mutation footprint:** Creates `redis.service.ts`.

---

### 13. `inject_rate_limiter`

**Purpose:** Inject Redis-backed rate limiting middleware into specific Express routes to prevent brute-force attacks.

**What it does:**
- Parses the target router file with ts-morph
- Injects `import rateLimit from "express-rate-limit"` and the Redis store configuration
- Creates an `authLimiter` instance configured for 5 requests per 15-minute window per IP
- Scans the AST for route declarations matching the specified paths
- Injects the limiter as a middleware argument into each matching route: `router.post("/login", authLimiter, handler)`
- Skips routes that are already protected

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetFile` | string | Yes | Absolute path to the Express router file |
| `routePaths` | string[] | Yes | Route paths to secure (e.g., `["/login", "/refresh"]`) |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Rate-limiting login and token refresh endpoints to prevent credential stuffing attacks.

**Mutation footprint:** Modifies the target router file.

---

### 14. `inject_payment_webhook`

**Purpose:** Generate a unified payment webhook system supporting both Stripe and Razorpay with signature verification and database synchronization.

**What it does:**
- Generates `src/controllers/webhook.controller.ts` with:
  - `handleStripeEvent()` — Verifies Stripe webhook signatures, processes `invoice.payment_succeeded` events
  - `handleRazorpayEvent()` — Verifies HMAC-SHA256 signatures, processes `subscription.charged` events
  - `paymentWebhook()` — Unified dispatcher that auto-detects the provider from headers or URL params
  - Updates `Subscription` status to `ACTIVE` and sets `currentPeriodEnd`
  - Emits `subscription_active` via Socket.io for real-time UI updates
- Generates `src/routes/webhook.routes.ts` with raw body parsing middleware for signature verification
- Auto-installs `stripe` and `razorpay` SDKs

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Handling recurring subscription payments from Stripe and Razorpay with a single webhook endpoint.

**Mutation footprint:** Creates `webhook.controller.ts` and `webhook.routes.ts`.

---

### 15. `inject_mail_provider`

**Purpose:** Integrate transactional email capabilities using the Resend SDK and wire it into the existing authentication flow.

**What it does:**
- Generates `src/services/mail.service.ts` — A mail service using the Resend SDK
- Uses ts-morph to modify `auth.controller.ts`:
  - Finds the `forgotPassword` function
  - Replaces the `console.log` placeholder with an actual `mailService.sendEmail()` call
  - Adds the `mailService` import automatically
- Auto-installs the `resend` package

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` directory |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Enabling real password reset emails instead of console.log placeholders in your auth system.

**Mutation footprint:** Creates `mail.service.ts`. Modifies `auth.controller.ts`.

---

### 16. `inject_subscription_system`

**Purpose:** Upgrade the application to support unified recurring subscriptions with a provider-agnostic architecture using the Strategy pattern.

**What it does:**
- Modifies `schema.prisma` to add:
  - `isPro`, `gatewayCustomerId` fields to the `User` model
  - New `Plan` model (name, priceAmount, currency, interval, stripePriceId, razorpayPlanId)
  - New `Subscription` model (userId, planId, gatewaySubscriptionId, status, currentPeriodEnd)
- Generates `src/services/subscription/` with four files:
  - `subscription.interface.ts` — `ISubscriptionProvider` contract
  - `stripe.provider.ts` — Stripe implementation (customers, plans, subscriptions)
  - `razorpay.provider.ts` — Razorpay implementation
  - `subscription.service.ts` — Factory service that selects the provider via `PAYMENT_PROVIDER` env var
- Runs `npx prisma generate` to update the client

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Adding paid subscription tiers to your SaaS application with the ability to switch between Stripe and Razorpay without code changes.

**Mutation footprint:** Modifies `schema.prisma`. Creates 4 files in `services/subscription/`.

---

### 17. `inject_plan_seeder`

**Purpose:** Generate an auto-seeder that creates subscription plans in your payment gateway and syncs them with your database.

**What it does:**
- Generates `src/scripts/seedPlans.ts` — A script that:
  - Iterates over default plans (Pro $25/mo, Premium $50/mo)
  - Calls `subscriptionService.createPlan()` to register each plan in Stripe or Razorpay
  - Upserts the plan record into the database with the gateway-returned plan ID
- Adds `"seed:plans": "ts-node src/scripts/seedPlans.ts"` to `package.json` scripts

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Automating the initial setup of subscription plans in your payment gateway and database after deploying the subscription system.

**Mutation footprint:** Creates `seedPlans.ts`. Modifies `package.json`.

---

### 18. `inject_api_tests`

**Purpose:** Scaffold automated integration tests using Vitest and Supertest.

**What it does:**
- Creates `vitest.config.ts` at the project root with Node environment, global assertions, dotenv setup, and a 10-second timeout
- Generates `src/__tests__/auth.test.ts` with baseline auth endpoint tests:
  - Validation error test (malformed email)
  - Invalid credentials test (wrong password)
- Auto-installs `vitest`, `supertest`, and `@types/supertest` as dev dependencies
- Adds `"test": "vitest run"` to `package.json` scripts if not present

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `targetRootDirectory` | string | Yes | Absolute path to the project root |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Bootstrapping a test suite for your API with sensible defaults and a working example test.

**Mutation footprint:** Creates `vitest.config.ts` and `auth.test.ts`. May modify `package.json`.

---

### 19. `inject_prisma_seed`

**Purpose:** Generate a database seeder script that creates initial admin users and sample data using Prisma.

**What it does:**
- Generates `prisma/seed.ts` with:
  - Admin user creation (email: `admin@example.com`, bcrypt-hashed password)
  - Sample product seeding with idempotent checks (skips existing records)
- Auto-installs `bcrypt`, `ts-node`, and type definitions
- Updates `package.json` with `"prisma": { "seed": "ts-node prisma/seed.ts" }`

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `prismaDirectory` | string | Yes | Absolute path to the `prisma` folder |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Setting up initial data after running migrations, providing admin access and sample records for development.

**Mutation footprint:** Creates `seed.ts`. Modifies `package.json`.

---

### 20. `generate_api_docs`

**Purpose:** Generate an OpenAPI 3.0 specification and automatically mount a Swagger UI endpoint in the Express application.

**What it does:**
- Generates `src/config/swagger.ts` with:
  - OpenAPI 3.0 spec definition with JWT Bearer auth security scheme
  - Automatic route/controller file scanning for JSDoc annotations
  - Dynamic port detection from environment config
- Uses ts-morph to modify `server.ts`:
  - Adds `swagger-ui-express` and `swaggerSpec` imports
  - Mounts `app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec))`
- Auto-installs `swagger-jsdoc` and `swagger-ui-express`

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `serverFile` | string | Yes | Absolute path to `server.ts` |
| `targetSrcDirectory` | string | Yes | Absolute path to the `src` directory |
| `dryRun` | boolean | No | Preview without writing (default: `false`) |

**Use case:** Adding interactive API documentation accessible at `/api-docs` with zero manual OpenAPI spec writing.

**Mutation footprint:** Creates `swagger.ts`. Modifies `server.ts`.

---

## Design Principles & Security

### 1. Read-Before-Write AST Injection
Every tool that modifies existing code reads the file into a ts-morph `Project`, analyzes the AST, and makes targeted mutations. No blind string concatenation. No regex search-and-replace on logic.

### 2. Dry-Run First
All 20 tools accept a `dryRun` parameter. When `true`, the tool returns the proposed file contents as text without touching the filesystem. This enables agents to preview and validate changes before committing.

### 3. Path Jail & Filesystem Boundaries
Every single `fs.writeFileSync`, `fs.mkdirSync`, and `fs.appendFileSync` across all 20 tools is protected by a strict `enforcePathJail` utility. The LLM mathematically cannot traverse outside the resolved `projectRoot` or use absolute paths to overwrite system files (`/etc/passwd`).

### 4. Universal Dependency Shield
Before installing any npm package, tools check `package.json` for existing dependencies. Only missing packages are installed using `--no-save --save-exact` to avoid manifest pollution. SDK versions are recorded in `SDK_VERSIONS.md` for reproducibility auditing.

### 5. Atomic Rollbacks (`mutationTracker.ts`)
High-risk operations like AST injection and `npx prisma generate` are wrapped in a mutation tracking engine. Before a file is touched, its exact buffer is snapshotted. If a tool fails halfway through scaffolding 4 files, the engine instantly **rolls back** all modified files to their original content and deletes any newly created files. Your project is never left in a broken, half-generated state.

### 6. Schema Intelligence
The Prisma model tool doesn't just append text. It understands relational gravity: if your `Booking` model has `userId String` with `relation: "User"`, the tool finds the `User` model and injects `bookings Booking[]` automatically.

### 7. Guard Clauses & Execution Timeouts
Every tool that creates files checks for existing files first and refuses to overwrite them. Furthermore, every shell execution (`npm install`, `npx prisma generate`) enforces a strict `timeout: 30000` to prevent indefinite hangs if the network stalls.

---

## Configuration Reference

### Environment Variables

The `inject_env_validation` tool generates a Zod schema that validates these variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Server listening port |
| `NODE_ENV` | No | `development` | Runtime environment |
| `DATABASE_URL` | Yes | — | Prisma database connection string |
| `JWT_SECRET` | Yes | — | JWT signing secret (min 32 chars) |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin |
| `STORAGE_TYPE` | No | `local` | File storage strategy: `local`, `s3`, `r2` |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL |
| `RESEND_API_KEY` | No | `""` | Resend SDK API key for emails |
| `PAYMENT_PROVIDER` | No | `stripe` | Active payment provider: `stripe` or `razorpay` |
| `STRIPE_SECRET_KEY` | No | `""` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | No | `""` | Stripe webhook signing secret |
| `RAZORPAY_KEY_ID` | No | `""` | Razorpay key ID |
| `RAZORPAY_SECRET` | No | `""` | Razorpay secret key |
| `RAZORPAY_WEBHOOK_SECRET` | No | `""` | Razorpay webhook signing secret |

---

<p align="center">
  Built with <strong>FastMCP</strong> + <strong>ts-morph</strong> + <strong>Zod</strong>
  <br />
  <em>Blueprint Architect — Infrastructure as a Conversation.</em>
</p>