import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { authMiddleware } from '../middleware/auth';
import { getRecordingsForRoom, getRecordingFilePath, getRecordingsDir } from '../media/recording';
import { User } from '../models/User';

const router = Router();

// Helper: get all userIds belonging to this admin
async function getAdminUserIds(adminId: string): Promise<string[]> {
    const users = await User.find({ adminId, isDeleted: { $ne: true } }).select('_id').lean();
    return users.map(u => String(u._id));
}

// Helper: parse segment filename into a timestamp
function parseSegmentTime(filename: string): number {
    try {
        const isoLike = filename.replace('segment_', '').replace('.mp3', '').replace('.webm', '');
        const restored = isoLike.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z/, 'T$1:$2:$3.$4Z');
        const ts = new Date(restored).getTime();
        return isNaN(ts) ? 0 : ts;
    } catch {
        return 0;
    }
}

// GET /api/recordings — list users with recordings (admin-scoped, server-side pagination + search)
// Query params: search, page (1-based), limit
router.get('/', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const adminId = req.auth!.id;
        const search = ((req.query.search as string) || '').trim().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));

        const recDir = getRecordingsDir();
        if (!fs.existsSync(recDir)) {
            res.json({ users: [], total: 0, page, pages: 0 });
            return;
        }

        // Get only this admin's user IDs
        const allowedUserIds = new Set(await getAdminUserIds(adminId));

        const userMap = new Map<string, { totalRecordings: number; rooms: { roomId: string, createdAt: number }[] }>();
        const roomDirs = fs.readdirSync(recDir, { withFileTypes: true }).filter(d => d.isDirectory());

        for (const roomDir of roomDirs) {
            const roomPath = path.join(recDir, roomDir.name);
            const userDirs = fs.readdirSync(roomPath, { withFileTypes: true }).filter(u => u.isDirectory());
            const roomCreatedAt = fs.statSync(roomPath).mtimeMs;

            for (const userDir of userDirs) {
                const userId = userDir.name;
                // Skip users not belonging to this admin
                if (!allowedUserIds.has(userId)) continue;

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

        // Fetch usernames from DB and apply search filter
        let usersResult: any[] = [];
        for (const [userId, data] of userMap.entries()) {
            let userName = 'Unknown User';
            try {
                const userDoc = await User.findById(userId).select('name').lean();
                if (userDoc) userName = userDoc.name;
            } catch { /* ignore invalid ObjectIds */ }

            // Apply search filter
            if (search && !userName.toLowerCase().includes(search) && !userId.toLowerCase().includes(search)) {
                continue;
            }

            data.rooms.sort((a, b) => b.createdAt - a.createdAt);
            usersResult.push({
                userId,
                userName,
                totalRecordings: data.totalRecordings,
                rooms: data.rooms
            });
        }

        usersResult.sort((a, b) => a.userName.localeCompare(b.userName));

        // Paginate
        const total = usersResult.length;
        const pages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;
        usersResult = usersResult.slice(offset, offset + limit);

        res.json({ users: usersResult, total, page, pages, limit });
    } catch (err) {
        console.error('List all recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/recordings/sessions — list all CallSessions flattened across all users for this admin
router.get('/sessions', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const adminId = req.auth!.id;
        const search = ((req.query.search as string) || '').trim().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));

        const recDir = getRecordingsDir();
        if (!fs.existsSync(recDir)) {
            res.json({ sessions: [], total: 0, page, pages: 0, limit });
            return;
        }

        // 1. Get valid users
        const allowedUserIds = new Set(await getAdminUserIds(adminId));

        // 2. Fetch User Names mapping
        const userDocs = await User.find({ _id: { $in: Array.from(allowedUserIds) } }).select('name').lean();
        const userNameMap = new Map<string, string>();
        for (const u of userDocs) {
            userNameMap.set(String(u._id), u.name);
        }

        interface Segment {
            filename: string;
            startTime: number;
            size: number;
        }
        interface CallSession {
            roomId: string;
            userId: string;
            userName: string;
            startTime: number;
            segments: Segment[];
        }

        let allSessions: CallSession[] = [];

        // 3. Scan directory sequentially mapping CallSessions
        const roomDirs = fs.readdirSync(recDir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const roomDir of roomDirs) {
            const roomPath = path.join(recDir, roomDir.name);
            const userDirs = fs.readdirSync(roomPath, { withFileTypes: true }).filter(u => u.isDirectory());

            for (const userDir of userDirs) {
                const userId = userDir.name;
                
                // Security Boundary: Force strict admin ownership
                if (!allowedUserIds.has(userId)) continue;

                // Match Search criteria strictly on valid users
                const uName = userNameMap.get(userId) || 'Unknown User';
                if (search && !uName.toLowerCase().includes(search) && !userId.toLowerCase().includes(search)) {
                    continue;
                }

                const userPath = path.join(roomPath, userId);
                const files = fs.readdirSync(userPath).filter(f => (f.endsWith('.mp3') || f.endsWith('.webm')) && !f.startsWith('_')).sort();
                
                if (files.length === 0) continue;

                const segments: Segment[] = [];
                let earliestStartTime = Number.MAX_SAFE_INTEGER;

                for (const filename of files) {
                    const filepath = path.join(userPath, filename);
                    const stats = fs.statSync(filepath);
                    let startTime = parseSegmentTime(filename);
                    if (!startTime) startTime = stats.mtimeMs; // Fallback

                    if (startTime < earliestStartTime) earliestStartTime = startTime;

                    segments.push({
                        filename,
                        startTime,
                        size: stats.size
                    });
                }

                allSessions.push({
                    roomId: roomDir.name,
                    userId,
                    userName: uName,
                    startTime: earliestStartTime === Number.MAX_SAFE_INTEGER ? Date.now() : earliestStartTime,
                    segments
                });
            }
        }

        // 4. Sort globally by strictly Time Descending (Chronological match)
        allSessions.sort((a, b) => b.startTime - a.startTime);

        // 5. Hard server-side pagination for infinite 1000s threshold
        const total = allSessions.length;
        const pages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;
        
        const paginatedSessions = allSessions.slice(offset, offset + limit);

        res.json({ sessions: paginatedSessions, total, page, pages, limit });
    } catch (err) {
        console.error('List sessions error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/recordings/user/:userId — list segments for specific user (admin-scoped)
router.get('/user/:userId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const adminId = req.auth!.id;
        const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;

        // Verify ownership
        const userDoc = await User.findOne({ _id: userId, adminId }).select('_id').lean();
        if (!userDoc) {
            res.status(403).json({ error: 'User does not belong to this admin' });
            return;
        }

        const result: Record<string, any[]> = {};
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
                        const startTime = parseSegmentTime(filename) || stats.mtimeMs;
                        return { filename, startTime, size: stats.size };
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

// DELETE /api/recordings/single — delete a single recording file
router.delete('/single', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const adminId = req.auth!.id;
        const { roomId, userId, filename } = req.body as { roomId: string; userId: string; filename: string };

        if (!roomId || !userId || !filename) {
            res.status(400).json({ error: 'roomId, userId, and filename are required' });
            return;
        }

        // Verify ownership
        const userDoc = await User.findOne({ _id: userId, adminId }).select('_id').lean();
        if (!userDoc) {
            res.status(403).json({ error: 'User does not belong to this admin' });
            return;
        }

        const filepath = getRecordingFilePath(roomId, userId, filename);
        if (!filepath) {
            res.status(404).json({ error: 'Recording not found' });
            return;
        }

        try {
            fs.unlinkSync(filepath);
        } catch {
            res.status(500).json({ error: 'Failed to delete file' });
            return;
        }

        res.json({ message: 'Recording deleted', filename });
    } catch (err) {
        console.error('Delete single recording error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/recordings/user/:userId — delete all recordings for a user
router.delete('/user/:userId', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const adminId = req.auth!.id;
        const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;

        // Verify ownership
        const userDoc = await User.findOne({ _id: userId, adminId }).select('_id').lean();
        if (!userDoc) {
            res.status(403).json({ error: 'User does not belong to this admin' });
            return;
        }

        const recDir = getRecordingsDir();
        if (!fs.existsSync(recDir)) {
            res.json({ message: 'No recordings found', deleted: 0 });
            return;
        }

        let deleted = 0;
        const roomDirs = fs.readdirSync(recDir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const roomDir of roomDirs) {
            const userDir = path.join(recDir, roomDir.name, userId);
            if (fs.existsSync(userDir)) {
                const files = fs.readdirSync(userDir);
                for (const f of files) {
                    try { fs.unlinkSync(path.join(userDir, f)); deleted++; } catch { /* ok */ }
                }
                try { fs.rmdirSync(userDir); } catch { /* ok */ }
            }
        }
        res.json({ message: `Deleted ${deleted} recordings for user`, deleted });
    } catch (err) {
        console.error('Delete user recordings error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/recordings/bulk — delete recordings for multiple sessions
router.delete('/bulk', authMiddleware(['admin']), async (req: Request, res: Response): Promise<void> => {
    try {
        const adminId = req.auth!.id;
        const { sessions } = req.body as { sessions: { roomId: string, userId: string }[] };

        if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
            res.status(400).json({ error: 'sessions array is required' });
            return;
        }

        const allowedUserIds = new Set(await getAdminUserIds(adminId));
        const recDir = getRecordingsDir();
        let totalDeleted = 0;

        if (fs.existsSync(recDir)) {
            for (const { roomId, userId } of sessions) {
                if (!allowedUserIds.has(userId)) continue;
                
                const userDir = path.join(recDir, roomId, userId);
                if (fs.existsSync(userDir)) {
                    const files = fs.readdirSync(userDir);
                    for (const f of files) {
                        try { fs.unlinkSync(path.join(userDir, f)); totalDeleted++; } catch { /* ok */ }
                    }
                    try { fs.rmdirSync(userDir); } catch { /* ok */ }
                }
            }
        }

        res.json({ message: `Deleted ${totalDeleted} recordings`, deleted: totalDeleted });
    } catch (err) {
        console.error('Bulk delete recordings error:', err);
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
