'use strict'
const bcrypt = require('bcrypt')
const crs = require('crypto-random-string')
const knex = require('@/db/knex')
const {
  ServerAcl: ServerAclSchema,
  Users: UsersSchema,
  UserEmails
} = require('@/modules/core/dbSchema')
const {
  validateUserPassword,
  updateUserAndNotify,
  MINIMUM_PASSWORD_LENGTH
} = require('@/modules/core/services/users/management')

const Users = () => UsersSchema.knex()
const Acl = () => ServerAclSchema.knex()

const { deleteStream } = require('./streams')
const { LIMITED_USER_FIELDS } = require('@/modules/core/helpers/userHelper')
const {
  getUserByEmail,
  getUsersBaseQuery
} = require('@/modules/core/repositories/users')
const { UsersEmitter, UsersEvents } = require('@/modules/core/events/usersEmitter')
const { pick, omit } = require('lodash')
const { dbLogger } = require('@/logging/logging')
const {
  UserInputError,
  PasswordTooShortError
} = require('@/modules/core/errors/userinput')
const { Roles } = require('@speckle/shared')
const { getServerInfo } = require('@/modules/core/services/generic')
const { sanitizeImageUrl } = require('@/modules/shared/helpers/sanitization')
const {
  createUserEmailFactory,
  findPrimaryEmailForUserFactory,
  findEmailFactory
} = require('@/modules/core/repositories/userEmails')
const { db } = require('@/db/knex')

const _changeUserRole = async ({ userId, role }) =>
  await Acl().where({ userId }).update({ role })

const countAdminUsers = async () => {
  const [{ count }] = await Acl().where({ role: Roles.Server.Admin }).count()
  return parseInt(count)
}
const _ensureAtleastOneAdminRemains = async (userId) => {
  if ((await countAdminUsers()) === 1) {
    const currentAdmin = await Acl().where({ role: Roles.Server.Admin }).first()
    if (currentAdmin.userId === userId) {
      throw new UserInputError('Cannot remove the last admin role from the server')
    }
  }
}

