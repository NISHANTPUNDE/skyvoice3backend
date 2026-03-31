import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { Admin } from '../models/Admin';
import { User } from '../models/User';
import { Room } from '../models/Room';
import { authMiddleware, generateToken } from '../middleware/auth';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';

const logosDir = path.resolve(process.cwd(), 'logos');
if (!fs.existsSync(logosDir)) {
    fs.mkdirSync(logosDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, logosDir);
    },
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || '.png';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, `logo-${uniqueSuffix}${ext}`);
    }
});
const upload = multer({ storage });

const router = Router();

// GET /api/admin/profile — get admin's own profile
router.get('/profile', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const admin = await Admin.findById(req.auth!.id).select('-passwordHash').lean();
        if (!admin) {
            res.status(404).json({ error: 'Admin not found' });
            return;
        }
        const obj: any = { ...admin };
        obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
        delete obj.encryptedPassword;
        res.json(obj);
    } catch (err) {
        console.error('Get profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/profile — update admin's own profile
router.put('/profile', authMiddleware(['admin']), upload.single('logo'), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, username, password } = req.body;
        const update: any = {};
        if (name) update.name = name;
        if (username) {
            const existing = await Admin.findOne({ username: username.toLowerCase(), _id: { $ne: new Types.ObjectId(req.auth!.id) } });
            if (existing) {
                res.status(409).json({ error: 'Username already taken' });
                return;
            }
            update.username = username.toLowerCase();
        }
        if (password) {
            update.passwordHash = await bcrypt.hash(password, 10);
            update.encryptedPassword = encryptPassword(password);
        }
        if (req.file) {
            update.logoUrl = `/api/logos/${req.file.filename}`;
        }

        const admin = await Admin.findByIdAndUpdate(req.auth!.id, update, { new: true, projection: '-passwordHash' });
        if (!admin) {
            res.status(404).json({ error: 'Admin not found' });
            return;
        }
        const obj: any = admin.toObject();
        obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
        delete obj.encryptedPassword;
        res.json(obj);
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/admin/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password, host } = req.body;
        if (!username || !password) {
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        const admin = await Admin.findOne({ username: username.toLowerCase() });
        if (!admin) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        if (host) {
            const requestedDomain = host.toLowerCase();
            const parts = requestedDomain.split('.');
            const prefixes = [];
            for (let i = parts.length; i > 0; i--) {
                prefixes.push(parts.slice(0, i).join('.'));
            }

            const hostOwner = await Admin.findOne({ subdomain: { $in: prefixes } });
            
            if (hostOwner) {
                if (String(hostOwner._id) !== String(admin._id)) {
                    res.status(403).json({ error: 'You are not authorized to log into this portal.' });
                    return;
                }
            } else {
                if (admin.subdomain) {
                    res.status(403).json({ error: `Please log in using your dedicated portal.` });
                    return;
                }
            }
        }

        if (!admin.isActive) {
            res.status(403).json({ error: 'Your account is deactivated. Please contact the Super Admin.' });
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
        const { name, username, phone, password } = req.body;
        if (!name || !username || !password) {
            res.status(400).json({ error: 'name, username, and password are required' });
            return;
        }

        // Check username only within this admin's users
        const existing = await User.findOne({ username: username.toLowerCase(), adminId: req.auth!.id, isDeleted: { $ne: true } });
        if (existing) {
            res.status(409).json({ error: 'User with this username already exists' });
            return;
        }

        // Check user limit (0 = unlimited)
        const admin = await Admin.findById(req.auth!.id);
        if (admin && admin.userLimit > 0) {
            const currentCount = await User.countDocuments({ adminId: req.auth!.id, isDeleted: { $ne: true } });
            if (currentCount >= admin.userLimit) {
                res.status(403).json({ error: `User limit reached (${admin.userLimit}). Contact Super Admin to increase your limit.` });
                return;
            }
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const encPwd = encryptPassword(password);
        const user = await User.create({
            name,
            username: username.toLowerCase(),
            phone: phone || undefined,
            passwordHash,
            encryptedPassword: encPwd,
            adminId: req.auth!.id,
        });

        res.status(201).json({
            _id: user._id,
            name: user.name,
            username: user.username,
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

// GET /api/admin/users — list users with pagination
router.get('/users', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
        const skip = (page - 1) * limit;

        const total = await User.countDocuments({ adminId: req.auth!.id });
        const users = await User.find({ adminId: req.auth!.id }, '-passwordHash')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        // Decrypt passwords for admin view
        const result = users.map(u => {
            const obj: any = u.toObject();
            obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
            delete obj.encryptedPassword;
            return obj;
        });

        // Get admin's user limit
        const admin = await Admin.findById(req.auth!.id);
        const userLimit = admin?.userLimit || 0;

        res.json({ users: result, total, page, pages: Math.ceil(total / limit), userLimit });
    } catch (err) {
        console.error('List users error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/users/:id — update user
router.put('/users/:id', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, username, phone, password } = req.body;
        const update: any = {};
        if (name) update.name = name;
        if (username) {
            const existing = await User.findOne({ username: username.toLowerCase(), adminId: req.auth!.id, _id: { $ne: new Types.ObjectId(req.params.id as string) } });
            if (existing) {
                res.status(409).json({ error: 'Username already taken' });
                return;
            }
            update.username = username.toLowerCase();
        }
        if (phone !== undefined) update.phone = phone;
        if (password) {
            update.passwordHash = await bcrypt.hash(password, 10);
            update.encryptedPassword = encryptPassword(password);
        }

        const user = await User.findOneAndUpdate(
            { _id: req.params.id, adminId: req.auth!.id },
            update,
            { new: true, projection: '-passwordHash' }
        );
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        const obj: any = user.toObject();
        obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
        delete obj.encryptedPassword;
        res.json(obj);
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PATCH /api/admin/users/:id/toggle-active — activate/deactivate user
router.patch('/users/:id/toggle-active', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await User.findOne({ _id: req.params.id, adminId: req.auth!.id });
        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        user.isDeleted = !user.isDeleted;
        await user.save();
        res.json({ message: user.isDeleted ? 'User deactivated' : 'User activated', isDeleted: user.isDeleted });
    } catch (err) {
        console.error('Toggle active error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/admin/users/:id — permanently delete user
router.delete('/users/:id', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const user = await User.findOneAndDelete(
            { _id: req.params.id, adminId: req.auth!.id }
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
