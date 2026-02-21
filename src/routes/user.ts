import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import { Room } from '../models/Room';
import { authMiddleware, generateToken } from '../middleware/auth';

const router = Router();

// POST /api/user/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { phone, password, deviceId } = req.body;
        if (!phone || !password || !deviceId) {
            res.status(400).json({ error: 'phone, password, and deviceId are required' });
            return;
        }

        const user = await User.findOne({ phone });
        if (!user) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        if (user.isDeleted) {
            res.status(403).json({ error: 'Account has been deleted. Contact your admin.' });
            return;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        // Device lock: first login sets deviceId, subsequent logins must match
        if (user.deviceId === null) {
            user.deviceId = deviceId;
            await user.save();
        } else if (user.deviceId !== deviceId) {
            res.status(403).json({ error: 'This account is locked to another device. Contact your admin to unlock.' });
            return;
        }

        const token = generateToken({ id: String(user._id), role: 'user' });
        res.json({
            token,
            role: 'user',
            name: user.name,
            phone: user.phone,
            adminId: user.adminId,
            userId: user._id,
        });
    } catch (err) {
        console.error('User login error:', err);
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
