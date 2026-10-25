export type ReqUser = { id: string; phone: string; name: string };

// Ambil user yang dipasang SessionGuard dari request.
export const reqUser = (req: unknown): ReqUser => (req as { user: ReqUser }).user;

export const moduleApp = undefined; // placeholder tak dipakai
