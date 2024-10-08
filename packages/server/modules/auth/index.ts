import { SpeckleModule } from '@/modules/shared/helpers/typeHelper'

import { registerOrUpdateScopeFactory } from '@/modules/shared/repositories/scopes'
import { moduleLogger } from '@/logging/logging'
import db from '@/db/knex'
import { initializeDefaultAppsFactory } from '@/modules/auth/services/serverApps'
import {
  getAllScopesFactory,
  getAppFactory,
  updateDefaultAppFactory,
  registerDefaultAppFactory,
  createAuthorizationCodeFactory
} from '@/modules/auth/repositories/apps'
import setupStrategiesFactory from '@/modules/auth/strategies'
import githubStrategyBuilderFactory from '@/modules/auth/strategies/github'
import { getServerInfo } from '@/modules/core/services/generic'
import {
  getUserByEmail,
  findOrCreateUser,
  getUserById,
  validatePasssword,
  createUser
} from '@/modules/core/services/users'
import {
  validateServerInviteFactory,
  finalizeInvitedServerRegistrationFactory,
  resolveAuthRedirectPathFactory
} from '@/modules/serverinvites/services/processing'
import {
  findServerInviteFactory,
  deleteServerOnlyInvitesFactory,
  updateAllInviteTargetsFactory
} from '@/modules/serverinvites/repositories/serverInvites'
import authRestApi from '@/modules/auth/rest/index'
import authScopes from '@/modules/auth/scopes'
import { AuthStrategyMetadata } from '@/modules/auth/helpers/types'
import azureAdStrategyBuilderFactory from '@/modules/auth/strategies/azureAd'
import googleStrategyBuilderFactory from '@/modules/auth/strategies/google'
import localStrategyBuilderFactory from '@/modules/auth/strategies/local'
import oidcStrategyBuilderFactory from '@/modules/auth/strategies/oidc'
import { getRateLimitResult } from '@/modules/core/services/ratelimiter'
import { passportAuthenticateHandlerBuilderFactory } from '@/modules/auth/services/passportService'

const initializeDefaultApps = initializeDefaultAppsFactory({
  getAllScopes: getAllScopesFactory({ db }),
  getApp: getAppFactory({ db }),
  updateDefaultApp: updateDefaultAppFactory({ db }),
  registerDefaultApp: registerDefaultAppFactory({ db })
})

const validateServerInvite = validateServerInviteFactory({
  findServerInvite: findServerInviteFactory({ db })
})
const finalizeInvitedServerRegistration = finalizeInvitedServerRegistrationFactory({
  deleteServerOnlyInvites: deleteServerOnlyInvitesFactory({ db }),
  updateAllInviteTargets: updateAllInviteTargetsFactory({ db })
})
const resolveAuthRedirectPath = resolveAuthRedirectPathFactory()

const commonBuilderDeps = {
  getServerInfo,
  getUserByEmail,
  findOrCreateUser,
  validateServerInvite,
  finalizeInvitedServerRegistration,
  resolveAuthRedirectPath,
  getUserById,
  passportAuthenticateHandlerBuilder: passportAuthenticateHandlerBuilderFactory()
}
const setupStrategies = setupStrategiesFactory({
  githubStrategyBuilder: githubStrategyBuilderFactory({
    ...commonBuilderDeps
  }),
  azureAdStrategyBuilder: azureAdStrategyBuilderFactory({ ...commonBuilderDeps }),
  googleStrategyBuilder: googleStrategyBuilderFactory({ ...commonBuilderDeps }),
  localStrategyBuilder: localStrategyBuilderFactory({
    ...commonBuilderDeps,
    validatePassword: validatePasssword,
    getRateLimitResult,
    createUser
  }),
  oidcStrategyBuilder: oidcStrategyBuilderFactory({ ...commonBuilderDeps }),
  createAuthorizationCode: createAuthorizationCodeFactory({ db }),
  getUserById
})

let authStrategies: AuthStrategyMetadata[]

export const init: SpeckleModule['init'] = async (app) => {
  moduleLogger.info('🔑 Init auth module')

  // Initialize authn strategies
  authStrategies = await setupStrategies(app)

  // Hoist auth routes
  authRestApi(app)

  // Register core-based scopes
  const registerFunc = registerOrUpdateScopeFactory({ db })
  for (const scope of authScopes) {
    await registerFunc({ scope })
  }
}

export const finalize: SpeckleModule['finalize'] = async () => {
  // Note: we're registering the default apps last as we want to ensure that all
  // scopes have been registered by any other modules.
  await initializeDefaultApps()
}

export const getAuthStrategies = (): AuthStrategyMetadata[] => authStrategies
