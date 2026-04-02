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

        // Find all users with this username across all admins (active or not)
        const allUsers = await User.find({ username: username.toLowerCase() });
        if (allUsers.length === 0) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        // Try password against each matching user
        let matchedUser = null;
        for (const u of allUsers) {
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

        // Check if matched user account is deactivated
        if (matchedUser.isDeleted) {
            res.status(403).json({ error: 'Account deactivated. Contact your admin.' });
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

// GET /api/user/recordings — list all recordings for this user grouped by Room (Call Session)
router.get('/recordings', authMiddleware(['user']), async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.auth!.id;
        interface Segment {
            filename: string;
            startTime: number;
            size: number;
        }
        interface CallSession {
            roomId: string;
            userId: string;
            startTime: number;
            segments: Segment[];
        }
        const sessions: CallSession[] = [];

        if (!fs.existsSync(RECORDINGS_DIR)) {
            res.json([]);
            return;
        }

        // Helper to accurately extract precise start time from filament
        const extractStartTime = (filename: string): number => {
            try {
                const isoLike = filename.replace('segment_', '').replace('.mp3', '').replace('.webm', '');
                // segment_2026-03-28T08-12-24-312Z.mp3 -> 2026-03-28T08:12:24.312Z
                const restored = isoLike.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z/, 'T$1:$2:$3.$4Z');
                const ts = new Date(restored).getTime();
                return isNaN(ts) ? 0 : ts;
            } catch { return 0; }
        };

        // Scan all room directories for this user's recordings
        const roomDirs = fs.readdirSync(RECORDINGS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const roomDir of roomDirs) {
            const userDir = path.join(RECORDINGS_DIR, roomDir.name, userId);
            if (!fs.existsSync(userDir)) continue;

            const files = fs.readdirSync(userDir).filter(f => (f.endsWith('.mp3') || f.endsWith('.webm')) && !f.startsWith('_')).sort();
            if (files.length === 0) continue;

            const segments: Segment[] = [];
            for (const filename of files) {
                const filepath = path.join(userDir, filename);
                const stats = fs.statSync(filepath);
                let startTime = extractStartTime(filename);
                if (!startTime) startTime = stats.mtimeMs; // fallback

                segments.push({
                    filename,
                    startTime,
                    size: stats.size,
                });
            }

            // Always chronological inside the folder
            segments.sort((a, b) => a.startTime - b.startTime);

            sessions.push({
                roomId: roomDir.name,
                userId,
                startTime: segments[0].startTime, // First segment dictated overall session start
                segments,
            });
        }

        // Sort folders by newest session first
        sessions.sort((a, b) => b.startTime - a.startTime);
        res.json(sessions);
    } catch (err) {
        console.error('User recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
