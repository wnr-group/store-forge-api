export interface AuthenticatedUser {
  userId: string;
  role: string;
  email?: string;
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedUser;
    }
  }
}
