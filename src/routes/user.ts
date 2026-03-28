import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';
import { User } from '../models/User';
import { Room } from '../models/Room';
import { authMiddleware, generateToken } from '../middleware/auth';
import { getRecordingFilePath } from '../media/recording';
import { isRoomActive } from '../ws/wsHandler';

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

        const dbRooms = await Room.find({ adminId: user.adminId, isActive: true }).populate('adminId', 'name');
        
        // Filter out stale rooms (e.g., if server restarted while room was active)
        const activeRooms = dbRooms.filter(r => isRoomActive(r.roomId));
        
        res.json(activeRooms);
    } catch (err) {
        console.error('User rooms error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

// GET /api/user/recordings — list all recordings for this user across all rooms
router.get('/recordings', authMiddleware(['user']), async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.auth!.id;
        const result: Array<{ roomId: string; filename: string; startTime: number; size: number }> = [];

        if (!fs.existsSync(RECORDINGS_DIR)) {
            res.json([]);
            return;
        }

        // Scan all room directories for this user's recordings
        const roomDirs = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const roomDir of roomDirs) {
            const userDir = path.join(RECORDINGS_DIR, roomDir.name, userId);
            if (!fs.existsSync(userDir)) continue;

            const files = fs.readdirSync(userDir).filter(f => (f.endsWith('.mp3') || f.endsWith('.webm')) && !f.startsWith('_')).sort().reverse();
            for (const filename of files) {
                const filepath = path.join(userDir, filename);
                const stats = fs.statSync(filepath);
                result.push({
                    roomId: roomDir.name,
                    filename,
                    startTime: stats.mtimeMs,
                    size: stats.size,
                });
            }
        }

        // Sort by newest first
        result.sort((a, b) => b.startTime - a.startTime);
        res.json(result);
    } catch (err) {
        console.error('User recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/user/recordings/stream — download a recording file
router.get('/recordings/stream', authMiddleware(['user']), async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.auth!.id;
        const roomId = req.query.roomId as string;
        const filename = req.query.filename as string;

        if (!roomId || !filename) {
            res.status(400).json({ error: 'roomId and filename query parameters required' });
            return;
        }

        const filepath = getRecordingFilePath(roomId, userId, filename);
        if (!filepath) {
            res.status(404).json({ error: 'Recording not found' });
            return;
        }

        const contentType = filename.endsWith('.webm') ? 'audio/webm' : 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(filename).replace(/"/g, '')}"`);
        res.sendFile(filepath);
    } catch (err) {
        console.error('User recording download error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
