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

export const allTools = [
    scaffoldProject,
    injectExpressRoute,
    injectPrismaModel,
    injectTransaction,
    injectRbacMiddleware,
    injectCrudController,
    injectAuthSystem,
    injectStorageService,
    injectEnvValidation,
    injectGlobalErrorHandler,
    injectSocketService,
    generateApiDocs,
    injectRateLimiter,
    injectPaymentWebhook,
    injectPrismaSeed,
    injectRedisService,
    injectMailProvider,
    injectApiTests,
    injectSubscriptionSystem,
    injectPlanSeeder
];
