import { Router, Request, Response } from 'express';
import { Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { SuperAdmin } from '../models/SuperAdmin';
import { Admin } from '../models/Admin';
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

// POST /api/superadmin/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, password, host } = req.body;
        if (!username || !password) {
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        if (host && host !== 'skai.deveraa.com' && !host.includes('localhost') && !host.includes('127.0.0.1')) {
            res.status(403).json({ error: 'Super Admin login is only allowed on the main network.' });
            return;
        }

        const superAdmin = await SuperAdmin.findOne({ username: username.toLowerCase() });
        if (!superAdmin) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        const valid = await bcrypt.compare(password, superAdmin.passwordHash);
        if (!valid) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        const token = generateToken({ id: String(superAdmin._id), role: 'superadmin' });
        res.json({ token, role: 'superadmin', username: superAdmin.username });
    } catch (err) {
        console.error('SuperAdmin login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/superadmin/admins — create admin
router.post('/admins', authMiddleware(['superadmin']), upload.single('logo'), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, username, password, userLimit, subdomain } = req.body;
        if (!name || !username || !password) {
            res.status(400).json({ error: 'name, username, and password are required' });
            return;
        }

        const existing = await Admin.findOne({ username: username.toLowerCase() });
        if (existing) {
            res.status(409).json({ error: 'Admin with this username already exists' });
            return;
        }

        let parsedSubdomain = subdomain?.trim().toLowerCase();
        if (parsedSubdomain) {
            const existingSub = await Admin.findOne({ subdomain: parsedSubdomain });
            if (existingSub) {
                res.status(409).json({ error: 'Admin with this subdomain already exists' });
                return;
            }
        }

        let logoUrl = '';
        if (req.file) {
            logoUrl = `/api/logos/${req.file.filename}`;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const encPwd = encryptPassword(password);
        const admin = await Admin.create({
            name,
            username: username.toLowerCase(),
            passwordHash,
            encryptedPassword: encPwd,
            createdBy: req.auth!.id,
            userLimit: userLimit ? parseInt(userLimit) : 0,
            subdomain: parsedSubdomain || undefined,
            logoUrl,
        });

        res.status(201).json({
            _id: admin._id,
            name: admin.name,
            username: admin.username,
            isActive: admin.isActive,
            userLimit: admin.userLimit,
            createdAt: (admin as any).createdAt,
        });
    } catch (err) {
        console.error('Create admin error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/superadmin/admins — list admins with pagination
router.get('/admins', authMiddleware(['superadmin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 30));
        const skip = (page - 1) * limit;

        const total = await Admin.countDocuments();
        const admins = await Admin.find({}, '-passwordHash')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const result = admins.map(a => {
            const obj: any = a.toObject();
            obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
            delete obj.encryptedPassword;
            return obj;
        });

        res.json({ admins: result, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
        console.error('List admins error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/superadmin/admins/:id — update admin
router.put('/admins/:id', authMiddleware(['superadmin']), upload.single('logo'), async (req: Request, res: Response): Promise<void> => {
    try {
        const { name, username, password, userLimit, subdomain } = req.body;
        const update: any = {};
        if (name) update.name = name;
        if (username) {
            const existing = await Admin.findOne({ username: username.toLowerCase(), _id: { $ne: new Types.ObjectId(req.params.id as string) } });
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
        if (userLimit !== undefined) update.userLimit = parseInt(userLimit);

        if (subdomain !== undefined) {
            const parsedSubdomain = subdomain.trim().toLowerCase();
            if (parsedSubdomain) {
                const existingSub = await Admin.findOne({ subdomain: parsedSubdomain, _id: { $ne: new Types.ObjectId(req.params.id as string) } });
                if (existingSub) {
                    res.status(409).json({ error: 'Subdomain already taken' });
                    return;
                }
                update.subdomain = parsedSubdomain;
            } else {
                update.$unset = { subdomain: 1 };
            }
        }

        if (req.file) {
            update.logoUrl = `/api/logos/${req.file.filename}`;
        }

        const admin = await Admin.findByIdAndUpdate(req.params.id, update, { new: true, projection: '-passwordHash' });
        if (!admin) {
            res.status(404).json({ error: 'Admin not found' });
            return;
        }
        const obj: any = admin.toObject();
        obj.password = obj.encryptedPassword ? decryptPassword(obj.encryptedPassword) : '***';
        delete obj.encryptedPassword;
        res.json(obj);
    } catch (err) {
        console.error('Update admin error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// PATCH /api/superadmin/admins/:id/toggle-active — activate/deactivate admin
router.patch('/admins/:id/toggle-active', authMiddleware(['superadmin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const admin = await Admin.findById(req.params.id);
        if (!admin) {
            res.status(404).json({ error: 'Admin not found' });
            return;
        }
        admin.isActive = !admin.isActive;
        await admin.save();
        res.json({ message: admin.isActive ? 'Admin activated' : 'Admin deactivated', isActive: admin.isActive });
    } catch (err) {
        console.error('Toggle active error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/superadmin/admins/:id — delete admin
router.delete('/admins/:id', authMiddleware(['superadmin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const admin = await Admin.findByIdAndDelete(req.params.id);
        if (!admin) {
            res.status(404).json({ error: 'Admin not found' });
            return;
        }
        res.json({ message: 'Admin deleted' });
    } catch (err) {
        console.error('Delete admin error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
