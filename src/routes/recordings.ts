import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { authMiddleware } from '../middleware/auth';
import { getRecordingsForRoom, getRecordingFilePath, getRecordingsDir } from '../media/recording';

import { User } from '../models/User';

const router = Router();

// GET /api/admin/recordings — list all users that have recordings
router.get('/', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const recDir = getRecordingsDir();
        if (!fs.existsSync(recDir)) {
            res.json([]);
            return;
        }
        
        const userMap = new Map<string, { totalRecordings: number; rooms: { roomId: string, createdAt: number }[] }>();
        const roomDirs = fs.readdirSync(recDir, { withFileTypes: true }).filter(d => d.isDirectory());
        
        for (const roomDir of roomDirs) {
            const roomPath = path.join(recDir, roomDir.name);
            const userDirs = fs.readdirSync(roomPath, { withFileTypes: true }).filter(u => u.isDirectory());
            const roomCreatedAt = fs.statSync(roomPath).mtimeMs;

            for (const userDir of userDirs) {
                const userId = userDir.name;
                const files = fs.readdirSync(path.join(roomPath, userId)).filter(f => (f.endsWith('.mp3') || f.endsWith('.webm')) && !f.startsWith('_'));
                if (files.length > 0) {
                    if (!userMap.has(userId)) {
                        userMap.set(userId, { totalRecordings: 0, rooms: [] });
                    }
                    const userEntry = userMap.get(userId)!;
                    userEntry.totalRecordings += files.length;
                    userEntry.rooms.push({ roomId: roomDir.name, createdAt: roomCreatedAt });
                }
            }
        }

        // Fetch usernames from DB
        const usersResult: any[] = [];
        for (const [userId, data] of userMap.entries()) {
            let userName = 'Unknown User';
            try {
                const userDoc = await User.findById(userId).select('name').lean();
                if (userDoc) userName = userDoc.name;
            } catch { /* ignore invalid ObjectIds */ }

            data.rooms.sort((a, b) => b.createdAt - a.createdAt); // newest rooms first
            usersResult.push({
                userId,
                userName,
                totalRecordings: data.totalRecordings,
                rooms: data.rooms
            });
        }
        
        usersResult.sort((a, b) => a.userName.localeCompare(b.userName));
        res.json(usersResult);
    } catch (err) {
        console.error('List all recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/recordings/user/:userId — list segments for specific user across all rooms
router.get('/user/:userId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
        const result: Record<string, any[]> = {}; // roomId -> segments[]
        
        const recDir = getRecordingsDir();
        if (!fs.existsSync(recDir)) {
            res.json(result);
            return;
        }
        
        const roomDirs = fs.readdirSync(recDir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const roomDir of roomDirs) {
            const userDir = path.join(recDir, roomDir.name, userId);
            if (fs.existsSync(userDir)) {
                const files = fs.readdirSync(userDir).filter(f => (f.endsWith('.mp3') || f.endsWith('.webm')) && !f.startsWith('_')).sort();
                if (files.length > 0) {
                    result[roomDir.name] = files.map(filename => {
                        const filepath = path.join(userDir, filename);
                        const stats = fs.statSync(filepath);
                        let startTime = 0;
                        try {
                            const isoLike = filename.replace('segment_', '').replace('.mp3', '').replace('.webm', '');
                            const restored = isoLike.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z/, 'T$1:$2:$3.$4Z');
                            const ts = new Date(restored).getTime();
                            startTime = isNaN(ts) ? stats.mtimeMs : ts;
                        } catch { startTime = stats.mtimeMs; }

                        return {
                            filename,
                            startTime,
                            size: stats.size,
                        };
                    });
                }
            }
        }
        res.json(result);
    } catch (err) {
        console.error('List user recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/recordings/stream — download/play individual segment
// IMPORTANT: Must be above /:roomId to avoid Express treating "stream" as a roomId
router.get('/stream', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = req.query.roomId as string;
        const userId = req.query.userId as string;
        const filename = req.query.filename as string;
        
        if (!roomId || !userId || !filename) {
            res.status(400).json({ error: 'roomId, userId, and filename query parameters required' });
            return;
        }
        const filepath = getRecordingFilePath(roomId, userId, filename);
        if (!filepath) {
            res.status(404).json({ error: 'Recording not found' });
            return;
        }
        res.download(filepath, filename);
    } catch (err) {
        console.error('Download recording error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/recordings/:roomId — list all recording segments for a room
router.get('/:roomId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
        const recordings = getRecordingsForRoom(roomId);
        res.json(recordings);
    } catch (err) {
        console.error('List recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/recordings/:roomId/:userId — list segments for specific user
router.get('/:roomId/:userId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const roomId = Array.isArray(req.params.roomId) ? req.params.roomId[0] : req.params.roomId;
        const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
        const all = getRecordingsForRoom(roomId);
        const segments = all[userId] || [];
        res.json(segments);
    } catch (err) {
        console.error('List user recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

export default router;
