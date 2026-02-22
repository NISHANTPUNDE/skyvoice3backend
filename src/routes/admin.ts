import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Admin } from '../models/Admin';
import { User } from '../models/User';
import { Room } from '../models/Room';
import { authMiddleware, generateToken } from '../middleware/auth';
import { encryptPassword, decryptPassword } from '../utils/crypto';

const router = Router();

// POST /api/admin/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        const admin = await Admin.findOne({ username: username.toLowerCase(), isActive: true });
        if (!admin) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        const valid = await bcrypt.compare(password, admin.passwordHash);
        if (!valid) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        const token = generateToken({ id: String(admin._id), role: 'admin' });
        res.json({ token, role: 'admin', name: admin.name, username: admin.username, adminId: admin._id });
    } catch (err) {
        console.error('Admin login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/users — create user
router.post('/users', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, phone, password } = req.body;
        if (!name || !phone || !password) {
            res.status(400).json({ error: 'name, phone, and password are required' });
            return;
        }

        const existing = await User.findOne({ phone });
        if (existing) {
            res.status(409).json({ error: 'User with this phone already exists' });
            return;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const encPwd = encryptPassword(password);
        const user = await User.create({
            name,
            phone,
            passwordHash,
            encryptedPassword: encPwd,
            adminId: req.auth!.id,
        });

        res.status(201).json({
            _id: user._id,
            name: user.name,
            phone: user.phone,
            deviceId: user.deviceId,
            isDeleted: user.isDeleted,
            createdAt: (user as any).createdAt,
        });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/users — list users for this admin
router.get('/users', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const users = await User.find({ adminId: req.auth!.id }, '-passwordHash').sort({ createdAt: -1 });
        // Decrypt passwords for admin view
        const result = users.map(u => {
            const obj: any = u.toObject();
            obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
            delete obj.encryptedPassword;
            return obj;
        });
        res.json(result);
    } catch (err) {
        console.error('List users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/admin/users/:id — soft-delete user
router.delete('/users/:id', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: req.auth!.id },
            { isDeleted: true },
            { new: true }
        );
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json({ message: 'User deleted', _id: user._id });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PATCH /api/admin/users/:id/unlock-device — unlock user device
router.patch('/users/:id/unlock-device', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: req.auth!.id },
            { deviceId: null },
            { new: true, projection: '-passwordHash' }
        );
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json({ message: 'Device unlocked', user });
    } catch (err) {
        console.error('Unlock device error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/rooms — get active room for this admin
router.get('/rooms', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const rooms = await Room.find({ adminId: req.auth!.id, isActive: true });
        res.json(rooms);
    } catch (err) {
        console.error('List rooms error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
