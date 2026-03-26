import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthPayload {
    id: string;
    role: 'superadmin' | 'admin' | 'user';
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPayload;
        }
    }
}

export function authMiddleware(allowedRoles: AuthPayload['role'][]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        const header = req.headers.authorization;
        const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
        const token = header?.startsWith('Bearer ') ? header.split(' ')[1] : queryToken;

        if (!token) {
            res.status(401).json({ error: 'No token provided' });
            return;
        }

        try {
            const decoded = jwt.verify(token, config.jwtSecret) as AuthPayload;
            if (!allowedRoles.includes(decoded.role)) {
                res.status(403).json({ error: 'Insufficient permissions' });
                return;
            }
            req.auth = decoded;
            next();
        } catch {
            res.status(401).json({ error: 'Invalid token' });
        }
    };
}

export function generateToken(payload: AuthPayload): string {
    return jwt.sign(payload, config.jwtSecret, { expiresIn: '7d' });
}
