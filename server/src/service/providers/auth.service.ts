import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import * as ms from 'ms';
import { ID } from 'shared/shared-types';
import { Connection } from 'typeorm';

import { ConfigService } from '../../config/config.service';
import { Session } from '../../entity/session/session.entity';
import { User } from '../../entity/user/user.entity';

import { PasswordService } from './password.service';

@Injectable()
export class AuthService {
    private readonly sessionDurationInMs;

    constructor(
        private passwordService: PasswordService,
        @InjectConnection() private connection: Connection,
        private configService: ConfigService,
    ) {
        this.sessionDurationInMs = ms(this.configService.authOptions.sessionDuration);
    }

    /**
     * Authenticates a user's credentials and if okay, creates a new session.
     */
    async authenticate(identifier: string, password: string): Promise<Session> {
        const user = await this.getUserFromIdentifier(identifier);
        const passwordMatches = await this.passwordService.check(password, user.passwordHash);
        if (!passwordMatches) {
            throw new UnauthorizedException();
        }
        const token = await this.generateSessionToken();
        const session = new Session({
            token,
            user,
            expires: this.getExpiryDate(),
            invalidated: false,
        });
        await this.invalidateUserSessions(user);
        // save the new session
        const newSession = this.connection.getRepository(Session).save(session);
        return newSession;
    }

    /**
     * Looks for a valid session with the given token and returns one if found.
     */
    async validateSession(token: string): Promise<Session | undefined> {
        const session = await this.connection.getRepository(Session).findOne({
            where: { token, invalidated: false },
            relations: ['user', 'user.roles', 'user.roles.channels'],
        });
        if (session && session.expires > new Date()) {
            await this.updateSessionExpiry(session);
            return session;
        }
    }

    /**
     * Invalidates all existing sessions for the given user.
     */
    async invalidateUserSessions(user: User): Promise<void> {
        await this.connection.getRepository(Session).update({ user }, { invalidated: true });
    }

    /**
     * Invalidates all sessions for the user associated with the given session token.
     */
    async invalidateSessionByToken(token: string): Promise<void> {
        const session = await this.connection.getRepository(Session).findOne({
            where: { token },
            relations: ['user'],
        });
        if (session) {
            return this.invalidateUserSessions(session.user);
        }
    }

    async getUserById(userId: ID): Promise<User | undefined> {
        return this.connection.getRepository(User).findOne(userId, {
            relations: ['roles', 'roles.channels'],
        });
    }

    private async getUserFromIdentifier(identifier: string): Promise<User> {
        const user = await this.connection.getRepository(User).findOne({
            where: { identifier },
            relations: ['roles', 'roles.channels'],
        });
        if (!user) {
            throw new UnauthorizedException();
        }
        return user;
    }

    /**
     * Generates a random session token.
     */
    private generateSessionToken(): Promise<string> {
        return new Promise((resolve, reject) => {
            crypto.randomBytes(32, (err, buf) => {
                if (err) {
                    reject(err);
                }
                resolve(buf.toString('hex'));
            });
        });
    }

    /**
     * If we are over half way to the current session's expiry date, then we update it.
     *
     * This ensures that the session will not expire when in active use, but prevents us from
     * needing to run an update query on *every* request.
     */
    private async updateSessionExpiry(session: Session) {
        const now = new Date().getTime();
        if (session.expires.getTime() - now < this.sessionDurationInMs / 2) {
            await this.connection
                .getRepository(Session)
                .update({ id: session.id }, { expires: this.getExpiryDate() });
        }
    }

    /**
     * Returns a future expiry date according to the configured sessionDuration.
     */
    private getExpiryDate(): Date {
        return new Date(Date.now() + this.sessionDurationInMs);
    }
}
