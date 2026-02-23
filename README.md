# 🏗️ Blueprint MCP Server

![Version](https://img.shields.io/badge/Version-4.0%20(Mega--Patch)-blue?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)
![Redis](https://img.shields.io/badge/redis-%23DD0031.svg?style=for-the-badge&logo=redis&logoColor=white)
![Express.js](https://img.shields.io/badge/express.js-%23404d59.svg?style=for-the-badge&logo=express&logoColor=%2361DAFB)

**Version:** 4.0 (Contextual Intelligence Mega-Patch)  
**Last Updated:** February 2026  
**Framework:** FastMCP + TypeScript  
**Purpose:** Autonomous code-generation and mutation toolset for enterprise-grade backend API scaffolding and contextual enhancement.

---

## 📑 Table of Contents

1. [MCP Server Overview](#mcp-server-overview)
2. [Architecture & Design Patterns](#architecture--design-patterns)
3. [Tool Inventory](#tool-inventory)
4. [Tool Specifications](#tool-specifications)
5. [Runtime Environment (proptech-backend)](#runtime-environment-proptech-backend)
6. [Dependency & Safety Management](#dependency--safety-management)
7. [Verification & Testing](#verification--testing)
8. [Roadmap](#roadmap)

---

## 🚀 MCP Server Overview

### Purpose
The **Blueprint MCP Server** is an intelligent code-generation and mutation suite designed to rapidly construct production-ready backend APIs with minimal boilerplate. Moving beyond basic templates, V4 introduces **Situational Awareness**, allowing the AI to read, understand, and safely mutate your project's Abstract Syntax Tree (AST) and database relational gravity.

It provides 22 specialized tools that handle:
* **Database Schema Generation** (Prisma models, migrations, inverse relations)
* **Express.js Route & Controller Injection**
* **Authentication Systems** (JWT, email/OAuth providers)
* **Payment Webhooks** (Stripe, Razorpay)
* **Storage Services** (S3/R2, local filesystem)
* **Socket.io Real-Time Communication**
* **Caching, Rate-Limiting, & Distributed Sessions** (Redis)
* **Testing Scaffolds** (Vitest + Supertest)
* **API Documentation** (Swagger/OpenAPI)
* **RBAC Middleware** (Role-based access control)

---

## 🧠 Architecture & Design Patterns



Each MCP tool follows a **Zod-validated** input schema with a strict Request-Response flow ensuring safe code mutation.

### Key Design Principles

1.  **Read-Before-Write AST Injection:** Tools read existing files into memory and use `ts-morph` to parse and mutate the AST. Avoids blindly overwriting files and detects "Ghost Import" conflicts.
2.  **Dry-Run Support:** All tools accept a `dryRun` boolean to return proposed changes as formatted text WITHOUT modifying disk.
3.  **Universal Dependency Shield:** Auto-installs only missing dependencies (checks `package.json`) using `--no-save --save-exact` to avoid manifest pollution. Records to `SDK_VERSIONS.md`.
4.  **Atomic Operations:** High-risk operations (e.g., `npx prisma generate`) use backup + rollback. On failure, the original state is restored.
5.  **Schema Intelligence:** Understands relational gravity. If a field references a parent model, it automatically locates the parent block and injects the inverse relation field safely.

---

## 🛠️ Tool Inventory

| Tool | Purpose | Risk Level | Status |
|---|---|---|---|
| `scaffoldProject` | Clone boilerplate, remove git history, install deps | Low | ✅ Active |
| `injectPrismaModel` | Add Prisma model with auto-generated fields & relations | Med (Prisma Gen) | ✅ Active |
| `injectExpressRoute` | Add Express route handler & mount in server.ts | Med (AST) | ✅ Active |
| `injectTransaction` | Wrap logic in ACID-compliant `prisma.$transaction` | Med (AST) | ✅ Active |
| `injectCrudController` | Generate CRUD handlers from Prisma schema | Low | ✅ Active |
| `injectAuthSystem` | Create email/OAuth auth stack | Low | ✅ Active |
| `injectSocketService` | Create Socket.io singleton & wire server | Med (Server Mod) | ✅ Active |
| `injectPaymentWebhook`| Generate unified Stripe + Razorpay webhook handler | Low | ✅ Active |
| `injectRateLimiter` | Inject Redis-backed rate-limit middleware | Low | ✅ Active |
| `injectRbacMiddleware`| Add role-based access control to a route | Low | ✅ Active |

*(See full documentation for all 22 tools in the repository wiki).*

---

## 🏗️ Runtime Environment (proptech-backend)

The `proptech-backend/` folder acts as the reference implementation and testing ground for all Blueprint MCP tools. It demonstrates a production-ready API with real DB schemas, controllers, middleware, and seed scripts.

**Key V4.0 Enhancements in Runtime:**
* **Socket.io Queuing:** Socket.io initialization is deferred until `server.listen` wires the HTTP server, avoiding circular dependency runtime errors.
* **Test-Safe Server Booting:** `server.listen()` is guarded for test environments to avoid port conflicts during automated Vitest runs.
* **Controller Error Parity:** All error responses throw a unified `AppError` instance for a predictable frontend experience.

### Running the Backend
```bash
cd proptech-backend
npm install
npx prisma migrate dev       # apply migrations
npx ts-node prisma/seed.ts   # seed initial data
npm run dev                  # start server on port 3000