export interface AuthUser {
  readonly userId: string;
  readonly fullName: string;
  readonly username: string;
  readonly email: string;
  readonly avatar: string | null;
  readonly status: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface PublicUser {
  readonly userId: string;
  readonly fullName: string;
  readonly username: string;
  readonly email: string;
  readonly avatar: string | null;
  readonly status: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface NewUserInput {
  readonly fullName: string;
  readonly username: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly avatar: string;
  readonly phone?: string;
  readonly dateOfBirth?: string;
}

export interface StoredCredentials {
  readonly user: AuthUser;
  readonly passwordHash: string;
}

export interface AuthRepository {
  createUser(input: NewUserInput): Promise<AuthUser>;
  findByIdentifier(identifier: string): Promise<StoredCredentials | null>;
  createSession(userId: string, tokenHash: Buffer, expiresAt: Date): Promise<void>;
  findSessionUser(tokenHash: Buffer): Promise<AuthUser | null>;
  revokeSession(tokenHash: Buffer): Promise<void>;
}

export class DuplicateAccountError extends Error {
  constructor() {
    super('An account with those details already exists.');
    this.name = 'DuplicateAccountError';
  }
}

export class DatabaseUnavailableError extends Error {
  readonly statusCode = 503;

  constructor() {
    super('Authentication storage is unavailable.');
    this.name = 'DatabaseUnavailableError';
  }
}