module.exports = {
  /*
    Users
  */

  /**
   * @param {{}} user
   * @param {{skipPropertyValidation: boolean } | undefined} options
   * @returns {Promise<string>}
   */
  async createUser(user, options = undefined) {
    // ONLY ALLOW SKIPPING WHEN CREATING USERS FOR TESTS, IT'S UNSAFE OTHERWISE
    const { skipPropertyValidation = false } = options || {}

    if (!user.email?.length) throw new UserInputError('E-mail address is required')

    let expectedRole = null
    if (user.role) {
      const isValidRole = Object.values(Roles.Server).includes(user.role)
      const isValidIfGuestModeEnabled =
        user.role !== Roles.Server.Guest || (await getServerInfo()).guestModeEnabled
      expectedRole = isValidRole && isValidIfGuestModeEnabled ? user.role : null
    }
    delete user.role

    user = skipPropertyValidation
      ? user
      : pick(user, ['id', 'bio', 'email', 'password', 'name', 'company', 'verified'])

    const newId = crs({ length: 10 })
    user.id = newId
    user.email = user.email.toLowerCase()

    if (!user.name) throw new UserInputError('User name is required')

    if (user.avatar) {
      user.avatar = sanitizeImageUrl(user.avatar)
    }

    if (user.password) {
      if (user.password.length < MINIMUM_PASSWORD_LENGTH)
        throw new PasswordTooShortError(MINIMUM_PASSWORD_LENGTH)
      user.passwordDigest = await bcrypt.hash(user.password, 10)
    }
    delete user.password

    const userEmail = await findEmailFactory({ db })({
      email: user.email
    })
    if (userEmail) throw new UserInputError('Email taken. Try logging in?')

    const [newUser] = (await Users().insert(user, UsersSchema.cols)) || []
    if (!newUser) throw new Error("Couldn't create user")

    const userRole =
      (await countAdminUsers()) === 0
        ? Roles.Server.Admin
        : expectedRole || Roles.Server.User

    await Acl().insert({ userId: newId, role: userRole })

    await createUserEmailFactory({ db })({
      userEmail: {
        email: user.email,
        userId: user.id,
        verified: user.verified
      }
    })

    await UsersEmitter.emit(UsersEvents.Created, { user: newUser })

    return newUser.id
  },

  /**
   * @param {{user: {email: string, name?: string, role?: import('@speckle/shared').ServerRoles}, bio?: string}} param0
   * @returns {Promise<{
   *  id: string,
   *  email: string,
   *  isNewUser?: boolean
   * }>}
   */
  async findOrCreateUser({ user }) {
    const userEmail = await findPrimaryEmailForUserFactory({ db })({
      email: user.email
    })
    if (userEmail) return { id: userEmail.userId, email: userEmail.email }

    user.password = crs({ length: 20 })
    user.verified = true // because we trust the external identity provider, no?
    return {
      id: await module.exports.createUser(user),
      email: user.email,
      isNewUser: true
    }
  },

  /**
   * @param {{userId: string}} param0
   * @returns {Promise<import('@/modules/core/helpers/types').UserRecord | null>}
   *TODO: this should be moved to repository
   */
  async getUserById({ userId }) {
    const user = await Users()
      .where({ [UsersSchema.col.id]: userId })
      .leftJoin(UserEmails.name, UserEmails.col.userId, UsersSchema.col.id)
      .where({ [UserEmails.col.primary]: true, [UserEmails.col.userId]: userId })
      .columns([
        ...Object.values(omit(UsersSchema.col, ['email', 'verified'])),
        knex.raw(`(array_agg("user_emails"."email"))[1] as email`),
        knex.raw(`(array_agg("user_emails"."verified"))[1] as verified`)
      ])
      .groupBy(UsersSchema.col.id)
      .first()
    if (user) delete user.passwordDigest
    return user
  },

  // TODO: deprecate
  async getUser(id) {
    const user = await Users()
      .where({ [UsersSchema.col.id]: id })
      .leftJoin(UserEmails.name, UserEmails.col.userId, UsersSchema.col.id)
      .where({ [UserEmails.col.primary]: true, [UserEmails.col.userId]: id })
      .columns([
        ...Object.values(omit(UsersSchema.col, ['email', 'verified'])),
        knex.raw(`(array_agg("user_emails"."email"))[1] as email`),
        knex.raw(`(array_agg("user_emails"."verified"))[1] as verified`)
      ])
      .groupBy(UsersSchema.col.id)
      .first()
    if (user) delete user.passwordDigest
    return user
  },

  // TODO: this should be moved to repository
  async getUserByEmail({ email }) {
    const user = await Users()
      .leftJoin(UserEmails.name, UserEmails.col.userId, UsersSchema.col.id)
      .where({ [UserEmails.col.primary]: true })
      .whereRaw('lower("user_emails"."email") = lower(?)', [email])
      .columns([
        ...Object.values(omit(UsersSchema.col, ['email', 'verified'])),
        knex.raw(`(array_agg("user_emails"."email"))[1] as email`),
        knex.raw(`(array_agg("user_emails"."verified"))[1] as verified`)
      ])
      .groupBy(UsersSchema.col.id)
      .first()
    if (!user) return null
    delete user.passwordDigest
    return user
  },

  async getUserRole(id) {
    const { role } = (await Acl().where({ userId: id }).select('role').first()) || {
      role: null
    }
    return role
  },

  /**
   * @deprecated {Use updateUserAndNotify() or repo method directly}
   */
  async updateUser(id, user) {
    return await updateUserAndNotify(id, user)
  },

  /**
   * @deprecated {Use changePassword()}
   */
  async updateUserPassword({ id, newPassword }) {
    if (newPassword.length < MINIMUM_PASSWORD_LENGTH)
      throw new PasswordTooShortError(MINIMUM_PASSWORD_LENGTH)
    const passwordDigest = await bcrypt.hash(newPassword, 10)
    await Users().where({ id }).update({ passwordDigest })
  },

  /**
   * User search available for normal server users. It's more limited because of the lower access level.
   */
  async searchUsers(searchQuery, limit, cursor, archived = false, emailOnly = false) {
    const prefixedLimitedUserFields = LIMITED_USER_FIELDS.map(
      (field) => `users.${field}`
    )
    const query = Users()
      .join('server_acl', 'users.id', 'server_acl.userId')
      .leftJoin(UserEmails.name, UserEmails.col.userId, UsersSchema.col.id)
      .columns([
        ...Object.values(omit(UsersSchema.col, ['email', 'verified'])).filter((col) =>
          prefixedLimitedUserFields.includes(col)
        ),
        knex.raw(`(array_agg("user_emails"."verified"))[1] as verified`)
      ])
      .groupBy(UsersSchema.col.id)
      .where((queryBuilder) => {
        queryBuilder.where({ [UserEmails.col.email]: searchQuery }) //match full email or partial name
        if (!emailOnly) queryBuilder.orWhere('name', 'ILIKE', `%${searchQuery}%`)
        if (!archived) queryBuilder.andWhere('role', '!=', Roles.Server.ArchivedUser)
      })

    if (cursor) query.andWhere('users.createdAt', '<', cursor)

    const defaultLimit = 25
    query.orderBy('users.createdAt', 'desc').limit(limit || defaultLimit)

    const rows = await query
    return {
      users: rows,
      cursor: rows.length > 0 ? rows[rows.length - 1].createdAt.toISOString() : null
    }
  },

  /**
   * @deprecated {Use validateUserPassword()}
   */
  async validatePasssword({ email, password }) {
    const user = await getUserByEmail(email, { skipClean: true })
    if (!user) return false
    return await validateUserPassword({
      password,
      user
    })
  },

  /**
   * TODO: this should be moved to repository
   * @param {{ deleteAllUserInvites: import('@/modules/serverinvites/domain/operations').DeleteAllUserInvites }} param0
   */
  deleteUser({ deleteAllUserInvites }) {
    return async (id) => {
      //TODO: check for the last admin user to survive
      dbLogger.info('Deleting user ' + id)
      await _ensureAtleastOneAdminRemains(id)
      const streams = await knex.raw(
        `
      -- Get the stream ids with only this user as owner
      SELECT "resourceId" as id
      FROM (
        -- Compute (streamId, ownerCount) table for streams on which the user is owner
        SELECT acl."resourceId", count(*) as cnt
        FROM stream_acl acl
        INNER JOIN
          (
          -- Get streams ids on which the user is owner
          SELECT "resourceId" FROM stream_acl
          WHERE role = '${Roles.Stream.Owner}' AND "userId" = ?
          ) AS us ON acl."resourceId" = us."resourceId"
        WHERE acl.role = '${Roles.Stream.Owner}'
        GROUP BY (acl."resourceId")
      ) AS soc
      WHERE cnt = 1
      `,
        [id]
      )
      for (const i in streams.rows) {
        await deleteStream({ streamId: streams.rows[i].id })
      }

      // Delete all invites (they don't have a FK, so we need to do this manually)
      // THIS REALLY SHOULD BE A REACTION TO THE USER DELETED EVENT EMITTED HER
      await deleteAllUserInvites(id)

      return await Users().where({ id }).del()
    }
  },

  /**
   * TODO: this should be moved to repositories
   * Get all users or filter them with the specified searchQuery. This is meant for
   * server admins, because it exposes the User object (& thus the email).
   * @param {number} limit
   * @param {number} offset
   * @param {string | null} searchQuery
   * @returns {Promise<import('@/modules/core/helpers/userHelper').UserRecord[]>}
   */
  async getUsers(limit = 10, offset = 0, searchQuery = null) {
    // sanitize limit
    const maxLimit = 200
    if (limit > maxLimit) limit = maxLimit

    const query = Users()
      .leftJoin(UserEmails.name, UserEmails.col.userId, UsersSchema.col.id)
      .columns([
        ...Object.values(
          omit(UsersSchema.col, ['email', 'verified', 'passwordDigest'])
        ),
        knex.raw(`(array_agg("user_emails"."email"))[1] as email`),
        knex.raw(`(array_agg("user_emails"."verified"))[1] as verified`)
      ])

    return getUsersBaseQuery(query, { searchQuery })
      .groupBy(UsersSchema.col.id)
      .orderBy(UsersSchema.col.createdAt)
      .limit(limit)
      .offset(offset)
  },

  /**
   * TODO: this should be moved to repositories
   * @param {string|null} searchQuery
   * @returns
   */
  async countUsers(searchQuery = null) {
    const query = Users().leftJoin(
      UserEmails.name,
      UserEmails.col.userId,
      UsersSchema.col.id
    )

    const [userCount] = await getUsersBaseQuery(query, { searchQuery }).count()
    return parseInt(userCount.count)
  },

  async changeUserRole({ userId, role, guestModeEnabled = false }) {
    if (!Object.values(Roles.Server).includes(role))
      throw new UserInputError(`Invalid role specified: ${role}`)
    if (!guestModeEnabled && role === Roles.Server.Guest)
      throw new UserInputError('Guest role is not enabled')
    if (role !== Roles.Server.Admin) await _ensureAtleastOneAdminRemains(userId)
    await _changeUserRole({ userId, role })
  }
}
