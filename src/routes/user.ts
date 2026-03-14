import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { Room } from '../models/Room';
import { authMiddleware, generateToken } from '../middleware/auth';

const router = Router();

// POST /api/user/login — login by username
// Tries all users with matching username across admins to find the right one
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password, deviceId } = req.body;
        if (!username || !password || !deviceId) {
            res.status(400).json({ error: 'username, password, and deviceId are required' });
            return;
        }

        // Find all active users with this username (may belong to different admins)
        const users = await User.find({ username: username.toLowerCase(), isDeleted: { $ne: true } });
        if (users.length === 0) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        // Try password against each matching user
        let matchedUser = null;
        for (const u of users) {
            const valid = await bcrypt.compare(password, u.passwordHash);
            if (valid) {
                matchedUser = u;
                break;
            }
        }

        if (!matchedUser) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        // Device lock: first login sets deviceId, subsequent logins must match
        if (matchedUser.deviceId === null) {
            matchedUser.deviceId = deviceId;
            await matchedUser.save();
        } else if (matchedUser.deviceId !== deviceId) {
            res.status(403).json({ error: 'This account is locked to another device. Contact your admin to unlock.' });
            return;
        }

        // Get admin name
        const admin = await (await import('../models/Admin')).Admin.findById(matchedUser.adminId, 'name');

        const token = generateToken({ id: String(matchedUser._id), role: 'user' });
        res.json({
            token,
            role: 'user',
            name: matchedUser.name,
            username: matchedUser.username,
            adminId: matchedUser.adminId,
            adminName: admin?.name || 'Admin',
            userId: matchedUser._id,
        });
    } catch (err) {
        console.error('User login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/user/me — get latest user profile (for syncing name changes)
router.get('/me', authMiddleware(['user']), async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await User.findById(req.auth!.id, '-passwordHash -encryptedPassword');
        if (!user || user.isDeleted) {
            res.status(403).json({ error: 'Account not active' });
            return;
        }
        const admin = await (await import('../models/Admin')).Admin.findById(user.adminId, 'name');
        res.json({
            name: user.name,
            username: user.username,
            adminName: admin?.name || 'Admin',
            userId: user._id,
            adminId: user.adminId,
        });
    } catch (err) {
        console.error('User me error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/user/rooms — get active rooms for user's admin
router.get('/rooms', authMiddleware(['user']), async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await User.findById(req.auth!.id);
        if (!user || user.isDeleted) {
            res.status(403).json({ error: 'Account not active' });
            return;
        }

        const rooms = await Room.find({ adminId: user.adminId, isActive: true }).populate('adminId', 'name');
        res.json(rooms);
    } catch (err) {
        console.error('User rooms error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
