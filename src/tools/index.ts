import { scaffoldProject } from "./scaffoldProject.js";
import { injectExpressRoute } from "./injectExpressRoute.js";
import { injectPrismaModel } from "./injectPrismaModel.js";
import { injectTransaction } from "./injectTransaction.js";
import { injectRbacMiddleware } from "./injectRbacMiddleware.js";
import { injectCrudController } from "./injectCrudController.js";
import { injectAuthSystem } from "./injectAuthSystem.js";
import { injectStorageService } from "./injectStorageService.js";
import { injectEnvValidation } from "./injectEnvValidation.js";
import { injectGlobalErrorHandler } from "./injectGlobalErrorHandler.js";
import { injectSocketService } from "./injectSocketService.js";
import { generateApiDocs } from "./generateApiDocs.js";
import { injectRateLimiter } from "./injectRateLimiter.js";
import { injectPaymentWebhook } from "./injectPaymentWebhook.js";
import { injectPrismaSeed } from "./injectPrismaSeed.js";
import { injectRedisService } from "./injectRedisService.js";
import { injectMailProvider } from "./injectMailProvider.js";
import { injectApiTests } from "./injectApiTests.js";
import { injectSubscriptionSystem } from "./injectSubscriptionSystem.js";
import { injectPlanSeeder } from "./injectPlanSeeder.js";


// ─── Tier Classification ───────────────────────────────────────────────────────
//
// FREE TOOLS:  Basic scaffolding, simple CRUD, standard Prisma schema creation.
//              Subject to a daily call rate limit (20 calls/tool/day).
//
// PRO  TOOLS:  Advanced AST injections, payment integrations, real-time services,
//              auth systems, and complex relational architecture.
//              Require a valid BLUEPRINT_LICENSE_KEY (Dodo Payments).
//
// ─────────────────────────────────────────────────────────────────────────────

export const FREE_TOOL_NAMES = new Set<string>([
    "scaffold_project",      // Clone boilerplate & install deps
    "inject_prisma_model",   // Add a new model to schema.prisma
    "inject_crud_controller",// Generate basic CRUD controller for a Prisma model
    "inject_env_validation", // Zod-powered environment variable validator
    "inject_express_route",  // Surgically inject a route into an Express router

]);

export const PRO_TOOL_NAMES = new Set<string>([
    "inject_auth_system",        // Full auth: signUp, signIn, refresh, reset, OAuth
    "inject_storage_service",    // Multer + S3/R2/Local storage switcher
    "inject_socket_service",     // Socket.io singleton with HTTP server wrapping
    "inject_global_error_handler",// Typed AppError + globalErrorHandler middleware
    "generate_api_docs",         // Swagger/OpenAPI 3.0 + /api-docs route injection
    "inject_rate_limiter",       // express-rate-limit on specific routes
    "inject_rbac_middleware",    // Role-Based Access Control middleware injection
    "inject_transaction",        // prisma.$transaction block wrapper
    "inject_payment_webhook",    // Stripe/Razorpay webhook handler
    "inject_mail_provider",      // Resend transactional email integration
    "inject_redis_service",      // ioredis caching & rate-limiting service
    "inject_api_tests",          // Vitest + Supertest integration test scaffolding
    "inject_prisma_seed",        // Prisma seed file with admin users & dummy data
    "inject_subscription_system",// Unified recurring subscriptions (Strategy pattern)
    "inject_plan_seeder",        // Auto-seed Stripe/Razorpay plans to DB
]);

// ─── All Tools ─────────────────────────────────────────────────────────────────

export const allTools = [
    // Free tier
    scaffoldProject,
    injectExpressRoute,
    injectPrismaModel,
    injectCrudController,
    injectEnvValidation,

    // Pro tier
    injectAuthSystem,
    injectStorageService,
    injectGlobalErrorHandler,
    injectSocketService,
    generateApiDocs,
    injectRateLimiter,
    injectRbacMiddleware,
    injectTransaction,
    injectPaymentWebhook,
    injectMailProvider,
    injectRedisService,
    injectApiTests,
    injectPrismaSeed,
    injectSubscriptionSystem,
    injectPlanSeeder,
];
